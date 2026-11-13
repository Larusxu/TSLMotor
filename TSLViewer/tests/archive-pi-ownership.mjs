import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const modules={};
function load(name){
 if(modules[name])return modules[name];
 const out={};modules[name]=out;
 const source=readFileSync(new URL(`../src/lib/${name}.ts`,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('exports','require',js)(out,p=>['./units','./motor-profile-ui'].includes(p)?load(p.slice(2)):{});
 return out;
}
const p=load('motor-profile-ui'),a=load('archive-editor');
function seed(m){
 const d=Array(128).fill(0),c=Array(128).fill(0);
 const values={24:0x855e,28:0x2000180,32:0x2000180,36:0xe60000,40:0xaf00000,
  44:4967*65536,48:4581298,52:23169,56:16384,60:2000000,64:4800,72:16383,
  76:0x0310010e,80:(100<<16)|1,84:0x2bb12,88:0xfff00001,92:100,96:100,
  100:91,104:1250,108:1000,112:15000,116:1000};
 for(const [o,v] of Object.entries(values))p.putWord(d,+o,v);
 d[20]=180;d[22]=60;return a.seedArchive(m,d,c);
}
test('MPD4 retreat is not copied into MEX1 pole pairs; calibration stays invalid',()=>{
 for(const m of [7,8]){
  const d=seed(m);assert.equal(p.word(d.extra,32),1);
  assert.equal(d.main[16],2);assert.equal(p.word(d.main,20),0);assert.equal(p.word(d.main,24),0);
  assert.deepEqual([28,32,36,40,44].map(o=>p.word(d.main,o)),[0x855e,0x2000180,0x2000180,0xe60000,0xaf00000]);
  assert.equal(p.word(d.extra,120),p.crc32(d.extra.slice(0,120)));
 }
});
test('applying motion configuration cannot import stale PI drafts',()=>{
 const base=seed(7).main,pid=p.pidFromProfile(base);
 const stale={...pid,flux_p:64,flux_i:48,torque_p:64,torque_i:48,vel_p:500,vel_i:250,pos_p:500,overwrite_target:false};
 const cfg={planning:'limits',mode:'position_direct',max_rpm:10000,trip_ma:1000,
  accel_deg_s2:6000,decel_deg_s2:6000,over_ms:180,sample_ms:60,comm_timeout_ms:1000,fault_action:'disable'};
 const next=p.profileWithControlOnly(base,stale,cfg,7);
 assert.deepEqual(next.slice(28,48),base.slice(28,48));
 assert.equal(p.word(next,112),Math.floor(10000*p.COUNTS_PER_RPM));
});

test('only RUN2 archives are accepted; no implicit legacy migration',()=>{
 const base=seed(7).main;
 assert.equal(p.checkedProfile(base,7),base);
 for(const tag of [0,0x314e5552]){
  const old=[...base];p.putWord(old,68,tag);p.putWord(old,120,p.crc32(old.slice(0,120)));
  assert.throws(()=>p.checkedProfile(old,7));
  assert.throws(()=>p.profileWithLongTermOnly(old,p.pidFromProfile(base),7));
 }
});
