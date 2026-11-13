import fs from 'node:fs';
import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false}),motors=[1,2,3,4,5,6,9,10,11,12,13,14,15,16];
const start=Date.now(),samples=[];let id=1;
try{
 for(;;){let waiting=[];
  for(const motor of motors){const at=Date.now();const r=await h.invoke('motor_semantic',{motor,request:{request_id:id++,boot_id:'0',session_id:0,task_id:0,command:{kind:'position_state'}}});
   samples.push({at:new Date().toISOString(),latency_ms:Date.now()-at,motor,response:r});const s=r.motor;
   if(r.result||s.fault||s.last_error||s.motion_active)throw Error(JSON.stringify(r));
   if(!s.config_verified||!s.align_valid||!s.feedback_fresh)waiting.push(motor);
  }
  if(!waiting.length){console.log('READY all 14, no motion; max reply ms',Math.max(...samples.map(x=>x.latency_ms)));break;}
  if(Date.now()-start>90000)throw Error('Initialization timeout '+waiting);
  console.log('waiting',waiting.join(','));await new Promise(r=>setTimeout(r,500));
 }
}finally{
 fs.writeFileSync(process.argv[2]||'.init-readonly.json',JSON.stringify(samples,null,2));await h.close();
}
