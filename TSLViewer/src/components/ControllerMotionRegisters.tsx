import {useEffect,useRef,useState} from "react";
import {useApp} from "../lib/app-store";
import {semanticMotion} from "../lib/semantic-motion";
import {controllerRegisters,registerWords,splitRegister32,commonControlRegisters,motorControlRegisters,cylinderControlRegisters,type ControlRegister} from "../lib/controller-registers";
import {Button,Card,SelectField} from "./ui";

const hex=(n:number)=>`0x${n.toString(16).toUpperCase().padStart(4,"0")}`;
export default function ControllerMotionRegisters(){
 const app=useApp(),alive=useRef(true);
 const [group,setGroup]=useState("common"),[values,setValues]=useState<Record<number,number>>({}),[drafts,setDrafts]=useState<Record<number,string>>({});
 const [busy,setBusy]=useState(false),[note,setNote]=useState("");
 const committed=useRef<Record<number,string>>({});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const read=async()=>{
  setBusy(true);setNote("");try{
   const actual:Record<number,number>={};
   // Cache-only reads, bounded to the firmware's 60-word packet limit.
   for(const [base,size] of [[528,14],[576,20],[608,416],[1024,288]])for(let i=0;i<size;i+=60){
    if(!alive.current)return;
    const words=await controllerRegisters(base+i,Math.min(60,size-i));
    words.forEach((v,k)=>{actual[base+i+k]=v;});
   }
   if(alive.current){setValues(actual);setNote("已读取；编辑输入保持不变");}
  }catch(e){if(alive.current)setNote(String(e));}finally{if(alive.current)setBusy(false);}
 };
 useEffect(()=>{if(app.connected)void read();else setValues({});},[app.connected]);
 const write=async(r:ControlRegister,force=false)=>{
  const text=drafts[r.address]?.trim();if(!text||busy||(!force&&committed.current[r.address]===text))return;
  setBusy(true);setNote("");try{
   const words=r.format==="u32"?splitRegister32(Number(text)):registerWords(text,r.count);
   await semanticMotion.ensureConfigurationSession();
   await controllerRegisters(r.address,r.count,words);
   committed.current[r.address]=text;
   if(alive.current)setNote(`${r.name}已提交${r.command?"":"；任务执行结果见状态表"}`);
  }catch(e){if(alive.current)setNote(String(e));}finally{if(alive.current)setBusy(false);}
 };
 const rows=group==="common"?commonControlRegisters:group==="motors"?Array.from({length:16},(_,i)=>motorControlRegisters(i+1)).flat():Array.from({length:5},(_,i)=>cylinderControlRegisters(i+1)).flat();
 const actual=(r:ControlRegister)=>{
  if(r.command)return "命令";
  if(r.address>=1024&&r.address<1184&&(r.address-1024)%32===11){
   const status=values[r.address-6];return status==null||status===65535?"—":String(status&1);
  }
  const words=Array.from({length:r.count},(_,i)=>values[r.address+i]);
  if(words.some(v=>v==null))return "—";
  return r.format==="u32"?String(words[0]*65536+words[1]):words.map(v=>r.address===592||r.address===593?hex(v):String(v)).join(" / ");
 };
 return <>
 <Card title="主控运动控制寄存器 · 可读写" right={<Button size="sm" disabled={!app.connected||busy} onClick={()=>void read()}>读取运行寄存器</Button>}>
  <div className="row"><SelectField label="控制寄存器分类" value={group} onChange={setGroup} options={[{value:"common",label:"整机控制"},{value:"motors",label:"M1–M16 电机控制"},{value:"cylinders",label:"C1–C5 电缸控制"}]}/><span className="tiny muted">修改后失焦或回车提交；多字参数整组写入，回读不覆盖输入。</span></div>
  <div className="config-result" role="status" aria-live="polite">{busy?"正在读写…":note}</div>
  <div className="table-scroll"><table className="table config-table"><thead><tr><th>地址</th><th>名称</th><th>当前读取</th><th>写入值</th><th>单位</th><th>说明</th></tr></thead><tbody>{rows.map(r=><tr key={r.address}>
   <td className="mono">{r.address}{r.count>1?`–${r.address+r.count-1}`:""}</td><td>{r.name}</td><td className="mono">{actual(r)}</td>
   <td><div className="row"><input className="input mono" aria-label={`${r.name}写入值`} value={drafts[r.address]??""} placeholder={r.count>1&&r.format!=="u32"?`${r.count}字，空格分隔`:"未编辑"} disabled={!app.connected||busy} onChange={e=>setDrafts(old=>({...old,[r.address]:e.target.value}))} onBlur={()=>void write(r)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();e.currentTarget.blur();}}}/>{r.command&&<span onMouseDown={e=>e.preventDefault()}><Button size="sm" disabled={!app.connected||busy||!drafts[r.address]} onClick={()=>void write(r,true)}>执行</Button></span>}</div></td>
   <td>{r.unit??"—"}</td><td className="muted">{r.description}</td>
  </tr>)}</tbody></table></div>
 </Card>
 <Card title="主控运动运行状态 · 只读"><div className="table-scroll"><table className="table"><thead><tr><th>接口 / 地址</th><th>flags</th><th>目标 / 实际行程</th><th>转速 rpm</th><th>电流 mA</th><th>任务状态 / 结果</th><th>故障 / 错误</th></tr></thead><tbody>{Array.from({length:16},(_,i)=>{
  const b=768+16*i,v=(a:number)=>values[a]==null?"—":String(values[a]);
  const signed32=(h:number,l:number)=>h*65536+l>0x7fffffff?h*65536+l-0x100000000:h*65536+l;
  const signed16=(n:number)=>n>32767?n-65536:n;
  return <tr key={i}><td>M{i+1} · {b}–{b+15}</td><td className="mono">{values[b+1]==null?"—":hex(values[b+1])}</td><td>{v(576+i)} / {values[b]==null||values[b]===65535?"未知":`${(values[b]/100).toFixed(2)}%`}</td><td>{values[b+2]==null?"—":signed32(values[b+2],values[b+3])}</td><td>{values[b+4]==null?"—":signed16(values[b+4])}</td><td>{v(b+11)} / {v(b+12)}</td><td>{v(b+6)} / {v(b+7)}</td></tr>;
 })}</tbody></table></div></Card>
 </>;
}
