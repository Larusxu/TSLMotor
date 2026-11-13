import {readMotionRegisters as read,writeMotionRegisters as write} from "./motion-registers";
import {semanticMotion} from "./semantic-motion";
import type {Pose,SequencePort} from "./pose-sequence";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
type Sample={motors:Record<string,{percent:number;flags:number;fault:number;error:number;age:number;rejected:boolean}>;cylinders:Record<string,number[]>};
export function createPosePort(current:()=>boolean,onWarning:(message:string)=>void=()=>{},onWaiting:(message:string)=>void=()=>{}):Omit<SequencePort,"stop">&{supersede:()=>void;stop:(explicit?:boolean)=>Promise<void>}{
 let motorIds:number[]=[],cylinderIds:number[]=[],boot="",submitted=false;
 let stopRequest:Promise<void>|null=null;
 const reported=new Set<string>();
 let observing:Promise<void>|null=null,observationError:unknown=null,lastObservation=0;
 let stopped=false,superseded=false;
 // At most one telemetry pass in flight; streaming targets do not wait for
 // every axis read. Completion still uses a fresh controller arrival report.
 function observe(){
  if(observationError)throw observationError;
  if(stopped||observing||Date.now()-lastObservation<200)return;
  lastObservation=Date.now();
  observing=sample().then(()=>{},error=>{observationError=error;}).finally(()=>{observing=null;});
 }

 const check=()=>{if(stopped||!current())throw Error("动作已停止或连接已改变");};
 async function sample(all=false):Promise<Sample>{
  check();const identity=(await read(534,4)).join(":");check();
  if(boot&&identity!==boot)throw Error("主控已重启，已停止动作序列");boot=identity;
  const result:Sample={motors:{},cylinders:{}};
  const ids=all?Array.from({length:16},(_,i)=>i+1):motorIds;
  for(const n of ids){
   check();const v=await read(768+16*(n-1),16);check();const flags=v[1],age=v[8]*65536+v[9];
   if(all&&(!(flags&64)||!(flags&8)||v[0]===65535))continue;
   // Controller owns readiness, mode, limits and command acceptance.
   const rejected=submitted&&v[11]===4&&(v[12]===1||v[12]===6||v[12]===15);
   if((v[6]&~16)||(submitted&&v[11]===4&&!rejected))throw Error(`M${String(n).padStart(2,"0")} 主控未执行目标：fault=${v[6]}，error=${v[7]}，result=${v[12]}`);
   if(rejected){const key=`${n}:${v[10]}:${v[12]}`;if(!reported.has(key)){reported.add(key);onWarning(`M${String(n).padStart(2,"0")} ${v[12]===1?"正在找零或配置，未接收本次目标":"目标被主控边界限制拒绝"}（result=${v[12]}），本次未执行，序列继续`);}}
   result.motors[n]={percent:v[0]/100,flags,fault:v[6],error:v[7],age,rejected};
  }
  for(const n of all?[1,2,3,4,5]:cylinderIds){
   check();const v=await read(1024+32*(n-1),12);check();
   if(all&&!(v[5]&2))continue;
   if(v[4]||(submitted&&v[10]))throw Error(`电缸${n} fault=${v[4]}，result=${v[10]}`);
   result.cylinders[n]=v;
  }
  check();return result;
 }
 async function idle(){
  const until=Date.now()+10000;
  for(;;){const s=await sample();if(Object.values(s.motors).every(m=>!(m.flags&256))&&Object.values(s.cylinders).every(c=>!(c[5]&4)))return s;if(Date.now()>until)throw Error("位置命令处理超时");await sleep(20);}
 }
 return {
  // Replacement retires this sender without sending STOP to the new target.
  supersede(){superseded=true;stopped=true;},
  async capture(){
   const s=await sample(!motorIds.length&&!cylinderIds.length);
   const motors=Object.fromEntries(Object.entries(s.motors).map(([k,m])=>[k,m.percent]));
   const cylinders=Object.fromEntries(Object.entries(s.cylinders).map(([k,c])=>[k,c[1]]));
   if(!Object.keys(motors).length&&!Object.keys(cylinders).length)throw Error("没有可记录的在线轴");
   return {motors,cylinders};
  },
  async prepare(poses:Pose[]){
   motorIds=[...new Set(poses.flatMap(p=>Object.keys(p.motors).map(Number)))].sort((a,b)=>a-b);
   cylinderIds=[...new Set(poses.flatMap(p=>Object.keys(p.cylinders).map(Number)))].sort((a,b)=>a-b);
   const s=await sample();
   // Submit all missing enables before waiting. The controller schedules each
   // lane; a host-side enable/wait loop adds its polling delay to every motor.
   const missing=motorIds.filter(n=>!(s.motors[n].flags&2));
   if(missing.length){const [enabled]=await read(593,1);check();await write(593,[missing.reduce((mask,n)=>mask|(1<<(n-1)),enabled)]);}
   for(const n of cylinderIds){check();if(!s.cylinders[n][11])await write(1024+32*(n-1)+11,[1]);}
   const ready=await idle();
   for(const n of missing)if(!(ready.motors[n].flags&2))throw Error(`M${String(n).padStart(2,"0")} 主控使能未完成：fault=${ready.motors[n].fault}，error=${ready.motors[n].error}`);
  },
  async send(pose){
   check();if(observationError)throw observationError;
   // Adjacent motor targets are submitted in one atomic register request.
   const entries=Object.entries(pose.motors).map(([k,v])=>[Number(k),Math.round(v*100)]).sort((a,b)=>a[0]-b[0]);
   while(entries.length){check();const [start,value]=entries.shift()!,values=[value];while(entries.length&&entries[0][0]===start+values.length)values.push(entries.shift()![1]);await write(575+start,values);}
   for(const [n,steps] of Object.entries(pose.cylinders)){check();await write(1024+32*(Number(n)-1)+15,[Math.round(steps)]);}
   submitted=true;observe();
  },
  async arrived(pose){
   if(observing)await observing;
   if(observationError)throw observationError;
   const until=Date.now()+30000;
   for(;;){
    const s=await idle();
    const waiting=[...Object.keys(pose.motors).filter(k=>!s.motors[k].rejected&&!(s.motors[k].flags&32)).map(k=>`M${String(k).padStart(2,"0")} 当前${s.motors[k].percent}% / 目标${pose.motors[k]}%`),...Object.keys(pose.cylinders).filter(k=>!(s.cylinders[k][5]&16)).map(k=>`电缸${k} 当前${s.cylinders[k][1]} / 目标${pose.cylinders[k]}步`)];
    onWaiting(waiting.length?`等待主控到位：${waiting.join("；")}`:"");
    if(!waiting.length)return;
    if(Date.now()>until)throw Error("等待主控到位超时："+[...Object.entries(pose.motors).filter(([k])=>!(s.motors[k].flags&32)).map(([k,v])=>`M${k} 当前${s.motors[k].percent}% / 目标${v}%`),...Object.entries(pose.cylinders).filter(([k])=>!(s.cylinders[k][5]&16)).map(([k,v])=>`电缸${k} 当前${s.cylinders[k][1]} / 目标${v}步`)].join("；"));await sleep(50);
   }
  },
  stop(explicit=false){
   // The button and playSequence's cancellation cleanup share one STOP.
   stopped=true;
   if(superseded&&!explicit)return Promise.resolve();
   if(stopRequest)return stopRequest;
   return stopRequest=(async()=>{
   // A restarted controller may already own a new automatic homing task.
   // Never apply the previous sequence's cleanup to that new boot.
   if(!boot)return;
   if((await read(534,4)).join(":")!==boot)return;
   // Best effort on every participating lane, including partial-send errors.
   const errors:unknown[]=[];
   // Ordinary sequence STOP uses the existing absolute-position STOP/HOLD.
   // Releasing PWM here forced a full enable/configure cycle on every restart.
   for(const n of motorIds)try{await semanticMotion.command(n,{kind:"stop",after:1});}catch(e){errors.push(e);}
   for(const n of cylinderIds)try{await write(1024+32*(n-1)+12,[1]);}catch(e){errors.push(e);}
   if(errors.length)throw Error(`停止命令未全部确认：${errors.map(String).join("；")}`);
   })();
  }
 };
}
