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
globalThis.__piInvoke=(name,args)=>h.invoke(name,args);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 const source=fs.readFileSync(file,'utf8');
 let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{
  if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__piInvoke(...a)'));
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
 await motion.open(9);await motion.permit(9,true);
 profile=(await readMotorProfile(9)).data;
 original=await service.livePi(9);
 if(process.env.PI_SEED){const seed=JSON.parse(process.env.PI_SEED),p=pidFromProfile(profile);
  ['flux','torque','vel','pos'].forEach((key,i)=>{p[key+'_p']=seed[i]>>>16;p[key+'_i']=seed[i]&65535;});
  for(const group of [0,1,2])await tuneMotorPi(9,group,p);
 }
 const result=process.env.PI_ENDPOINT==='1'?await service.endpoint(9,(process.env.PI_SPEEDS??'500,15000').split(',').map(Number),console.log):await service.automatic(9,{loop:Number(process.env.PI_LOOP??1),amplitude:Number(process.env.PI_AMP??994),
  durationMs:Number(process.env.PI_DURATION??1000),travelCounts:Number(process.env.PI_TRAVEL??655360),
  sampling:Number(process.env.PI_SAMPLE??7),excitationSampling:Number(process.env.PI_EXCITE??7)},
  Number(process.env.PI_BW??100),true,()=>{},console.log);
 fs.writeFileSync(report+'-result.json',JSON.stringify(result));
 console.log('UI_AUTO_RESULT',result.improved,result.best.coefficients??[result.best.p,result.best.i]);
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
  }
 }catch(e){console.error('Cleanup failed:',e.message);process.exitCode=1;}
 finally{try{if(motion){await motion.permit(9,false);await motion.close();}}finally{await h.close();}}
}
