// Actual application workflow with a controlled register/archive transport.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/motor-profile-ui.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const units=ts.transpileModule(readFileSync(new URL('../src/lib/units.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const u={};new Function('exports',units)(u);
function harness(fail=false,running=false) {
 const calls=[],exports={};let saved,common;
 const motor={drive:running?2:0,motion_active:running,fault:0,limits_valid:true,config_verified:true,effective_iq_raw:2483,effective_velocity_raw:4581298,mode:1};
 const motion={report:()=>{},command:async(_,q)=>{
  calls.push(q.kind);
  if(q.kind==='apply_configuration') {
   saved.splice(28,36,...q.payload.slice(4,40));saved.splice(68,52,...q.payload.slice(40));
   exports.putWord(saved,120,exports.crc32(saved.slice(0,120)));
  }
  return {motor:{...motor}};
 },wait:async(_,__,accept)=>{assert(accept({motor}));},stop:async()=>{motor.drive=0;}};
 const storageJob=async(_,op)=>{
  calls.push(`storage:${op}`);
  if(op===1&&_===0)return {data:[...common]};
  const data=[...saved];if(fail&&calls.includes('apply_configuration'))data[44]^=1;
  return {data};
 };
 new Function('exports','require',js)(exports,name=>name==='./units'?u:name==='./semantic-motion'?{semanticMotion:motion}:{storageJob});
 saved=Array(128).fill(0);
 saved.splice(0,4,...Buffer.from('MTR1'));exports.putWord(saved,4,0x00800001);
 saved[12]=saved[14]=9;saved[16]=2;exports.putWord(saved,56,23169);exports.putWord(saved,48,2483*65536);exports.putWord(saved,52,4581298);
 exports.putWord(saved,60,8774555);exports.putWord(saved,68,exports.RUN2_TAG);exports.putWord(saved,104,1);exports.putWord(saved,112,4581298);
 exports.putWord(saved,120,exports.crc32(saved.slice(0,120)));exports.putWord(saved,124,0x31544d43);
 common=Array(128).fill(0);exports.putWord(common,32,1050);exports.putWord(common,36,2000);exports.putWord(common,120,exports.crc32(common.slice(0,120)));
 return {run:()=>exports.applyMotorPi(9,exports.pidFromProfile(saved)),motor,calls};
}
test('configuration apply needs no authorization API and does not enable a motor',async()=>{
 const h=harness();await h.run();assert.equal(h.motor.drive,0);
 assert(!h.calls.includes('permit'));assert(!h.calls.includes('drive_enable'));
});
test('archive verification failure surfaces without enabling the motor',async()=>{
 const h=harness(true);await assert.rejects(h.run());
 assert.equal(h.motor.drive,0);assert(!h.calls.includes('drive_enable'));
});
test('online PI apply preserves active task and PWM without stopping or enabling',async()=>{
 const h=harness(false,true);await h.run();
 assert.equal(h.motor.drive,2);assert.equal(h.motor.motion_active,true);
 assert(!h.calls.includes('stop'));assert(!h.calls.includes('drive_enable'));
});
