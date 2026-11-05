/** Transport-independent real trial optimizer; UI and CLI share this path. */
import type {Capture,Candidate} from './model';
import {gainScales,spectrum,frequencyCandidate} from './frequency';
import {validateCaptureTiming} from './response';
export interface Trial {p:number;i:number;capture:Capture;score:number;peak:number}
export interface AutoPort {capture():Promise<Capture>; apply(c:Capture,p:number,i:number):Promise<void>; restore():Promise<void>; cancelled():boolean; notice(text:string):void}
export interface AutoResult {baseline:Trial;best:Trial;trials:Trial[];improved:boolean;candidate:Candidate}
export function trackingQuality(c:Capture,targetHz:number) {
 if(c.state!==2||c.error||c.count!==c.samples.length||c.count<160||(c.events&8))throw Error('需要完整且无丢帧的辨识记录，原 PI 保留');
 validateCaptureTiming(c);
 const trim=Math.max(24,Math.round(c.sampleHz*.1)),s=c.samples.slice(trim),amp=Math.max(...s.map(v=>Math.abs(v.reference)));
 if(!amp)throw Error('没有有效 PRBS 激励');
 const peak=Math.max(...s.map(v=>Math.abs(v.actual)))/amp;
 let energy=0,err=0,bias=0,effort=0,targetError=0,desired=0;
 const pole=Math.exp(-2*Math.PI*targetHz/c.sampleHz);
 // Compare every candidate under identical clocks. One fixed sample of delay
 // accommodates the reference/feedback channel order, never fitted per trial.
 for(let k=1;k<s.length;k++){
   desired=pole*desired+(1-pole)*s[k-1].reference;
   const e=(s[k].actual-s[k-1].reference)/amp;
   err+=e*e;targetError+=((s[k].actual-desired)/amp)**2;bias+=e;energy+=(s[k].actual/amp)**2;effort+=s[k].effort**2;
 }
 const rms=Math.sqrt(err/(s.length-1)),biasAbs=Math.abs(bias/(s.length-1));
 const sp=spectrum(c),trusted=sp.bins.filter(b=>b.coherence>.4&&b.hz<=Math.min(c.sampleHz*.4,targetHz*2));
 let freq=0,weight=0;
 for(const b of trusted){const ratio=b.hz/targetHz,re=1/(1+ratio*ratio),im=-ratio/(1+ratio*ratio),w=1/(1+ratio*ratio);freq+=w*((re-b.re)**2+(im-b.im)**2);weight+=w;}
 // Weak correlation is a diagnostic, not a reason to invent an object model.
 // The baseline can still be improved by measured same-excitation trials.
 // Match a desired closed-loop bandwidth, rather than reward tracking every
 // high-frequency PRBS edge with ever larger gains. This is a reference model,
 // not an assumption that the physical motor is a first-order plant.
 const targetRms=Math.sqrt(targetError/(s.length-1));
 const score=targetRms+.15*biasAbs+(weight?.15*Math.sqrt(freq/weight):0)+Math.max(0,peak-1.6)*.8;
 return {score,peak,rms,targetRms,bias:biasAbs,coherence:sp.coherence,bandwidthHz:sp.bandwidthHz,rmsEffort:Math.sqrt(effort/(s.length-1)),rmsActual:Math.sqrt(energy/(s.length-1))};
}
export async function automaticTune(port:AutoPort,targetHz:number,maxTrials=12):Promise<AutoResult>{
 if(!Number.isFinite(targetHz)||targetHz<=0)throw Error('目标带宽必须大于 0');
 const trials:Trial[]=[],seen=new Set<string>();let current:Capture|undefined;
 const capture=async(p?:number,i?:number)=>{
  if(port.cancelled())throw Error('自动整定已取消');
  if(current&&p!==undefined&&i!==undefined)await port.apply(current,p,i);
  current=await port.capture();
  const q=trackingQuality(current,targetHz),t={p:current.coefficient>>>16,i:current.coefficient&65535,capture:current,score:q.score,peak:q.peak};trials.push(t);seen.add(`${t.p}/${t.i}`);
  port.notice(`第 ${trials.length} 轮 P=${t.p} I=${t.i}；评分 ${t.score.toFixed(4)}；峰值/激励 ${q.peak.toFixed(2)}；相干度 ${(q.coherence*100).toFixed(1)}%`);return t;
 };
 try{
  const baseline=await capture();let best=baseline;
  const tryPair=async(p:number,i:number)=>{
   p=Math.max(1,Math.min(32767,Math.round(p)));i=Math.max(0,Math.min(32767,Math.round(i)));
   if(seen.has(`${p}/${i}`)||trials.length>=maxTrials)return;
   const trial=await capture(p,i);if(trial.peak<=2.5&&trial.score<best.score)best=trial;
  };
  let guess:Candidate|undefined;
  try{guess=frequencyCandidate(current!,targetHz);}catch(e){port.notice(`频域数据暂不足，改用实际试验搜索：${String(e)}`);}
  if(guess)await tryPair(guess.p,guess.i);
  // Current low-gain baseline often needs a large change, not repeated 10% P.
  for(const scale of [.5,2,4]){if(trials.length>=maxTrials-4)break;await tryPair(baseline.p*scale,baseline.i*scale);}
  // If the response is still too slow at the largest trial, continue the
  // measured growth direction before doing local refinement. This matters for
  // position PI starting far below the requested bandwidth.
  while(best.p>=baseline.p*4&&trials.length<maxTrials-4){
   const prior=best;await tryPair(best.p*2,best.i);
   if(best===prior)break;
  }
  for(let round=0;round<2&&trials.length<maxTrials-2;round++){
   const seed=best;for(const [p,i]of [[seed.p*1.5,seed.i],[seed.p*.7,seed.i],[seed.p,Math.max(1,seed.i)*2],[seed.p,seed.i*.5]])await tryPair(p,i);
  }
  // Repeat both endpoints. One lucky realization must not become the winner.
  // A nearly stationary response can have a deceptively small tracking score.
  // Explore from the best score, but repeat a candidate with observed tracking.
  const qualified=trials.filter(t=>{const q=trackingQuality(t.capture,targetHz);return t.peak<=2.5&&q.coherence>=.6&&q.rmsActual>=.15;});
  const selected=qualified.reduce((a,b)=>b.score<a.score?b:a,qualified[0]??baseline);
  const beforeRepeat=await capture(baseline.p,baseline.i),afterRepeat=await capture(selected.p,selected.i);
  const baseScore=(baseline.score+beforeRepeat.score)/2,bestScore=(selected.score+afterRepeat.score)/2;
  const finalQuality=trackingQuality(afterRepeat.capture,targetHz);
  const improved=(selected.p!==baseline.p||selected.i!==baseline.i)&&bestScore<baseScore*.98&&afterRepeat.peak<=Math.max(2,baseline.peak*1.2)&&finalQuality.coherence>=.6&&finalQuality.rmsActual>=.15;
  if(!improved){await port.restore();best=baseline;port.notice('重复对照未确认改善，已恢复原 PI；未写入 W25');}
  else best=afterRepeat;
  const scales=gainScales(best.capture),quality=spectrum(best.capture);
  return {baseline,best,trials,improved,candidate:{p:best.p,i:best.i,kp:best.p/scales.p,kiPerSecond:best.i/scales.i*scales.hz,bandwidthHz:targetHz,method:'measured-search',
   model:{a:0,b:0,fit:quality.coherence,validationFit:quality.coherence,tauSeconds:null,dcGain:null},warnings:[improved?'重复 PRBS 对照已改善；仍需验证实际低、高速运动':'没有确认可重复的改善，保留原 PI',quality.bandwidthHz?`测得闭环带宽约 ${quality.bandwidthHz.toFixed(1)} Hz`:'尚未可靠测出 -3dB 带宽，不能宣称达到目标带宽']}};
 }catch(e){try{await port.restore();}catch(restoreError){throw Error(`${String(e)}；原 PI 恢复失败：${String(restoreError)}`);}throw e;}
}
