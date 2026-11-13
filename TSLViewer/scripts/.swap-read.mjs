import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});
try {
 for(const motor of [15,16]) {
  for(const command of [{kind:'position_state'},{kind:'rtmi_state',cursor:0xfffffffe}]) {
   const r=await h.invoke('motor_semantic',{motor,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command}});
   console.log(motor,JSON.stringify(r));
  }
  console.log('POWER',motor,await h.invoke('main_control',{motor,op:4,data:[]}));
 }
}finally{await h.close();}
