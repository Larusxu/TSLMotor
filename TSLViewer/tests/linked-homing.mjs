import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
function load(file,require=()=>({})) {
  const exports={};
  const js=ts.transpileModule(readFileSync(new URL('../src/lib/'+file,import.meta.url),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText;
  new Function('exports','require',js)(exports,require);return exports;
}
const {LinkedHoming,defaultHomePartner,homeTargets}=load('linked-homing.ts',()=>load('multi-open-loop-jog.ts'));
function harness(fail=false) {
  const log=[],reads=new Map();
  const motion={
    command:async(motor,command)=>{log.push([motor,command.kind]);return {motor:{align_valid:true,config_verified:true,drive:0,fault:0}};},
    initialize:async motor=>log.push([motor,'initialize']),
    enable:async motor=>log.push([motor,'enable']),
    stop:async motor=>log.push([motor,'stop']),wait:async motor=>log.push([motor,'wait']),
  };
  const group=new LinkedHoming(motion,async motor=>{
    log.push([motor,'read']);const count=(reads.get(motor)??0)+1;reads.set(motor,count);
    return {stage:fail&&motor===16?3:count>=(motor===15?1:3)?2:1,error:1,message:fail?'timeout':''};
  },async()=>{});
  return {group,log,motion};
}
test('partner defaults, current motor inclusion, deduplication and invalid input',()=>{
  assert.equal(defaultHomePartner(15),'16');assert.equal(defaultHomePartner(16),'15');
  assert.deepEqual(homeTargets(15,true,'16,15,16'),[15,16]);
  assert.deepEqual(homeTargets(16,false,'15'),[16]);
  assert.throws(()=>homeTargets(15,true,'17'));
});
test('prepare both before START; start both before waiting; preserve independent completion',async()=>{
  const {group,log}=harness();await group.start([15,16],0);
  assert.ok(log.findIndex(([m,c])=>m===16&&c==='get_state')<log.findIndex(([,c])=>c==='homing_linked'));
  assert.ok(log.findIndex(([m,c])=>m===16&&c==='homing_linked')<log.findIndex(([,c])=>c==='read'));
  assert.equal(log.filter(([m,c])=>m===15&&c==='read').length,1);
  assert.equal(log.filter(([m,c])=>m===16&&c==='read').length,3);
  assert.equal(log.some(([,c])=>c==='stop'),false);
  assert.deepEqual(log.filter(([,c])=>c==='wait').map(([m])=>m),[15,16]);
  assert.ok(log.findIndex(([m,c])=>m===16&&c==='homing_linked')<log.findIndex(([,c])=>c==='wait'));
  assert.equal(group.getSnapshot().busy,false);assert.equal(group.getSnapshot().note,'找零完成');
});

test('complex pair uses grouped starts, restores both, then uses ordinary absolute moves to midpoint',async()=>{
  const {group,motion,log}=harness(),commands=[],original=motion.command;
  motion.command=async(m,c)=>{
    commands.push([m,c]);const r=await original(m,c);
    Object.assign(r.motor,{span_valid:true,logical_span:'100001',motion_active:false,arrival_phase:4});
    return r;
  };
  await group.start([15,16],0,10000,{complex:true,returnMiddle:true});
  assert.equal(commands.filter(([,c])=>c.kind==='homing_linked'&&c.complex).length,2);
  assert.deepEqual(commands.filter(([,c])=>c.kind==='logical_move').map(([m,c])=>[m,c.position]),[[15,'50000'],[16,'50000']]);
  assert.ok(log.findLastIndex(([,c])=>c==='wait')<log.findIndex(([,c])=>c==='logical_move'));
  assert.deepEqual(log.filter(([,c])=>c==='enable').map(([m])=>m),[15,16]);
  assert.ok(log.findLastIndex(([,c])=>c==='enable')<log.findIndex(([,c])=>c==='logical_move'));
  assert.ok(log.findLastIndex(([,c])=>c==='logical_move')<log.findIndex(([,c])=>c==='position_state'));
  assert.equal(group.getSnapshot().busy,false);
});
test('reject impossible complex/midpoint selection before any command',async()=>{
  const {group,log}=harness();
  await assert.rejects(group.start([15],0,10000,{complex:true}));
  await assert.rejects(group.start([15,16],1,10000,{returnMiddle:true}));
  assert.equal(log.length,0);
});

test('a failed preparation is reported before an idle HOME_STATE can hide it',async()=>{
  const {group,motion,log}=harness();const command=motion.command;let starts=0;
  motion.command=async(m,c)=>{
    const reply=await command(m,c);
    if(c.kind==='homing_linked')starts++;
    if(starts===2&&m===16&&c.kind==='get_state')reply.motor.last_error=13;
    return reply;
  };
  await assert.rejects(group.start([15,16],0),/M16.*error=13/);
  assert.deepEqual(log.filter(([,c])=>c==='stop').map(([m])=>m),[15,16]);
  assert.equal(group.getSnapshot().busy,false);
});
test('failure stops every attempted lane and keeps per-motor results',async()=>{
  const {group,log}=harness(true);await assert.rejects(group.start([15,16],0),/M16/);
  assert.deepEqual(log.filter(([,c])=>c==='stop').map(([m])=>m),[15,16]);
  assert.equal(group.getSnapshot().states[15].stage,2);assert.equal(group.getSnapshot().states[16].stage,3);
  assert.equal(group.getSnapshot().busy,false);
});
test('cancel during an accepted but unanswered START stops the attempted lane, never starts its partner',async()=>{
  const {group,log,motion}=harness();let release,started;
  const ready=new Promise(r=>started=r),original=motion.command;
  motion.command=async(m,c)=>{const result=await original(m,c);if(c.kind==='homing_linked'){started();await new Promise(r=>release=r);}return result;};
  const running=group.start([15,16],0);await ready;await group.stop();release();await running;
  assert.deepEqual(log.filter(([,c])=>c==='homing_linked').map(([m])=>m),[15]);
  assert.deepEqual(log.filter(([,c])=>c==='stop').map(([m])=>m),[15]);
  assert.equal(group.getSnapshot().note,'联动找零已取消');
});


 test('positive-first dual order is retained for both grouped requests',async()=>{
  const {group,motion}=harness(),commands=[],original=motion.command;
  motion.command=async(m,c)=>{commands.push([m,c]);return original(m,c);};
  await group.start([15,16],2,10000,{complex:true});
  const starts=commands.filter(([,c])=>c.kind==='homing_linked');
  assert.equal(starts.length,2);
  for(const [,c] of starts){assert.equal(c.direction,2);assert.equal(c.dual,true);assert.equal(c.complex,true);}
 });
