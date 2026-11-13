import {hardware} from './pi-hardware.mjs';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const h=await hardware('D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/multi-jog-check.json',{managed:false});
function load(file,require){const exports={};const js=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('exports','require',js)(exports,require);return exports;}
const {SemanticMotion}=load('../src/lib/semantic-motion.ts',name=>name==='./api'?{invokeCommand:(n,args)=>h.invoke(n,args)}:name==='./pi-auto/acquisition'?{acquisitionLane:{busy:()=>true}}:{});
const {MultiOpenLoopJog,jogTargets}=load('../src/lib/multi-open-loop-jog.ts',()=>({}));
const motion=new SemanticMotion(),errors=[];
motion.subscribeLog((level,message)=>{if(level==='error')console.error(message);});
const group=new MultiOpenLoopJog(motion,e=>{errors.push(String(e));console.error(e);});
const motors=jogTargets(15,true,'16');
motion.observeMotor(15);
let selectedPolls=0;
motion.subscribe((r,motor)=>{if(motor===15&&r.motor)selectedPolls++;});
try {
 for(const motor of motors){
  const r=await motion.command(motor,{kind:'get_state'});console.log('BEFORE',motor,JSON.stringify(r.motor));
  assert(!r.motor.fault&&!r.motor.motion_active&&r.motor.config_verified,'lane must already be healthy and stationary');
  await motion.permit(motor,true);
 }
 for(const sign of [-1,1]){
  await group.start(motors,sign*91626);
  await new Promise(r=>setTimeout(r,900));
  for(const motor of motors){
   const r=await motion.command(motor,{kind:'get_state'});
   console.log('MOVING',sign,motor,JSON.stringify(r.motor));
   assert(r.motor.motion_active&&!r.motor.fault&&!r.motor.last_error,'both lanes must remain moving');
  }
  await group.stop();
  for(const motor of motors){const r=await motion.wait(motor,10000,r=>r.motor.drive===0&&!r.motor.motion_active);console.log('STOPPED',sign,motor,JSON.stringify(r.motor));}
 }
 assert.deepEqual(errors,[]);assert(selectedPolls>5);console.log('PASS selected M15 + entered 16: both directions, renewal, release, selected status stays fresh',selectedPolls);
}finally{
 await group.stop().catch(console.error);
 for(const motor of motors)await motion.permit(motor,false).catch(console.error);
 await motion.close().catch(console.error);await h.close();
}
