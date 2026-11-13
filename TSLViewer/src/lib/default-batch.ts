import {api} from './api';
import {storageJob} from './split-storage';
import {loadArchive,saveArchive,seedArchive,sealArchive,type ArchiveDraft} from './archive-editor';
import {word,putWord} from './motor-profile-ui';
import {semanticMotion} from './semantic-motion';
export type DefaultGroup='pi'|'encoder'|'limits'|'ramp'|'protection';
function patch(base:ArchiveDraft,seed:ArchiveDraft,group:DefaultGroup){
 const d={...base,main:[...base.main],extra:[...base.extra]};
 const copy=(extra:boolean,offsets:number[])=>offsets.forEach(o=>putWord(extra?d.extra:d.main,o,word(extra?seed.extra:seed.main,o)));
 if(group==='pi'){copy(false,[28,32,36,40,44]);d.main[16]|=2;}
 if(group==='encoder'){copy(true,[8,12,16,20,24,28,32]);d.main[18]=seed.main[18];}
 if(group==='limits')copy(false,[48,52,56,60,80,112]);
 if(group==='protection')copy(false,[84,88,92]);
 if(group==='ramp')copy(true,[44,48,52,56,64]);
 if(group==='ramp'||group==='limits')for(const [dst,src] of [[72,44],[76,48]])putWord(d.main,dst,Math.max(1,Math.floor(word(d.main,112)*131072000/(60000000*word(d.extra,src)))));
 return sealArchive(d);
}
/** All live writes complete before any archive write. Each archive is patched
 * independently, preserving identity, offset and fields outside this group. */
let running=false;
export async function applyDefaultBatch(defaults:number[],group:DefaultGroup,persist:boolean,progress:(text:string)=>void){
 if(running)throw Error('已有批量配置正在执行');
 running=true;
 try{return await executeBatch(defaults,group,persist,progress);}finally{running=false;}
}
async function executeBatch(defaults:number[],group:DefaultGroup,persist:boolean,progress:(text:string)=>void){
 const common=(await storageJob(0,1)).data,online:number[]=[],plans=new Map<number,ArchiveDraft>();
 for(const start of [128,192]){
  const p=await api.mainControl(0,10,[start,64]);if(p.length!==128)throw Error('在线状态快照不完整');
  for(let i=0;i<8;i++)if((p[i*16+14]*256+p[i*16+15])&2)online.push((start-128)/8+i+1);
 }
 if(!online.length)throw Error('没有在线 TMC，未写入档案');
 for(let m=1;m<=16;m++)plans.set(m,patch(await loadArchive(m,defaults,common),seedArchive(m,defaults,common),group));
 // Check the whole set before changing any chip; active movement is not interrupted.
 for(const m of online){const r=await semanticMotion.command(m,{kind:'get_state'});if(r.pending||r.motor?.motion_active||r.motor?.fault)throw Error(`M${m} 正在运动、执行任务或存在故障，请处理后重试`);}
 for(const m of online){
  progress(`M${m}：写入并校验 TMC`);const d=plans.get(m)!;let error:unknown;
  for(let attempt=0;attempt<2;attempt++)try{
   const before=await loadArchive(m,defaults,common);
   if(group==='encoder'||group==='pi'){
    await semanticMotion.stop(m,true);
    await semanticMotion.wait(m,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
   }
   if(group==='encoder'){
    const e=d.extra,bits=word(e,28);
    await semanticMotion.command(m,{kind:'encoder_temporary',config:[word(e,8),word(e,32),bits&255,(bits>>>8)&255,word(e,12),(bits>>>16)&255,word(e,20),word(e,24),word(e,16),bits>>>24,0xffffffff]});
   }else{
    const code={pi:3,limits:4,ramp:5,protection:6}[group];
    const payload=[...before.main.slice(120,124),...d.main.slice(28,64),...d.main.slice(68,120),code];
    if(group==='ramp')payload.push(...d.extra.slice(52,64));
    await semanticMotion.command(m,{kind:'apply_configuration',payload});
   }
   await semanticMotion.wait(m,30000,r=>!r.pending&&!r.motor?.pending_action&&!!r.motor?.config_verified);
   error=undefined;break;
  }catch(e){error=e;progress(`M${m}：${attempt===0?'配置重试 1/1':'失败'} · ${String(e)}`);
   if(attempt===0)await semanticMotion.wait(m,30000,r=>!r.pending&&!r.motor?.pending_action);
  }
  if(error)throw Error(`M${m} TMC 写入失败，尚未写入任何档案：${String(error)}`);
 }
 if(persist)for(let m=1;m<=16;m++){
  progress(`M${m}：更新档案对应字段`);
  // Re-read to preserve edits made after the initial plan was prepared.
  const d=patch(await loadArchive(m,defaults,common),seedArchive(m,defaults,common),group);
  try{await saveArchive(m,d);}catch{await saveArchive(m,d);}
 }
 progress(persist?`在线 ${online.length} 路 TMC 校验通过，16 路档案已更新`:`在线 ${online.length} 路 TMC 校验通过，档案未修改`);
}
