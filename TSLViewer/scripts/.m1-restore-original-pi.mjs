import fs from 'node:fs';
import {hardware} from './.m1-hardware.mjs';
const backup=JSON.parse(fs.readFileSync('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-before-encoder-backup.json','utf8'));
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-restore-original-pi.json');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function idle(){for(let n=0;n<100;n++){const r=await h.command(1,{kind:'get_state'});if(!r.pending&&!r.motor.pending_action&&r.motor.drive===0)return r;if(r.motor.fault)throw Error('fault');await pause(80);}throw Error('timeout');}
try{
 await h.command(1,{kind:'stop',after:2});await idle();
 await h.command(1,{kind:'pi_tune',group:2,expected_config:backup.pi[0],coefficients:backup.pi.slice(1)});await idle();
 await h.command(1,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[0x140,0x142,0x143,0x145,0x146,65535,65535],decimation:4});await idle();
 let cursor=0xffffffff;const values=Array(5).fill(null);
 for(let n=0;n<100&&values.some(v=>v===null);n++){
  const b=Buffer.from((await h.command(1,{kind:'rtmi_state',cursor})).rtmi);cursor=b.readUInt32LE(0);
  for(let i=20;i<b.length;i+=9)if(b[i+4]<5)values[b[i+4]]=b.readUInt32LE(i+5);
  await pause(5);
 }
 console.log('PI readback',values,'expected',backup.pi);
 if(JSON.stringify(values)!==JSON.stringify(backup.pi))throw Error('PI mismatch');
 console.log('Homing config',(await h.command(1,{kind:'homing_config_read'})).homing_config);
 if(JSON.stringify(await h.profile())!==JSON.stringify(backup.profile))throw Error('W25 changed');
 console.log('W25 unchanged');
} finally {
 try{await h.command(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await idle();}finally{await h.close();}
}
