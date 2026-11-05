import fs from 'node:fs';
import {hardware} from './pi-hardware.mjs';
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/';
const report=root+process.argv[2],h=await hardware(report+'.json');
let original,profile,changed=false,savedMode,savedSpeed;
const seed=process.env.PI_SEED?JSON.parse(process.env.PI_SEED):null;
async function tune(words){await h.wait(9,3000,r=>r.motor.drive===0&&r.motor.feedback_fresh);for(const group of [0,1,2]){await h.command(9,{kind:'pi_tune',group,expected_config:original[0],coefficients:words});await h.wait(9,15000,r=>r.motor.drive===0);}const back=await h.registers([0x140,0x142,0x143,0x145,0x146]);if(back[0]!==original[0]||back.slice(1).some((v,i)=>v!==words[i]))throw Error('PI readback differs');}
try{
 const state=(await h.command(9,{kind:'position_state'})).motor;
 if(!state.coordinate_valid||!state.align_valid||state.motion_active)throw Error('Homed idle M9 required');
 await h.command(9,{kind:'permit',enabled:true,lease_ms:3000});
 original=await h.registers([0x140,0x142,0x143,0x145,0x146]);profile=await h.profile();
 const bytes=Buffer.from(profile),span=Number(state.logical_span);savedMode=state.mode;savedSpeed=bytes.readUInt32LE(112);
 if(seed){changed=true;await tune(seed);}
 for(const mode of (process.env.PI_MODES??'0').split(',').map(Number))for(const rpm of (process.env.PI_RPMS??'500,2000,8000,15000').split(',').map(Number)){
  await h.wait(9,5000,r=>r.motor.drive===0&&r.motor.feedback_fresh&&Math.abs(r.motor.velocity_raw)<=8192);
  await h.command(9,{kind:'task_speed',velocity_raw:Math.round(rpm*1099511627776/3600000000),mode});await h.wait(9,15000,r=>r.motor.drive===0);
  await h.command(9,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[0x154,0x153,0x155,0x152,65535,65535,65535],decimation:4});await h.wait(9,15000,r=>r.motor.drive===0);
  await h.command(9,{kind:'drive_enable'});await h.wait(9,15000,r=>r.motor.drive===2);
  const boundary=Buffer.from((await h.command(9,{kind:'rtmi_state',cursor:0xffffffff})).rtmi);
  let cursor=boundary.readUInt32LE(0),errors=boundary.readUInt32LE(8);
  h.records.push({telemetry_boundary:{cursor,errors}});
  for(const percent of [40,60,50]){
   const before=await h.command(9,{kind:'position_state'}),target=Math.round(span*percent/100);
   h.records.push({bench_start:true,rpm,percent,mode});
   const accepted=await h.command(9,{kind:'logical_move',position:String(target)});h.records.push({bench_accepted:true,timestamp_ms:accepted.timestamp_ms});
   let tick=0,latest=0,completed=0;const deadline=Date.now()+90000;let endpoint=null;
   while(true){
    const reply=await h.command(9,{kind:'rtmi_state',cursor}),b=Buffer.from(reply.rtmi);cursor=b.readUInt32LE(0);
    if(!b[16]||b[18]!==15)throw Error('Movement RTMI session changed');
    if(b.readUInt32LE(4)||b.readUInt32LE(8)!==errors){
     const gap={lost:b.readUInt32LE(4),errorsBefore:errors,errorsAfter:b.readUInt32LE(8),timestamp_ms:reply.timestamp_ms};
     h.records.push({telemetry_gap:gap});console.warn('Telemetry gap; motion state remains independently checked',gap);errors=b.readUInt32LE(8);
    }
    for(let k=20;k<b.length;k+=9)latest=b.readUInt32LE(k);
    if(Date.now()-tick>=100&&!completed){const r=await h.command(9,{kind:'position_state'});endpoint=r.motor;
     if(endpoint.fault||endpoint.last_error||!endpoint.coordinate_valid)throw Error('Movement fault '+JSON.stringify(endpoint));
     if(!endpoint.motion_active&&endpoint.arrival_phase===4)completed=r.timestamp_ms;
     tick=Date.now();
    }
    if(completed&&latest>=completed)break;
    if(Date.now()>deadline)throw Error('Arrival or final telemetry deadline');
    await new Promise(r=>setTimeout(r,2));
   }
   h.records.push({bench_done:true,rpm,percent,mode,endpoint,from:before.motor.logical_position});console.log('arrived',mode,rpm,percent,'error%',100*Math.abs(Number(endpoint.logical_position)-target)/span);
  }
  await h.command(9,{kind:'stop',after:2});await h.wait(9,15000,r=>r.motor.drive===0&&!r.motor.motion_active);
  await h.command(9,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await h.wait(9,15000,r=>r.motor.drive===0);
 }
}catch(error){
 console.error('Primary movement failure',String(error));
 try{await h.failure();}catch(diagnosticError){console.error('Failure snapshot unavailable',String(diagnosticError));}
 throw error;
}finally{
 try{
  await h.command(9,{kind:'stop',after:2});await h.wait(9,15000,r=>r.motor.drive===0&&!r.motor.motion_active);
  await h.command(9,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await h.wait(9,15000,r=>r.motor.drive===0);
  if(changed)await tune(original.slice(1));
  if(savedMode!==undefined){await h.wait(9,5000,r=>r.motor.drive===0&&r.motor.feedback_fresh&&Math.abs(r.motor.velocity_raw)<=8192);await h.command(9,{kind:'task_speed',velocity_raw:savedSpeed,mode:savedMode});await h.wait(9,15000,r=>r.motor.drive===0);}
  if(profile&&JSON.stringify(await h.profile())!==JSON.stringify(profile))throw Error('W25 changed');
  fs.writeFileSync(report+'-final.json',JSON.stringify((await h.command(9,{kind:'position_state'})).motor));
 }finally{await h.close();}
}
