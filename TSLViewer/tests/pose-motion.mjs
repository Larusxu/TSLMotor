import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
function module(file,require){const out={};new Function('exports','require',ts.transpileModule(readFileSync(new URL(`../src/lib/${file}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(out,require);return out;}

test('prepare batches enables and preserves enabled nonparticipants',async()=>{
 const writes=[];let enabled=256;
 const {createPosePort}=module('pose-motion',()=>({
  readMotionRegisters:async a=>a===534?[1,2,3,4]:a===593?[enabled]:[5000,77|((enabled&(1<<((a-768)/16)))?2:0),0,0,0,0,0,0,0,1,1,3,0,0,1,0],
  writeMotionRegisters:async(a,v)=>{writes.push([a,v]);if(a===593)enabled=v[0];}
 }));
 await createPosePort(()=>true).prepare([{motors:{1:50,2:50},cylinders:{}}]);
 assert.deepEqual(writes,[[593,[259]]]);
});

test('button and cancellation cleanup share one stop transaction',async()=>{
 const writes=[];
 const {createPosePort}=module('pose-motion',name=>name==='./semantic-motion'?{semanticMotion:{command:async(n,c)=>{writes.push([n,c]);}}}:({
  readMotionRegisters:async a=>a===534?[1,2,3,4]:[5000,79,0,0,0,0,0,0,0,1,1,3,0,0,1,0],
  writeMotionRegisters:async(a,v)=>{writes.push([a,v]);}
 }));
 const port=createPosePort(()=>true);await port.prepare([{motors:{1:50},cylinders:{}}]);
 await Promise.all([port.stop(),port.stop()]);await port.stop();
 assert.deepEqual(writes,[[1,{kind:'stop',after:1}]]);
});

test('cancelled read cannot report a previous task result as a new error',async()=>{
 let active=true,submitted=false;
 const {createPosePort}=module('pose-motion',()=>({
  readMotionRegisters:async a=>{
   if(a===534)return [1,2,3,4];
   if(submitted)active=false;
   return [5000,79,0,0,0,0,0,0,0,1,1,submitted?4:3,submitted?4:0,0,1,0];
  },writeMotionRegisters:async()=>{submitted=true;}
 }));
 const port=createPosePort(()=>active),p={motors:{1:50},cylinders:{}};
 await port.prepare([p]);await port.send(p);
 await assert.rejects(port.arrived(p),/已停止或连接已改变/);
});

test('waiting reports the pending axis and advances only on controller arrival',async()=>{
 let reads=0,sent=false;
 const {createPosePort}=module('pose-motion',name=>name==='./semantic-motion'?{semanticMotion:{enable:async()=>assert.fail()}}:{
  readMotionRegisters:async a=>a===534?[1,2,3,4]:[24,sent&&++reads>=3?111:79,0,0,0,300,0,0,0,10,1,3,0,0,1,0],
  writeMotionRegisters:async()=>{sent=true;}
 });
 const p={name:'last',group:null,duration_ms:1000,motors:{2:.03},cylinders:{}};
 const waiting=[],port=createPosePort(()=>true,()=>{},s=>waiting.push(s));
 await port.prepare([p]);await port.send(p);await port.arrived(p);
 assert(waiting.some(s=>s.includes('M02')&&s.includes('0.24%')&&s.includes('0.03%')));
 assert.equal(waiting.at(-1),'');assert.equal(reads,3);
});
for(const result of [1,6,15])test(`controller notice ${result} lets the sequence continue`,async()=>{
 let sent=false;
 const {createPosePort}=module('pose-motion',name=>{
  if(name==='./semantic-motion')return {semanticMotion:{enable:async()=>assert.fail()}};
  if(name==='./motion-registers')return {
   readMotionRegisters:async a=>a===534?[1,2,3,4]:[6,111,0,0,0,300,0,0,0,10,1,sent?4:3,sent?result:0,0,1,0],
   writeMotionRegisters:async()=>{sent=true;}
  };
  assert.fail(name);
 });
 const p={name:'return',group:null,duration_ms:1000,motors:{13:100.02},cylinders:{}};
 const notices=[],port=createPosePort(()=>true,message=>notices.push(message));
 await port.prepare([p]);await port.send(p);
 await port.arrived(p);
 assert.equal(notices.length,1);assert.match(notices[0],new RegExp(`M13.*result=${result}`));
 assert.match(notices[0],/未执行/);
});
test('real sequence adapter runs recorded 14 motor / 5 cylinder endpoint poses',async()=>{
 const ids=[1,2,3,4,5,6,9,10,11,12,13,14,15,16];
 const motors=Object.fromEntries(ids.map(n=>[n,n>=15?50:100]));
 const cylinders=Object.fromEntries([1,2,3,4,5].map(n=>[n,[0,894,618,418,79][n-1]]));
 const writes=[];
 const regs={readMotionRegisters:async(address)=>{
  if(address===534)return [1,2,3,4];
  if(address<1024){const n=1+(address-768)/16;return [Math.round(motors[n]*100),writes.length?110:94,0,0,0,300,0,0,0,10,0,3,0,0,0,0];}
  const n=1+(address-1024)/32;return [cylinders[n]+3,cylinders[n],0,0,0,27,0,1800,0,0,0,1];
 },writeMotionRegisters:async(address,values)=>{
  writes.push([address,values]);
  if(address<592)values.forEach((v,i)=>motors[address-575+i]=v/100);
  else if(address>=1024)cylinders[1+(address-1039)/32]=values[0];
 }};
 const limits=Array.from({length:21},()=>({min:0,max:100}));
 const {createPosePort}=module('pose-motion',name=>{
  if(name==='./motion-registers')return regs;
  if(name==='./semantic-motion')return {semanticMotion:{enable:async()=>assert.fail('already enabled')}};
  if(name==='./motion-travel')return {getMotionTravel:()=>limits,readMotionTravel:async()=>{}};
  assert.fail(name);
 });
 const {playSequence}=module('pose-sequence',()=>assert.fail());
 const first={name:'pose01',group:null,duration_ms:1000,motors:{...motors,10:100.02,13:100.02},cylinders:{...cylinders}};
 const second={...first,name:'pose02',motors:{...motors,2:.03,3:.13,12:.08,13:.06}};
 await playSequence({format:'teslahand.pose-sequence',version:1,poses:[first,second]},createPosePort(()=>true),()=>true);
 assert.equal(motors[2],.03);assert.equal(motors[10],100);assert.ok(writes.some(([a,v])=>a<=585&&v[585-a]===10002));assert.equal(motors[13],.06);
 assert.equal(writes.length,14); // two contiguous motor groups + five cylinders per pose
 assert.equal(first.motors[10],100.02);
});

test('slow telemetry does not block the next interpolated target',async()=>{
 let slow=false,release;const writes=[];
 const blocked=new Promise(resolve=>{release=resolve;});
 const {createPosePort}=module('pose-motion',()=>({
  readMotionRegisters:async a=>{if(slow)await blocked;return a===534?[1,2,3,4]:[5000,111,0,0,0,0,0,0,0,1,1,3,0,0,1,0];},
  writeMotionRegisters:async(a,v)=>{writes.push([a,v]);}
 }));
 const port=createPosePort(()=>true),p={motors:{1:50},cylinders:{}};
 await port.prepare([p]);slow=true;
 try{
  await port.send(p);
  await Promise.race([port.send({motors:{1:60},cylinders:{}}),new Promise((_,reject)=>setTimeout(()=>reject(Error('target blocked by telemetry')),250))]);
  assert.deepEqual(writes,[[576,[5000]],[576,[6000]]]);
 }finally{release();}
 await port.arrived(p);
});

test('replacement drains in-flight target and retires old cleanup without STOP',async()=>{
 let release,blocked=false;const writes=[],stops=[];
 const {createPosePort}=module('pose-motion',name=>name==='./semantic-motion'?{semanticMotion:{command:async(...v)=>stops.push(v)}}:{
  readMotionRegisters:async a=>a===534?[1,2,3,4]:a>=1024?[0,0,0,0,0,27,0,2000,0,0,0,1]:[5000,111,0,0,0,0,0,0,0,1,1,3,0,0,1,0],
  writeMotionRegisters:async(a,v)=>{writes.push([a,v]);if(!blocked){blocked=true;await new Promise(r=>release=r);}}
 });
 const pose={motors:{1:20,3:30},cylinders:{1:100}};
 const old=createPosePort(()=>true);await old.prepare([pose]);
 const inflight=old.send(pose);old.supersede();release();
 await assert.rejects(inflight);await old.stop();
 assert.deepEqual(writes,[[576,[2000]]]);assert.deepEqual(stops,[]);
 const next=createPosePort(()=>true);await next.prepare([pose]);await next.send({...pose,motors:{1:80,3:70}});
 await old.stop();assert.deepEqual(stops,[]);
 assert.deepEqual(writes,[[576,[2000]],[576,[8000]],[578,[7000]],[1039,[100]]]);
 await next.stop();assert.equal(stops.length,2);
});

test('explicit STOP remains available while a replacement drains',async()=>{
 const stops=[];
 const {createPosePort}=module('pose-motion',name=>name==='./semantic-motion'?{semanticMotion:{command:async(...v)=>stops.push(v)}}:{
  readMotionRegisters:async a=>a===534?[1,2,3,4]:[5000,111,0,0,0,0,0,0,0,1,1,3,0,0,1,0],
  writeMotionRegisters:async()=>{}
 });
 const port=createPosePort(()=>true);await port.prepare([{motors:{1:50},cylinders:{}}]);
 port.supersede();await port.stop();assert.equal(stops.length,0);
 await port.stop(true);assert.deepEqual(stops,[[1,{kind:'stop',after:1}]]);
});
