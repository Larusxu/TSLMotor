import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
const js = ts.transpileModule(readFileSync(new URL('../src/lib/semantic-state.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function load(invoke = () => assert.fail('unexpected invoke'), hardware = true) {
  const exports = {};
  new Function('exports', 'require', js)(exports, name => {
    if (name === './api') return { invokeCommand: hardware ? invoke : () => Promise.reject(Error('浏览器预览没有后端')) };
    if (name === '@tauri-apps/api/core') return { invoke };
    throw new Error(name);
  });
  return exports;
}
function reply(motor, id, boot = '18446744073709551615') {
  return {protocol_version:2,operation:1,request_id:id,boot_id:boot,session_id:0,
    task_id:0,timestamp_ms:20,result:0,result_name:'OK',replayed:false,pending:false,
    device:motor === 0 ? {capabilities:3,motors:16,source:0,active_motor:0,stopping:false,request_floor:9} : null,
    motor:motor === 0 ? null : {position:'-9007199254740993',feedback_fresh:false,align_valid:false,span_valid:false}};
}
test('device and motor share boot, exact decimal identity/count and freshness', async () => {
  const {SemanticStateSource,semanticFresh} = load();
  const seen=[];
  const source=new SemanticStateSource(async(m,id)=>{seen.push(m);return reply(m,id);},()=>5000);
  const v=await source.poll(9);
  assert.deepEqual(seen,[0,9]);assert.equal(v.bootId,'18446744073709551615');
  assert.equal(v.state.position,'-9007199254740993');assert.equal(v.state.feedback_fresh,false);
  assert(semanticFresh(v,7000));assert(!semanticFresh(v,7001));assert(!semanticFresh(v,4999));
});
test('all calls are zero-session read-only discovery; no browser fake state', async () => {
  const calls=[];
  const {SemanticStateSource}=load(async(command,{motor,request:q})=>{
    calls.push(command);assert.deepEqual(q.command,{kind:calls.length===3?'telemetry_state':motor?'position_state':'get_state'});
    assert.equal(q.boot_id,'0');assert.equal(q.session_id,0);assert.equal(q.task_id,0);
    return reply(motor,q.request_id,'0');
  });
  const v=await new SemanticStateSource().poll(9);
  assert.equal(v.bootId,'0');assert.equal(v.state.align_valid,false);
  assert.deepEqual(calls,['motor_semantic','motor_semantic','motor_semantic']);
  const preview=await new (load(undefined,false).SemanticStateSource)().poll(9);
  assert.equal(preview.state,null);assert.match(preview.error,/浏览器/);
});
test('reboot invalidates old identity; rejected reads retain original timestamp without refreshing it', async () => {
  const {SemanticStateSource}=load();
  for (const bad of ['boot','session','replay','failure','request']) {
    let corrupt=false;
    const source=new SemanticStateSource(async(m,id)=>{
      if(corrupt&&bad==='failure')throw new Error('lost');
      const r=reply(m,id);
      if(corrupt&&m){if(bad==='boot')r.boot_id='2';if(bad==='session')r.session_id=5;
        if(bad==='replay')r.replayed=true;if(bad==='request')r.request_id++;}
      return r;
    });
    assert((await source.poll(9)).state);corrupt=true;
    const before=source.view();const v=await source.poll(9);assert(v.error,bad);
    if(bad==='boot')assert.equal(v.state,null,bad);
    else {assert.equal(v.state,before.state,bad);assert.equal(v.receivedAt,before.receivedAt,bad);}
  }
});
test('motor/connection change quarantines pending responses and never overlaps queries', async () => {
  const {SemanticStateSource}=load();let complete;let calls=0;
  const source=new SemanticStateSource((m,id)=>{calls++;return new Promise(resolve=>{complete=()=>resolve(reply(m,id));});});
  const pending=source.poll(9);await source.poll(9);assert.equal(calls,1);
  source.reset(2);complete();await pending;assert.equal(calls,1);
  assert.equal(source.view().motor,2);assert.equal(source.view().state,null);
});
