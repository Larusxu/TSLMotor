import {hardware} from './pi-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/pi-stop-1105-field.json',{managed:false});
try {
 for(const [i,command] of [{kind:'get_state'},{kind:'rtmi_state',cursor:0xfffffffe},{kind:'rtmi_state',cursor:0xfffffffd}].entries()) {
  const r=await h.invoke('motor_semantic',{motor:9,request:{request_id:i+1,boot_id:'0',session_id:0,task_id:0,command}});
  console.log(JSON.stringify(r));
 }
}finally{await h.close();}
