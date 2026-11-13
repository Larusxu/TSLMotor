export const POSE_FORMAT="teslahand.pose-sequence";
export type Pose={name:string;pose_id?:string;alias?:string;wait_ms?:number;group:number|null;duration_ms:number;motors:Record<string,number>;cylinders:Record<string,number>};
export type PoseDocument={format:typeof POSE_FORMAT;version:1;poses:Pose[];round_interval_ms?:number};
export const emptySequence=():PoseDocument=>({format:POSE_FORMAT,version:1,poses:[]});
export function validateSequence(value:unknown):PoseDocument{
 const d=value as PoseDocument;
 if(!d||d.format!==POSE_FORMAT||d.version!==1||!Array.isArray(d.poses)||d.poses.length>9999)throw Error("不支持的姿态文件格式或版本");
 if(d.round_interval_ms!==undefined&&(!Number.isInteger(d.round_interval_ms)||d.round_interval_ms<0||d.round_interval_ms>86400000))throw Error("轮间间隔应为0～86400000 ms");
 const names=new Set<string>(),groups=new Set<number>();let previous:number|null=null;
 for(const p of d.poses){
  if(!p||typeof p.name!=="string"||!p.name||names.has(p.name))throw Error("姿态名称为空或重复");names.add(p.name);
  if(p.pose_id!==undefined&&(typeof p.pose_id!=="string"||!p.pose_id||p.pose_id.length>200))throw Error("姿态引用标识无效");
  if(p.alias!==undefined&&(typeof p.alias!=="string"||p.alias.length>100))throw Error("别名最多100个字符");
  if(p.wait_ms!==undefined&&(!Number.isInteger(p.wait_ms)||p.wait_ms<0||p.wait_ms>86400000))throw Error("执行后等待应为0～86400000 ms");
  if(!Number.isInteger(p.duration_ms)||p.duration_ms<100||p.duration_ms>600000)throw Error("段时长应为100～600000 ms");
  if(p.group!==null&&(!Number.isInteger(p.group)||p.group<1))throw Error("联动组编号无效");
  if(p.group!==previous){if(p.group!==null&&groups.has(p.group))throw Error("同一联动组必须连续排列");if(p.group!==null)groups.add(p.group);}previous=p.group;
  for(const [field,max,count] of [["motors",655.35,16],["cylinders",2000,5]] as const){
   const a=p[field];if(!a||Array.isArray(a)||typeof a!=="object")throw Error("姿态轴数据无效");
   for(const [key,v] of Object.entries(a))if(!Array.from({length:count},(_,i)=>String(i+1)).includes(key)||typeof v!=="number"||!Number.isFinite(v)||v<0||v>max||(field==="cylinders"&&!Number.isInteger(v)))throw Error("姿态轴编号或位置无效");
  }
  if(!Object.keys(p.motors).length&&!Object.keys(p.cylinders).length)throw Error("姿态没有有效轴");
 }
 for(let i=1;i<d.poses.length;i++){const a=d.poses[i-1],b=d.poses[i];if(a.group!==null&&a.group===b.group&&(["motors","cylinders"] as const).some(f=>Object.keys(a[f]).sort().join()!==Object.keys(b[f]).sort().join()))throw Error("联动组各姿态的轴必须一致");}
 return structuredClone(d);
}
export function nextPoseName(poses:Pose[]){const n=1+Math.max(0,...poses.map(p=>/^姿态\d+$/.test(p.name)?Number(p.name.slice(2)):0));return `姿态${String(n).padStart(2,"0")}`;}
/** Monotone cubic Hermite: C1 velocity, no overshoot, zero boundary velocity. */
export function interpolate(values:number[],durations:number[],segment:number,u:number){
 const tangent=(i:number)=>{if(i===0||i===values.length-1)return 0;const a=(values[i]-values[i-1])/durations[i-1],b=(values[i+1]-values[i])/durations[i];if(a*b<=0)return 0;const w1=2*durations[i]+durations[i-1],w2=durations[i]+2*durations[i-1];return (w1+w2)/(w1/a+w2/b);};
 u=Math.min(1,Math.max(0,u));const h=durations[segment],a=values[segment],b=values[segment+1];
 return (2*u**3-3*u*u+1)*a+(u**3-2*u*u+u)*h*tangent(segment)+(-2*u**3+3*u*u)*b+(u**3-u*u)*h*tangent(segment+1);
}
export interface SequencePort{capture:()=>Promise<Pick<Pose,"motors"|"cylinders">>;prepare:(poses:Pose[])=>Promise<void>;send:(pose:Pick<Pose,"motors"|"cylinders">)=>Promise<void>;arrived:(pose:Pose)=>Promise<void>;stop:()=>Promise<void>}
export async function playSequence(document:PoseDocument,port:SequencePort,current:()=>boolean,progress:(name:string)=>void=()=>{},loop=false){
 const poses=validateSequence(document).poses;let touched=false;
 const check=()=>{if(!current())throw Error("动作序列已停止");};
 const wait=async(ms:number)=>{const end=performance.now()+ms;while(performance.now()<end){check();await new Promise(r=>setTimeout(r,Math.min(50,end-performance.now())));}check();};
 try{
  check();await port.prepare(poses);check();
  if(!poses.length)return;
  let round=0;
  do{round++;
  for(let i=0;i<poses.length;){
   check();const first=poses[i];
   const label=(p:Pose)=>`${loop?`第 ${round} 轮 · `:""}${p.name}${p.alias?` · ${p.alias}`:""}`;
   if(first.group===null){progress(label(first));touched=true;await port.send(first);check();await port.arrived(first);await wait(first.wait_ms??0);i++;continue;}
   let end=i+1;while(end<poses.length&&poses[end].group===first.group&&!(poses[end-1].wait_ms))end++;
   const origin=await port.capture(),points=[origin,...poses.slice(i,end)],durations=poses.slice(i,end).map(p=>p.duration_ms/1000);
   const started=performance.now();let offset=0;
   for(let segment=0;segment<durations.length;segment++){
    progress(label(poses[i+segment]));const duration=durations[segment];
    for(;;){
     check();const u=Math.min(1,Math.max(0,((performance.now()-started)/1000-offset)/duration));
     const target={motors:{},cylinders:{}} as Pick<Pose,"motors"|"cylinders">;
     for(const f of ["motors","cylinders"] as const)for(const key of Object.keys(first[f]))target[f][key]=interpolate(points.map(p=>p[f][key]),durations,segment,u);
     touched=true;await port.send(target);if(u>=1)break;await new Promise(r=>setTimeout(r,100));
    }offset+=duration;
   }
   check();await port.arrived(poses[end-1]);await wait(poses[end-1].wait_ms??0);i=end;
  }
  if(loop){progress(`第 ${round} 轮完成 · 等待下一轮`);await wait(document.round_interval_ms??0);}
  }while(loop);
 }catch(e){if(touched)await port.stop();throw e;}
}
export function pythonScript(document:PoseDocument){
 const d=validateSequence(document),bytes=new TextEncoder().encode(JSON.stringify(d));let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);const encoded=btoa(binary);
 return `# Install: pip install -e <TeslaHand>/application/TeslaHand/doc/SDK\n# Run: python sequence.py --port COM10\nimport argparse\nimport base64\nimport json\nfrom teslahand_sdk import TeslaHand\n\nSEQUENCE = json.loads(base64.b64decode("${encoded}"))\n\ndef main():\n    parser = argparse.ArgumentParser(description="TeslaHand pose sequence")\n    parser.add_argument("--port", required=True)\n    parser.add_argument("--loop", action="store_true", help="Repeat until Ctrl+C")\n    args = parser.parse_args()\n    with TeslaHand.open_rs485(args.port) as hand:\n        if args.loop:\n            hand.play_sequence(SEQUENCE, loop=True)\n        else:\n            hand.play_sequence(SEQUENCE)\n\nif __name__ == "__main__":\n    main()\n`;
}

/** Legacy inserts shared the alias but had no persistent reference ID. */
export function linkPoseReferences(document:PoseDocument):PoseDocument{
 const d=validateSequence(document),aliases=new Map<string,string>();
 for(const p of d.poses){const alias=p.alias?.trim();if(alias&&p.pose_id)aliases.set(alias,p.pose_id);}
 for(const p of d.poses){const alias=p.alias?.trim();p.pose_id??=(alias?aliases.get(alias):undefined)??crypto.randomUUID();if(alias)aliases.set(alias,p.pose_id);}
 return d;
}
export function replacePoseData(document:PoseDocument,name:string,data:Pick<Pose,"motors"|"cylinders">):PoseDocument{
 const source=document.poses.find(p=>p.name===name);if(!source)throw Error("姿态已删除");
 return {...document,poses:document.poses.map(p=>(p===source||!!source.pose_id&&p.pose_id===source.pose_id)?{...p,motors:{...data.motors},cylinders:{...data.cylinders}}:p)};
}
