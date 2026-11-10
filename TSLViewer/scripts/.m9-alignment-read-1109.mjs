import fs from 'node:fs';
import {hardware} from './.m1-hardware.mjs';
const output='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/m9-alignment-read-1109.json';
const h=await hardware(output,{managed:false});
let boot='0',session=0,sequence=1;
const command=(motor,command)=>h.invoke('motor_semantic',{motor,request:{request_id:sequence++,boot_id:boot,session_id:session,task_id:0,command}});
try{
 const state=await command(9,{kind:'get_state'});
 const device=await command(0,{kind:'get_state'});boot=device.boot_id;sequence=Math.max(sequence,device.device.request_floor+1);session=crypto.getRandomValues(new Uint32Array(1))[0]||1;
 const opened=await command(0,{kind:'open'});if(opened.result)throw Error('Read session rejected');
 const power=await h.invoke('main_control',{motor:9,op:4,data:[]});
 const id=Date.now()%0xffffffff;
 const send=operation=>h.invoke('motor_storage',{motor:9,request:{id,operation,offset:0,data:[]}});
 let archive;
 for(let attempt=0;attempt<10;attempt++){
  try{archive=await send(1);break;}catch(e){if(!String(e).includes('result=-7')||attempt===9)throw e;await new Promise(r=>setTimeout(r,100));}
 }
 const end=Date.now()+10000;
 while(archive.phase===2||archive.phase===3){if(Date.now()>end)throw Error('Archive read timeout');await new Promise(r=>setTimeout(r,80));archive=await send(6);}
 if(archive.result||archive.phase!==4)throw Error('Archive read failed '+JSON.stringify(archive));
 const tail=await h.invoke('motor_storage',{motor:9,request:{id,operation:6,offset:106,data:[]}});
 if(tail.result||tail.generation!==archive.generation)throw Error('Archive fragment mismatch');
 const data=Buffer.from([...archive.data,...tail.data]);
 const fields={motorId:data.readUInt16LE(12),slot:data.readUInt16LE(14),flags:data.readUInt16LE(16),poles:data[18],sensorDirection:data[19],offset:data.readUInt32LE(20),qualityPpm:data.readUInt32LE(24),pidConfig:data.readUInt32LE(28),currentLimitRaw:data.readUInt32LE(48),velocityLimitRaw:data.readUInt32LE(52),pi:[32,36,40,44].map(i=>[data.readUInt32LE(i)>>>16,data.readUInt32LE(i)&65535])};
 fs.writeFileSync(output.replace('.json','-summary.json'),JSON.stringify({state,power,fields,data:[...data]},null,2));
 console.log(JSON.stringify({state:state.motor,power,fields}));
}finally{try{if(session)await command(0,{kind:'close'});}finally{await h.close();}}
