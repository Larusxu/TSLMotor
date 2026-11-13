import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});
try {
 for(const motor of [0,5,6]) {
  const r=await h.invoke('motor_semantic',{motor,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command:{kind:motor?'position_state':'get_state'}}});
  console.log(JSON.stringify({motor,...r}));
 }
}finally{await h.close();}
