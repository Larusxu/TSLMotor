/** Real M9 stop during short midpoint moves; preserve boot-local validity. */
import assert from 'node:assert/strict';
import {hardware} from './pi-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/pi-stop-1105-reuse.json');
try{
 const initial=(await h.command(9,{kind:'position_state'})).motor;
 assert(initial.coordinate_valid&&initial.align_valid&&!initial.fault);
 const span=Number(initial.logical_span);
 await h.command(9,{kind:'task_speed',velocity_raw:610840,mode:0});
 await h.wait(9,10000,r=>r.motor.drive===0);
 for(const percent of [55,45,50]){

  await h.command(9,{kind:'drive_enable'});await h.wait(9,10000,r=>r.motor.drive===2);
  await h.command(9,{kind:'logical_move',position:String(Math.round(span*percent/100))});
  await new Promise(r=>setTimeout(r,120));
  await h.command(9,{kind:'stop',after:1});
  const r=await h.wait(9,15000,r=>!r.motor.motion_active);
  assert.equal(r.motor.fault,0);assert(r.motor.logic_power);
  assert(r.motor.align_valid&&r.motor.home_neg_valid&&r.motor.home_pos_valid&&r.motor.coordinate_valid);
  console.log('STOP_REUSABLE',percent,r.motor.drive,r.motor.velocity_raw);
  await h.command(9,{kind:'stop',after:2});await h.wait(9,15000,r=>r.motor.drive===0);
 }
 console.log('PASS three moving stops, reauthorization, enable, power and calibration validity');
}finally{
 try{await h.command(9,{kind:'stop',after:2});await h.wait(9,15000,r=>r.motor.drive===0);}finally{await h.close();}
}
