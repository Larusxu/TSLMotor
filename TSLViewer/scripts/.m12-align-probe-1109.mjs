import {hardware} from './.m1-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/m12-align-probe-1109.json',{managed:false});let boot='0',session=0,seq=1;
const cmd=(motor,command)=>h.invoke('motor_semantic',{motor,request:{request_id:seq++,boot_id:boot,session_id:session,task_id:0,command}});
try{const d=await cmd(0,{kind:'get_state'});boot=d.boot_id;seq=d.device.request_floor+1;session=12390873;await cmd(0,{kind:'open'});await cmd(12,{kind:'permit',enabled:true,lease_ms:3000});console.log('start',JSON.stringify(await cmd(12,{kind:'alignment',scan_degrees:720,step_degrees:90,settle_ms:700,current_ma:300})));const end=Date.now()+90000;while(Date.now()<end){await new Promise(r=>setTimeout(r,150));await cmd(0,{kind:'pulse'});await cmd(12,{kind:'permit',enabled:true,lease_ms:3000});const s=await cmd(12,{kind:'get_state'});if(s.motor?.drive!==1&&!s.pending&&!s.motor?.pending_action){console.log('end',JSON.stringify(s));break;}}}finally{try{if(session)await cmd(0,{kind:'close'});}finally{await h.close();}}


