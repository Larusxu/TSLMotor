import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const load=async path=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(fs.readFileSync(path,'utf8').replace(/^import .*;\r?\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64'));
const r=await load('src/lib/motor-ramp.ts');
const p=await load('src/lib/motor-profile-ui.ts');
for(const rpm of [2000,5000,15000,25000]) {
 const task=r.rampTask({mode:'position_ramp',max_rpm:rpm},r.DEFAULT_RAMP);
 const raw=p.accelerationRaw(task.accel_deg_s2);
 assert(Math.abs(raw-Math.round(rpm*p.COUNTS_PER_RPM*131072/6000000))<=1);
 assert(Math.abs(p.accelerationRaw(task.decel_deg_s2)-raw)<=1);
 assert.equal(task.max_rpm,rpm);
}
const words=bytes=>Array.from({length:bytes.length/4},(_,i)=>Buffer.from(bytes).readUInt32LE(i*4));
assert.deepEqual(words(r.rampSupplement({mode:'position_ramp'},r.DEFAULT_RAMP)),[91,1250,0]);
assert.deepEqual(words(r.rampSupplement({mode:'velocity_ramp'},{...r.DEFAULT_RAMP,velocity_ff:true})),[91,1250,0]);
assert.equal(r.rampTask({mode:'velocity_ramp',max_rpm:15000},r.DEFAULT_RAMP).decel_deg_s2,900000);
assert.deepEqual(r.rampSupplement({mode:'position_direct'},r.DEFAULT_RAMP),[]);
assert.throws(()=>r.rampTask({mode:'position_ramp',max_rpm:15000},{...r.DEFAULT_RAMP,acceleration_s:0}));
assert.throws(()=>r.rampSupplement({mode:'position_ramp'},{...r.DEFAULT_RAMP,delay_ms:3000}));
console.log('PASS Ramp physical-unit conversion, speed scaling, velocity-mode semantics and native field bounds');
