// Explicit real-board configuration verification. No motion or gate-enable commands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {hardware} from './.m1-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/ramp-config-real.json');
const url=s=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64');
const read=p=>fs.readFileSync(p,'utf8').replace(/^import .*;\r?\n/gm,'');
let storageSeq=Date.now()>>>0;
const storageJob=async(motor,operation)=>{
 let request={id:storageSeq++,operation,offset:0,data:[]};let reply;
 const end=Date.now()+10000;
 for(;;){reply=await h.invoke('motor_storage',{motor,request});if(reply.phase===4)break;if(Date.now()>end)throw Error('Storage timeout');request.operation=6;await new Promise(r=>setTimeout(r,30));}
 if(reply.result)throw Error('Storage '+reply.result);
 const data=[];for(const offset of [0,106]){reply=await h.invoke('motor_storage',{motor,request:{...request,operation:6,offset}});data.push(...reply.data);}return {data};
};
globalThis.rampHardware={storageJob,semanticMotion:{command:h.command,wait:h.wait,stop:()=>{throw Error('Unexpected stop from configuration test');},report:(level,message)=>console.log(level,message)}};
const units=await import(url(read('src/lib/units.ts')));globalThis.rampUnits=units;
const m=await import(url('const {storageJob,semanticMotion}=globalThis.rampHardware;const {composePidConfig,parsePidConfig}=globalThis.rampUnits;\n'+read('src/lib/motor-profile-ui.ts')));
const ramp=await import(url(read('src/lib/motor-ramp.ts')));
let original,originalRegisters,pi,baseTask;
const words=values=>values.flatMap(v=>[v&255,v>>>8&255,v>>>16&255,v>>>24&255]);
try {
 const before=(await h.command(1,{kind:'position_state'})).motor;
 assert.equal(before.drive,0);assert(!before.motion_active);assert(before.config_verified);assert.equal(before.fault,0);
 original=(await storageJob(1,1)).data;
 originalRegisters=await h.registers([0x100,0x147,0x148,0x140,0x142,0x143,0x145]);
 const positionPi=(await h.registers([0x146]))[0];
 pi={...m.pidFromProfile(original),...units.parsePidConfig(originalRegisters[3]),flux_p:originalRegisters[4]>>>16,flux_i:originalRegisters[4]&65535,torque_p:originalRegisters[5]>>>16,torque_i:originalRegisters[5]&65535,vel_p:originalRegisters[6]>>>16,vel_i:originalRegisters[6]&65535,pos_p:positionPi>>>16,pos_i:positionPi&65535};
 baseTask=m.motionFromProfile(original,{planning:'limits',max_rpm:5000});
 for(const [mode,ff] of [['position_ramp',false],['position_ramp',true],['velocity_ramp',true],['position_direct',false],['velocity_direct',false]]){
  const task={...baseTask,mode,max_rpm:5000},r={...ramp.DEFAULT_RAMP,velocity_ff:ff};
  await m.applyMotorConfiguration(1,pi,ramp.rampTask(task,r),ramp.rampSupplement(task,r));
  const regs=await h.registers([0x100,0x1c6,0x1c9,0x1ce,0x147,0x148,0x1cd]);
  const modeBits={position_ramp:0x4800,velocity_ramp:0x6600,position_direct:0x800,velocity_direct:0x2600};
  assert.equal(regs[0]&0xffe00,modeBits[mode]|(mode==='position_ramp'&&ff?0x80000:0));
  if(ramp.rampEnabled(mode))assert.equal(regs[1],m.accelerationRaw(30000/.1));
  if(mode==='position_ramp'){assert.equal(regs[2],m.accelerationRaw(30000/.2));assert.equal(regs[3],Math.floor(5000*m.COUNTS_PER_RPM));assert.equal(regs[4],91);assert.equal(regs[5],1250);assert.equal(regs[6],256);}
  if(mode!=='position_ramp')assert.equal(regs[4],0);
  const state=(await h.command(1,{kind:'position_state'})).motor;assert.equal(state.drive,0);assert.equal(state.fault,0);assert.equal(state.align_valid,before.align_valid);assert.equal(state.span_valid,before.span_valid);
  console.log('PASS',mode,'FF',ff,regs.map(v=>'0x'+v.toString(16)));
 }
 // Speed-only updates must maintain the applied time, without any motion target.
 await m.applyMotorConfiguration(1,pi,ramp.rampTask({...baseTask,mode:'position_ramp',max_rpm:5000},ramp.DEFAULT_RAMP),ramp.rampSupplement({mode:'position_ramp'},ramp.DEFAULT_RAMP));
 await h.command(1,{kind:'task_speed',velocity_raw:Math.floor(15000*m.COUNTS_PER_RPM),mode:1});await h.wait(1,10000,r=>r.motor.drive===0&&r.motor.limits_valid);
 const scaled=await h.registers([0x1c6,0x1c9,0x1ce,0x1cb,0x1cc]);
 assert(Math.abs(scaled[0]-m.accelerationRaw(900000))<=2);assert(Math.abs(scaled[1]-m.accelerationRaw(450000))<=2);assert.equal(scaled[2],Math.floor(15000*m.COUNTS_PER_RPM));assert.equal(scaled[3],0);assert.equal(scaled[4],0);
 console.log('PASS task-speed 15000 rpm time-preserving Ramp',scaled);
} finally {
 try {
  if(original&&originalRegisters){
   const current=await storageJob(1,1),restored=[...original];
   // Restore original live PI without replacing saved PI in the archive.
   const live=m.profileWithPiOnly(original,pi,1);restored.splice(28,20,...live.slice(28,48));
   const payload=[...current.data.slice(120,124),...restored.slice(28,64),...restored.slice(68,120),1,...words([originalRegisters[1],originalRegisters[2],originalRegisters[0]>>>19&1])];
   await h.command(1,{kind:'apply_configuration',payload});await h.wait(1,20000,r=>r.motor.drive===0&&r.motor.config_verified);
   assert.deepEqual((await storageJob(1,1)).data,original,'Original W25 must be restored byte-for-byte');
   console.log('PASS original W25 and operating mode restored; no motion commands issued');
  }
 } finally {await h.close();delete globalThis.rampHardware;delete globalThis.rampUnits;}
}
