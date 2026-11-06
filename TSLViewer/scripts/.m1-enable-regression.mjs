import {hardware} from './.m1-hardware.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-enable-'+(process.argv[2]||'baseline')+'.json');
let original;
try {
 await delay(1000);
 let s=await h.command(1,{kind:'position_state'});console.log('INITIAL',s.motor);
 if(s.motor.fault){await h.command(1,{kind:'clear_fault'});await h.wait(1,20000,r=>r.motor.drive===0);}
 s=await h.command(1,{kind:'position_state'});
 if(!s.motor.config_verified){await h.command(1,{kind:'commission',action:1});await h.wait(1,20000,r=>r.motor.drive===0);}
 if(process.env.LIVE_CONFIG==='1'){
  const p=original=await h.profile();const payload=[...p.slice(120,124),...p.slice(28,64),...p.slice(68,120),1];
  if(process.env.RESTORE_CONFIG!=='1')payload[4]^=2; // Valid volatile target policy; archive must retain its PI configuration.
  console.log('APPLY_LIVE_CONFIG',payload[4]);
  await delay(300);
  for(let attempt=0;;attempt++){try{await h.command(1,{kind:'apply_configuration',payload});break;}catch(e){if(attempt>=15||!e.message.startsWith('DRIVE_NOT_READY:'))throw e;await delay(80);}}
  await h.wait(1,10000,r=>r.motor.drive===0);
 }
 for(let i=0;i<3;i++){
  await h.command(1,{kind:'task_speed',mode:2,velocity_raw:4581298});await h.wait(1,10000,r=>r.motor.drive===0);
  if(process.env.RTMI==='1'){await h.command(1,{kind:'rtmi_config',enabled:true,sampling:127,addresses:[0x150,0x154,0x153,0x155,65535,65535,65535],decimation:2});await h.wait(1,10000,r=>r.motor.drive===0);}
  console.log('ENABLE',i,await h.command(1,{kind:'drive_enable'}));
  await h.wait(1,10000,r=>r.motor.drive===2);
  await delay(300);console.log('READY',(await h.command(1,{kind:'position_state'})).motor);
  await h.command(1,{kind:'stop',after:2});await h.wait(1,10000,r=>r.motor.drive===0);
  if(process.env.RTMI==='1'){await h.command(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await h.wait(1,10000,r=>r.motor.drive===0);}
  await h.command(1,{kind:'stop',after:1});await delay(150);const idle=await h.command(1,{kind:'get_state'});
  if(idle.motor.fault||idle.motor.drive!==0||idle.motor.pending_action)throw Error('Idle Stop started a task');
 }
 if(original)console.log('W25_UNCHANGED',JSON.stringify(original)===JSON.stringify(await h.profile()));
}catch(e){console.error('FAIL',e.message);await h.failure();process.exitCode=1;}finally{console.log('FINAL',(await h.command(1,{kind:'position_state'})).motor);await h.close();}
