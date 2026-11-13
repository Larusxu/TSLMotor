/** Runs the actual UI service + SemanticMotion + storage codec on real M9.
 * Only Tauri invoke is bridged to the existing production Rust transport.
 * No browser mock, synthetic samples, W25 commit, or UI automation. */
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hardware} from './pi-hardware.mjs';
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/';
const report=root+(process.argv[2]??'pi-ui-real');
const h=await hardware(report+'.json',{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};
globalThis.__piInvoke=(name,args)=>h.invoke(name,args);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 const source=fs.readFileSync(file,'utf8');
 let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{
  if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__piInvoke(...a)'));
  if(name==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=()=>{throw Error("Desktop event subscriptions are outside this command-path test")};'));
  if(!name.startsWith('.'))throw Error('Unmapped runtime dependency '+name);
  return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),name+'.ts')));
 });
 const url=data(code);cache.set(file,url);return url;
}
const lib=file=>load(fileURLToPath(new URL('../src/lib/'+file+'.ts',import.meta.url)));
let motion,service,original,profile;
try{
 const {semanticMotion}=await import(lib('semantic-motion'));motion=semanticMotion;
 const {piAuto}=await import(lib('pi-auto/service'));service=piAuto;
 const {readMotorProfile,pidFromProfile,tuneMotorPi}=await import(lib('motor-profile-ui'));
 await motion.open(9);
 profile=(await readMotorProfile(9)).data;
 original=await service.livePi(9);
 if(process.env.PI_SEED){const seed=JSON.parse(process.env.PI_SEED),p=pidFromProfile(profile);
  ['flux','torque','vel','pos'].forEach((key,i)=>{p[key+'_p']=seed[i]>>>16;p[key+'_i']=seed[i]&65535;});
  for(const group of [0,1,2])await tuneMotorPi(9,group,p);
 }
 const {emptyCaptureView,updateCaptureView}=await import(lib('pi-auto/presentation'));
 let view=emptyCaptureView(),completed=0,previousPhase='';
 const progress=event=>{
  const previous=view.capture;view=updateCaptureView(view,event);
  if(event.phase!=='complete'&&view.capture!==previous)throw Error('Completed waveform was replaced by progress');
  if(event.phase==='complete'){completed++;console.log('WAVEFORM_RETAINED',completed,event.capture.samples.length);}
  if(event.phase!==previousPhase){console.log('PHASE',event.phase);previousPhase=event.phase;}
 };
 const trial=(t,round)=>console.log('ROUND',t.capture.loop,round,t.p,t.i,t.score);
 const range=process.env.PI_RANGE?process.env.PI_RANGE.split(',').map(Number):undefined;
 const options={loop:Number(process.env.PI_LOOP??1),amplitude:Number(process.env.PI_AMP??994),durationMs:Number(process.env.PI_DURATION??1000),travelCounts:Number(process.env.PI_TRAVEL??655360),sampling:Number(process.env.PI_SAMPLE??7),excitationSampling:Number(process.env.PI_EXCITE??7),useHomedTravel:process.env.PI_HOMED!=='0',travelPercentRange:range};
 const result=process.env.PI_CAPTURE==='1'?await service.capture(9,options,progress,console.log):process.env.PI_SEQUENCE==='1'?await service.sequence(9,true,progress,console.log,loop=>console.log('LOOP',loop),trial,range):process.env.PI_ENDPOINT==='1'?await service.endpoint(9,(process.env.PI_SPEEDS??'500,15000').split(',').map(Number),console.log):await service.automatic(9,{loop:Number(process.env.PI_LOOP??1),amplitude:Number(process.env.PI_AMP??994),
  durationMs:Number(process.env.PI_DURATION??1000),travelCounts:Number(process.env.PI_TRAVEL??655360),
  sampling:Number(process.env.PI_SAMPLE??7),excitationSampling:Number(process.env.PI_EXCITE??7),travelPercentRange:range},
  Number(process.env.PI_BW??100),true,progress,console.log,trial);
 fs.writeFileSync(report+'-result.json',JSON.stringify(result));
 for(const r of Array.isArray(result)?result:[result])console.log(r.best?'UI_AUTO_RESULT':'UI_CAPTURE_RESULT',r.best?[r.improved,r.best.coefficients??[r.best.p,r.best.i]]:{state:r.state,error:r.error,count:r.count,sampleHz:r.sampleHz,diagnostic:r.diagnostic});
 if(process.env.PI_TRY==='1'){
  const r=Array.isArray(result)?result.at(-1):result;
  await service.tryResult(9,r.best.capture.loop,r.best.p,r.best.i,true);
  const actual=await service.livePi(9),index=r.best.capture.loop+1;
  if(actual[index]!==r.best.p*65536+r.best.i)throw Error('Result trial readback differs');
  console.log('RESULT_TRIAL_TMC_VERIFIED');
 }
 if(process.env.PI_SEQUENCE_ENDPOINT==='1'){
  const endpoint=await service.endpoint(9,[500,15000],console.log);
  fs.writeFileSync(report+'-endpoint-result.json',JSON.stringify(endpoint));
  console.log('UI_ENDPOINT_RESULT',endpoint.improved,endpoint.best.coefficients);
 }
}catch(e){console.error('UI real service failed:',e.message);process.exitCode=1;}
finally{
 try{
  if(service?.hasTrial(9))await service.restore(9);
  if(original&&motion){
   await motion.command(9,{kind:'stop',after:2});await motion.wait(9,15000,r=>r.motor?.drive===0);
   for(const group of [0,1,2]){await motion.command(9,{kind:'pi_tune',group,expected_config:original[0],coefficients:original.slice(1)});await motion.wait(9,10000,r=>r.motor?.drive===0);}
   const back=await service.livePi(9);if(JSON.stringify(back)!==JSON.stringify(original))throw Error('Original PI restore differs');
   const {readMotorProfile}=await import(lib('motor-profile-ui'));
   if(JSON.stringify((await readMotorProfile(9)).data)!==JSON.stringify(profile))throw Error('W25 changed');
   console.log('RESTORED_ORIGINAL_PI_W25_UNCHANGED');
   const finalState=(await motion.command(9,{kind:'position_state'})).motor;
   console.log('FINAL_STATE',JSON.stringify(finalState));
   if(finalState.fault||!finalState.logic_power||!finalState.align_valid)throw Error('Final state is not reusable');
  }
 }catch(e){console.error('Cleanup failed:',e.message);process.exitCode=1;}
 finally{try{if(motion){await motion.command(9,{kind:"drive_disable"});await motion.close();}}finally{await h.close();}}
}
