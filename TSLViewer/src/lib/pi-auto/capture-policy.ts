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
export function resolveCaptureTravel(requested:number,useHomed:boolean,state?:{coordinate_valid?:boolean;position?:string;negative_contact?:string;positive_contact?:string;margin_counts?:number|null}|null):number {
  if(!useHomed||!state?.coordinate_valid)return requested;
  const p=Number(state.position),lo=Number(state.negative_contact),hi=Number(state.positive_contact);
  if(![p,lo,hi].every(Number.isFinite)||hi<=lo)return requested;
  const room=Math.min(p-lo,hi-p)-Math.max(0,state.margin_counts??0);
  if(room<=0)throw Error('当前位置已在机械行程端部，请先移到中段再辨识；没有启动激励，不需要清故障');
  return Math.min(0x7fffffff,Math.max(1,Math.floor(room*.8)));
}
export function diagnosticText(c:Capture):string {
  const d=c.diagnostic;if(!d)return '旧固件未提供触发现场，不能凭此提示认定电机损坏';
  const bits:[[number,string],...[number,string][]]=[[0,'上电失败'],[3,'IO供电异常'],[4,'电荷泵'],[5,'VM欠压'],[6,'电源故障'],[7,'PLL时钟'],[8,'外部电阻'],[9,'ADC引擎故障'],[10,'温度限制'],[12,'短路'],[13,'过温关断'],[24,'芯片电流过载'],[25,'电流采样削顶（警告）'],[28,'VM过压'],[29,'温度预警']];
  const flags=bits.filter(([b])=>d.status&(2**b)).map(([,text])=>text);
  return `STATUS=0x${d.status.toString(16).toUpperCase()}（${flags.join('、')||'无所列电气故障'}），ADC=0x${d.adcStatus.toString(16).toUpperCase()}，触发Iq=${((d.packedCurrent>>16)*.20131).toFixed(1)}mA，峰值${amplitudeText(c.loop<2?c.loop:1,d.peakCurrent)}，偏移${(d.delta*360/65536).toFixed(1)}° / ±${(d.travel*360/65536).toFixed(1)}°，时间${d.elapsedMs}ms`;
}
export function captureFailure(c:Capture,amplitude:number,travel:number):string {
  if(c.error===3)return `到达本轮位移边界，已采集${c.count}组，已停止激励；这是采集停止，不是电流超限，也不是电机故障，也不需要清故障。实际激励${amplitudeText(c.loop,amplitude)}，相对本次采集起点的边界±${(travel*360/65536).toFixed(2)}°。可使用“按已找零行程”或调整自定义边界；电流环PRBS不带位置保持，存在累计漂移。${diagnosticText(c)}`;
  if(c.error===8)return `芯片电气状态停止：${diagnosticText(c)}`;
  if(c.error===4)return `旧固件的瞬时电流/混合状态判定中止：${diagnosticText(c)}；新版已取消基于PI限幅120%的单点判定，请更新固件`;
  if(c.error===6&&c.loop<2){const limit=c.loop===0?c.currentLimits&32767:c.currentLimits>>>16&32767;
    return !limit||amplitude>limit?limitMessage(c.loop,amplitude,limit):'激励在当前电流限幅内，主控仍拒绝启动；请检查PWM周期配置（不属于位置原点检查失败）';}
  if(c.error===6&&c.loop===2)return !c.velocityLimit||amplitude>c.velocityLimit?limitMessage(2,amplitude,c.velocityLimit):'激励在当前速度限幅内，主控仍拒绝启动；请检查PWM周期配置';
  if(c.error===6)return '位置PRBS启动条件不满足：请检查激励幅值、相对起点的最大偏移、临时位置偏置回读以及PWM周期配置；退出时恢复原坐标偏置';
  return ['成功','TMC读写失败','已取消或授权超时','','电流或芯片故障','RTMI数据缺失','','配置恢复未完成'][c.error]??`错误码${c.error}`;
}

/** Percentages of the full homed stroke; convert to a symmetric native PRBS boundary. */
export function percentCaptureTravel(range:readonly number[],state?:{coordinate_valid?:boolean;position?:string;negative_contact?:string;positive_contact?:string;margin_counts?:number|null}|null):number {
  if(range.length!==2||![[20,80],[30,70],[40,60]].some(v=>v[0]===range[0]&&v[1]===range[1]))throw Error('请选择有效的整定行程范围');
  if(!state?.coordinate_valid)throw Error('请先完成双端找零，再按行程百分比整定');
  const p=Number(state.position),lo=Number(state.negative_contact),hi=Number(state.positive_contact);
  if(![p,lo,hi].every(Number.isFinite)||hi<=lo)throw Error('找零行程尚未读取完整');
  const lower=lo+(hi-lo)*range[0]/100,upper=lo+(hi-lo)*range[1]/100;
  const room=Math.floor(Math.min(p-lower,upper-p)-Math.max(0,state.margin_counts??0));
  if(room<=0)throw Error(`当前位置不在 ${range[0]}%–${range[1]}% 的可用范围内，请先移至行程中点`);
  return Math.min(0x7fffffff,room);
}
