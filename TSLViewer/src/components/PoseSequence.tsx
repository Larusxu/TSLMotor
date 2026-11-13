import {useEffect,useRef,useState} from "react";
import {Button,Card} from "./ui";
import {useApp} from "../lib/app-store";
import {savePoseFile} from "../lib/pose-files";
import {createPosePort} from "../lib/pose-motion";
import {emptySequence,linkPoseReferences,replacePoseData,nextPoseName,playSequence,pythonScript,validateSequence,type PoseDocument,type Pose} from "../lib/pose-sequence";
import {readHandHome,startHandHome,stopHandHome,stopHandDemo} from "../lib/motion-registers";
const KEY="tsl-pose-sequence-v1";
const STAGES=["等待初始化","电缸复位","手指正端","腕部找零","半屈关节","全屈关节","拇指电缸展开","拇指半屈","拇指全屈","拇指电缸归位","M9找零","整手找零完成","整手找零失败"];
export default function PoseSequence({onBusy,editDraft,onEdit,onComplete}:{onBusy:(busy:boolean)=>void;editDraft:Pose|null;onEdit:(pose:Pose|null)=>void;onComplete:()=>Promise<void>}){
 const app=useApp(),connected=app.connected&&app.mode!=="direct";
 const [document,setDocument]=useState<PoseDocument>(emptySequence),[linked,setLinked]=useState(false),[group,setGroup]=useState<number|null>(null);
 const [filename,setFilename]=useState(""),[duration,setDuration]=useState(1000),[busy,setBusy]=useState(false),[progress,setProgress]=useState(""),[error,setError]=useState("");
 const [home,setHome]=useState<number[]|null>(null);
 const [boundaryNotice,setBoundaryNotice]=useState("");
 const [waiting,setWaiting]=useState("");
 const [insertName,setInsertName]=useState(""),[editing,setEditing]=useState<string|null>(null),[aliasDraft,setAliasDraft]=useState("");
 const named=document.poses.filter((p,i,all)=>p.alias?.trim()&&!all.slice(0,i).some(a=>a.pose_id===p.pose_id));
 const selected=named.find(p=>p.name===insertName)??named[0];
 const epoch=useRef(0),port=useRef<ReturnType<typeof createPosePort>|null>(null),file=useRef<HTMLInputElement>(null),busyRef=useRef(false);
 const execution=useRef<Promise<void>|null>(null);
 const connectedRef=useRef(connected);connectedRef.current=connected;
 const homing=!!home&&home[0]>0&&home[0]<11;
 useEffect(()=>{try{const text=localStorage.getItem(KEY);if(text)setDocument(linkPoseReferences(JSON.parse(text)));}catch(e){setError(`本地姿态读取失败：${String(e)}`);}},[]);
 useEffect(()=>{
  let disposed=false,timer:ReturnType<typeof setTimeout>;setHome(null);
  if(connected){const poll=async()=>{try{const s=await readHandHome();if(!disposed)setHome(s);}catch(e){if(!disposed)setError(String(e));}if(!disposed)timer=setTimeout(poll,1000);};void poll();}
  return()=>{disposed=true;clearTimeout(timer);++epoch.current;void port.current?.stop(true);};
 },[connected]);
 useEffect(()=>{onBusy(busy||homing);return()=>onBusy(false);},[busy,homing,onBusy]);
 function save(next:PoseDocument){const d=linkPoseReferences(next);localStorage.setItem(KEY,JSON.stringify(d));setDocument(d);}
 async function task(action:()=>Promise<void>){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");setProgress("");try{await action();}catch(e){setError(String(e));app.toast("error",String(e));app.hostLog("error","pose/sequence",String(e));}finally{busyRef.current=false;setBusy(false);}}
 function baseName(){const name=filename.trim();if(!name)throw Error("请填写导出文件名");if(/[<>:"/\\|?*\u0000-\u001f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw Error("文件名包含无效字符");return name.replace(/\.(json|py)$/i,"");}
 async function exportFile(extension:"json"|"py"){await task(async()=>{const name=`${baseName()}.${extension}`;const path=await savePoseFile(name,extension==="json"?JSON.stringify(document,null,2):pythonScript(document),extension==="json"?"application/json":"text/x-python");setProgress(path?`已保存：${path}`:"已取消保存");});}
 async function record(){await task(async()=>{
  const token=epoch.current,current=()=>connectedRef.current&&token===epoch.current;
  const pose=await createPosePort(current).capture();if(!current())return;
  const name=nextPoseName(document.poses);
  save({...document,poses:[...document.poses,{...pose,name,alias:"",wait_ms:0,group:linked?group:null,duration_ms:duration}]});
  setProgress(`${name} 已记录 · ${Object.keys(pose.motors).length}路电机 / ${Object.keys(pose.cylinders).length}路电缸`);
 });}
 async function execute(poses:Pose[],loop=false){
  if(!connectedRef.current||homing||editDraft||(busyRef.current&&!execution.current))return;
  const token=++epoch.current,current=()=>token===epoch.current&&connectedRef.current;
  const previous=execution.current;
  port.current?.supersede();
  busyRef.current=true;setBusy(true);setError("");setBoundaryNotice("");setWaiting("");
  setProgress(`正在切换 · ${poses[0]?.name??"姿态"}`);
  const run=(async()=>{
   // Drain the previous in-flight transport operation before sending the new
   // pose. Its retired cleanup cannot STOP or overwrite the replacement UI.
   if(previous)await previous;
   if(!current())return;
   const warnings:string[]=[];
   const p=createPosePort(current,message=>{if(current()){warnings.push(message);setBoundaryNotice(message);app.hostLog("info","pose/sequence",message);}},message=>{if(current())setWaiting(message);});
   port.current=p;
   try{
    await playSequence({...document,poses},p,current,name=>{if(current())setProgress(`执行中 · ${name}`);},loop);
    if(current())setProgress(warnings.length?`序列结束 · ${warnings.length} 项边界提示（被拒绝的目标未执行）`:"动作执行完成");
   }catch(e){if(current()){setError(String(e));app.toast("error",String(e));app.hostLog("error","pose/sequence",String(e));}}
   finally{if(current()){port.current=null;setWaiting("");await onComplete();}}
  })().catch(e=>{if(current())setError(String(e));}).finally(()=>{
   if(execution.current===run){execution.current=null;busyRef.current=false;setBusy(false);}
  });
  execution.current=run;
  await run;
 }
 function updatePose(index:number,patch:Partial<Pose>){try{save({...document,poses:document.poses.map((p,i)=>i===index?{...p,...patch}:p)});}catch(e){setError(String(e));}}
 function insert(){if(!selected)return;try{const copy=structuredClone(selected);save({...document,poses:[...document.poses,{...copy,name:nextPoseName(document.poses),group:linked?group:null}]});setProgress(`已插入 ${selected.name} · ${selected.alias}`);}catch(e){setError(String(e));}}
 function editRow(p:Pose){
  if(editDraft?.name===p.name){try{save(replacePoseData(document,p.name,editDraft));onEdit(null);}catch(e){setError(String(e));}}
  else onEdit(structuredClone(p));
 }
 function runRow(index:number){void execute([{...document.poses[index],group:null}]);}
 async function stop(){++epoch.current;try{if(homing)await stopHandHome();await port.current?.stop(true);setProgress("已发送停止");}catch(e){setError(String(e));}}
 return <>
  <section className="pose-home-bar" aria-label="整手找零">
   <Button variant="primary" disabled={!connected||busy||homing||home===null} onClick={()=>void task(async()=>{await startHandHome();setHome([1,0]);setProgress("整手找零已启动");})}>一键找零</Button>
   <span role="status">{home?STAGES[home[0]]??`找零阶段 ${home[0]}`:"连接主控后读取找零状态"}{home?.[0]===12?`（${home[1]>32767?home[1]-65536:home[1]}）`:""}</span>
   {homing&&<Button onClick={()=>void stop()}>停止找零</Button>}
  </section>
  <Card title="动作序列" sub="电机记录行程百分比，电缸记录步数；联动组内所有轴由上位机连续插补">
   {home?.[4]===1&&<p role="status">固件演示中 · 姿态{home[5]} · 已完成{home[6]}轮，点击“停止演示序列”退出。</p>}
   <div className="pose-tools">
    <Button disabled={!connected||busy||homing} onClick={()=>void record()}>记录姿态</Button>
    <Button pressed={linked} variant={linked?"primary":"default"} disabled={busy} onClick={()=>{setLinked(!linked);setGroup(!linked?Math.max(0,...document.poses.map(p=>p.group??0))+1:null);}}>联动记录{linked?` · 组 ${group}`:" · 关"}</Button>
    <label>已有别名姿态 <select aria-label="选择要插入的姿态" disabled={busy||!named.length} value={selected?.name??""} onChange={e=>setInsertName(e.target.value)}>{!named.length&&<option value="">暂无已命名姿态</option>}{named.map(p=><option key={p.name} value={p.name}>{p.name} · {p.alias}</option>)}</select></label>
    <Button disabled={busy||!selected} onClick={insert}>插入</Button>
    <label>新姿态联动段时长 <input type="number" min={100} max={600000} step={100} value={duration} disabled={busy} onChange={e=>{const v=Number(e.target.value);if(Number.isInteger(v)&&v>=100&&v<=600000)setDuration(v);}}/> ms</label>
    <Button disabled={!connected||busy||homing||!!editDraft||!document.poses.length} onClick={()=>void execute(document.poses)}>顺序执行全部</Button>
    <Button disabled={!connected||busy||homing||!!editDraft||!document.poses.length} onClick={()=>void execute(document.poses,true)}>循环执行</Button>
    <label>每轮间隔 <input aria-label="每轮间隔（ms）" type="number" min={0} max={86400000} step={100} value={document.round_interval_ms??0} disabled={busy} onChange={e=>{const v=Number(e.target.value);if(Number.isInteger(v)&&v>=0&&v<=86400000)save({...document,round_interval_ms:v});}}/> ms</label>
    <Button disabled={!busy} onClick={()=>void stop()}>停止序列</Button>
    <Button disabled={!connected} onClick={()=>void stopHandDemo().then(()=>{setProgress("已停止固件演示，本次上电不再自动循环");}).catch(e=>setError(String(e)))}>停止演示序列</Button>
   </div>
   <div className="pose-files">
    <label>文件名 <input value={filename} onChange={e=>setFilename(e.target.value)} placeholder="填写导出文件名" disabled={busy}/></label>
    <Button disabled={busy} onClick={()=>void exportFile("json")}>导出 JSON</Button>
    <Button disabled={busy} onClick={()=>file.current?.click()}>导入 JSON</Button>
    <Button disabled={busy||!document.poses.length} onClick={()=>void exportFile("py")}>转换 Python SDK</Button>
    <input ref={file} type="file" accept=".json,application/json" hidden onChange={e=>{const f=e.target.files?.[0];e.target.value="";if(f)void task(async()=>{if(f.size>2*1024*1024)throw Error("JSON文件不能超过2MB");const next=validateSequence(JSON.parse(await f.text()));save(next);onEdit(null);setLinked(false);setGroup(null);setProgress(`已导入 ${next.poses.length} 个姿态`);});}}/>
   </div>
   <div className="pose-list"><table><thead><tr><th>姿态</th><th>别名</th><th>类型</th><th>电机 / 电缸</th><th>联动段时长</th><th>执行后等待（ms）</th><th className="pose-row-actions">操作</th></tr></thead><tbody>
    {document.poses.map((p,i)=><tr key={p.name} tabIndex={0} aria-label={`${p.name}，双击或回车执行`} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest("button,input,select,[data-pose-edit]")&&connected&&!homing&&!editDraft)runRow(i);}} onKeyDown={e=>{if(e.target===e.currentTarget&&e.key==="Enter"&&connected&&!homing&&!editDraft){e.preventDefault();runRow(i);}}} className={editDraft?.name===p.name?"is-editing":p.group!==null?"is-linked":""}>
     <td>{p.name}</td>
     <td data-pose-edit className="pose-alias" onDoubleClick={()=>{if(!busy){setEditing(p.name);setAliasDraft(p.alias??"");}}}>
      {editing===p.name?<input autoFocus aria-label={`${p.name}别名`} maxLength={100} value={aliasDraft} onChange={e=>setAliasDraft(e.target.value)} onBlur={()=>{updatePose(i,{alias:aliasDraft.trim()});setEditing(null);}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape"){setEditing(null);}}}/>:<button type="button" disabled={busy} className="pose-alias-trigger" aria-label={`编辑${p.name}别名`} title="双击编辑别名" onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setEditing(p.name);setAliasDraft(p.alias??"");}}}>{p.alias||<span className="muted">双击设置</span>}</button>}
     </td>
     <td>{p.group===null?"独立姿态":`联动组 ${p.group}`}</td><td title={`电机：${Object.keys(p.motors).join(",")}；电缸：${Object.keys(p.cylinders).join(",")}`}>{Object.keys(p.motors).length} / {Object.keys(p.cylinders).length}</td><td>{p.group===null?"—":`${p.duration_ms} ms`}</td>
     <td><input className="pose-wait" aria-label={`${p.name}执行后等待（ms）`} type="number" min={0} max={86400000} step={100} disabled={busy} value={p.wait_ms??0} onChange={e=>{const v=Number(e.target.value);if(Number.isInteger(v)&&v>=0&&v<=86400000)updatePose(i,{wait_ms:v});}}/></td>
     <td className="pose-row-actions"><Button disabled={busy||homing||!!editDraft&&editDraft.name!==p.name} onClick={()=>editRow(p)}>{editDraft?.name===p.name?"保存":"编辑"}</Button><Button disabled={!connected||homing||!!editDraft} onClick={()=>runRow(i)}>执行</Button><Button disabled={busy||!!editDraft} onClick={()=>{try{save({...document,poses:document.poses.filter((_,j)=>j!==i)});}catch(e){setError(String(e));}}}>删除</Button></td></tr>)}
    {!document.poses.length&&<tr><td colSpan={7} className="muted">调整滑杆，点击“记录姿态”。开启联动记录后，后续记录将加入同一组。</td></tr>}
   </tbody></table></div>
   <p className="tiny muted">编辑行以橙色显示；拖动下方滑杆修改姿态，保存后同步所有引用。双击别名编辑，回车或失焦保存。联动组默认连续插补；执行后等待从主控确认到位起计时。循环执行可随时停止。导入和插入只修改列表，不触发运动。</p>
   {progress&&<p role="status">{progress}</p>}{waiting&&<p className="tiny muted">{waiting}</p>}{boundaryNotice&&<p role="status" style={{color:"#f59e0b"}}>{boundaryNotice}</p>}{error&&<p role="alert" className="action-axis-error">{error}</p>}
  </Card>
 </>;
}
