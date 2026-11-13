import type { SemanticMotion } from "./semantic-motion";
import type { HomingState } from "./types";
import { jogTargets } from "./multi-open-loop-jog";

export const defaultHomePartner = (motor: number) => motor === 15 ? "16" : motor === 16 ? "15" : "";
export const homeTargets = jogTargets;
export type LinkedHomeView = {
  busy: boolean;
  motors: number[];
  states: Record<number, HomingState>;
  note: string;
};

/** UART commands are queued; accepted homing tasks execute independently on
 * the MCU. Keep group observation alive across navigation, without changing
 * either motor's existing contact-current homing algorithm. */
export class LinkedHoming {
  private view: LinkedHomeView = { busy: false, motors: [], states: {}, note: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private attempted: number[] = [];
  constructor(
    private motion: Pick<SemanticMotion, "command" | "initialize" | "enable" | "stop" | "wait">,
    private read: (motor: number) => Promise<HomingState>,
    private delay = () => new Promise<void>(resolve => setTimeout(resolve, 200)),
  ) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<LinkedHomeView>) {
    this.view = { ...this.view, ...change };
    this.listeners.forEach(listener => listener());
  }
  private async stopAttempted() {
    const results = await Promise.allSettled(this.attempted.map(motor => this.motion.stop(motor, true)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  async start(motors: number[], direction: number, timeoutMs = 615000, options: {complex?:boolean;returnMiddle?:boolean} = {}) {
    if (this.view.busy) throw Error("联动找零正在进行");
    if (!motors.length || motors.some(m => !Number.isInteger(m) || m < 1 || m > 16)) throw Error("请选择 1–16 的电机编号");
    motors = [...new Set(motors)];
    if(options.complex&&motors.length!==2)throw Error("复杂工况需要两路联动电机");
    if(options.returnMiddle&&direction!==0&&direction!==2)throw Error("回到行程中点需要双端找零");
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.attempted = [];
    this.update({ busy: true, motors, states: {}, note: "正在准备联动找零" });
    try {
      // Prepare every lane before starting the first lane.
      for (const motor of motors) {
        let r = await this.motion.command(motor, {kind:"get_state"});
        if (!current()) return;
        if (r.motor?.motion_active || r.motor?.drive === 2) {
          await this.motion.stop(motor, true);
          await this.motion.wait(motor, 10000, r => r.motor?.drive === 0 && !r.motor.motion_active);
        }
        if (!current()) return;
        if (!r.motor?.config_verified) await this.motion.initialize(motor);
        if (!current()) return;
        r = await this.motion.command(motor, {kind:"get_state"});
        if (!r.motor?.align_valid || r.motor.fault) throw Error(`M${motor} 未完成标定或存在故障`);
        if (!current()) return;
      }
      for (const motor of motors) {
        if (!current()) return;
        this.attempted.push(motor); // A lost reply can still mean START was accepted.
        const mask=motors.reduce((mask,m)=>mask|(1<<(m-1)),0);
        await this.motion.command(motor, {kind:"homing_linked",direction:direction===2?2:direction === 1 ? 0 : 1,step_unit:100,dual:direction === 0||direction===2,motor_mask:mask,complex:!!options.complex}, current);
      }
      this.update({note:"联动找零进行中"});
      const deadline = Date.now() + timeoutMs;
      while (current()) {
        await this.delay();
        for (const motor of motors) {
          if (!current()) return;
          if (this.view.states[motor]?.stage === 2) continue;
          const reply = await this.motion.command(motor, {kind:"get_state"});
          if (!current()) return;
          if (reply.motor?.fault || reply.motor?.last_error) {
            throw Error(`M${motor} 找零任务失败 fault=${reply.motor.fault}, error=${reply.motor.last_error}`);
          }
          const state = await this.read(motor);
          if (!current()) return;
          this.update({states:{...this.view.states,[motor]:state}});
          if (state.stage === 3) throw Error(`M${motor} 找零失败：${state.message || state.error}`);
        }
        if (motors.every(m => this.view.states[m]?.stage === 2)) {
          this.update({note:"正在恢复运行配置"});
          for (const motor of motors) {
            await this.motion.wait(motor, 15000, r => !r.motor?.motion_active);
            if (!current()) return;
          }
          if(options.returnMiddle) {
            this.update({note:"使用正常运动模式返回行程中点"});
            const targets = new Map<number,string>();
            for(const motor of motors) {
              if(!current())return;
              const r=await this.motion.command(motor,{kind:"get_state"});
              if(!r.motor?.span_valid||!r.motor.logical_span)throw Error(`M${motor} 未建立有效行程`);
              if(!current())return;
              targets.set(motor,(BigInt(r.motor.logical_span)/2n).toString());
              if(r.motor.drive===0)await this.motion.enable(motor);
            }
            // Prepare every gate before the first ordinary position move.
            for(const [motor,position] of targets) {
              if(!current())return;
              await this.motion.command(motor,{kind:"logical_move",position},current);
            }
            const pending=new Set(motors),end=Date.now()+120000;
            while(current()&&pending.size) {
              await this.delay();
              for(const motor of pending) {
                if(!current())return;
                const r=await this.motion.command(motor,{kind:"position_state"});
                if(r.motor?.fault||r.motor?.last_error)throw Error(`M${motor} 回中失败 fault=${r.motor.fault}, error=${r.motor.last_error}`);
                if(!r.pending&&r.motor?.arrival_phase===4&&!r.motor.motion_active)pending.delete(motor);
              }
              if(Date.now()>end)throw Error("返回行程中点超时");
            }
            if(!current())return;
          }
          this.update({note:options.returnMiddle?"找零完成，已回到行程中点":"找零完成"});
          return;
        }
        if (Date.now() > deadline) throw Error("联动找零等待超时");
      }
    } catch (error) {
      if (!current()) return;
      this.update({note:String(error)});
      try { await this.stopAttempted(); }
      catch (stopError) { this.update({note:`${String(error)}；停止失败：${String(stopError)}`}); }
      throw error;
    } finally {
      if (current()) this.update({busy:false});
    }
  }
  async stop() {
    ++this.generation;
    // START uses the same transport queue, so STOP follows any in-flight START.
    try { await this.stopAttempted(); this.update({note:"联动找零已取消"}); }
    catch (error) { this.update({note:`停止失败：${String(error)}`}); throw error; }
    finally { this.update({busy:false}); }
  }
}
