import {hardware} from './pi-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/'+process.argv[2]+'.json');
try{
 let s=(await h.command(9,{kind:'position_state'})).motor;
 if(!s.config_verified){await h.command(9,{kind:'commission',action:1});await h.wait(9,15000,r=>r.motor.config_verified);}
 await h.command(9,{kind:'permit',enabled:true,lease_ms:3000});
 if(!s.coordinate_valid||process.env.PI_REHOME==='1'){console.log('HOME',await h.command(9,{kind:'homing_config_read'}));await h.command(9,{kind:'homing_start',direction:1,step_unit:100,dual:true});s=(await h.wait(9,180000,r=>r.motor.coordinate_valid&&!r.motor.motion_active)).motor;}
 s=(await h.command(9,{kind:'position_state'})).motor;console.log('HOMED',s);
 await h.wait(9,5000,r=>r.motor.feedback_fresh);
 await h.command(9,{kind:'task_speed',velocity_raw:610840,mode:1});await h.wait(9,15000,r=>r.motor.drive===0);
 await h.command(9,{kind:'drive_enable'});await h.wait(9,15000,r=>r.motor.drive===2);
 await h.command(9,{kind:'logical_move',position:String(Math.round(Number(s.logical_span)/2))});
 const mid=await h.wait(9,120000,r=>!r.motor.motion_active&&Math.abs(Number(r.motor.logical_position)-Number(s.logical_span)/2)<Number(s.logical_span)*.0005);console.log('CENTER',mid.motor);
 await h.command(9,{kind:'stop',after:2});await h.wait(9,15000,r=>r.motor.drive===0);
}finally{await h.close();}
