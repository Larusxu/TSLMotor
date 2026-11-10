import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
const js = ts.transpileModule(readFileSync(new URL('../src/lib/split-storage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function module(invoke, hardware = true, open = async () => {}) {
  const exports = {};
  new Function('exports', 'require', js)(exports, name => {
    if (name === './api') return { invokeCommand: hardware ? invoke : () => Promise.reject(Error('Tauri unavailable')) };
    if (name === './semantic-motion') return { semanticMotion: {ensureConfigurationSession: open} };
    if (name === '@tauri-apps/api/core') return { invoke };
    throw new Error(name);
  });
  return exports;
}
test('C-generated compact backup vector and every bit corruption', () => {
  const codec = module(() => { throw new Error('No transport needed'); });
  const data = [...readFileSync(new URL('./fixtures/motor-backup-v1.bin', import.meta.url))];
  assert.deepEqual(codec.decodeBackup(data, 65535, 9), {handId:65535,motor:9,offset:43210,generation:0x12345678});
  for (let i=0;i<128;i++) {const bad=[...data];bad[i>>3]^=1<<(i&7);assert.throws(()=>codec.decodeBackup(bad,65535,9));}
  // Hand identity binding was intentionally removed; CRC remains required.
  assert.equal(codec.decodeBackup(data,1,9).handId,1);
});
test('passive reads retry only explicit BUSY, serialize across pages, and do not open a session', async () => {
  const calls=[]; let first=true;
  const service=module(async (_,{motor,request:q})=>{
    calls.push([motor,q.operation,q.offset]);
    if(first){first=false;return {phase:5,result:-7,flags:0};}
    return {id:q.id,motor,operation:q.operation===6?1:q.operation,phase:4,result:0,generation:1,hand_id:1,flags:1,offset:q.offset,data:Array(q.offset?22:106).fill(motor)};
  },true,()=>assert.fail('passive read opened motion session'));
  const result=await Promise.all([service.storageJob(1,1),service.storageJob(9,1)]);
  assert.deepEqual(calls,[[1,1,0],[1,1,0],[1,6,106],[9,1,0],[9,6,106]]);
  assert.equal(result[0].data.length,128);assert.equal(result[1].data[0],9);
});
test('explicit write rejection is not replayed and uses configuration session', async () => {
  let opened=0,calls=0;
  const service=module(async()=>{calls++;return {phase:5,result:-7,flags:0};},true,async()=>{opened++;});
  await assert.rejects(service.storageJob(9,10),/-7/);
  assert.equal(opened,1);assert.equal(calls,1);
});
test('two chunks, one commit, immutable status polling and complete data', async () => {
  const calls=[];const data=Array.from({length:128},(_,i)=>i);
  const service=module(async (command,{motor,request:q})=>{
    calls.push({...q});assert.equal(command,'motor_storage');assert.equal(motor,9);
    return {id:q.id,motor,operation:q.operation===6?3:q.operation,phase:q.operation===2?1:q.operation===3?2:4,
      result:0,generation:q.operation===6?7:0,hand_id:1,flags:1,offset:q.offset,
      data:q.operation===6?data.slice(q.offset,q.offset+106):[]};
  });
  const r=await service.storageJob(9,3,data);
  assert.deepEqual(r.data,data);assert.equal(r.generation,7);
  assert.deepEqual(calls.map(c=>c.operation),[2,2,3,6,6]);
  assert.deepEqual(calls[0].data,data.slice(0,106));assert.deepEqual(calls[1].data,data.slice(106));
  assert.equal(new Set(calls.map(c=>c.id)).size,1);
});
test('ambiguous commit failure is never retried; preview cannot fake storage', async () => {
  const calls=[];const service=module(async (_,{request:q})=>{
    calls.push(q.operation);if(q.operation===3)throw new Error('ambiguous timeout');
    return {phase:1,result:0};
  });
  await assert.rejects(service.storageJob(9,3,Array(128).fill(0)),/ambiguous timeout/);
  assert.deepEqual(calls,[2,2,3]);
  await assert.rejects(module(()=>assert.fail('preview invoked transport'),false).storageJob(9,1),/Tauri/);
});
test('failed terminal and inconsistent fragments do not produce success', async () => {
  await assert.rejects(module(async()=>({phase:5,result:-4,flags:4})).storageJob(9,4),/-4/);
  const service=module(async (_,{motor,request:q})=>({id:q.id,motor,operation:1,phase:4,result:0,
    generation:q.offset?2:1,hand_id:1,flags:1,offset:q.offset,data:Array(q.offset?22:106).fill(0)}));
  await assert.rejects(service.storageJob(9,1),/分片/);
});
