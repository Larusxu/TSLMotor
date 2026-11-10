import fs from 'node:fs';
import {hardware} from './.m1-hardware.mjs';
const out='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/m12-extra-read-1109.json';
const h=await hardware(out,{managed:false});let boot='0',session=0,seq=1;
const cmd=(motor,command)=>h.invoke('motor_semantic',{motor,request:{request_id:seq++,boot_id:boot,session_id:session,task_id:0,command}});
async function read(motor,operation){const id=Date.now()>>>0;let q={id,operation,offset:0,data:[]},r=await h.invoke('motor_storage',{motor,request:q});const end=Date.now()+15000;while(r.phase===2||r.phase===3){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,80));r=await h.invoke('motor_storage',{motor,request:{...q,operation:6}});}if(r.result||r.phase!==4)throw Error(JSON.stringify(r));const tail=await h.invoke('motor_storage',{motor,request:{...q,operation:6,offset:106}});return Buffer.from([...r.data,...tail.data]);}
try{const d=await cmd(0,{kind:'get_state'});boot=d.boot_id;seq=d.device.request_floor+1;session=12390872;await cmd(0,{kind:'open'});for(const cursor of [0xfffffffe,0xfffffffd]){const r=await cmd(12,{kind:'rtmi_state',cursor});console.log('DIAGNOSTIC',JSON.stringify(r));}const common=await read(0,1);const defaults=await read(0,7);const extra=await read(12,9);const words=b=>Array.from({length:32},(_,i)=>[i*4,b.readUInt32LE(i*4),'0x'+b.readUInt32LE(i*4).toString(16)]);console.log(JSON.stringify({common:words(common),defaults:words(defaults),extra:words(extra)}));fs.writeFileSync(out+'-decoded.json',JSON.stringify({common:[...common],defaults:[...defaults],extra:[...extra]},null,2));}finally{try{if(session)await cmd(0,{kind:'close'});}finally{await h.close();}}




