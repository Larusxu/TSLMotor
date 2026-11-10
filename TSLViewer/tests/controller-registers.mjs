import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const js=ts.transpileModule(readFileSync(new URL('../src/lib/controller-registers.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function load(call){const exports={};new Function('exports','require',js)(exports,()=>({api:{mainControl:call}}));return exports;}
test('read/write codec validates transaction identity and big-endian words',async()=>{
 const calls=[];const m=load(async(motor,op,q)=>{calls.push(q);assert.equal(motor,0);assert.equal(op,35);return [...q.slice(0,3),0,...(q[2]===3?[0x12,0x34,0xab,0xcd]:[])];});
 assert.deepEqual(await m.controllerRegisters(640,2),[0x1234,0xabcd]);
 await m.controllerRegisters(640,2,m.splitRegister32(15000));
 assert.deepEqual(calls[1].slice(2),[16,2,128,0,2,0,0,58,152]);
 const stale=load(async()=>[0,0,3,0,0,0]);await assert.rejects(stale.controllerRegisters(576,1),/不匹配/);
 await assert.rejects(m.controllerRegisters(640,2,[1.5,0]));
 assert.deepEqual(m.registerWords('0x10 20',2),[16,20]);assert.throws(()=>m.registerWords('1.5',1));
});
test('all sixteen motors and five cylinders map to distinct writable groups',()=>{
 const m=load(()=>assert.fail());const groups=Array.from({length:16},(_,i)=>m.motorControlRegisters(i+1)).flat();
 assert.equal(new Set(groups.map(r=>r.address)).size,80);
 assert.equal(m.motorControlRegisters(16)[4].address,1304);
 assert.equal(m.cylinderControlRegisters(5)[0].address,1152);
 assert.equal(m.cylinderControlRegisters(5)[4].address,1166);
});
