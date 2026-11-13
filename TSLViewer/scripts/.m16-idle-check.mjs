import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});
let id=1,boot='0';
async function command(motor,command){
 const r=await h.invoke('motor_semantic',{motor,request:{request_id:id++,boot_id:boot,session_id:0,task_id:0,command}});
 if(r.result)throw Error(JSON.stringify(r));return r;
}
try {
 const d=await command(0,{kind:'get_state'});boot=d.boot_id;id=d.device.request_floor+1;
 for(const motor of [1,2,15,16]) {
  const r=await command(motor,{kind:'get_state'});
  console.log('BEFORE',motor,JSON.stringify(r.motor));
  console.log('POWER',motor,await h.invoke('main_control',{motor,op:4,data:[]}));
 }
 const s=(await command(16,{kind:'get_state'})).motor;
 if(s.drive!==0||s.motion_active)throw Error('M16 must already be stopped');
 if(s.fault){console.log('RECOVER',JSON.stringify(await command(16,{kind:'clear_fault'})));}
 for(let n=0;n<120;n++) {
  await new Promise(r=>setTimeout(r,250));
  const q=await command(16,{kind:'get_state'});
  if(n%4===0||q.motor.fault)console.log('IDLE',n,JSON.stringify(q.motor));
 }
}finally{await h.close();}
