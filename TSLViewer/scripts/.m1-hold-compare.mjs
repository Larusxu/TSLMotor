import fs from 'node:fs';
import {hardware} from './.m1-hardware.mjs';
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-hold-18000-p650';
const h=await hardware(root+'.json');const records=[];let original,profile;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 original=(await h.command(1,{kind:'position_state'})).motor;
 if(!original.coordinate_valid||!original.align_valid||original.motion_active||original.drive!==0)throw Error('Requires homed idle disabled M1');
 profile=await h.profile();
 const pi=await h.registers([0x140,0x142,0x143,0x145,0x146]);
 if(JSON.stringify(pi)!==JSON.stringify([34140,11731328,11731328,16384000,85196800]))throw Error('Screenshot PI mismatch');
 await h.command(1,{kind:'pi_tune',group:2,expected_config:34140,coefficients:[11731328,11731328,16384000,42598400]});
 await h.wait(1,10000,r=>r.motor.drive===0);
 console.log('comparison PI',await h.registers([0x140,0x142,0x143,0x145,0x146]));
 await h.command(1,{kind:'task_speed',mode:0,velocity_raw:Math.floor(18000*1099511627776/3600000000)});
 await h.wait(1,10000,r=>r.motor.drive===0&&r.motor.limits_valid);
 await h.command(1,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[0x154,0x153,0x155,0x152,65535,65535,65535],decimation:2});
 await h.wait(1,10000,r=>r.motor.drive===0);
 let boundary=Buffer.from((await h.command(1,{kind:'rtmi_state',cursor:0xffffffff})).rtmi),cursor=boundary.readUInt32LE(0),errors=boundary.readUInt32LE(8),generation=boundary.readUInt32LE(12);
 async function collect(label,until){
  let poll=0,done=0;const start=Date.now(),samples=[],states=[];
  while(Date.now()-start<30000){
   const r=await h.command(1,{kind:'rtmi_state',cursor}); const b=Buffer.from(r.rtmi);cursor=b.readUInt32LE(0);
   if(b.readUInt32LE(4)||b.readUInt32LE(8)!==errors||b.readUInt32LE(12)!==generation)throw Error('RTMI loss/errors/change');
   for(let k=20;k<b.length;k+=9)samples.push({at:b.readUInt32LE(k),ch:b[k+4],raw:b.readInt32LE(k+5)});
   if(Date.now()-poll>150){const state=await h.command(1,{kind:'position_state'});states.push(state);poll=Date.now();
    if(state.motor.fault||state.motor.last_error||!state.motor.coordinate_valid)throw Error('Motor fault '+JSON.stringify(state.motor));
    if(!done&&until(state))done=Date.now();
   }
   if(done&&Date.now()-done>=6000)break;
   await delay(2);
  }
  records.push({label,samples,states});fs.writeFileSync(root+'-samples.json',JSON.stringify(records));
  if(!done)throw Error('Arrival timeout');
  console.log(label,'samples',samples.length,'last',JSON.stringify(states.at(-1).motor));
 }
 await collect('disabled-baseline',()=>true);
 await h.command(1,{kind:'drive_enable'});await h.wait(1,15000,r=>r.motor.drive===2);
 for(const percent of [55,50]){
  const accepted=await h.command(1,{kind:'logical_move',position:String(Math.round(Number(original.logical_span)*percent/100))});
  records.push({label:'target',percent,accepted});
  await collect('hold-'+percent,r=>!r.motor.motion_active&&r.motor.arrival_phase===4);
 }
 await h.command(1,{kind:'stop',after:2});await h.wait(1,15000,r=>r.motor.drive===0&&!r.motor.motion_active);
 await collect('disabled-after',()=>true);
}finally{
 try{
  await h.command(1,{kind:'stop',after:2});await h.wait(1,15000,r=>r.motor.drive===0&&!r.motor.motion_active);
  await h.command(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await h.wait(1,10000,r=>r.motor.drive===0);
  await h.command(1,{kind:'pi_tune',group:2,expected_config:34140,coefficients:[11731328,11731328,16384000,85196800]});
  await h.wait(1,10000,r=>r.motor.drive===0);
  console.log('restored PI',await h.registers([0x140,0x142,0x143,0x145,0x146]));
  if(original)await h.command(1,{kind:'task_speed',mode:original.mode,velocity_raw:original.effective_velocity_raw});
  await h.wait(1,10000,r=>r.motor.drive===0);
  if(profile&&JSON.stringify(profile)!==JSON.stringify(await h.profile()))throw Error('W25 changed');
 }finally{fs.writeFileSync(root+'-samples.json',JSON.stringify(records));await h.close();}
}
