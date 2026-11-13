/** Runs the actual UI service + SemanticMotion + storage codec on real M9.
 * Only Tauri invoke is bridged to the existing production Rust transport.
 * No browser mock, synthetic samples, W25 commit, or UI automation. */
import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hardware} from './.m1-hardware.mjs';
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/';
const report=root+(process.argv[2]??'pi-ui-real');
const writesOnly=process.argv.includes('--writes-only');
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

let motion,service,original,profile,speed,mode;
try{
 motion=(await import(lib('semantic-motion'))).semanticMotion;service=(await import(lib('pi-auto/service'))).piAuto;
 const m=await import(lib('motor-profile-ui')),units=await import(lib('units'));
 motion.subscribeLog((level,message)=>{if(level==='error'||message.includes('????'))console.log(level,message);});
 await motion.open(1);
 const state=(await motion.command(1,{kind:'position_state'})).motor;console.log('INITIAL',JSON.stringify(state));
 if(state.motion_active||state.fault||(!writesOnly&&!state.coordinate_valid))throw Error('M1 not ready for bounded regression');
 profile=(await m.readMotorProfile(1)).data;original=await service.livePi(1);speed=state.effective_velocity_raw;mode=state.mode;
 fs.writeFileSync(report+'-before.json',JSON.stringify({state,profile,original}));
 let p={...m.pidFromProfile(profile),...units.parsePidConfig(original[0])};
 ['flux','torque','vel','pos'].forEach((k,i)=>{p[k+'_p']=original[i+1]>>>16;p[k+'_i']=original[i+1]&65535;});
 const expected=[...original];
 for(const group of [0,1,2]){
  const keys=group===0?['flux','torque']:group===1?['vel']:['pos'];for(const k of keys)p[k+'_p']++;
  // Target-handling bits may differ from the editor without changing gain formats.
  await m.tuneMotorPi(1,group,{...p,overwrite_target:!p.overwrite_target,keep_pos_target:!p.keep_pos_target});const live=await service.livePi(1);
  for(const index of group===0?[1,2]:group===1?[3]:[4])expected[index]+=65536;
  if(JSON.stringify(live)!==JSON.stringify(expected))throw Error('Temporary write mismatch group '+group);
  if(JSON.stringify((await m.readMotorProfile(1)).data)!==JSON.stringify(profile))throw Error('Volatile write changed W25');
  console.log('TEMP_WRITE_PASS',group,live);
 }
 for(const group of [0,1,2]){await motion.command(1,{kind:'pi_tune',group,expected_config:original[0],coefficients:original.slice(1)});await motion.wait(1,5000,r=>!r.pending);}
 if(!writesOnly){

 await motion.taskCommand(1,0,Math.floor(1000*m.COUNTS_PER_RPM),{kind:'logical_move',position:String(Math.round(Number(state.logical_span)/2))});
 await motion.wait(1,90000,r=>!r.motor.motion_active&&Math.abs(Number(r.motor.logical_position)-Number(state.logical_span)/2)<Number(state.logical_span)*.002);
 await motion.stop(1,true);await motion.wait(1,10000,r=>r.motor.drive===0);
 console.log('CENTERED');
 const options={loop:1,amplitude:993,durationMs:1000,travelCounts:655360,sampling:7,excitationSampling:7,travelPercentRange:[40,60]};
 const result=await service.automatic(1,options,100,true,e=>{if(e.phase==='complete')console.log('CAPTURE_COMPLETE',e.capture.count,e.capture.pidConfig);},console.log,(t,n)=>console.log('TRIAL',n,t.p,t.i,t.score));
 fs.writeFileSync(report+'-result.json',JSON.stringify(result));console.log('AUTOMATIC_PASS',result.trials.length,result.improved);
 }
} catch(e){console.error('REGRESSION_FAILED',e.message);process.exitCode=1;}
finally{
 try{if(motion&&original){await motion.stop(1,true);await motion.wait(1,15000,r=>r.motor.drive===0);
 if(service.hasTrial(1))await service.restore(1);
 for(const group of [0,1,2]){await motion.command(1,{kind:'pi_tune',group,expected_config:original[0],coefficients:original.slice(1)});await motion.wait(1,5000,r=>!r.pending);}
 const back=await service.livePi(1);if(JSON.stringify(back)!==JSON.stringify(original))throw Error('Original PI restoration mismatch');
 await motion.command(1,{kind:'task_speed',mode,velocity_raw:speed});await motion.wait(1,10000,r=>r.motor.drive===0);
 const m=await import(lib('motor-profile-ui'));if(JSON.stringify((await m.readMotorProfile(1)).data)!==JSON.stringify(profile))throw Error('W25 changed');
 console.log('RESTORED_PI_AND_SPEED_W25_UNCHANGED');
 }}catch(e){console.error('RESTORE_FAILED',e.message);process.exitCode=1;}
 finally{try{if(motion){await motion.command(1,{kind:"drive_disable"});await motion.close();}}finally{await h.close();}}
}
