import {hardware} from './pi-hardware.mjs';
import fs from 'node:fs';
const report='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/swap-jog-'+Date.now()+'.json';
const h=await hardware(report,{managed:false});
let id=1,boot='0',session=0;const tasks=new Map();let active=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function command(motor,command){
 const r=await h.invoke('motor_semantic',{motor,request:{request_id:id++,boot_id:boot,session_id:session,task_id:tasks.get(motor)||0,command}});
 if(motor&&r.motor)tasks.set(motor,r.task_id);
 if(r.result)throw Error(JSON.stringify(r));return r;
}
try {
 const d=await command(0,{kind:'get_state'});boot=d.boot_id;id=d.device.request_floor+1;session=0x53574150;
 await command(0,{kind:'open'});
 for(const motor of (process.argv[2]?process.argv.slice(2).map(Number):[15,16])) {
  let r;
  for(let n=0;n<100;n++) {
   r=await command(motor,{kind:'get_state'});
   if(!r.pending&&r.motor.config_verified&&r.motor.feedback_fresh)break;
   await sleep(200);
  }
  console.log('BEFORE',motor,JSON.stringify(r));
  if(r.pending||r.motor.drive!==0||r.motor.fault||!r.motor.config_verified||!r.motor.feedback_fresh)throw Error('Lane not ready');
  await command(motor,{kind:'permit',enabled:true,lease_ms:1500});active=motor;
  console.log('START',motor,JSON.stringify(await command(motor,{kind:'open_loop_start',velocity_raw:Number(process.env.JOG_RAW || 91626),lease_ms:700})));
  const begin=Date.now();
  while(Date.now()-begin<5500) {
   await sleep(120);
   r=await command(motor,{kind:'get_state'});
   console.log('SAMPLE',motor,Date.now()-begin,JSON.stringify(r.motor));
   if(r.motor.fault||r.motor.last_error||(!r.pending&&!r.motor.motion_active)){console.log('ENDED',motor);break;}
   if(r.motor.motion_active)await command(motor,{kind:'jog_renew'});
  }
  console.log('STOP',motor,JSON.stringify(await command(motor,{kind:'stop',after:2})));
  for(let n=0;n<100;n++){r=await command(motor,{kind:'get_state'});if(!r.pending&&r.motor.drive===0&&!r.motor.motion_active)break;await sleep(100);}
  console.log('FINAL',motor,JSON.stringify(r));
  console.log('FAULT_DETAIL',motor,JSON.stringify(await command(motor,{kind:'rtmi_state',cursor:0xfffffffe})));
  await command(motor,{kind:'permit',enabled:false,lease_ms:0});active=0;
 }
}finally{
 if(active){try{await command(active,{kind:'stop',after:2});await command(active,{kind:'permit',enabled:false,lease_ms:0});}catch(e){console.error('STOP',String(e));}}
 try{if(session)await command(0,{kind:'close'});}finally{await h.close();}
 console.log('REPORT',report);
}
