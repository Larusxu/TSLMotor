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


let motion,service,original,profile,originalTask;
try{
 motion=(await import(lib('semantic-motion'))).semanticMotion;service=(await import(lib('pi-auto/service'))).piAuto;
 const m=await import(lib('motor-profile-ui')),units=await import(lib('units'));
 motion.subscribeLog((level,message)=>{if(level==='error')console.log(level,message);});
 await motion.open(1);const state=(await motion.command(1,{kind:'position_state'})).motor;
 if(state.motion_active||state.fault)throw Error('Busy before test');
 profile=(await m.readMotorProfile(1)).data;original=await service.livePi(1);
 const modes=['position_direct','position_ramp','velocity_direct','velocity_ramp'];
 originalTask={...m.motionFromProfile(profile,{planning:'limits'}),mode:modes[state.mode]};
 fs.writeFileSync(report+'-before.json',JSON.stringify({state,profile,original,originalTask}));
 const testTask={...originalTask,mode:'position_direct'};
 // Recreate a volatile/native target-control change with an older saved preset.
 // No target or motion command is sent; restore the archive before exercising Apply.
 await m.applyMotorPi(1,{...m.pidFromProfile(profile),overwrite_target:false,keep_pos_target:false});
 await (await import(lib('split-storage'))).storageJob(1,3,profile);
 await motion.command(1,{kind:'task_speed',mode:0,velocity_raw:Math.floor(testTask.max_rpm*m.COUNTS_PER_RPM)});
 await motion.wait(1,10000,r=>!r.pending&&r.motor.drive===0);
 await motion.enable(1);
 const attemptStart=h.records.length;
 await m.applyMotorConfiguration(1,m.pidFromProfile(profile),testTask);
 const attempts=h.records.slice(attemptStart).filter(r=>r.request?.command?.kind==='apply_configuration');
 if(attempts.length!==2||attempts[0].response.result!==1||attempts[1].response.result!==0)
  throw Error('Expected one explicit BUSY rejection then one accepted configuration: '+JSON.stringify(attempts.map(r=>r.response.result)));
 const registers=await service.livePi(1),expected=[m.word(profile,28),...Array.from({length:4},(_,i)=>m.word(profile,32+4*i))];
 if(((registers[0]^expected[0])&0x7ffffc)||registers.slice(1).some((v,i)=>v!==expected[i+1]))throw Error('Configuration did not write requested PID');
 console.log('BUSY_RECOVERY_PASS',registers);
}catch(e){console.error('CONFIG_REGRESSION_FAILED',e.message);process.exitCode=1;}
finally{
 try{if(motion&&original){const m=await import(lib('motor-profile-ui')),units=await import(lib('units')),storage=await import(lib('split-storage'));
 await motion.stop(1,true);await motion.wait(1,15000,r=>r.motor.drive===0);
 const p={...m.pidFromProfile(profile),...units.parsePidConfig(original[0])};['flux','torque','vel','pos'].forEach((k,i)=>{p[k+'_p']=original[i+1]>>>16;p[k+'_i']=original[i+1]&65535;});
 await m.applyMotorConfiguration(1,p,originalTask);
 const back=await service.livePi(1);if(((back[0]^original[0])&0x7ffffc)||back.slice(1).some((v,i)=>v!==original[i+1]))throw Error('Live PID restore mismatch');
 await storage.storageJob(1,3,profile);if(JSON.stringify((await m.readMotorProfile(1)).data)!==JSON.stringify(profile))throw Error('Archive restore mismatch');
 console.log('CONFIG_RESTORED_EXACT_W25_AND_ORIGINAL_LIVE_PI');
 }}catch(e){console.error('CONFIG_RESTORE_FAILED',e.message);process.exitCode=1;}
 finally{try{if(motion){await motion.command(1,{kind:"drive_disable"});await motion.close();}}finally{await h.close();}}
}
