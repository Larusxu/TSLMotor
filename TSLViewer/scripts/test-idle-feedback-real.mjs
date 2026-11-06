import assert from 'node:assert/strict';
import {hardware} from './pi-hardware.mjs';
const report='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/idle-feedback-fixed-1105';
const h=await hardware(report+'.json',{managed:false});
let seq=1,boot='0',session=0,task=0;
async function cmd(motor,command){const r=await h.invoke('motor_semantic',{motor,request:{request_id:seq++,boot_id:boot,session_id:session,task_id:task,command}});assert.equal(r.result,0,JSON.stringify(r));if(r.motor)task=r.task_id;return r;}
async function wait(test){const end=Date.now()+20000;for(;;){const r=await cmd(9,{kind:'get_state'});assert.equal(r.motor.fault,0,JSON.stringify(r.motor));if(!r.pending&&!r.motor.pending_action&&test(r.motor))return r.motor;if(Date.now()>end)throw Error('wait timeout');await cmd(0,{kind:'pulse'});await new Promise(r=>setTimeout(r,80));}}
try{
 const first=await cmd(0,{kind:'get_state'});boot=first.boot_id;seq=first.device.request_floor+1;session=0x49444c45;
 await cmd(0,{kind:'open'});await cmd(9,{kind:'commission',action:1});
 console.log('INITIALIZED',JSON.stringify(await wait(s=>s.config_verified&&s.feedback_fresh&&s.drive===0)));
 for(let cycle=0;cycle<8;cycle++){
  await cmd(9,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[0x155,0x154,0x153,65535,65535,65535,65535],decimation:1});
  await wait(s=>s.drive===0);await new Promise(r=>setTimeout(r,150));
  await cmd(9,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});
  await wait(s=>s.drive===0&&s.feedback_fresh);console.log('RTMI_STOP_PASS',cycle+1);
 }
 await cmd(0,{kind:'close'});session=0;
 const end=Date.now()+120000;let lastPrint=0,count=0,low=Infinity,high=0;
 while(Date.now()<end){const s=(await cmd(9,{kind:'get_state'})).motor;assert.equal(s.fault,0,JSON.stringify(s));assert.equal(s.last_error,0);assert(s.logic_power&&s.config_verified&&s.limits_valid);assert.equal(s.drive,0);assert(!s.motion_active&&!s.permit);low=Math.min(low,s.sampled_at_ms);high=Math.max(high,s.sampled_at_ms);count++;if(Date.now()-lastPrint>25000){console.log('IDLE',JSON.stringify({count,ageMs:s.sampled_at_ms,fresh:s.feedback_fresh,temperature:s.temperature_raw,fault:s.fault,power:s.logic_power}));lastPrint=Date.now();}await new Promise(r=>setTimeout(r,100));}
 assert(high-low>110000);console.log('PASS 120 seconds idle after 8 RTMI start/stop cycles; continuous feedback, PWM OFF, no permit/fault/power loss');
 console.log('FINAL',JSON.stringify((await cmd(9,{kind:'get_state'})).motor));
}finally{if(session){try{await cmd(0,{kind:'close'});}catch(e){console.error(e);}}await h.close();}
