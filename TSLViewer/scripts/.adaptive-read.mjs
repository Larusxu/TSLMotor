import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});
try {
 for(const motor of [1,3]) {
  const r=await h.invoke('motor_semantic',{motor,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command:{kind:'get_state'}}});
  console.log('READONLY',motor,JSON.stringify(r));
 }
 console.log('HOME',await h.invoke('main_control',{motor:1,op:16,data:[]}));
}finally{await h.close();}
