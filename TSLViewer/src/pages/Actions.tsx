import {useEffect,useRef,useState} from "react";
import {useApp} from "../lib/app-store";
import {semanticMotion} from "../lib/semantic-motion";
import type {MotorState} from "../lib/semantic-state";
import type {CylinderModel} from "../lib/cylinder";
import {motorDisplayName} from "../lib/motor-names";
import {cylinderDisplayName} from "../lib/cylinder-names";
import {readMotionTravel,saveMotionTravel,useMotionTravel,type TravelRange} from "../lib/motion-travel";
import {Badge,Button,Card,Field,NumField} from "../components/ui";
import "../styles/actions.css";
import type {Pose} from "../lib/pose-sequence";
import PoseSequence from "../components/PoseSequence";

function AxisRow({name,actual,ready,stoppable,limits,passive,editable,onTarget,onSave,onMove,onStop,linked,onLinked}:{
 name:string;actual:number|null;ready:boolean;stoppable:boolean;limits:TravelRange;
 linked?:boolean;onLinked?:(enabled:boolean)=>void;
 passive:{version:string;value:number|null};editable:boolean;onTarget:(value:number)=>void;
 onSave:(value:TravelRange)=>Promise<unknown>;onMove:(value:number,current:()=>boolean)=>Promise<unknown>;onStop:()=>Promise<unknown>;
}){
 const [target,setTarget]=useState(0),[draft,setDraft]=useState(limits),[error,setError]=useState("");
 const [saving,setSaving]=useState(false),[moving,setMoving]=useState(false);
 const epoch=useRef(0),latest=useRef<number|null>(null),pumping=useRef(false);
 const targetInitialized=useRef(false);
 useEffect(()=>{if(actual!=null&&!targetInitialized.current){targetInitialized.current=true;setTarget(Math.min(limits.max,Math.max(limits.min,actual)));}},[actual,limits.min,limits.max]);
 // Passive snapshots update display only: never enter the command pump.
 useEffect(()=>{if(passive.value!=null){setTarget(passive.value);targetInitialized.current=true;}},[passive.version]);
 const mover=useRef(onMove);mover.current=onMove;
 const readyRef=useRef(ready);readyRef.current=ready;
 useEffect(()=>setDraft(limits),[limits.min,limits.max]);
 useEffect(()=>{if(!ready){++epoch.current;latest.current=null;}},[ready]);
 useEffect(()=>()=>{++epoch.current;latest.current=null;},[]);
 const editTarget=(value:number)=>{const v=Math.min(limits.max,Math.max(limits.min,value));setTarget(v);onTarget(v);};
 const move=(value:number)=>{
  if(!ready)return;
  latest.current=value;setError("");
  if(pumping.current)return;
  pumping.current=true;setMoving(true);const token=epoch.current;
  void(async()=>{try{
   while(latest.current!=null&&token===epoch.current&&readyRef.current){
    // Merge rapid slider changes, keeping the final value for this axis.
    await new Promise(r=>setTimeout(r,50));
    if(token!==epoch.current)break;
    const p=latest.current;latest.current=null;
    if(p!=null)await mover.current(p,()=>token===epoch.current&&readyRef.current);
   }
  }catch(e){latest.current=null;setError(String(e));}finally{pumping.current=false;setMoving(false);}})();
 };
 const save=async(value:TravelRange)=>{
  setDraft(value);setSaving(true);setError("");
  try{await onSave(value);}catch(e){setError(String(e));}finally{setSaving(false);}
 };
 const stop=()=>{
  ++epoch.current;latest.current=null;
  void onStop().catch(e=>setError(String(e)));
 };
 return <section className="action-axis" aria-label={name}>
  <div className="action-axis-name"><strong>{name}</strong>{onLinked&&<label className="tiny"><input type="checkbox" checked={!!linked} onChange={e=>onLinked(e.target.checked)}/>联动</label>}<span className="tiny muted">实际 {actual==null?"—":`${actual.toFixed(1)}%`}{moving?" · 发送中":""}</span></div>
  <div className="action-axis-slider">
   <input type="range" aria-label={`${name}绝对位置`} min={limits.min} max={limits.max} step={0.1} value={Math.max(limits.min,Math.min(limits.max,target))} disabled={(!ready&&!editable)||saving}
    onChange={e=>{const value=Number(e.target.value);editTarget(value);move(value);}}/>
   <div className="action-axis-scale"><span>{limits.min}%</span><span>{limits.max}%</span></div>
  </div>
  <Field label="目标位置"><NumField label={`${name}目标位置`} value={target} unit="%" min={limits.min} max={limits.max} step={0.1} disabled={(!ready&&!editable)||saving} onChange={editTarget}/></Field>
  <div className="action-axis-buttons"><Button variant="primary" disabled={!ready||saving} onClick={()=>move(target)}>前往</Button><Button disabled={!stoppable} onClick={stop}>停止</Button></div>
  <Field label="最小行程"><NumField label={`${name}最小行程`} value={draft.min} unit="%" min={0} max={100} step={0.1} disabled={!stoppable||saving} clampOnCommit={false} onChange={min=>setDraft(v=>({...v,min}))} onCommit={min=>void save({...draft,min})}/></Field>
  <Field label="最大行程"><NumField label={`${name}最大行程`} value={draft.max} unit="%" min={0} max={655.35} step={0.1} disabled={!stoppable||saving} clampOnCommit={false} onChange={max=>setDraft(v=>({...v,max}))} onCommit={max=>void save({...draft,max})}/></Field>
  {error&&<p className="action-axis-error" role="alert">{error}</p>}
 </section>;
}
export default function Actions({cylinders,active=true}:{cylinders:CylinderModel;active?:boolean}){
 const app=useApp(),limits=useMotionTravel();
 const [sequenceBusy,setSequenceBusy]=useState(false),sequenceBusyRef=useRef(false);sequenceBusyRef.current=sequenceBusy;
 const [states,setStates]=useState<Record<number,MotorState>>({}),[loaded,setLoaded]=useState(false),[error,setError]=useState("");
 const [editDraft,setEditDraft]=useState<Pose|null>(null),[refreshVersion,setRefreshVersion]=useState(0);
 const [wristLinked,setWristLinked]=useState(false),[wristTarget,setWristTarget]=useState({version:0,value:0});
 const connected=app.connected&&app.mode!=="direct";
 const activeRef=useRef(active);activeRef.current=active;
 useEffect(()=>{
  let disposed=false;setStates({});setLoaded(false);setError("");
  if(!connected)return;
  void readMotionTravel().then(()=>{if(!disposed)setLoaded(true);}).catch(e=>{if(!disposed)setError(String(e));});
  let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   for(let motor=1;motor<=16&&!disposed&&activeRef.current&&!sequenceBusyRef.current;motor++){
    try{const r=await semanticMotion.command(motor,{kind:"position_state"});if(!disposed&&r.motor)setStates(s=>({...s,[motor]:r.motor!}));}catch{if(!disposed)setStates(s=>{const next={...s};delete next[motor];return next;});}
   }
   if(!disposed)timer=setTimeout(poll,800);
  };
  void poll();return()=>{disposed=true;clearTimeout(timer);};
 },[connected]);
 const refresh=async()=>{
  if(!connected)return;
  const next:Record<number,MotorState>={};
  for(let motor=1;motor<=16;motor++){try{const r=await semanticMotion.command(motor,{kind:"position_state"});if(r.motor)next[motor]=r.motor;}catch{}}
  for(const r of cylinders.rows){try{await cylinders.command(cylinders.rows.indexOf(r)+1,{kind:"snapshot",id:r.id},false,true);}catch{}}
  setStates(next);setRefreshVersion(v=>v+1);
 };
 const changeMotor=(m:number,p:number)=>{
  const linked=wristLinked&&(m===15||m===16);
  if(linked)setWristTarget(t=>({version:t.version+1,value:p}));
  setEditDraft(d=>d?{...d,motors:{...d.motors,...(linked?{15:p,16:p}:{[m]:p})}}:d);
 };
 const changeCylinder=(ch:number,p:number)=>setEditDraft(d=>d?{...d,cylinders:{...d.cylinders,[ch]:p}}:d);
 const save=(row:number)=>(range:TravelRange)=>saveMotionTravel(row,range);
 return <div className="actions-page">
  <PoseSequence onBusy={setSequenceBusy} editDraft={editDraft} onEdit={setEditDraft} onComplete={refresh}/>
  <div className="actions-summary"><Badge>{Object.keys(states).length} 路电机状态</Badge><span>拖动滑杆即更新绝对位置目标；输入百分比后点击前往。</span><span>行程限制失焦或回车保存并回读。默认0～100%；仅最大行程允许超过100%。</span></div>
  {error&&<p role="alert">{error}</p>}
  {!connected&&<p className="muted">请连接主控后读取行程配置。</p>}
  <Card title="电机 · 绝对位置" sub="沿用各路当前运动模式与正常任务转速">
   {[1,4,6,3,5,2,10,13,11,12,9,14,7,8,15,16].map(m=>{
    const linked=wristLinked&&(m===15||m===16);
    const i=m-1,s=states[m],span=s?.logical_span?BigInt(s.logical_span):0n,margin=BigInt(s?.margin_counts??0),usable=span-2n*margin;
    const ready=connected&&!sequenceBusy&&loaded&&!!s?.coordinate_valid&&usable>0n;
    const actual=s?.coordinate_valid&&s.feedback_fresh&&usable>0n&&s.logical_position!=null?Number((BigInt(s.logical_position)-margin)*10000n/usable)/100:null;
    return <AxisRow key={m} linked={linked} onLinked={m===15||m===16?enabled=>{setWristLinked(enabled);setWristTarget({version:0,value:0});}:undefined} name={motorDisplayName(m)} limits={limits[i]} actual={actual} ready={ready} editable={!!editDraft} passive={{version:`${refreshVersion}:${editDraft?.name??""}:${linked?wristTarget.version:0}`,value:linked&&wristTarget.version?wristTarget.value:editDraft?.motors[m]??actual}} onTarget={p=>changeMotor(m,p)} stoppable={connected} onSave={save(i)}
     onMove={async(p,current)=>{
      if(!ready)throw Error("需要有效双端行程及位置模式");
      // One slider pump sends both targets; passive peer updates never send.
      const motors=linked?[m,m===15?16:15]:[m];
      const targets=motors.map(motor=>{
       const state=states[motor],offset=BigInt(state?.margin_counts??0),travel=BigInt(state?.logical_span??0)-2n*offset;
       if(!state?.coordinate_valid||travel<=0n)throw Error(`M${motor}需要有效双端行程`);
       const percent=Math.min(limits[motor-1].max,Math.max(limits[motor-1].min,p));
       return {motor,position:(offset+travel*BigInt(Math.round(percent*100))/10000n).toString()};
      });
      for(const target of targets){if(!current())return;await semanticMotion.command(target.motor,{kind:"logical_move",position:target.position},current);}
     }}
     onStop={()=>semanticMotion.command(m,{kind:"stop",after:1})}/>;
   })}
  </Card>
  <Card title="电缸 · 绝对位置" sub="百分比相对已标定的行程上下限；电缸需先使能">
   {cylinders.rows.map((r,i)=>{
    const ch=i+1,s=r.status,span=s?s.upper-s.lower:0;
    const ready=connected&&!sequenceBusy&&loaded&&!!s?.travel_valid&&span>0;
    return <AxisRow key={ch} name={cylinderDisplayName(ch)} limits={limits[16+i]} actual={s?.online&&span>0?(s.position-s.lower)*100/span:null} ready={ready} editable={!!editDraft&&span>0} passive={{version:`${refreshVersion}:${editDraft?.name??""}`,value:editDraft?.cylinders[ch]!=null&&s&&span>0?(editDraft.cylinders[ch]-s.lower)*100/span:s&&span>0?(s.position-s.lower)*100/span:null}} onTarget={p=>{if(s&&span>0)changeCylinder(ch,Math.round(s.lower+span*p/100));}} stoppable={connected} onSave={save(16+i)}
     onMove={async(p,current)=>{if(!current()||!ready||!s)return;const position=Math.round(s.lower+span*p/100);if(position>2000)throw Error("目标超过电缸物理行程2000步");await cylinders.command(ch,{kind:"target",id:r.id,position},false,true);}}
     onStop={()=>cylinders.stop(ch)}/>;
   })}
  </Card>
 </div>;
}
