import fs from 'node:fs';
import {hardware} from './pi-hardware.mjs';
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/artifacts/board_backup_20261112_before_upgrade/';
const h=await hardware(null,{managed:false});
const motors=[1,2,3,4,5,6,9,10,11,12,13,14,15,16];
let boot='0',seq=1,session=0,released=false,complete=false;
const log=x=>fs.appendFileSync(root+'rounds.jsonl',JSON.stringify({at:new Date().toISOString(),...x})+'\n');
async function cmd(motor,command){const r=await h.invoke('motor_semantic',{motor,request:{request_id:seq++,boot_id:boot,session_id:session,task_id:0,command}});log({motor,command,response:r});if(r.result)throw Error(`M${motor} ${command.kind} ${r.result_name}`);if(boot!=='0'&&r.boot_id!==boot)throw Error('Unexpected controller restart');return r;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function policy(hold){
 let id=Date.now()>>>0;
 const send=(op,offset=0,data=[])=>h.invoke('motor_storage',{motor:0,request:{id,operation:op,offset,data}});
 let r=await send(12);while([2,3].includes(r.phase)){await sleep(40);r=await send(6);}
 if(r.result||r.phase!==4)throw Error('Policy read failed');
 const tail=await send(6,106);if(tail.result||tail.generation!==r.generation)throw Error('Policy tail mismatch');
 const b=Buffer.from([...r.data,...tail.data]);if(b.length!==128)throw Error('Policy size');
 if(!hold&&b[16]!==1)throw Error('Expected startup held');
 b[16]=hold?1:0;let c=0xffffffff;for(const v of b.subarray(0,120)){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}b.writeUInt32LE((c^0xffffffff)>>>0,120);
 id++;
 for(const off of [0,106]){const r=await send(2,off,[...b.subarray(off,off+106)]);if(r.result||r.phase!==1)throw Error('Policy staging');}
 r=await send(13);while([2,3].includes(r.phase)){await sleep(40);r=await send(6);}
 if(r.result||r.phase!==4)throw Error('Policy save');
 log({policy_startup_hold:hold});
}
try{
 const first=await cmd(0,{kind:'get_state'});boot=first.boot_id;seq=first.device.request_floor+1;session=0x48494c01;
 await cmd(0,{kind:'open'});
 const readyUntil=Date.now()+90000;
 for(;;){let waiting=[];for(const m of motors){const s=(await cmd(m,{kind:'position_state'})).motor;if(s.fault||s.motion_active)throw Error(`M${m} unsafe preflight ${JSON.stringify(s)}`);if(!s.align_valid||!s.config_verified||!s.feedback_fresh)waiting.push(m);}
  if(!waiting.length)break;if(Date.now()>readyUntil)throw Error('Initialization incomplete: '+waiting.join(','));console.log('Waiting for initialization',waiting.join(','));await sleep(1000);}

 console.log('READY: controller initialized all 14 motors using their saved profiles; no per-motor initialization/configuration commands sent');
 await policy(false);released=true;console.log('START automatic groups');
 const end=Date.now()+600000;const last=new Map();let allSince=0;
 while(Date.now()<end){
  if(fs.existsSync(root+'STOP'))throw Error('Operator stop file');
  let all=true;
  for(let ch=1;ch<=5;ch++){
   const raw=Buffer.from(await h.invoke('main_control',{motor:ch,op:34,data:[0,1]}));
   const c={pending:raw[1],result:raw.readInt16LE(2),enabled:!!raw[6],online:!!raw[7],position:raw.readInt16LE(48),target:raw.readInt16LE(46),fault:raw.readUInt16LE(58)};
   log({cylinder:ch,snapshot:c});
   const k='C'+ch,v=JSON.stringify([c.enabled,c.position,c.fault,c.result]);
   if(last.get(k)!==v){last.set(k,v);console.log(k,JSON.stringify(c));}
   if(c.fault||c.result)throw Error(`Cylinder ${ch} failed ${JSON.stringify(c)}`);
   if(ch===1&&(c.pending||Math.abs(c.position-raw.readUInt16LE(64))>2))all=false;
  }
  for(const m of motors){
   const r=await cmd(m,{kind:'position_state'}),s=r.motor;
   const bytes=await h.invoke('main_control',{motor:m,op:13,data:[]});const b=Buffer.from(bytes);
   const home={stage:b[0],valid:b[1],error:b[2],leg:b[10],ends:b[11],phase:b[25]};
   log({motor:m,home});
   const key=JSON.stringify([s.drive,s.motion_active,s.home_pos_valid,s.home_neg_valid,s.span_valid,s.fault,s.last_error,home.stage,home.leg]);
   if(last.get(m)!==key){last.set(m,key);console.log('M'+m,JSON.stringify({drive:s.drive,moving:s.motion_active,pos:s.home_pos_valid,neg:s.home_neg_valid,span:s.span_valid,fault:s.fault,error:s.last_error,home}));}
   if(s.fault||s.last_error||home.stage===3)throw Error(`M${m} failed ${JSON.stringify(s)} home=${JSON.stringify(home)}`);
   if(!s.span_valid||s.motion_active||r.pending||s.pending_action||home.stage===1)all=false;
  }
  if(all){if(!allSince)allSince=Date.now();if(Date.now()-allSince>1000){complete=true;console.log('COMPLETE all 14 spans valid, all tasks stopped');break;}}else allSince=0;
  await sleep(300);
 }
 if(!complete)throw Error('Whole hand timeout');
}catch(e){
 console.error('FAILED',String(e));log({failure:String(e)});process.exitCode=1;
 if(released){try{await policy(true);}catch(x){console.error('HOLD',String(x));}
  for(const m of motors)try{await cmd(m,{kind:'stop',after:2});}catch(x){console.error('STOP',m,String(x));}}
}finally{log({finished:true,complete,released});await h.close();}
