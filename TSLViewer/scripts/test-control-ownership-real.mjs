/** Explicit M9 hardware regression through production TS services/Rust transport. */
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {hardware} from './pi-hardware.mjs';
const report='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/control-ownership-1105';
const h=await hardware(report+'.json',{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};
globalThis.__realInvoke=(...a)=>h.invoke(...a);
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64'),cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{
  if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__realInvoke(...a)'));
  if(name==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=()=>{throw Error("No desktop events in CLI test")};'));
  if(!name.startsWith('.'))throw Error('Unmapped '+name);
  return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),name+'.ts')));
 });const url=data(code);cache.set(file,url);return url;
}
const lib=n=>load(fileURLToPath(new URL('../src/lib/'+n+'.ts',import.meta.url)));
let motion,pi,profile,original,cfg;
try{
 motion=(await import(lib('semantic-motion'))).semanticMotion;
 pi=(await import(lib('pi-auto/service'))).piAuto;
 const m=await import(lib('motor-profile-ui'));
 await motion.open(9);await motion.initialize(9);
 await motion.wait(9,10000,r=>r.motor?.feedback_fresh&&r.motor.config_verified);
 profile=(await m.readMotorProfile(9)).data;original=await pi.livePi(9);
 const pid=m.pidFromProfile(profile);
 cfg=m.runFromProfile(profile,{motor:9,poles:1,min_deg:0,max_deg:54600,max_rpm:2000,limit_ma:1000,trip_ma:1000,trajectory:true,duration_ms:2000,accel_deg_s2:6000,decel_deg_s2:6000,mode:'position_ramp',planning:'limits',over_ms:180,sample_ms:60,comm_timeout_ms:1000,fault_action:'disable'});
 const trial={...pid,vel_p:pid.vel_p+1};
 await m.tuneMotorPi(9,1,trial);
 await m.applyMotorConfiguration(9,trial,{...cfg,mode:cfg.mode==='position_direct'?'position_ramp':'position_direct'});
 const applied=await pi.livePi(9),saved=(await m.readMotorProfile(9)).data;
 assert.equal(applied[3],trial.vel_p*65536+trial.vel_i);
 assert.deepEqual(saved.slice(28,48),profile.slice(28,48),'motion apply must not persist trial PI');
 assert.equal((await motion.command(9,{kind:'position_state'})).motor.fault,0);
 console.log('PASS current PID-page PI applied to TMC; W25 PI unchanged; configuration retained');
 await m.applyMotorConfiguration(9,pid,cfg);
 assert.deepEqual((await m.readMotorProfile(9)).data,profile);
 for(const velocity of [Math.round(300*m.COUNTS_PER_RPM),-Math.round(300*m.COUNTS_PER_RPM)]){
  await motion.wait(9,5000,r=>r.motor?.feedback_fresh);
  const before=(await motion.command(9,{kind:'position_state'})).motor;
  await motion.openLoopJog(9,velocity);
  await new Promise(r=>setTimeout(r,600));
  const active=(await motion.command(9,{kind:'position_state'})).motor;
  await motion.stop(9,true);await motion.wait(9,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
  const after=(await motion.command(9,{kind:'position_state'})).motor;
  console.log('OPEN_LOOP',JSON.stringify({velocity,before:before.position,active:active.position,after:after.position,home:after.span_valid,temperature:after.temperature_raw,fault:after.fault,error:after.last_error}));
  assert.equal(after.fault,0);assert.equal(after.last_error,0);assert(after.logic_power);
  assert.notEqual(active.position,before.position,'open-loop shaft feedback must move');
  assert.equal(Math.sign(Number(active.position)-Number(before.position)),Math.sign(velocity));
 }
 assert.deepEqual((await m.readMotorProfile(9)).data,profile);
 console.log('PASS bidirectional open-loop jog, release PWM OFF, power/configuration retained, W25 unchanged');
}finally{
 try{
  if(motion){await motion.stop(9,true);await motion.wait(9,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);}
  if(original&&profile&&pi){
   const m=await import(lib('motor-profile-ui')),p=m.pidFromProfile(profile);
   for(const group of [0,1,2])await m.tuneMotorPi(9,group,p);
   if(cfg)await m.applyMotorConfiguration(9,p,cfg);
   assert.deepEqual((await m.readMotorProfile(9)).data,profile);
   assert.deepEqual(await pi.livePi(9),original);
   console.log('RESTORED original TMC PI and original W25 profile');
  }
 }finally{try{if(motion){await motion.command(9,{kind:"drive_disable"});await motion.close();}}finally{await h.close();}}
}
