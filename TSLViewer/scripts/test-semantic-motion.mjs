// Protocol orchestration unit tests; no browser, hardware, or motion simulation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
let boot='1',powered=true,calls=[];
globalThis.__motionInvoke=async(name,args)=>{
 if(name==='main_control'){
   calls.push({kind:'gateway',op:args.op});
   if(args.op===5){powered=false;return [];}
   return [3,2,1,12,17,1,0,1,0,16]; // diagnostics_live=0 is valid with outputs OFF.
 }
 const q=args.request,cmd=q.command;calls.push(cmd);
 return {protocol_version:2,operation:1,request_id:q.request_id,replayed:false,result:0,result_name:'OK',boot_id:boot,session_id:cmd.kind==='close'?0:q.session_id,task_id:0,timestamp_ms:1,pending:false,
   device:{capabilities:3,request_floor:q.request_id,stopping:false},motor:args.motor?{logic_power:powered,config_verified:powered,limits_valid:powered,drive:0,motion_active:false,pending_action:0,fault:0,last_error:0}:null};
};
let source=fs.readFileSync(new URL('../src/lib/semantic-motion.ts',import.meta.url),'utf8').replace('import { invokeCommand } from "./api";','const invokeCommand=(...a:any[])=>globalThis.__motionInvoke(...a);');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {SemanticMotion}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const m=new SemanticMotion();let errors=0;m.subscribeErrors(()=>errors++);
try{
 await m.initialize(9);assert(!calls.some(c=>c.kind==='commission'));
 const beforeCancel=calls.length;
 await assert.rejects(m.taskCommand(9,0,1000,{kind:'logical_move',position:'100'},()=>false),/运动请求已取消/);
 assert.equal(calls.length,beforeCancel); // An obsolete slider producer cannot enqueue motion.

 boot='2';const r=await m.command(9,{kind:'get_state'});assert.equal(r.boot_id,'2');assert.equal(errors,0);
 await m.powerOff(9);assert.equal(powered,false);assert(!m.owned());assert(calls.some(c=>c.kind==='gateway'&&c.op===5));
 powered=true;await m.command(9,{kind:'get_state'});boot='3';
 const before=calls.length;await assert.rejects(m.command(9,{kind:'drive_enable'}),/主控已重启/);
 assert.equal(calls.slice(before).filter(c=>c.kind==='drive_enable').length,1);
 console.log('PASS idempotent initialize, reboot read recovery without toast, single-route OFF and no replay of writes');
}finally{boot='2';await m.close().catch(()=>{});}
