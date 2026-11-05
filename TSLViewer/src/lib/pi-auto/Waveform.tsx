import {useState} from 'react';
import type {Capture,Sample} from './model';
import {SelectField} from '../../components/ui';
/** Extrema-preserving display reduction; numeric analysis always uses all samples. */
function reduce(points:Sample[],key:'actual'|'reference') {
  if(points.length<=900)return points.map((p,i)=>({i,v:p[key]}));
  const result:{i:number;v:number}[]=[],step=Math.ceil(points.length/450);
  for(let k=0;k<points.length;k+=step){let min=k,max=k;for(let j=k;j<Math.min(k+step,points.length);j++){if(points[j][key]<points[min][key])min=j;if(points[j][key]>points[max][key])max=j;}
    for(const i of min===max?[min]:[min,max].sort((a,b)=>a-b))result.push({i,v:points[i][key]});}
  return result;
}
export function IdentificationWaveform({capture}:{capture:Capture}) {
  const [windowMs,setWindowMs]=useState(100),[offset,setOffset]=useState(0);
  const all=capture.samples,totalMs=Math.max(0,(all.length-1)*1000/capture.sampleHz),start=Math.min(offset,Math.max(0,totalMs-windowMs));
  const first=windowMs?Math.floor(start*capture.sampleHz/1000):0;
  const points=windowMs?all.slice(first,first+Math.max(2,Math.ceil(windowMs*capture.sampleHz/1000))):all;
  if(!points.length)return null;
  const values=points.flatMap(p=>[p.actual,p.reference]),lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||1;
  const path=(key:'actual'|'reference')=>reduce(points,key).map(p=>`${65+p.i*705/Math.max(1,points.length-1)},${175-(p.v-lo)/span*145}`).join(' ');
  const begin=first*1000/capture.sampleHz,end=(first+points.length-1)*1000/capture.sampleHz;
  return <>
    <div className="row-wrap tiny"><span>显示窗口</span><SelectField value={windowMs} onChange={v=>{setWindowMs(Number(v));setOffset(0);}} options={[{label:'50 ms',value:50},{label:'100 ms',value:100},{label:'500 ms',value:500},{label:'全程',value:0}]}/><span className="muted">纵轴：寄存器原码 · 实线反馈 / 虚线参考</span></div>
    <div className="pi-auto-wave"><svg viewBox="0 0 800 210" role="img" aria-label={`辨识响应，${begin.toFixed(1)} 到 ${end.toFixed(1)} 毫秒，原码范围 ${lo} 到 ${hi}`}>
      {[0,.5,1].map(v=><g key={v}><line x1="65" x2="770" y1={175-v*145} y2={175-v*145} stroke="var(--line)"/><text x="58" y={179-v*145} textAnchor="end" fill="var(--muted)" fontSize="11">{(lo+v*span).toFixed(0)}</text></g>)}
      <polyline points={path('reference')} fill="none" stroke="var(--warn)" strokeWidth="1.2" strokeDasharray="5 3"/>
      <polyline points={path('actual')} fill="none" stroke="var(--accent)" strokeWidth="1.5"/>
      <text x="65" y="199" fill="var(--muted)" fontSize="11">{begin.toFixed(1)} ms</text><text x="770" y="199" textAnchor="end" fill="var(--muted)" fontSize="11">{end.toFixed(1)} ms</text>
    </svg></div>
    {!!windowMs&&totalMs>windowMs&&<input aria-label="移动辨识响应时间窗口" type="range" min="0" max={Math.max(0,totalMs-windowMs)} step="1" value={start} onChange={e=>setOffset(Number(e.target.value))} style={{width:'100%'}}/>}
  </>;
}
