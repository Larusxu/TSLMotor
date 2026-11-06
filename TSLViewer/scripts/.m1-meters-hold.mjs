import fs from 'node:fs';
import {hardware} from './.m1-hardware.mjs';
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-meters-hold';
const backup=JSON.parse(fs.readFileSync('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-before-encoder-backup.json','utf8'));
const h=await hardware(root+'.json'),records=[];let original;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try {
 original=(await h.command(1,{kind:'position_state'})).motor;
 if(original.motion_active||!original.align_valid)throw Error('Requires calibrated idle M1');
 await h.command(1,{kind:'permit',enabled:true,lease_ms:3000});
 if(original.last_error){await h.command(1,{kind:'commission',action:1});await h.wait(1,15000,r=>r.motor.drive===0);}
 const pi=backup.pi;
 for(const group of [0,1,2]){await h.command(1,{kind:'pi_tune',group,expected_config:pi[0],coefficients:pi.slice(1)});await h.wait(1,10000,r=>r.motor.drive===0);}
 console.log('PI',await h.registers([0x140,0x142,0x143,0x145,0x146]));
 if(!original.coordinate_valid){
  console.log('Homing using unchanged existing PI and shared homing config');
  await h.command(1,{kind:'homing_start',direction:1,step_unit:100,dual:true});
  await h.wait(1,120000,r=>r.motor.coordinate_valid);console.log('Homing complete');
  await h.command(1,{kind:'pi_tune',group:2,expected_config:pi[0],coefficients:pi.slice(1)});await h.wait(1,10000,r=>!r.motor.motion_active);
 }
 await h.command(1,{kind:'stop',after:2});await h.wait(1,15000,r=>r.motor.drive===0);
 const state=(await h.command(1,{kind:'position_state'})).motor;
 records.push({label:'setup',state,pi,meters:await h.registers([0x244,0x245,0x246,0x250])});
 await h.command(1,{kind:'task_speed',mode:0,velocity_raw:5497558});await h.wait(1,10000,r=>r.motor.drive===0);
 await h.command(1,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[0x155,0x150,0x154,0x24a,0x24b,0x152,0x159],decimation:2});await h.wait(1,10000,r=>r.motor.drive===0);
 const boundary=Buffer.from((await h.command(1,{kind:'rtmi_state',cursor:0xffffffff})).rtmi);let cursor=boundary.readUInt32LE(0);const errors=boundary.readUInt32LE(8),generation=boundary.readUInt32LE(12);
 await h.command(1,{kind:'drive_enable'});await h.wait(1,15000,r=>r.motor.drive===2);
 for(const percent of [45,55,50]){
  await h.command(1,{kind:'logical_move',position:String(Math.round(Number(state.logical_span)*percent/100))});
  let arrival=null,poll=0;const start=Date.now(),samples=[],states=[];
  while(Date.now()-start<40000){
   const b=Buffer.from((await h.command(1,{kind:'rtmi_state',cursor})).rtmi);cursor=b.readUInt32LE(0);
   if(b.readUInt32LE(4)||b.readUInt32LE(8)!==errors||b.readUInt32LE(12)!==generation)throw Error('Capture discontinuity');
   for(let i=20;i<b.length;i+=9)samples.push({at:b.readUInt32LE(i),ch:b[i+4],raw:b.readInt32LE(i+5)});
   if(Date.now()-poll>100){const r=await h.command(1,{kind:'position_state'});states.push(r);poll=Date.now();
    if(r.motor.fault||r.motor.last_error||!r.motor.coordinate_valid)throw Error('Motor fault '+JSON.stringify(r.motor));
    if(arrival===null&&!r.motor.motion_active&&r.motor.arrival_phase===4)arrival=r.timestamp_ms;
   }
   if(arrival!==null&&samples.at(-1)?.at>=arrival+5100)break;
   await pause(2);
  }
  if(arrival===null)throw Error('Arrival timeout');
  const hold=samples.filter(v=>v.at>=arrival&&v.at<arrival+5000);
  records.push({label:'hold',percent,arrival,samples,hold,states});fs.writeFileSync(root+'-samples.json',JSON.stringify(records));
  console.log('Captured',percent,'arrival',arrival,'hold samples',hold.length);
 }
} finally {
 try {
  await h.command(1,{kind:'stop',after:2});await h.wait(1,15000,r=>r.motor.drive===0&&!r.motor.motion_active);
  await h.command(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await h.wait(1,10000,r=>r.motor.drive===0);
  if(original){await h.command(1,{kind:'task_speed',mode:backup.state.motor.mode,velocity_raw:backup.state.motor.effective_velocity_raw});await h.wait(1,10000,r=>r.motor.drive===0);}
  for(const group of [0,1,2]){await h.command(1,{kind:'pi_tune',group,expected_config:backup.pi[0],coefficients:backup.pi.slice(1)});await h.wait(1,10000,r=>r.motor.drive===0);}
  if(JSON.stringify(backup.profile)!==JSON.stringify(await h.profile()))throw Error('W25 changed');
  console.log('Final',JSON.stringify((await h.command(1,{kind:'position_state'})).motor));
 } finally {fs.writeFileSync(root+'-samples.json',JSON.stringify(records));await h.close();}
}
