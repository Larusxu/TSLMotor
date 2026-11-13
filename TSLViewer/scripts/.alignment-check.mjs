import {hardware} from './pi-hardware.mjs';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const motor=Number(process.argv[2]||16),current=Number(process.argv[3]||500);
const h=await hardware(`D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/align-${motor}-${current}.json`,{managed:false});
const js=ts.transpileModule(readFileSync(new URL('../src/lib/semantic-motion.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};new Function('exports','require',js)(exports,n=>n==='./api'?{invokeCommand:(name,args)=>h.invoke(name,args)}:{acquisitionLane:{busy:()=>true}});
const motion=new exports.SemanticMotion();motion.observeMotor(motor);
try{
 console.log('BEFORE',JSON.stringify(await motion.command(motor,{kind:'get_state'})));
 console.log('ENCODER',JSON.stringify(await motion.command(motor,{kind:'encoder_state'})));
 await motion.permit(motor,true);
 console.log('START',JSON.stringify(await motion.command(motor,{kind:'alignment',scan_degrees:720,step_degrees:90,settle_ms:700,current_ma:current})));
 const end=Date.now()+100000;
 for(;;){
  await new Promise(r=>setTimeout(r,200));
  const r=await motion.command(motor,{kind:'get_state'});
  if(!r.pending&&r.motor.drive!==1){console.log('RESULT',JSON.stringify(r));break;}
  if(Date.now()>end)throw Error('alignment wait timeout');
 }
 console.log('ENCODER_END',JSON.stringify(await motion.command(motor,{kind:'encoder_state'})));
 console.log('DETAIL',JSON.stringify(await motion.command(motor,{kind:'rtmi_state',cursor:0xfffffffe})));
}finally{
 await motion.stop(motor,true).catch(console.error);
 await motion.permit(motor,false).catch(console.error);
 await motion.close().catch(console.error);await h.close();
}
