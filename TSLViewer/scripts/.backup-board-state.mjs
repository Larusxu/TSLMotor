import fs from 'node:fs';
import {hardware} from './pi-hardware.mjs';
const out=process.argv[2];if(!out)throw Error('output file required');
const h=await hardware(null,{managed:false});const data={at:new Date().toISOString(),motors:{}};
try{
 data.device=await h.invoke('motor_semantic',{motor:0,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command:{kind:'get_state'}}});
 for(let motor=1;motor<=16;motor++){
  const record={};for(const kind of ['position_state','encoder_state','homing_config_read']){
   try{record[kind]=await h.invoke('motor_semantic',{motor,request:{request_id:1,boot_id:data.device.boot_id,session_id:0,task_id:0,command:{kind}}});}
   catch(e){record[kind]={error:String(e)};}
  }
  data.motors[motor]=record;fs.writeFileSync(out,JSON.stringify(data,null,2));
  console.log(motor,JSON.stringify(record.position_state.motor??record.position_state));
 }
}finally{fs.writeFileSync(out,JSON.stringify(data,null,2));await h.close();}
