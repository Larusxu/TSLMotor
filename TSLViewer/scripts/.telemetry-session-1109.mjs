import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {hardware} from './.m1-hardware.mjs';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/telemetry-session-1109.json',{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};
globalThis.__realInvoke=(...a)=>h.invoke(...a);
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64'),cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{
  if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__realInvoke(...a)'));
  if(name==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=()=>{throw Error("No desktop events in CLI test")};'));
  if(!name.startsWith('.'))throw Error('Unmapped '+name);
  return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),name+'.ts')));
 });const url=data(code);cache.set(file,url);return url;
}
let motion;
try{
 const pre=await h.invoke('motor_semantic',{motor:9,request:{request_id:1,boot_id:'0',session_id:0,task_id:0,command:{kind:'get_state'}}});
 assert(!pre.motor.motion_active&&pre.motor.drive===0,'Read-only test requires idle motor');
 motion=(await import(load(fileURLToPath(new URL('../src/lib/semantic-motion.ts',import.meta.url))))).semanticMotion;
 const display=await import(load(fileURLToPath(new URL('../src/lib/semantic-state.ts',import.meta.url))));
 let previous=null,telemetryReads=0;
 motion.subscribe((r,m)=>{if(m!==9)return;if(r.motor){previous=display.retainMotorTelemetry(r.motor,previous);}else if(r.telemetry&&previous){previous=display.mergeMotorTelemetry(previous,r.telemetry);telemetryReads++;}});
 await motion.command(9,{kind:'get_state'});
 await new Promise(r=>setTimeout(r,1600));
 assert(telemetryReads>=2);assert(previous.bus_voltage_mv>20000&&previous.bus_voltage_mv<30000);
 assert(previous.target_logical_position!=null);assert(previous.drive===0&&!previous.motion_active);
 console.log(JSON.stringify({result:'PASS',telemetryReads,volts:previous.bus_voltage_mv/1000,target:previous.target_logical_position,position:previous.logical_position,motionActive:previous.motion_active}));
}finally{try{if(motion)await motion.close();}finally{await h.close();}}
