/** Non-parametric closed-loop identification. No first-order plant assumption. */
import type { Capture, Candidate } from './model';
import { validateCaptureTiming } from './response';
export interface Bin { hz:number; re:number; im:number; coherence:number; power:number }
export interface Spectrum { bins:Bin[]; coherence:number; bandwidthHz:number|null; resolutionHz:number }
function fft(re:number[],im:number[]) {
  const n=re.length;for(let i=1,j=0;i<n;i++){let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
  for(let size=2;size<=n;size*=2)for(let start=0;start<n;start+=size)for(let j=0;j<size/2;j++){
    const a=-2*Math.PI*j/size,c=Math.cos(a),s=Math.sin(a),k=start+j,l=k+size/2;
    const r=re[l]*c-im[l]*s,v=re[l]*s+im[l]*c;re[l]=re[k]-r;im[l]=im[k]-v;re[k]+=r;im[k]+=v;
  }
}
export function spectrum(c:Capture):Spectrum {
  if(c.state!==2||c.error||c.count!==c.samples.length||c.count<192||(c.events&8))throw Error('需要完整且无丢帧的频域辨识记录');
  validateCaptureTiming(c);
  const samples=c.samples.slice(Math.max(24,Math.round(c.sampleHz*.05)));
  let n=64;while(n<1024&&n*8<=samples.length)n*=2;
  const rr=Array(n/2).fill(0),yy=[...rr],re=[...rr],im=[...rr];let segments=0;
  for(let start=0;start+n<=samples.length;start+=n/2){
    const block=samples.slice(start,start+n),mr=block.reduce((a,v)=>a+v.reference,0)/n,my=block.reduce((a,v)=>a+v.actual,0)/n;
    const r=block.map((v,k)=>(v.reference-mr)*(.5-.5*Math.cos(2*Math.PI*k/(n-1)))),y=block.map((v,k)=>(v.actual-my)*(.5-.5*Math.cos(2*Math.PI*k/(n-1))));
    const ri=Array(n).fill(0),yi=Array(n).fill(0);fft(r,ri);fft(y,yi);segments++;
    for(let k=1;k<n/2;k++){rr[k]+=r[k]*r[k]+ri[k]*ri[k];yy[k]+=y[k]*y[k]+yi[k]*yi[k];re[k]+=y[k]*r[k]+yi[k]*ri[k];im[k]+=yi[k]*r[k]-y[k]*ri[k];}
  }
  if(segments<3)throw Error('有效数据不足三个频谱窗口');
  const peak=Math.max(...rr),bins:Bin[]=[];
  for(let k=1;k<n/2;k++)if(rr[k]>peak*.003)bins.push({hz:k*c.sampleHz/n,re:re[k]/rr[k],im:im[k]/rr[k],coherence:Math.min(1,(re[k]**2+im[k]**2)/(rr[k]*yy[k]||1)),power:rr[k]});
  const usable=bins.filter(b=>b.coherence>=.6),weighted=bins.reduce((a,b)=>a+b.coherence*b.power,0)/(bins.reduce((a,b)=>a+b.power,0)||1);
  // Absolute -3 dB relative to unity reference tracking; never substitute
  // Nyquist or the controller execution frequency for measured bandwidth.
  const low=usable.slice(0,3),unity=low.length===3&&low.every(b=>Math.hypot(b.re,b.im)>.7&&Math.hypot(b.re,b.im)<1.4);
  const crossing=unity?usable.find(b=>b.hz>low[2].hz&&Math.hypot(b.re,b.im)<Math.SQRT1_2):undefined;
  return {bins,coherence:weighted,bandwidthHz:crossing?.hz??null,resolutionHz:c.sampleHz/n};
}
export function gainScales(c:Capture) {
  const cfg=c.pidConfig,loop=c.loop;
  const pf=loop<2?((cfg>>>2)&1)*8:((cfg>>>(loop===2?4:8))&3)*8;
  const inf=loop<2?((cfg>>>3)&1)*8:8+((cfg>>>(loop===2?6:10))&3)*8;
  const shift=loop===2?(cfg>>>12)&15:0;
  const hz=loop<2?c.pwmHz:loop===2?c.velocityHz:c.velocityHz/(((cfg>>>16)&127)+1);
  return {p:2**(pf+shift),i:2**(inf+shift),hz};
}
function controller(p:number,i:number,hz:number,f:number):[number,number] {
  const w=2*Math.PI*f/hz;return [p+i/2,-i/(2*Math.tan(w/2))];
}
const mul=(a:number[],b:number[])=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]];
const div=(a:number[],b:number[])=>{const d=b[0]**2+b[1]**2;return [(a[0]*b[0]+a[1]*b[1])/d,(a[1]*b[0]-a[0]*b[1])/d];};
/** Predict with T'=q*T/(1-T+q*T), q=C'/C. Actual PRBS trials
 * remain mandatory: finite-band frequency data is not a stability proof. */
export function frequencyCandidate(c:Capture,targetHz:number):Candidate {
  if(!Number.isFinite(targetHz)||targetHz<=0||targetHz>=c.sampleHz/2)throw Error(`目标带宽必须大于 0 且低于采样奈奎斯特频率 ${(c.sampleHz/2).toFixed(1)} Hz`);
  const response=spectrum(c),bins=response.bins.filter(b=>b.coherence>=.6&&b.hz<=c.sampleHz*.4),sc=gainScales(c);
  if(bins.length<8||!bins.some(b=>b.hz<=targetHz*.7)||!bins.some(b=>b.hz>=targetHz*1.5))throw Error(`激励/响应没有可靠覆盖目标带宽；相干度 ${(response.coherence*100).toFixed(1)}%。可调整激励时钟、幅值或目标带宽后重采，不强套一阶模型。`);
  const oldP=c.coefficient>>>16,oldI=c.coefficient&65535;
  if(!oldP&&!oldI)throw Error('原 PI 均为零，不能按闭环比值推算');
  const cost=(p:number,i:number)=>{
    let loss=0,weight=0;
    for(const b of bins){
      const base=controller(oldP/sc.p,oldI/sc.i,sc.hz,b.hz),next=controller(p/sc.p,i/sc.i,sc.hz,b.hz),t=[b.re,b.im],q=div(next,base),qt=mul(q,t),den=[1-t[0]+qt[0],-t[1]+qt[1]],pred=div(qt,den);
      const amp=Math.hypot(...pred);if(!Number.isFinite(amp)||amp>1.8)return Infinity;
      const desired=div([1,0],[1,b.hz/targetHz]),w=b.coherence/(1+(b.hz/targetHz)**2);
      loss+=w*((pred[0]-desired[0])**2+(pred[1]-desired[1])**2);weight+=w;
    }return loss/weight;
  };
  let best={p:oldP,i:oldI,cost:cost(oldP,oldI)};
  for(const ps of [.5,.7,1,1.4,2])for(const is of [0,.25,.5,1,2,4]){
    const p=Math.max(1,Math.round(oldP*ps)),i=Math.round(oldI*is);if(p>32767||i>32767)continue;
    const score=cost(p,i);if(score<best.cost)best={p,i,cost:score};
  }
  if(!Number.isFinite(best.cost))throw Error('测得频域范围内没有可用的 PI 候选');
  return {p:best.p,i:best.i,kp:best.p/sc.p,kiPerSecond:best.i/sc.i*sc.hz,bandwidthHz:targetHz,method:'frequency',
    model:{a:0,b:0,fit:response.coherence,validationFit:response.coherence,tauSeconds:null,dcGain:null},
    warnings:['闭环频域候选，不要求对象符合一阶模型；必须实测复核',...(response.bandwidthHz?[`测得闭环带宽约 ${response.bandwidthHz.toFixed(1)} Hz`]:['未可靠测出闭环 -3dB 带宽'])]};
}
