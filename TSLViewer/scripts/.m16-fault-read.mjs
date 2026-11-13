import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});
try {
 for(const command of [{kind:'position_state'}, {kind:'rtmi_state',cursor:0xfffffffe}, {kind:'rtmi_state',cursor:0xfffffffd}]) {
  const r=await h.invoke('motor_semantic',{motor:16,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command}});
  console.log(JSON.stringify(r));
  if(r.rtmi){const b=Buffer.from(r.rtmi),v=[];for(let k=20;k+9<=b.length;k+=9)v.push(b.readUInt32LE(k+5));console.log('WORDS',v.map(x=>'0x'+x.toString(16)));}
 }
}finally{await h.close();}
