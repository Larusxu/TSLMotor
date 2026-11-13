import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
const out={};
new Function('exports',ts.transpileModule(readFileSync(new URL('../src/lib/pose-sequence.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(out);
const fixture=()=>({format:out.POSE_FORMAT,version:1,poses:[
 {name:'姿态01',group:1,duration_ms:100,motors:{1:20,15:40,16:50},cylinders:{1:300,5:400}},
 {name:'姿态02',group:1,duration_ms:100,motors:{1:40,15:60,16:70},cylinders:{1:600,5:800}}
]});
test('editing shared references updates axis data while keeping row timing and linkage',()=>{
 const d=fixture();d.poses[0].alias='Open';
 d.poses.push({...structuredClone(d.poses[0]),name:'姿态03',group:null,wait_ms:700});
 const linked=out.linkPoseReferences(d);
 assert.equal(linked.poses[0].pose_id,linked.poses[2].pose_id);
 assert.notEqual(linked.poses[0].pose_id,linked.poses[1].pose_id);
 const changed=out.replacePoseData(linked,'姿态03',{motors:{1:35,15:40,16:50},cylinders:{1:350,5:450}});
 assert.equal(changed.poses[0].motors[1],35);assert.equal(changed.poses[2].motors[1],35);
 assert.equal(changed.poses[1].motors[1],40);assert.equal(changed.poses[2].wait_ms,700);
 assert.equal(changed.poses[0].group,1);assert.equal(changed.poses[2].group,null);
 assert.equal(linked.poses[0].motors[1],20);
 assert.deepEqual(out.linkPoseReferences(changed),changed);
});
test('preflight rejection does not stop or disable axes that never received a target',async()=>{
 let stopped=0;
 await assert.rejects(out.playSequence(fixture(),{prepare:async()=>{throw Error('limit');},stop:async()=>{stopped++;}},()=>true),/limit/);
 assert.equal(stopped,0);
});
test('pose JSON validates units, names, contiguous groups and identical axes',()=>{
 const d=fixture();assert.deepEqual(out.validateSequence(d),d);
 for(const mutate of [d=>d.poses[0].motors[17]=20,d=>d.poses[0].motors[1]=NaN,d=>d.poses[0].cylinders[1]=2.5,d=>delete d.poses[1].motors[16]]){
  const bad=fixture();mutate(bad);assert.throws(()=>out.validateSequence(bad));
 }
 assert.equal(out.nextPoseName(d.poses),'姿态03');assert.equal(out.nextPoseName([{name:'姿态99'}]),'姿态100');
});
test('linked playback interpolates every axis, waits only at group end',async()=>{
 const sent=[],arrived=[];const d=fixture();
 await out.playSequence(d,{
  prepare:async()=>{},capture:async()=>({motors:{1:0,15:0,16:0},cylinders:{1:0,5:0}}),
  send:async p=>sent.push(p),arrived:async p=>arrived.push(p.name),stop:async()=>assert.fail('unexpected stop')
 },()=>true);
 assert.deepEqual(arrived,['姿态02']);
 for(const [field,key,max] of [['motors','1',20],['motors','15',40],['motors','16',50],['cylinders','1',300],['cylinders','5',400]]){
  assert(sent.some(p=>p[field][key]>0&&p[field][key]<max));
 }
 assert.deepEqual(sent.at(-1),{motors:d.poses[1].motors,cylinders:d.poses[1].cylinders});
});
test('transport error stops all through the port and never retries target',async()=>{
 let sends=0,stops=0;
 await assert.rejects(out.playSequence(fixture(),{
  prepare:async()=>{},capture:async()=>({motors:{1:0,15:0,16:0},cylinders:{1:0,5:0}}),
  send:async()=>{sends++;throw Error('lost ACK');},arrived:async()=>assert.fail(),stop:async()=>{stops++;}
 },()=>true),/lost ACK/);
 assert.equal(sends,1);assert.equal(stops,1);
});
test('Python export runs with SDK entry point and lossless JSON including hostile names',()=>{
 const d=fixture();d.poses[0].name=`姿态01'''\nraise Exception('injected')`;
 const script=out.pythonScript(d);
 const program=`import ast,sys,types,json\nsource=sys.stdin.read()\nast.parse(source)\nclass Hand:\n @classmethod\n def open_rs485(cls,port):\n  assert port=='TEST'\n  return cls()\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def play_sequence(self,d): print(json.dumps(d))\nsys.modules['teslahand_sdk']=types.SimpleNamespace(TeslaHand=Hand)\nsys.argv=['sequence.py','--port','TEST']\nexec(compile(source,'sequence.py','exec'),{'__name__':'__main__'})\n`;
 const r=spawnSync('python',['-c',program],{input:script,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),d);
});
test('interpolation has matching velocity at knots without overshoot',()=>{
 const v=[0,30,80,20],t=[1,2,1],e=1e-5;
 for(let i=0;i<3;i++)for(let j=0;j<=100;j++){const x=out.interpolate(v,t,i,j/100);assert(x>=Math.min(v[i],v[i+1])-1e-8&&x<=Math.max(v[i],v[i+1])+1e-8);}
 const left=(out.interpolate(v,t,0,1)-out.interpolate(v,t,0,1-e))/e;
 const right=(out.interpolate(v,t,1,e)-out.interpolate(v,t,1,0))/(2*e);
 assert(Math.abs(left-right)<.002);
});

test('post-arrival wait splits linked interpolation and precedes the next target',async()=>{
 for(const mutate of [d=>d.round_interval_ms=-1,d=>d.poses[0].wait_ms=-1,d=>d.poses[0].alias=123]){const invalid=fixture();mutate(invalid);assert.throws(()=>out.validateSequence(invalid));}
 const d=fixture();d.poses[0].alias='Open';d.poses[0].wait_ms=90;
 const arrivals=[];let secondAt=0;
 await out.playSequence(d,{
  prepare:async()=>{},capture:async()=>({motors:{1:0,15:0,16:0},cylinders:{1:0,5:0}}),
  send:async()=>{if(arrivals.length===1&&!secondAt)secondAt=performance.now();},
  arrived:async p=>arrivals.push([p.name,performance.now()]),stop:async()=>assert.fail('unexpected stop')
 },()=>true);
 assert.deepEqual(arrivals.map(a=>a[0]),['姿态01','姿态02']);
 assert(secondAt-arrivals[0][1]>=80);
 assert.equal(out.validateSequence(d).poses[0].alias,'Open');
});

test('loop observes round gap and stop interrupts a wait promptly',async()=>{
 const d=fixture();d.poses=d.poses.slice(0,1);d.poses[0].group=null;d.round_interval_ms=90;
 const sends=[];let active=true,stops=0;
 await assert.rejects(out.playSequence(d,{
  prepare:async()=>{},send:async()=>sends.push(performance.now()),arrived:async()=>{if(sends.length===2)setTimeout(()=>{active=false;},10);},stop:async()=>{stops++;}
 },()=>active,()=>{},true),/已停止/);
 assert.equal(sends.length,2);assert(sends[1]-sends[0]>=80);assert.equal(stops,1);
});
