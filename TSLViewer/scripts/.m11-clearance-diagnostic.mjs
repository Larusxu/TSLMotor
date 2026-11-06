import {hardware} from './.m1-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/m11-before-clearance-fix.json',{managed:false});
try {const r=await h.invoke('motor_semantic',{motor:11,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command:{kind:'rtmi_state',cursor:0xfffffffe}}});console.log(JSON.stringify(r));}finally{await h.close();}
