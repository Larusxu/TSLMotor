import { storageJob, StorageError } from "./split-storage";
import { semanticMotion, CommandRejected } from "./semantic-motion";
import { composePidConfig, parsePidConfig } from "./units";
import type { ControlConfig } from "./motor-control";
import type { PidCfgPayload } from "./types";

export const COUNTS_PER_RPM = 1099511627776 / 3600000000;
export const MA_PER_RAW = .20131;
export function crc32(data: number[]) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
export const word = (p: number[], i: number) => new DataView(Uint8Array.from(p).buffer).getUint32(i, true);
export function putWord(p: number[], i: number, v: number) { for (let j = 0; j < 4; j++) p[i + j] = (v >>> (j * 8)) & 255; }
export function checkedProfile(p: number[], motor: number) {
  if (p.length !== 128 || String.fromCharCode(...p.slice(0, 4)) !== "MTR1" ||
      word(p, 4) !== 0x00800001 || (p[12] | p[13] << 8) > 16 ||
      (p[14] | p[15] << 8) !== motor || word(p, 120) !== crc32(p.slice(0, 120)) || word(p, 124) !== 0x31544d43)
    throw Error("电机档案版本、CRC 或编号不匹配");
  return p;
}
export function pidFromProfile(p: number[]): PidCfgPayload {
  const pair = (i: number) => [word(p, i) >>> 16, word(p, i) & 65535];
  const [flux_p, flux_i] = pair(32), [torque_p, torque_i] = pair(36);
  const [vel_p, vel_i] = pair(40), [pos_p, pos_i] = pair(44);
  return { ...parsePidConfig(word(p, 28)), flux_p, flux_i, torque_p, torque_i, vel_p, vel_i, pos_p, pos_i,
    torque_limit_ma: (word(p, 48) >>> 16) * MA_PER_RAW, flux_limit_ma: (word(p, 48) & 32767) * MA_PER_RAW,
    vel_limit_rpm: word(p, 52) / COUNTS_PER_RPM,
    velocity_mode_limit_rpm:word(p,68)===0x324e5552?word(p,60)/COUNTS_PER_RPM:28730, uq_ud_limit: word(p, 56),
    ma_per_count: MA_PER_RAW, counts_per_rpm: COUNTS_PER_RPM };
}
export function profileWithPid(base: number[], cfg: PidCfgPayload, motor: number) {
  const p = [...checkedProfile(base, motor)];
  const gains = [cfg.flux_p, cfg.flux_i, cfg.torque_p, cfg.torque_i, cfg.vel_p, cfg.vel_i, cfg.pos_p, cfg.pos_i];
  if (gains.some(x => !Number.isInteger(x) || x < 0 || x > 32767) ||
      ![cfg.torque_limit_ma, cfg.flux_limit_ma, cfg.vel_limit_rpm, cfg.uq_ud_limit].every(Number.isFinite) ||
      cfg.torque_limit_ma <= 0 || cfg.torque_limit_ma > 1050 || cfg.flux_limit_ma < 0 || cfg.flux_limit_ma > 1050 ||
      cfg.vel_limit_rpm <= 0 || cfg.vel_limit_rpm > 28730 || cfg.uq_ud_limit <= 0 || cfg.uq_ud_limit > 65535)
    throw Error("PI 或驱动器限幅超出档案范围");
  const mask = 0x007fffff;
  putWord(p, 28, (word(p, 28) & ~mask) | (composePidConfig(cfg) & mask));
  for (let j = 0; j < 4; j++) putWord(p, 32 + 4 * j, gains[j * 2] * 65536 + gains[j * 2 + 1]);
  putWord(p, 48, Math.floor(cfg.torque_limit_ma / MA_PER_RAW + 1e-9) * 65536 + Math.floor(cfg.flux_limit_ma / MA_PER_RAW + 1e-9));
  putWord(p, 52, Math.floor(cfg.vel_limit_rpm * COUNTS_PER_RPM)); putWord(p, 56, cfg.uq_ud_limit);
  p[16] |= 2; putWord(p, 120, crc32(p.slice(0, 120))); return p;
}
export async function readMotorProfile(motor: number) {
  const r = await storageJob(motor, 1); checkedProfile(r.data, motor); return r;
}
export const RUN_TAG = 0x314e5552;
export const RUN2_TAG = 0x324e5552;
export const accelerationRaw = (v: number) => Math.max(1, Math.round(v * 65536 / 360 * 131072 * 16777216 / 60000000 ** 2));
const accelerationUnits = (v: number) => v * 360 / 65536 / 131072 / 16777216 * 60000000 ** 2;
export function runFromProfile(p: number[], fallback: ControlConfig): ControlConfig {
  const pid = pidFromProfile(p);
  const base = { ...fallback, mode: "position_ramp" as const, planning:"limits" as const, max_rpm: pid.vel_limit_rpm, limit_ma: pid.torque_limit_ma };
  if (!word(p,68)) return base;
  if (word(p,68)!==RUN_TAG&&word(p,68)!==RUN2_TAG) throw Error("不支持的运行配置版本");
  return { ...base, max_rpm:word(p,68)===RUN2_TAG?word(p,112)/COUNTS_PER_RPM:pid.vel_limit_rpm,
    accel_deg_s2: accelerationUnits(word(p,72)), decel_deg_s2: accelerationUnits(word(p,76)),
    trip_ma: word(p,80)*MA_PER_RAW, over_ms: word(p,84), sample_ms: word(p,88), comm_timeout_ms: word(p,92),
    mode: (["position_direct","position_ramp","velocity_direct","velocity_ramp"] as const)[word(p,104)],
    fault_action: word(p,108)===1?"controlled_stop":"disable" };
}
export function profileWithRun(base: number[], pid: PidCfgPayload, cfg: ControlConfig, motor: number) {
  const p=profileWithPid(base,pid,motor);
  if (cfg.planning!=="limits" || ![cfg.accel_deg_s2,cfg.decel_deg_s2,cfg.trip_ma,cfg.over_ms,cfg.sample_ms,cfg.comm_timeout_ms].every(Number.isFinite) ||
      cfg.accel_deg_s2<1||accelerationRaw(cfg.accel_deg_s2)>0x7fffff||cfg.decel_deg_s2<1||accelerationRaw(cfg.decel_deg_s2)>0x7fffff||
      cfg.trip_ma<=0||cfg.trip_ma>1050||cfg.sample_ms<20||cfg.sample_ms>1000||cfg.over_ms<cfg.sample_ms||cfg.over_ms>10000||
      cfg.comm_timeout_ms<2*cfg.sample_ms||cfg.comm_timeout_ms>5000) throw Error("运行参数约束冲突");
  const mode=["position_direct","position_ramp","velocity_direct","velocity_ramp"].indexOf(cfg.mode);
  if(mode<0)throw Error("不支持的运动模式");
  // A single current/speed ceiling lives at 0x14A/0x14B. No task ceiling record.
  const run=[RUN_TAG,accelerationRaw(cfg.accel_deg_s2),accelerationRaw(cfg.decel_deg_s2),Math.floor(cfg.trip_ma/MA_PER_RAW),
    cfg.over_ms,cfg.sample_ms,cfg.comm_timeout_ms,Math.max(5000,cfg.comm_timeout_ms),65536,mode,
    cfg.fault_action==="disable"?2:1,0,256];
  run.forEach((v,i)=>putWord(p,68+4*i,v));putWord(p,120,crc32(p.slice(0,120)));return p;
}
export function validateCommonLimits(common:number[],expected:number[]) {
  const maxMa=word(common,32),run2=word(expected,68)===RUN2_TAG;
  if(!maxMa)throw Error("公共电流上限无效");
  if((word(expected,48)>>>16)*MA_PER_RAW>maxMa)throw Error(`超过公共电流上限 ${maxMa} mA`);
  const maximum=run2?28730:word(common,36);
  if(!maximum||word(expected,52)/COUNTS_PER_RPM>maximum)throw Error(`速度超过允许范围 ${maximum} rpm`);
  if(run2&&(word(expected,60)/COUNTS_PER_RPM>28730||word(expected,112)>word(expected,60)||word(expected,52)>word(expected,60)))
    throw Error("本次任务转速超过已保存的长期转速限幅；输入保持不变");
}
/** One explicit W25 + chip workflow; failure is never reported as a transaction rollback. */
async function applyConfiguration(motor:number,build:(before:number[])=>number[],preservePi=false,ramp:number[]=[]) {
  let stage="检查主控状态";
  const trace=(message:string)=>{stage=message;semanticMotion.report("info",`M${motor} 配置阶段：${stage}`);};
  try {
  trace(stage);
  const state=await semanticMotion.command(motor,{kind:"get_state"});
  if(state.motor?.fault)throw Error("请先处理故障");
  trace("读取 W25 原档案并生成写入计划");
  const before=await readMotorProfile(motor), expected=build(before.data);
  let online=word(expected,104)===state.motor?.mode &&
    (word(expected,28)&0x7fffff)===(word(before.data,28)&0x7fffff);
  if(!online && state.motor && (state.motor.drive!==0||state.motor.motion_active)) {
    trace("切模或基础参数变更：受控停止并临时禁能 PWM");
    await semanticMotion.stop(motor,true);
    await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
  }
  trace(online?"在线更新：保留任务、PWM、授权和积分器":"停止后配置：保留逻辑供电和授权");
  trace("校验公共上限与模式约束");
  const common=await storageJob(0,1);
  if(common.data.length!==128||word(common.data,120)!==crc32(common.data.slice(0,120)))throw Error("公共配置CRC错误");
  validateCommonLimits(common.data,expected);
  const payload=[...before.data.slice(120,124),...expected.slice(28,64),...expected.slice(68,120)];
  if(preservePi)payload.push(1);
  if(ramp.length){if(!preservePi||ramp.length!==12)throw Error("Ramp 配置负载无效");payload.push(...ramp);}
  const archived=[...expected];
  if(preservePi){archived.splice(28,20,...before.data.slice(28,48));putWord(archived,120,crc32(archived.slice(0,120)));}
  trace("请求主控写入 TMC、回读并保存 W25");
  try {
    await semanticMotion.command(motor,{kind:"apply_configuration",payload});
  } catch(error) {
    // BUSY is an explicit rejection before the worker accepts this plan.
    // The archive cannot establish whether volatile PID settings match the
    // live controller. Finish the stopped configuration path once; never
    // replay an accepted/timeout request or a motion command.
    if(!(error instanceof CommandRejected)||error.reply.result!==1)throw error;
    trace("主控尚未接收配置：核对任务状态与临时 PI，完成停止后配置");
    const device=await semanticMotion.deviceState();
    if(device.device?.active_motor&&device.device.active_motor!==motor)throw error;
    const current=await semanticMotion.command(motor,{kind:"get_state"});
    if(current.motor?.fault)throw error;
    if(current.pending||current.motor?.pending_action)
      await semanticMotion.wait(motor,30000,r=>!r.pending&&!r.motor?.pending_action);
    await semanticMotion.stop(motor,true);
    await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
    const fresh=await readMotorProfile(motor);
    if(fresh.data.some((v,i)=>v!==before.data[i]))throw Error("档案已被其他配置操作更新，请读取后再应用；本次尚未写入");
    online=false;
    trace("停止已完成：重新提交未被接收的配置，保持运动授权");
    await semanticMotion.command(motor,{kind:"apply_configuration",payload});
  }
  await semanticMotion.wait(motor,30000,r=>!!r.motor?.config_verified&&!!r.motor.limits_valid&&!r.pending&&!r.motor.pending_action);
  trace("独立读取 W25 校验保存结果");
  const after=await readMotorProfile(motor);
  if(after.data.slice(12,120).some((v,i)=>v!==archived[i+12]))throw Error("W25 独立读回不一致；未使能");
  trace("核对 TMC 模式与有效限幅");
  const actual=await semanticMotion.command(motor,{kind:"get_state"});
  if(!actual.motor?.limits_valid||(!online&&actual.motor.drive!==0)||actual.motor.effective_iq_raw!==(word(after.data,48)>>>16)||
      actual.motor.effective_velocity_raw!==modeVelocityRaw(after.data)||actual.motor.mode!==(word(after.data,68)?word(after.data,104):1))throw Error("W25 已保存，TMC 状态读回不一致；禁止使能");
  semanticMotion.report("ok",`M${motor} 配置完成：TMC/W25 一致，编辑输入保持不变`);
  return after;
  } catch(error) {
    // A host validation/storage error must not revoke authorization. The MCU
    // owns PWM shutdown for an actual partial TMC write or electrical fault.
    // Keep the exact failed stage visible without inventing another fault.
    semanticMotion.report("error",`M${motor} 配置失败阶段=${stage}：${String(error)}`);throw error;
  }
}

export function applyMotorConfiguration(motor:number,pid:PidCfgPayload,cfg:ControlConfig,ramp:number[]=[]) {
  return applyConfiguration(motor,base=>profileWithControlOnly(base,pid,cfg,motor),true,ramp);
}
export function applyMotorLongTermConstraints(motor:number,pid:PidCfgPayload) {
  return applyConfiguration(motor,base=>profileWithPiOnly(profileWithLongTermOnly(base,pid,motor),pid,motor),true);
}
/** PI page owns coefficients/normalization only. Unapplied control-card edits
 * must never leak into a PI commit; preserve saved limits and RUN1 verbatim. */
export function profileWithPiOnly(base:number[],edit:PidCfgPayload,motor:number) {
  const saved=pidFromProfile(base);
  return profileWithPid(base,{...edit,torque_limit_ma:saved.torque_limit_ma,flux_limit_ma:saved.flux_limit_ma,
    vel_limit_rpm:saved.vel_limit_rpm,uq_ud_limit:saved.uq_ud_limit},motor);
}
export function applyMotorPi(motor:number,pid:PidCfgPayload) {
  return applyConfiguration(motor,base=>profileWithPiOnly(base,pid,motor));
}
/** Volatile coefficients only. Normalization must match the verified working
 * configuration; firmware performs serialized write/readback, no integrator reset. */
export async function tuneMotorPi(motor:number,group:0|1|2,pid:PidCfgPayload) {
  const pairs=[[pid.flux_p,pid.flux_i],[pid.torque_p,pid.torque_i],[pid.vel_p,pid.vel_i],[pid.pos_p,pid.pos_i]];
  if(pairs.flat().some(v=>!Number.isInteger(v)||v<0||v>32767))throw Error("PI 系数范围为 0～32767");
  try {
    await semanticMotion.command(motor,{kind:"pi_tune",group,expected_config:composePidConfig(pid),
      coefficients:pairs.map(([p,i])=>p*65536+i)});
  } catch(error) {
    if(error instanceof CommandRejected&&error.reply.result===10)
      throw Error("本次 PI 未写入：页面归一化、速度右移或位置采样与 TMC 不同。请先应用基础配置，再临时写入系数；不是写入成功。");
    throw error;
  }
  await semanticMotion.wait(motor,5000,r=>!!r.motor?.config_verified&&!r.pending);
  const labels=["Id","Iq","速度","位置"];
  const indices=group===0?[0,1]:[group+1];
  const message=`M${motor} 临时 PI 已写入 TMC 并由主控逐项回读：${indices.map(i=>`${labels[i]} P=${pairs[i][0]} I=${pairs[i][1]}`).join("；")}；W25 未写入`;
  semanticMotion.report("ok",message);
  return message;
}

/** Apply current PI-page coefficients with the motion plan; retain the saved
 * right-hand limits rather than importing its unapplied edits. */
export function profileWithControlOnly(base:number[],edit:PidCfgPayload,cfg:ControlConfig,motor:number) {
  if(word(base,68)!==RUN2_TAG&&(word(base,60)!==0||word(base,112)!==0))throw Error("旧档案含非零扩展字段，不能无损迁移 RUN2");
  const pi=profileWithPiOnly(base,edit,motor);
  const built=profileWithRun(pi,pidFromProfile(pi),cfg,motor);
  if(!Number.isFinite(cfg.max_rpm)||cfg.max_rpm<=0||cfg.max_rpm>28730)throw Error("本次转速范围为 0～28730 rpm（不含0）");
  const task=Math.floor(cfg.max_rpm*COUNTS_PER_RPM);
  const speedCeiling=word(base,68)===RUN2_TAG?word(base,60):Math.floor(28730*COUNTS_PER_RPM);
  if(task>speedCeiling)throw Error(`本次任务 ${cfg.max_rpm} rpm 超过已保存的长期转速限幅 ${(speedCeiling/COUNTS_PER_RPM).toFixed(2)} rpm；请先应用长期约束，输入保持不变`);
  const next=[...checkedProfile(base,motor)];
  next.splice(28,20,...built.slice(28,48));
  next.splice(68,52,...built.slice(68,120));
  putWord(next,68,RUN2_TAG);putWord(next,60,speedCeiling);putWord(next,112,task);
  // 0x14B is the working loop limit, not another persisted safety ceiling.
  putWord(next,52,cfg.mode==="position_direct"?task:speedCeiling);
  putWord(next,120,crc32(next.slice(0,120)));return next;
}
/** Right section owns current/voltage and the unified long-term speed ceiling.
 * Recompute the working 0x14B; preserve task, mode, Ramp, PI and calibration. */
export function profileWithLongTermOnly(base:number[],edit:PidCfgPayload,motor:number) {
  const saved=pidFromProfile(base);
  const built=profileWithPid(base,{...saved,...longTermConstraints(edit)},motor);
  const next=[...checkedProfile(base,motor)];
  next.splice(48,4,...built.slice(48,52));next.splice(56,4,...built.slice(56,60));
  const ceiling=edit.velocity_mode_limit_rpm??saved.velocity_mode_limit_rpm??28730;
  if(!Number.isFinite(ceiling)||ceiling<=0||ceiling>28730)throw Error("速度模式上限范围为 1～28730 rpm");
  // Upgrade only on an explicit save, using the existing position ceiling and
  // task profile. No arbitrary position-mode default is introduced.
  if(word(next,68)!==RUN2_TAG) {
    if(!word(next,68))throw Error("请先应用一次运动与保护参数，再保存模式级约束");
    if(word(next,60)!==0||word(next,112)!==0)throw Error("旧档案使用非零 V_START，请先确认迁移策略");
    putWord(next,112,word(next,52));putWord(next,68,RUN2_TAG);
  }
  putWord(next,60,Math.floor(ceiling*COUNTS_PER_RPM));
  if(word(next,112)>word(next,60))throw Error("长期上限小于已保存的本次转速，请先降低本次转速");
  putWord(next,52,word(next,104)===0?word(next,112):word(next,60));
  putWord(next,120,crc32(next.slice(0,120)));return next;
}
export function longTermConstraints(pid:PidCfgPayload) {
  return {torque_limit_ma:pid.torque_limit_ma,flux_limit_ma:pid.flux_limit_ma,uq_ud_limit:pid.uq_ud_limit};
}
/** Explicit left-side read updates only left-side inputs; limit_ma is a
 * legacy alias owned by the right-side Iq draft and must survive this read. */
export function motionFromProfile(p:number[],fallback:ControlConfig):ControlConfig {
  return {...runFromProfile(p,fallback),limit_ma:fallback.limit_ma};
}
export function modeVelocityRaw(p:number[]) {
  return word(p,68)===RUN2_TAG&&word(p,104)>=2?word(p,60):word(p,52);
}

/** Optional extension, independent of the deployed 128-byte MTR1 record. */
export async function readMotorRamp(motor:number,fallback:import("./motor-ramp").RampConfig) {
 let data:number[];
 try {data=(await storageJob(motor,9)).data;}catch(e){if(e instanceof StorageError&&e.result===-4)return fallback;throw e;}
 if(data.length!==128||String.fromCharCode(...data.slice(0,4))!=="MEX1"||word(data,120)!==crc32(data.slice(0,120)))throw Error("电机扩展档案 CRC 或版本不匹配");
 return {...fallback,acceleration_s:word(data,44)/1000||fallback.acceleration_s,deceleration_s:word(data,48)/1000||fallback.deceleration_s,
 ...(word(data,64)?{tolerance_deg:word(data,52)*360/65536,delay_ms:word(data,56)/25,velocity_ff:!!word(data,60)}:{})};
}
