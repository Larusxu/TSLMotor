import fs from 'node:fs';
import {hardware} from './.m1-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-encoder-live.json');
try {
 const state=await h.command(1,{kind:'position_state'});console.log('before',state.motor);
 if(state.motor.motion_active)throw Error('M1 moving');
 await h.command(1,{kind:'stop',after:2});await h.wait(1,15000,r=>r.motor.drive===0);
 const before=(await h.command(1,{kind:'encoder_state'})).encoder;console.log('snapshot',before);
 if(before?.length!==16||!before[1])throw Error('Extended snapshot unavailable');
 const profile=await h.profile();const velocity=await h.registers([0x244,0x245,0x246,0x250]);
 const command=before[12]>>>0, idle=command>>>16&255;
 const config=[Math.round(2**24/(before[2]&0xffffff)),before[3]&255,(command>>>8&31)+1,command>>>26&3,Math.round(30000000/((command&255)+1)),idle,before[13]>>>0,before[14]>>>0,before[6]&65535,before[5]&3,0xffffffff];
 try{
  config[5]=idle===17?18:17;
  await h.command(1,{kind:'encoder_config',config});await h.wait(1,15000,r=>r.motor.config_verified&&r.motor.drive===0);
  const changed=(await h.command(1,{kind:'encoder_state'})).encoder;
  console.log('changed',changed);if((changed[12]>>>16&255)!==config[5])throw Error('Idle write mismatch');
 } finally {
  config[5]=idle;await h.command(1,{kind:'encoder_config',config});await h.wait(1,15000,r=>r.motor.config_verified&&r.motor.drive===0);
 }
 const restored=(await h.command(1,{kind:'encoder_state'})).encoder;
 if(restored[12]!==before[12])throw Error('Restore mismatch');
 if(JSON.stringify(velocity)!==JSON.stringify(await h.registers([0x244,0x245,0x246,0x250])))throw Error('Velocity config changed');
 if(JSON.stringify(profile)!==JSON.stringify(await h.profile()))throw Error('W25 changed');
 console.log('PASS: editable idle written/read back/restored; both velocity configs and W25 unchanged');
} finally {await h.close();}
