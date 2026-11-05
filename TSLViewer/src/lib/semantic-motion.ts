import { invoke } from "@tauri-apps/api/core";
import type { SemanticReply } from "./semantic-state";

export type MotorCommand = { kind: string; [key: string]: unknown };
class CommandRejected extends Error {
  constructor(readonly reply: SemanticReply) {
    super(`主控 ${reply.result_name}，结果码 ${reply.result}；fault=${reply.motor?.fault ?? "?"}, error=${reply.motor?.last_error ?? "?"}, mode=${reply.motor?.mode ?? "?"}, pending=${reply.motor?.pending_action ?? "?"}；请读取当前状态后处理`);
  }
}
class SessionLost extends Error {}
/** A single owner shared by all motion controls. The MCU executes trajectories;
 * this service only renews authorization and the specific held-jog lease. */
export class SemanticMotion {
  private boot = "0";
  private session = 0;
  private seq = 0;
  private motor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pulseBusy = false;
  private chain: Promise<unknown> = Promise.resolve();
  private permitWanted = false;
  private heldJog = false;
  private jogGeneration = 0;
  private motionEpoch = 0;
  private task = 0;
  private pulseAt = 0;
  private permitAt = 0;
  private jogAt = 0;
  private heldTask = 0;
  private observers = new Set<(r: SemanticReply, motor: number) => void>();
  private logObservers = new Set<(level: "info" | "ok" | "warn" | "error", message: string) => void>();
  subscribeLog(fn: (level: "info" | "ok" | "warn" | "error", message: string) => void) {
    this.logObservers.add(fn); return () => { this.logObservers.delete(fn); };
  }
  report(level: "info" | "ok" | "warn" | "error", message: string) { this.log(level, message); }
  private log(level: "info" | "ok" | "warn" | "error", message: string) {
    this.logObservers.forEach(fn => fn(level, message));
  }
  private errors = new Set<(error: string) => void>();
  subscribeErrors(fn: (error: string) => void) { this.errors.add(fn); return () => { this.errors.delete(fn); }; }
  owned() { return this.session !== 0; }
  subscribe(fn: (r: SemanticReply, motor: number) => void) {
    this.observers.add(fn); return () => { this.observers.delete(fn); };
  }
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn); this.chain = next.catch(() => undefined); return next;
  }
  private async call(motor: number, command: MotorCommand): Promise<SemanticReply> {
    const id = ++this.seq;
    const detailed = !["get_state","position_state","pulse","jog_renew","permit"].includes(command.kind);
    const context = `M${motor} ${command.kind} request=${id} boot=${this.boot} session=${this.session} task=${this.task}`;
    if (detailed) this.log("info", `${context} 发送 ${JSON.stringify(command)}`);
    try {
    const sentAt = Date.now();
    const r = await invoke<SemanticReply>("motor_semantic", { motor, request: {
      request_id: id, boot_id: this.boot, session_id: this.session, task_id: this.task, command,
    } });
    if (command.kind === "position_state" && r.result === 14 && r.request_id === id &&
        (this.boot === "0" || r.boot_id === this.boot)) return this.call(motor, {kind:"get_state"});
    if (r.request_id !== id || r.protocol_version !== 2 || r.replayed)
      throw Error("主控响应身份未确认，等待下一次状态读取");
    if (this.boot !== "0" && r.boot_id !== this.boot) throw new SessionLost("主控已重启，请重新确认状态和运动授权");
    // A stale jog task is not a stale control session (e.g. endpoint hold).
    if (command.kind !== "close" && this.session && r.session_id !== this.session) throw new SessionLost("主控会话已结束，请重新开启运动授权");
    if (r.result) {
      this.observers.forEach(fn => fn(r, motor));
      if (r.result === 15) { this.heldJog = false; throw Error("到达行程限位"); }
      throw new CommandRejected(r);
    }
    if (command.kind === "pulse" || command.kind === "open") this.pulseAt = sentAt;
    if (command.kind === "permit" && command.enabled) this.permitAt = sentAt;
    if (command.kind === "jog_start" || command.kind === "velocity_start" || command.kind === "jog_renew") this.jogAt = sentAt;
    if (motor) this.task = r.task_id;
    if (detailed) this.log("ok", `${context} ${r.result_name}(${r.result}) ${Date.now()-sentAt}ms pending=${r.pending} drive=${r.motor?.drive ?? "-"} fault=${r.motor?.fault ?? "-"} error=${r.motor?.last_error ?? "-"}`);
    this.observers.forEach(fn => fn(r, motor));
    return r;
    } catch (error) { this.log(String(error).includes("到达行程限位")?"warn":"error", `${context} ${String(error)}`); if(!String(error).includes("到达行程限位"))this.errors.forEach(fn => fn(String(error))); throw error; }
  }
  async open(motor: number) {
    return this.queue(async () => {
      if (this.session) {
        if (this.motor !== motor) throw Error("请先关闭当前电机控制会话再切换电机");
        return;
      }
      this.boot = "0"; this.prepared=null;
      const d = await this.call(0, { kind: "get_state" });
      if (!d.device || d.device.capabilities !== 3) throw Error("主控不支持生产执行器");
      this.boot = d.boot_id; this.seq = Math.max(this.seq, d.device.request_floor);
      this.session = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      this.motor = motor; this.task = 0;
      try { await this.call(0, { kind: "open" }); }
      catch (e) { this.session = 0; this.boot = "0"; throw e; }
      this.timer = setInterval(() => void this.tick(), 200);
    });
  }
  private async tick() {
    if (!this.session || this.pulseBusy) return;
    this.pulseBusy = true;
    try {
      await this.queue(async () => {
        if (!this.session) return;
        // Do not silently resurrect expired leases after a long blocked call.
        if (Date.now() - this.pulseAt >= 1500) throw new SessionLost("控制会话续期超时，请重新确认运动授权");
        await this.call(0, { kind: "pulse" });
        if (this.permitWanted && Date.now() - this.permitAt >= 1200) {
          this.permitWanted = this.heldJog = false;
          await this.call(this.motor, { kind: "permit", enabled: false, lease_ms: 0 });
          this.errors.forEach(fn => fn("运动授权续期超时，已停止；请重新授权"));
        }
        if (this.permitWanted) await this.call(this.motor, { kind: "permit", enabled: true, lease_ms: 1500 });
        // Renew before optional telemetry; a failed read must not starve a held jog.
        if (this.heldJog) {
          if (Date.now() - this.jogAt >= 550) {
            ++this.jogGeneration; this.heldJog = false;
            await this.call(this.motor, { kind: "stop", after: 1 });
            this.errors.forEach(fn => fn("点动续期超时，已停止；请松开后重新按住"));
          } else {
            try { await this.call(this.motor, { kind: "jog_renew" }); }
            catch (e) {
              if (!(e instanceof CommandRejected)) throw e;
              this.heldJog = false; // Task ended/rejected: never retry START.
            }
          }
        }
        const state = await this.call(this.motor, { kind: "position_state" });
        if (state.motor?.fault || !state.motor?.permit) this.permitWanted = this.heldJog = false;
        if (this.heldJog && (state.task_id !== this.heldTask ||
            (state.motor?.motion_owner !== 3 && !state.pending))) this.heldJog = false;
      });
    } catch (error) {
      if (error instanceof SessionLost ||
          (error instanceof CommandRejected && error.reply.result === 7)) {
        ++this.motionEpoch; ++this.jogGeneration; this.heldJog = this.permitWanted = false;
        if (this.timer) clearInterval(this.timer); this.timer = null;
        this.session = 0; this.boot = "0"; this.motor = this.task = 0; this.prepared = null;
        this.errors.forEach(fn => fn(String(error)));
      } else if (error instanceof CommandRejected) {
        this.heldJog = this.permitWanted = false;
      }
      // One transport/read failure preserves the session. Only bounded lease
      // renewals are retried on the next tick; motion commands are never replayed.
    } finally { this.pulseBusy = false; }
  }
  async command(motor: number, cmd: MotorCommand) {
    const epoch=this.motionEpoch;
    if(["mode","limits","apply_configuration","commission","clear_fault"].includes(cmd.kind))this.prepared=null;
    await this.open(motor);
    if (["jog_start","velocity_start","logical_move","logical_work","move","work"].includes(cmd.kind)) {
      let state=await this.waitForStop(motor,epoch);
      if(epoch!==this.motionEpoch)throw Error("运动准备已取消");
      if(state.motor?.drive===0)await this.enable(motor);
    }
    return this.queue(() => {
      if(["jog_start","velocity_start","logical_move","logical_work","move","work"].includes(cmd.kind)&&epoch!==this.motionEpoch)
        throw Error("运动请求已被停止操作取消");
      return this.call(motor,cmd);
    });
  }
  async permit(motor: number, enabled: boolean) {
    this.permitWanted = false;
    if(enabled){const state=await this.command(motor,{kind:"get_state"});if(!state.motor?.config_verified)await this.initialize(motor);}
    const r = await this.command(motor, { kind: "permit", enabled, lease_ms: enabled ? 1500 : 0 });
    this.permitWanted = enabled && !!r.motor?.permit; return r;
  }
  async initialize(motor: number) {
    await this.command(motor, { kind: "commission", action: 1 });
    return this.wait(motor, 15000, r => !!r.motor?.config_verified && !!r.motor.limits_valid);
  }
  async clearFault(motor:number) {
    this.permitWanted=this.heldJog=false;
    await this.command(motor,{kind:"clear_fault"});
    const end=Date.now()+20000;
    for(;;) {
      await new Promise(resolve=>setTimeout(resolve,100));
      const r=await this.command(motor,{kind:"get_state"});
      // The old latch remains visible until the MCU completes OFF/readback.
      if(!r.pending&&r.motor?.drive!==1&&!r.motor?.pending_action) {
        if(r.motor?.fault||r.motor?.last_error)throw Error(`故障恢复失败 fault=${r.motor?.fault}, error=${r.motor?.last_error}`);
        this.report("ok",`M${motor} 故障已清除，PWM禁能；请重新确认运动授权`);return r;
      }
      if(Date.now()>=end)throw Error("故障恢复超时，未自动使能或重试");
    }
  }
  async wait(motor: number, timeout: number, accept: (r: SemanticReply) => boolean) {
    const end = Date.now() + timeout;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const r = await this.command(motor, { kind: "get_state" });
      if (r.motor?.fault || (r.motor?.last_error && r.motor.last_error!==15)) throw Error(`M${motor} 主控任务失败 fault=${r.motor.fault}, error=${r.motor.last_error}${r.motor.last_error===13 ? "（设备读写失败，请确认电机编号、连接和供电）" : ""}`);
      if (!r.pending && r.motor?.drive !== 1 && !r.motor?.pending_action && accept(r)) return r;
      if (Date.now() >= end) throw Error("主控任务等待超时；未自动重发，请读取当前状态");
    }
  }
  /** Pending action may be zero while firmware is measuring its stop window.
   * Query the device stopping flag; never replay a rejected motion command. */
  private async waitForStop(motor:number,epoch:number) {
    const end=Date.now()+10000;let announced=false;
    for(;;){
      if(epoch!==this.motionEpoch)throw Error("运动准备已取消");
      const device=await this.queue(()=>this.call(0,{kind:"get_state"}));
      if(!device.device)throw Error("主控停止状态未确认");
      if(!device.device.stopping){
        const state=await this.queue(()=>this.call(motor,{kind:"get_state"}));
        if(epoch!==this.motionEpoch)throw Error("运动准备已取消");
        return state;
      }
      if(!announced){this.report("info",`M${motor} 等待上一次停止/位置保持完成；尚未发送新运动`);announced=true;}
      if(Date.now()>=end)throw Error("主控停止/位置保持尚未完成，请检查当前状态；未发送新运动");
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  /** RTMI channel changes require gate OFF in the current firmware. Finish an
   * existing stop, then disable stationary holding without cutting logic power. */
  async configureRtmi(motor:number,cmd:MotorCommand){
    await this.open(motor);const epoch=this.motionEpoch;
    const state=await this.waitForStop(motor,epoch);
    if(state.motor?.motion_active)throw Error("电机正在运行，请先停止运行，再开始、停止或修改遥测采集");
    if(state.motor?.fault)throw Error(`M${motor} 当前故障=${state.motor.fault}，不能修改遥测配置`);
    if(state.motor?.drive===2){
      this.report("info",`M${motor} 遥测配置：先退出静止保持并禁能PWM，逻辑电源与标定/找零记录保持`);
      await this.command(motor,{kind:"stop",after:2});
    }
    // A completed previous task's last_error is not a failed NEW RTMI request.
    // If already idle, submit the new request (MCU validates and resets its
    // operation result). Only wait here for an actual transition in progress.
    if(state.motor?.drive!==0||state.pending||state.motor.pending_action)
      await this.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
    if(epoch!==this.motionEpoch)throw Error("遥测配置已取消");
    return this.command(motor,cmd);
  }
  async enable(motor: number) {
    await this.command(motor, { kind: "drive_enable" });
    return this.wait(motor, 15000, r => r.motor?.drive === 2);
  }
  private taskChain: Promise<unknown> = Promise.resolve();
  private prepared: { motor:number; mode:number; speed:number; boot:string } | null = null;
  private async prepareTask(motor:number, mode:number, speed:number, epoch:number) {
    if(!Number.isInteger(mode)||mode<0||mode>3||!Number.isInteger(speed)||speed<=0||speed>0x7ffffff)
      throw Error("运动模式或本次转速无效");
    await this.open(motor);
    let state=await this.waitForStop(motor,epoch);
    const old=this.prepared;
    if(old?.motor===motor&&old.mode===mode&&old.speed===speed&&old.boot===state.boot_id&&
       state.motor?.mode===mode&&state.motor.limits_valid&&state.motor.config_verified)return;
    if(state.motor?.motion_active)throw Error("请先停止当前运动，再修改模式或本次转速");
    if(state.motor?.drive!==0) {
      await this.command(motor,{kind:"stop",after:2});
      await this.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
    }
    await this.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active&&
      !!r.motor.feedback_fresh&&r.motor.pending_action===0);
    if(epoch!==this.motionEpoch)throw Error("运动准备已取消");
    // MCU stages mode + speed together, validates saved ceilings, and performs
    // checked RMW. This avoids transient failure against the old task speed.
    await this.command(motor,{kind:"task_speed",velocity_raw:speed,mode});
    state=await this.wait(motor,5000,r=>!!r.motor?.limits_valid&&r.motor.mode===mode);
    if(epoch!==this.motionEpoch)throw Error("运动准备已取消");
    this.prepared={motor,mode,speed,boot:state.boot_id};
  }
  async taskCommand(motor:number,mode:number,speed:number,cmd:MotorCommand) {
    const epoch=this.motionEpoch;
    const perform=async()=>{
      if(epoch!==this.motionEpoch)throw Error("运动请求已取消");
      await this.prepareTask(motor,mode,speed,epoch);
      if(epoch!==this.motionEpoch)throw Error("运动请求已取消");
      return this.command(motor,cmd);
    };
    const next=this.taskChain.then(perform,perform);this.taskChain=next.catch(()=>undefined);return next;
  }
  async jog(motor: number, velocity: number, mode: number) {
    const generation = ++this.jogGeneration;
    const r = await this.taskCommand(motor,mode,Math.abs(velocity),{ kind: "jog_start", velocity_raw: velocity, lease_ms: 700 });
    this.heldJog = generation === this.jogGeneration;
    this.heldTask = r.task_id; return r;
  }
  async velocity(motor:number,velocity:number,mode:number) {
    if(mode<2||mode>3)throw Error("速度任务需要速度模式");
    const generation=++this.jogGeneration;
    const r=await this.taskCommand(motor,mode,Math.abs(velocity),{kind:"velocity_start",velocity_raw:velocity,lease_ms:700});
    this.heldJog=generation===this.jogGeneration;
    this.heldTask=r.task_id;return r;
  }
  async stop(motor: number, disable = false) {
    ++this.motionEpoch; ++this.jogGeneration; this.heldJog = false;
    // A released hold cancels START immediately via motionEpoch. Let an
    // already accepted gate-OFF mode/configuration transaction finish before
    // sending STOP, so its UART read is not cancelled/quarantined mid-plan.
    // For an established motion task this chain is already settled.
    await this.taskChain;
    return this.command(motor, { kind: "stop", after: disable ? 2 : 1 });
  }
  async emergency(motor: number) {
    ++this.motionEpoch; ++this.jogGeneration; this.heldJog = this.permitWanted = false;
    return this.command(motor, { kind: "e_stop" });
  }
  async close() {
    ++this.motionEpoch; ++this.jogGeneration; this.heldJog = this.permitWanted = false;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    return this.queue(async () => {
      try { if (this.session) await this.call(0, { kind: "close" }); }
      finally { this.session = 0; this.boot = "0"; this.motor = 0; this.task = 0; }
    });
  }
}
export const semanticMotion = new SemanticMotion();
