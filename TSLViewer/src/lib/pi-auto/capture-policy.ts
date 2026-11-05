import type { Capture, Loop } from './model';
export const amplitudeText=(loop:Loop,raw:number)=>loop<2?`${(raw*.20131).toFixed(2)} mA`:loop===2?`${(raw/305.4198966044444).toFixed(2)} rpm`:`${(raw*360/65536).toFixed(2)}°`;
function limitMessage(loop:Loop,requested:number,limit:number):string {
  const axis=loop===0?'Id 磁链电流':loop===1?'Iq 转矩电流':'速度';
  const field=loop===0?'磁链电流限幅':loop===1?'转矩电流限幅':'转速限幅';
  return `${axis}激励${amplitudeText(loop,requested)}${limit===0?'无法启动：当前上限为0':'超过当前上限'+amplitudeText(loop,limit)}。请减小激励幅值，或到「机械找零 → 电机控制 → 长期约束 → ${field}」修改并点击「应用并回读」后重试；以TMC已生效值为准。不自动降低激励或修改限幅。`;
}
export function permittedAmplitude(loop:Loop,requested:number,currentLimits:number,velocityLimit:number):number {
  const limit=loop<2?(loop===0?currentLimits&32767:currentLimits>>>16&32767):loop===2?velocityLimit:requested;
  if(!limit||requested>limit)throw Error(limitMessage(loop,requested,limit));
  return requested;
}
export function validatePositionExcitation(amplitude:number,travel:number):void {
  if(amplitude>travel)throw Error(`位置环辨识未启动：激励±${amplitudeText(3,amplitude)}超过相对采集起点的最大偏移±${amplitudeText(3,travel)}。请减小激励幅值或按可用行程调整最大偏移。`);
}
export function captureFailure(c:Capture,amplitude:number,travel:number):string {
  if(c.error===3)return `位移保护停止：已采集${c.count}组，电机位置相对本次采集起点的偏移已超过±${(travel*360/65536).toFixed(2)}°（电机轴角度，不是丝杠直线距离）；实际激励${amplitudeText(c.loop,amplitude)}。这不是电流超限。请将滑块移至行程中段，并从更小的激励幅值开始重试；必要时缩短采集时长或按可用行程调整最大偏移`;
  if(c.error===6&&c.loop<2){const limit=c.loop===0?c.currentLimits&32767:c.currentLimits>>>16&32767;
    return !limit||amplitude>limit?limitMessage(c.loop,amplitude,limit):'激励在当前电流限幅内，主控仍拒绝启动；请检查PWM周期配置（不属于位置原点检查失败）';}
  if(c.error===6&&c.loop===2)return !c.velocityLimit||amplitude>c.velocityLimit?limitMessage(2,amplitude,c.velocityLimit):'激励在当前速度限幅内，主控仍拒绝启动；请检查PWM周期配置';
  if(c.error===6)return '位置PRBS启动条件不满足：请检查激励幅值、相对起点的最大偏移、临时位置偏置回读以及PWM周期配置；退出时恢复原坐标偏置';
  return ['成功','TMC读写失败','已取消或授权超时','','电流或芯片故障','RTMI数据缺失','','配置恢复未完成'][c.error]??`错误码${c.error}`;
}
