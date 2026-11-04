// Exercise the actual frontend session/lease executor with a deterministic
// transport and clock. No browser preview, serial port, firmware write or motion.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const js=ts.transpileModule(readFileSync(new URL('../src/lib/semantic-motion.ts',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
function harness(){
  let now=1000,session=0,boot='123',task=0,fail='',reject=null,block='',unblock;
  const log=[],errors=[],observed=[];
  const state={drive:0,mode:0,permit:false,config_verified:true,limits_valid:true,
    feedback_fresh:true,fault:0,last_error:0,velocity_raw:0,motion_owner:0,
    motion_active:false,align_valid:true,span_valid:true,logic_power:true,pending_action:0};
  const invoke=async(_, {motor,request:q})=>{
    const kind=q.command.kind;log.push(kind);
    if(kind===block)await new Promise(resolve=>{unblock=resolve;});
    if(fail===kind){fail='';throw Error('one read timeout');}
    let result=reject?.kind===kind?reject.result:0;
    if(!result){
      if(kind==='open')session=q.session_id;
      if(kind==='close')session=0;
      if(kind==='permit')state.permit=q.command.enabled;
      if(kind==='task_speed')state.mode=q.command.mode;
      if(kind==='drive_enable')state.drive=2;
      if(kind==='jog_start'||kind==='velocity_start'){task++;state.motion_owner=3;state.motion_active=true;}
      if(kind==='stop'){state.motion_active=false;state.motion_owner=0;state.drive=q.command.after===2?0:2;}
      if(kind==='logical_move'){task++;state.motion_owner=4;state.motion_active=true;}
    }
    return {protocol_version:2,operation:1,request_id:q.request_id,replayed:false,result,result_name:result?'REJECTED':'OK',
      boot_id:boot,session_id:session,task_id:motor?task:0,pending:!!state.pending_action,
      device:motor?null:{capabilities:3,request_floor:100},motor:motor?{...state}:null};
  };
  const exports={};
  new Function('exports','require','Date','setInterval','clearInterval','setTimeout','crypto',js)(exports,
    name=>name==='./api'?{HAS_TAURI:true}:{invoke}, {now:()=>now},()=>1,()=>{},
    fn=>{now+=100;queueMicrotask(fn);}, {getRandomValues:a=>{a[0]=1234;return a;}});
  const motion=new exports.SemanticMotion();motion.subscribeErrors(e=>errors.push(e));motion.subscribe(r=>observed.push(r));
  return {motion,log,state,errors,observed,advance:ms=>{now+=ms;},fail:kind=>{fail=kind;},
    reject:(kind,result)=>{reject=kind?{kind,result}:null;},reboot:()=>{boot='124';session=0;},
    block:kind=>{block=kind;},unblock:()=>{block='';unblock();}};
}
test('one state or pulse timeout keeps session, validity and permit renewal',async()=>{
  for(const kind of ['position_state','pulse']){
    const h=harness();await h.motion.permit(9,true);const before=h.observed.at(-1);
    h.advance(200);h.fail(kind);await h.motion.tick();assert(h.motion.owned());
    assert.equal(before.motor.align_valid,true);assert.equal(before.motor.span_valid,true);
    h.advance(200);await h.motion.tick();assert(h.motion.owned());assert(h.state.permit);
    assert(h.errors.some(e=>e.includes('timeout')));assert.equal(h.log.filter(k=>k==='open').length,1);
  }
});
test('held jog renews before telemetry and survives one read timeout',async()=>{
  const h=harness();await h.motion.permit(9,true);await h.motion.jog(9,30541,0);
  h.advance(200);h.fail('position_state');await h.motion.tick();
  for(let i=0;i<8;i++){h.advance(200);await h.motion.tick();}
  assert(h.motion.owned());assert(h.motion.heldJog);assert(h.state.permit);
  assert.equal(h.log.filter(k=>k==='jog_start').length,1);
  assert.equal(h.log.filter(k=>k==='jog_renew').length,9);
  assert(h.log.indexOf('jog_renew')<h.log.indexOf('position_state'));
  await h.motion.stop(9);const renews=h.log.filter(k=>k==='jog_renew').length;
  h.advance(200);await h.motion.tick();assert.equal(h.log.filter(k=>k==='jog_renew').length,renews);
});
test('stale completed jog task does not destroy authorization or session',async()=>{
  const h=harness();await h.motion.permit(9,true);await h.motion.jog(9,30541,0);
  h.reject('jog_renew',7);h.state.motion_owner=0;h.state.motion_active=false;
  h.advance(200);await h.motion.tick();assert(h.motion.owned());assert(!h.motion.heldJog);
  h.reject(null);h.advance(200);await h.motion.tick();assert(h.state.permit);assert(h.motion.owned());
});
test('missed jog deadline stops without replaying motion or closing healthy session',async()=>{
  const h=harness();await h.motion.permit(9,true);await h.motion.jog(9,30541,0);
  h.advance(600);await h.motion.tick();assert(!h.motion.heldJog);assert(h.motion.owned());
  assert.equal(h.log.filter(k=>k==='jog_start').length,1);assert.equal(h.state.motion_active,false);
});
test('expired authorization is revoked and never silently regranted',async()=>{
  const h=harness();await h.motion.permit(9,true);h.advance(1250);await h.motion.tick();
  assert(h.motion.owned());assert(!h.state.permit);assert(!h.motion.permitWanted);
  h.advance(200);await h.motion.tick();assert(!h.state.permit);
});
test('reboot or session deadline retires owner without automatic motion restart',async()=>{
  for(const reboot of [true,false]){
    const h=harness();await h.motion.permit(9,true);
    if(reboot)h.reboot();else h.advance(1600);
    await h.motion.tick();assert(!h.motion.owned());assert(!h.motion.permitWanted);assert(!h.motion.heldJog);
    assert.equal(h.log.filter(k=>k==='open').length,1);
  }
});
test('repeated same-mode tasks reuse preparation; close accepts acknowledged session=0',async()=>{
  const h=harness();await h.motion.permit(9,true);
  await h.motion.taskCommand(9,1,30541,{kind:'logical_move',position:'50'});
  h.state.motion_active=false;h.state.motion_owner=0;
  await h.motion.taskCommand(9,1,30541,{kind:'logical_move',position:'60'});
  assert.equal(h.log.filter(k=>k==='task_speed').length,1);
  assert.equal(h.log.filter(k=>k==='drive_enable').length,1);
  assert.equal(h.log.filter(k=>k==='logical_move').length,2);
  await h.motion.close();assert(!h.motion.owned());assert.equal(h.errors.length,0);
});
test('release during drive preparation cancels delayed jog start',async()=>{
  const h=harness();await h.motion.permit(9,true);h.block('drive_enable');
  const starting=h.motion.jog(9,30541,0);const rejected=assert.rejects(starting,/取消/);
  for(let i=0;i<100&&!h.log.includes('drive_enable');i++)await Promise.resolve();
  assert(h.log.includes('drive_enable'));const stopping=h.motion.stop(9);h.unblock();
  await stopping;await rejected;assert(!h.motion.heldJog);
  assert.equal(h.log.filter(k=>k==='jog_start').length,0);assert.equal(h.state.motion_active,false);
});

test('diagnostic subscription records parameters, request identity, MCU rejection and stops after unsubscribe',async()=>{
  const h=harness(),logs=[];
  const off=h.motion.subscribeLog((level,message)=>logs.push({level,message}));
  await h.motion.permit(9,true);
  await h.motion.jog(9,30541,0);
  assert(logs.some(x=>x.message.includes('task_speed')&&x.message.includes('velocity_raw')&&x.message.includes('request=')));
  assert(logs.some(x=>x.level==='ok'&&x.message.includes('jog_start')&&x.message.includes('fault=0')));
  await h.motion.stop(9,true);
  h.reject('task_speed',6);
  await assert.rejects(h.motion.jog(9,4581298,0),/结果码 6/);
  assert(logs.some(x=>x.level==='error'&&x.message.includes('task_speed')));
  h.motion.report('error','M9 配置失败阶段=独立读取 W25');
  assert(logs.some(x=>x.message.includes('配置失败阶段')));
  off();const n=logs.length;h.motion.report('info','unsubscribed');assert.equal(logs.length,n);
});

test('release during task-speed configuration waits for accepted plan, never interrupts UART or starts jog',async()=>{
 const h=harness();await h.motion.permit(9,true);h.block('task_speed');
 const starting=h.motion.jog(9,30541,0);const rejected=assert.rejects(starting,/取消/);
 for(let i=0;i<100&&!h.log.includes('task_speed');i++)await Promise.resolve();
 assert(h.log.includes('task_speed'));
 const stopping=h.motion.stop(9);await Promise.resolve();
 assert.equal(h.log.filter(x=>x==='stop').length,0);
 h.unblock();await stopping;await rejected;
 assert.equal(h.log.filter(x=>x==='jog_start').length,0);
 assert.equal(h.log.filter(x=>x==='stop').length,1);
});


test('all four selected modes dispatch logical positioning and jog without forcing position-direct',async()=>{
 for(let mode=0;mode<4;mode++) {
  const h=harness();await h.motion.permit(9,true);
  await h.motion.taskCommand(9,mode,4581298,{kind:'logical_move',position:'5000'});
  assert.equal(h.state.mode,mode);assert(h.log.includes('logical_move'));
  await h.motion.stop(9,true);
  await h.motion.jog(9,4581298,mode);assert.equal(h.state.mode,mode);
  assert(h.log.includes('jog_start'));assert(h.motion.heldJog);assert(h.state.permit);
  await h.motion.stop(9);assert(h.state.permit);
 }
});
