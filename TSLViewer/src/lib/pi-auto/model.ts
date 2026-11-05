/** Pure numeric module. Native register units throughout; no transport/UI IO. */
import { evaluateResponse, validateCaptureTiming } from './response';
export type Loop = 0|1|2|3;
/** One current-group command carries both axes; preserve the other axis only
 * when sharing is off. SPI/UART writes remain sequential on the device. */
export function trialCoefficients(original:number[],loop:Loop,p:number,i:number,shared:boolean):number[] {
  const next=[...original],word=p*65536+i;
  if(loop<2&&shared){next[0]=word;next[1]=word;}else next[loop]=word;
  return next;
}
export interface Sample { at:number; reference:number; actual:number; effort:number }
export interface Capture {
  appliedAmplitude?:number; attempts?:number;
  state:number; motor:number; loop:Loop; generation:number; count:number; error:number;
  sampleHz:number; pidConfig:number; pwmHz:number; velocityHz:number; coefficient:number;
  velocityLimit:number; currentLimits:number; events:number; cursor:number; samples:Sample[]; coefficients:number[];
}
export function decodeCapture(bytes:number[]):Capture {
  if(bytes.length<64||bytes.length>100||(bytes.length-64)%16||bytes[0]!==1||bytes[1]>3||bytes[2]>16||bytes[3]>3)
    throw Error("辨识数据格式不匹配");
  const d=new DataView(Uint8Array.from(bytes).buffer),u=(i:number)=>d.getUint32(i,true);
  if(u(8)>22528||u(48)>u(8))throw Error("辨识数据游标错误");
  const coefficients:number[]=[];for(let i=0,j=0;i<4;i++)coefficients[i]=i===bytes[3]?u(32):u(52+4*j++);
  return {coefficients,state:bytes[1],motor:bytes[2],loop:bytes[3] as Loop,generation:u(4),count:u(8),error:u(12),
    sampleHz:u(16)/1000,pidConfig:u(20),pwmHz:u(24),velocityHz:u(28),coefficient:u(32),
    velocityLimit:u(36),currentLimits:u(40),events:u(44),cursor:u(48),
    samples:Array.from({length:(bytes.length-64)/16},(_,i)=>({at:u(64+16*i),reference:d.getInt32(68+16*i,true),actual:d.getInt32(72+16*i,true),effort:d.getInt32(76+16*i,true)}))};
}
export interface Model { a:number; b:number; fit:number; validationFit:number; tauSeconds:number|null; dcGain:number|null }
export interface Candidate { p:number; i:number; kp:number; kiPerSecond:number; bandwidthHz:number; method?:'plant'|'frequency'|'measured-search'; model:Model; warnings:string[] }
const average=(a:number[])=>a.reduce((x,y)=>x+y,0)/a.length;
/** Instrumental-variable ARX(1,1). Reference PRBS instruments separate the
 * actuator/feedback correlation from additive measurement noise. Model is
 * y[k]=a*y[k-1]+b*u[k-1]; effort is the measured limited inner-loop target. */
export function identify(c:Capture):Model {
  if(c.state!==2||c.error||c.samples.length!==c.count||c.count<96||!Number.isFinite(c.sampleHz)||c.sampleHz<=0)
    throw Error("需要完整且无丢帧的辨识记录（至少96组）");
  if(c.events&0x08)throw Error("RTMI 中断事件置位，请降低采样负载后重新采集");
  validateCaptureTiming(c);
  const s=c.samples.slice(24);
  // Fit only the first half. Validate on unseen samples by free simulation:
  // using measured y[k-1] at every step hides a wrong plant behind feedback.
  const train=s.slice(0,Math.floor(s.length/2)),validation=s.slice(train.length);
  const out=train.slice(2),prev=train.slice(1,-1),lag=train.slice(0,-2);
  const meanZ=average(prev.map(v=>v.reference)),meanW=average(lag.map(v=>v.reference));
  const meanY=average(out.map(v=>v.actual)),meanPrev=average(prev.map(v=>v.actual)),meanU=average(prev.map(v=>v.effort));
  let aa=0,ab=0,ba=0,bb=0,ay=0,by=0,energy=0;
  for(let k=2;k<train.length;k++){
    const z=train[k-1].reference-meanZ,w=train[k-2].reference-meanW,y=train[k].actual-meanY,prev=train[k-1].actual-meanPrev,u=train[k-1].effort-meanU;
    aa+=z*prev;ab+=z*u;ba+=w*prev;bb+=w*u;ay+=z*y;by+=w*y;energy+=y*y;
  }
  const det=aa*bb-ab*ba,scale=Math.abs(aa*bb)+Math.abs(ab*ba);
  if(!energy||!scale||Math.abs(det)<scale*1e-5)throw Error("激励或响应不足，无法分辨对象动态；请检查信号及采样带宽");
  const a=(ay*bb-ab*by)/det,b=(aa*by-ay*ba)/det;
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<=0||a>1.01||b<=0)throw Error(`一阶对象模型不适用（a=${a.toFixed(4)}, b=${b.toPrecision(4)}），不生成PI`);
  let residual=0;for(let k=2;k<train.length;k++)residual+=(train[k].actual-meanY-a*(train[k-1].actual-meanPrev)-b*(train[k-1].effort-meanU))**2;
  const fit=1-residual/energy;
  if(fit<.65)throw Error(`模型拟合不足（${(fit*100).toFixed(1)}%），需要更合适的采样或模型`);
  let prediction=validation[0].actual,error=0,power=0;
  const offset=meanY-a*meanPrev-b*meanU,center=average(validation.map(v=>v.actual));
  for(let k=1;k<validation.length;k++){
    prediction=a*prediction+b*validation[k-1].effort+offset;
    error+=(validation[k].actual-prediction)**2;power+=(validation[k].actual-center)**2;
  }
  const validationFit=power>0?1-error/power:-Infinity;
  if(!Number.isFinite(validationFit)||validationFit<.65)throw Error(`独立自由响应验证不足（${(validationFit*100).toFixed(1)}%），不生成PI；单步拟合不能代替模型验证`);
  return {a,b,fit,validationFit,tauSeconds:a<1?-1/(c.sampleHz*Math.log(a)):null,dcGain:a<1?b/(1-a):null};
}
export function encodeGains(kp:number,kiPerSecond:number,controllerHz:number,config:number,loop:Loop) {
  const current=loop<2;
  const pf=current?((config>>>2)&1)*8:((config>>>(loop===2?4:8))&3)*8;
  const inf=current?((config>>>3)&1)*8:8+((config>>>(loop===2?6:10))&3)*8;
  const shift=loop===2?((config>>>12)&15):0;
  if(![kp,kiPerSecond,controllerHz].every(Number.isFinite)||kp<=0||kiPerSecond<0||controllerHz<=0)throw Error("PI换算输入无效");
  const p=Math.round(kp*2**(pf+shift)),i=Math.round(kiPerSecond/controllerHz*2**(inf+shift));
  if(p<1||p>32767||i<0||i>32767)throw Error("当前归一化无法表示候选PI；请调整带宽或在PID页配置归一化后重新辨识");
  return {p,i};
}
/** Double real closed-loop pole design, with the measured sample delay.
 * The computed integral increment is converted to the actual TMC loop period. */
export function calculate(c:Capture,bandwidthHz:number):Candidate {
  if(!Number.isFinite(bandwidthHz)||bandwidthHz<=0||bandwidthHz>c.sampleHz/10)
    throw Error(`目标带宽应大于0且不超过本次采样率的1/10（${(c.sampleHz/10).toFixed(2)} Hz）`);
  const model=identify(c);
  if(c.loop<2&&model.a<Math.exp(-.5))throw Error("电流对象时间常数不足两个采样周期，当前链路无法可靠整定该电流环");
  const pole=Math.exp(-2*Math.PI*bandwidthHz/c.sampleHz);
  const kp=(model.a-pole*pole)/model.b,kiPerSecond=(1-pole)**2/model.b*c.sampleHz;
  const controllerHz=c.loop<2?c.pwmHz:c.loop===2?c.velocityHz:c.velocityHz/(((c.pidConfig>>>16)&127)+1);
  const encoded=encodeGains(kp,kiPerSecond,controllerHz,c.pidConfig,c.loop);
  return {...encoded,kp,kiPerSecond,bandwidthHz,model,warnings:["一阶小信号候选；需实测验证后保存",...(model.a>=1?["对象接近积分环节"]:[])]};
}
/** Bounded experimental step when a closed-loop response is identifiable but
 * the low-rate data cannot identify an open-loop plant. Not pole placement. */
export function velocityTrial(c:Capture):Candidate {
  const response=evaluateResponse(c),oldP=c.coefficient>>>16,i=c.coefficient&65535;
  const p=Math.round(oldP*1.1);
  if(oldP<1||i<1||p>32767||p===oldP)throw Error('当前速度PI不能生成小步候选');
  const pf=((c.pidConfig>>>4)&3)*8,inf=8+((c.pidConfig>>>6)&3)*8,shift=(c.pidConfig>>>12)&15;
  return {p,i,kp:p/2**(pf+shift),kiPerSecond:i*c.velocityHz/2**(inf+shift),bandwidthHz:0,
    model:{a:response.coefficients[0],b:response.coefficients[2],fit:response.validationFit,validationFit:response.validationFit,tauSeconds:null,dcGain:null},
    warnings:['闭环PRBS验证通过；P增加10%的实验候选，I保持。不是已拟合的最优PI。','试用后以同幅值重新采集，比较响应误差、峰值和电流，再验证实际高低转速；未改善应恢复原PI。']};
}
