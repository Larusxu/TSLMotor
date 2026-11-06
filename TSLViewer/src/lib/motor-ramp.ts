import type { ControlConfig } from "./motor-control";
export interface RampConfig { acceleration_s:number; deceleration_s:number; tolerance_deg:number; delay_ms:number; velocity_ff:boolean }
export const DEFAULT_RAMP: RampConfig={acceleration_s:.1,deceleration_s:.1,tolerance_deg:.5,delay_ms:50,velocity_ff:false};
export const rampEnabled=(mode:ControlConfig["mode"])=>mode==="position_ramp"||mode==="velocity_ramp";
/** Datasheet pp94–96: velocity Ramp uses A_MAX for both directions of change. */
export function rampTask(task:ControlConfig,ramp:RampConfig):ControlConfig {
  if(!rampEnabled(task.mode))return task;
  const times=task.mode==="position_ramp"?[ramp.acceleration_s,ramp.deceleration_s]:[ramp.acceleration_s];
  if(times.some(t=>!Number.isFinite(t)||t<=0))throw Error("加减速时间必须大于 0 秒");
  const speed=task.max_rpm*6;
  return {...task,accel_deg_s2:speed/ramp.acceleration_s,decel_deg_s2:speed/(task.mode==="position_ramp"?ramp.deceleration_s:ramp.acceleration_s)};
}
export function rampSupplement(task:ControlConfig,ramp:RampConfig):number[] {
  if(!rampEnabled(task.mode))return [];
  if(!Number.isFinite(ramp.tolerance_deg)||ramp.tolerance_deg<0||!Number.isFinite(ramp.delay_ms)||ramp.delay_ms<0||ramp.delay_ms>2621.4)throw Error("位置容差或延时超出芯片范围");
  const values=[Math.round(ramp.tolerance_deg*65536/360),Math.round(ramp.delay_ms*25),task.mode==="position_ramp"&&ramp.velocity_ff?1:0];
  if(values[0]>0x7fffffff)throw Error("位置容差超出芯片范围");
  return values.flatMap(v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255]);
}
