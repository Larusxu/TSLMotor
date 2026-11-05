import type { Capture } from './model';
const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length;
/** Wire timestamps are integer milliseconds, not the native sample clock.
 * At kHz rates adjacent samples can legitimately share a timestamp. CRC and
 * ring-loss checks on the MCU establish frame continuity; timestamps detect
 * larger gaps and an implausible overall span. Model dt stays 1/sampleHz. */
export function validateCaptureTiming(c:Capture):void {
  if(!Number.isFinite(c.sampleHz)||c.sampleHz<=0)throw Error('采样时间不连续');
  const s=c.samples.slice(24),period=1000/c.sampleHz;
  for(let k=1;k<s.length;k++){
    const dt=(s[k].at-s[k-1].at)>>>0;
    if((!dt&&period>1)||Math.abs(dt-period)>Math.max(2,.3*period))throw Error('采样时间不连续');
  }
  if(s.length>1){
    const elapsed=(s[s.length-1].at-s[0].at)>>>0,expected=(s.length-1)*period;
    if(Math.abs(elapsed-expected)>Math.max(2,.3*expected))throw Error('采样时间不连续');
  }
}
/** Closed-loop PRBS model, not an inferred open-loop motor plant. */
export interface ResponseQuality { validationFit:number; delayedRmse:number; peakRatio:number; rmsEffort:number; coefficients:number[] }
export function evaluateResponse(c:Capture):ResponseQuality {
  if(c.loop!==2||c.state!==2||c.error||c.count!==c.samples.length||c.count<160||(c.events&8))
    throw Error('需要完整速度PRBS记录');
  validateCaptureTiming(c);
  const s=c.samples.slice(24),n=Math.floor(s.length/2);
  const ym=mean(s.slice(0,n).map(v=>v.actual)),um=mean(s.slice(0,n).map(v=>v.reference));
  const scale=Math.max(...s.map(v=>Math.abs(v.reference)));
  if(!scale||!Number.isFinite(scale))throw Error('PRBS激励无效');
  const y=s.map(v=>(v.actual-ym)/scale),u=s.map(v=>(v.reference-um)/scale);
  const mat=Array.from({length:4},()=>Array(5).fill(0) as number[]);
  for(let k=2;k<n;k++){const x=[y[k-1],y[k-2],u[k-1],u[k-2]];
    for(let i=0;i<4;i++){for(let j=0;j<4;j++)mat[i][j]+=x[i]*x[j];mat[i][4]+=x[i]*y[k];}}
  for(let i=0;i<4;i++){
    let pivot=i;for(let j=i+1;j<4;j++)if(Math.abs(mat[j][i])>Math.abs(mat[pivot][i]))pivot=j;
    [mat[i],mat[pivot]]=[mat[pivot],mat[i]];
    if(Math.abs(mat[i][i])<1e-8)throw Error('闭环辨识矩阵不可辨识');
    const d=mat[i][i];for(let j=i;j<5;j++)mat[i][j]/=d;
    for(let k=0;k<4;k++)if(k!==i){const f=mat[k][i];for(let j=i;j<5;j++)mat[k][j]-=f*mat[i][j];}
  }
  const a=mat.map(v=>v[4]);
  // Jury stability for z²-a1*z-a2.
  if(Math.abs(a[1])>=1||1-a[0]-a[1]<=0||1+a[0]-a[1]<=0)throw Error('闭环模型不稳定');
  const pred=[...y];let error=0,power=0;const center=mean(y.slice(n));
  for(let k=n;k<y.length;k++){pred[k]=a[0]*pred[k-1]+a[1]*pred[k-2]+a[2]*u[k-1]+a[3]*u[k-2];error+=(y[k]-pred[k])**2;power+=(y[k]-center)**2;}
  const validationFit=power?1-error/power:-Infinity;
  if(!Number.isFinite(validationFit)||validationFit<.65)throw Error(`闭环独立验证不足 ${(validationFit*100).toFixed(1)}%`);
  // Fixed one-sample reference delay. This metric must never be called
  // zero-delay tracking error or used to infer current-loop bandwidth.
  const delayedRmse=Math.sqrt(mean(s.slice(1).map((v,i)=>(v.actual-s[i].reference)**2)));
  return {validationFit,delayedRmse,peakRatio:Math.max(...s.map(v=>Math.abs(v.actual)))/scale,
    rmsEffort:Math.sqrt(mean(s.map(v=>v.effort**2))),coefficients:a};
}
export function compareResponse(base:Capture,trial:Capture) {
  if(base.motor!==trial.motor||base.pidConfig!==trial.pidConfig||base.currentLimits!==trial.currentLimits||
    base.velocityLimit!==trial.velocityLimit||Math.abs(base.sampleHz-trial.sampleHz)>.01||Math.abs(base.count-trial.count)>Math.max(3,base.count*.05)||
    Math.max(...base.samples.map(v=>Math.abs(v.reference)))!==Math.max(...trial.samples.map(v=>Math.abs(v.reference))))
    throw Error('对照采集的电机、限幅、采样或激励不同');
  const before=evaluateResponse(base),after=evaluateResponse(trial);
  const improvement=1-after.delayedRmse/before.delayedRmse;
  return {before,after,improvement,accepted:improvement>=.03&&after.peakRatio<=1.8&&after.peakRatio<=before.peakRatio*1.2};
}
