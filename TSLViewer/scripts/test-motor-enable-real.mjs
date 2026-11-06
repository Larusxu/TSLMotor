/** Production SemanticMotion on real M9: initialize, idempotent initialize, OFF, ON. No PWM enable or movement. */
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {hardware} from './pi-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/pi-enable-toggle-1105.json',{managed:false});
globalThis.__enableInvoke=(...a)=>h.invoke(...a);
let source=fs.readFileSync(new URL('../src/lib/semantic-motion.ts',import.meta.url),'utf8');
source=source.replace('import { invokeCommand } from "./api";','const invokeCommand=(...a:any[])=>globalThis.__enableInvoke(...a);');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {semanticMotion:m}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
try{
 const started=Date.now(),first=await m.initialize(9);assert(first.motor.config_verified&&first.motor.logic_power);console.log('INITIALIZE_MS',Date.now()-started);
 const before=h.records.length,again=Date.now();await m.initialize(9);
 assert(!h.records.slice(before).some(r=>r.request?.command?.kind==='commission'));console.log('ALREADY_READY_MS',Date.now()-again);
 await m.powerOff(9);
 let off=await m.command(9,{kind:'get_state'});assert.equal(off.motor.logic_power,false);assert.equal(off.motor.config_verified,false);assert.equal(off.motor.fault,0);console.log('OFF_CONFIRMED',JSON.stringify(off.motor));
 await new Promise(r=>setTimeout(r,1000));off=await m.command(9,{kind:'get_state'});assert.equal(off.motor.fault,0);assert.equal(off.motor.logic_power,false);
 const enabled=await m.initialize(9);assert(enabled.motor.logic_power&&enabled.motor.config_verified);assert.equal(enabled.motor.fault,0);assert.equal(enabled.motor.motion_active,false);
 console.log('REENABLE_CONFIRMED_NO_MOTION',JSON.stringify(enabled.motor));
}finally{await m.close().catch(()=>{});await h.close();}
