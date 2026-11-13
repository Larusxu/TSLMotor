import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
function load(path, deps) {
 const js=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports={};new Function('exports','require',js)(exports,name=>deps[name]??{});return exports;
}
const codec=load('../src/lib/motor-profile-ui.ts',{});
test('concurrent travel edits preserve other axes and verify public flash readback',async()=>{
 let data=Array(128).fill(0);data.splice(0,4,84,82,86,49);
 for(let i=0;i<21;i++){data[10+i*4]=16;data[11+i*4]=39;}
 codec.putWord(data,120,codec.crc32(data.slice(0,120)));
 const operations=[];
 const service=load('../src/lib/motion-travel.ts',{'react':{useSyncExternalStore:(_,get)=>get()},'./motor-profile-ui':codec,'./split-storage':{storageJob:async(m,op,p)=>{
  assert.equal(m,0);operations.push(op);
  if(op===15)data=[...p];return {data:[...data]};
 }}});
 await Promise.all([service.saveMotionTravel(0,{min:20,max:110}),service.saveMotionTravel(20,{min:5,max:125})]);
 const ranges=service.useMotionTravel();assert.deepEqual(ranges[0],{min:20,max:110});assert.deepEqual(ranges[20],{min:5,max:125});assert.deepEqual(ranges[1],{min:0,max:100});
 assert.deepEqual(operations,[14,15,14,14,15,14]);
 assert.equal(service.useArrivalTolerance(),.5); // legacy reserved word = 0
 await Promise.all([service.saveArrivalTolerance(.75),service.saveMotionTravel(1,{min:1,max:99})]);
 assert.equal(service.useArrivalTolerance(),.75);
 assert.deepEqual(service.useMotionTravel()[0],{min:20,max:110});
 assert.deepEqual(service.useMotionTravel()[1],{min:1,max:99});
 assert.equal(data[4],75);
 for(const value of [0,-1,NaN,10.01])await assert.rejects(service.saveArrivalTolerance(value));
 for(const range of [{min:-1,max:100},{min:101,max:120},{min:10,max:10},{min:0,max:700}])await assert.rejects(service.saveMotionTravel(0,range));
 data[8]^=1;await assert.rejects(service.readMotionTravel(),/CRC/);
});
