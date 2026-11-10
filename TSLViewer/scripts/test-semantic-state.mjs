// Actual TypeScript state source with injected command reader; no DOM, browser,
// serial hardware or simulated firmware. Every observed request is GET_STATE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/lib/semantic-state.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {SemanticStateSource, semanticFresh, mergeMotorTelemetry, retainMotorTelemetry} = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
let now=1000, fail=false, boot='123', pause=null, calls=[];
const reader=async (motor,id)=>{
  calls.push(motor);if(pause) await pause;
  if(fail) throw Error('timeout');
  return {protocol_version:2,operation:1,request_id:id,replayed:false,result:0,result_name:'OK',
    boot_id:boot,session_id:0,device:motor===0?{capabilities:3}:null,
    motor:motor?{align_valid:true,span_valid:true}:null};
};
const state=new SemanticStateSource(reader,()=>now);
let view=await state.poll(9);
assert(semanticFresh(view,now));assert.deepEqual(calls,[0,9]);
assert(view.state.align_valid&&view.state.span_valid);
assert(!semanticFresh(view,now+2001));
fail=true;view=await state.poll(9);
assert(view.state.align_valid&&view.state.span_valid);assert.equal(view.receivedAt,1000);assert(view.error.includes('timeout'));
assert(!semanticFresh(view,now+2001));
fail=false;boot='124';view=await state.poll(9);assert.equal(view.bootId,'124');
let release;pause=new Promise(resolve=>{release=resolve;});
const inflight=state.poll(9);state.reset(10);release();await inflight;
assert.equal(state.view().motor,10);assert.equal(state.view().state,null);
pause=null;view=await state.poll(10);assert.equal(view.motor,10);assert.equal(view.bootId,'124');
console.log('PASS actual state source: immediate discovery, preserved timestamp on timeout, expiry, reboot and selection-change response isolation');

const base={sampled_at_ms:1000,feedback_fresh:true};
const telemetry={sampled_at_ms:1060,bus_voltage_mv:24000,target_logical_position:"10000",id_raw:12,protection_state:0};
const merged=mergeMotorTelemetry(base,telemetry);
assert.equal(merged.bus_voltage_mv,24000);assert.equal(merged.target_logical_position,"10000");
assert.equal(retainMotorTelemetry({...base,sampled_at_ms:1200},merged).bus_voltage_mv,24000);
assert.equal(retainMotorTelemetry({...base,sampled_at_ms:2200},merged).bus_voltage_mv,undefined);
assert.equal(mergeMotorTelemetry({...base,feedback_fresh:false},telemetry).bus_voltage_mv,undefined);
assert.equal(mergeMotorTelemetry({...base,sampled_at_ms:15},{...telemetry,sampled_at_ms:0xfffffff0}).bus_voltage_mv,24000);
console.log('PASS telemetry: adjacent cache samples merge, base refresh retains display, stale data expires, rollover supported');
