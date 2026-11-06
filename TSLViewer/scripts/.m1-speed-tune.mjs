import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {hardware} from './.m1-hardware.mjs';
const out='D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-speed-'+(process.argv[2]||'baseline');
const backup=JSON.parse(fs.readFileSync('D:/WorkeSpace/work/comp_proj/TeslaHand/build/m1-speed-backup.json','utf8'));
const h=await hardware(out+'-wire.json',{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};
globalThis.__piInvoke=async(name,args)=>{for(let attempt=0;;attempt++){try{return await h.invoke(name,args);}catch(error){console.error('WIRE_FAILURE',name,args.request?.command,String(error));if(attempt<3&&String(error).includes('主控错误 5 (')){await new Promise(r=>setTimeout(r,80));continue;}throw error;}}};
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64'),cache=new Map();
function load(file){if(cache.has(file))return cache.get(file);let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__piInvoke(...a)'));if(name==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=()=>()=>{}'));if(!name.startsWith('.'))throw Error(name);return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),name+'.ts')));});const url=data(code);cache.set(file,url);return url;}
const lib=name=>import(load(path.resolve('src/lib/'+name+'.ts')));
const {semanticMotion:m}=await lib('semantic-motion');
const {piAuto}=await lib('pi-auto/service');
const {decodeRtmi}=await lib('native-rtmi');
const {trackingQuality}=await lib('pi-auto/automatic');
const {readMotorProfile,COUNTS_PER_RPM}=await lib('motor-profile-ui');
let saved,results=[];
const stop=async()=>{await m.stop(1,true);await m.wait(1,15000,r=>r.motor?.drive===0&&!r.motor.motion_active,[8,15]);};
async function pulse(rpm){
 await stop();await m.command(1,{kind:'task_speed',mode:2,velocity_raw:Math.floor(Math.abs(rpm)*COUNTS_PER_RPM)});await m.wait(1,10000,r=>r.motor?.drive===0);
 await m.configureRtmi(1,{kind:'rtmi_config',enabled:true,sampling:127,addresses:[0x150,0x154,0x153,0x155,65535,65535,65535],decimation:2});await m.wait(1,10000,r=>r.motor?.drive===0);
 const boundary=decodeRtmi((await m.command(1,{kind:'rtmi_state',cursor:0xffffffff})).rtmi);let cursor=boundary.cursor,points=[],states=[];
 await m.enable(1);const accepted=await m.velocity(1,Math.floor(rpm*COUNTS_PER_RPM),2);
 const end=Date.now()+Number(process.env.PI_PULSE_MS||600);let poll=0;
 while(Date.now()<end){const b=decodeRtmi((await m.command(1,{kind:'rtmi_state',cursor})).rtmi);cursor=b.cursor;if(b.lost||b.errors!==boundary.errors)throw Error('Pulse RTMI continuity');points.push(...b.samples);if(Date.now()-poll>100){const s=await m.command(1,{kind:'position_state'});states.push(s);if(s.motor.fault||s.motor.last_error)throw Error('Pulse fault '+JSON.stringify(s.motor));poll=Date.now();}await new Promise(r=>setTimeout(r,2));}
 const stopped=await m.stop(1,true);await m.wait(1,15000,r=>r.motor?.drive===0&&!r.motor.motion_active);
 const drainEnd=Date.now()+3000;while((points.at(-1)?.at??0)<stopped.timestamp_ms&&Date.now()<drainEnd){const b=decodeRtmi((await m.command(1,{kind:'rtmi_state',cursor})).rtmi);cursor=b.cursor;if(b.lost||b.errors!==boundary.errors)throw Error('Pulse drain continuity');points.push(...b.samples);}
 const summary={rpm,peakTargetRpm:Math.max(0,...points.filter(p=>p.ch===0&&p.at>=accepted.timestamp_ms&&p.at<stopped.timestamp_ms).map(p=>Math.abs(p.raw)/COUNTS_PER_RPM)),peakActualRpm:Math.max(0,...points.filter(p=>p.ch===1&&p.at>=accepted.timestamp_ms&&p.at<stopped.timestamp_ms).map(p=>Math.abs(p.raw)/COUNTS_PER_RPM)),tailActualRpm:points.filter(p=>p.ch===1&&p.at>=stopped.timestamp_ms-200&&p.at<stopped.timestamp_ms).map(p=>p.raw/COUNTS_PER_RPM)};
 results.push({summary,accepted,points,states});fs.writeFileSync(out+'-results.json',JSON.stringify(results));console.log('PULSE',JSON.stringify(summary));
 await m.configureRtmi(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await m.wait(1,10000,r=>r.motor?.drive===0);
}
async function move(percent,mode,rpm,measure=false){
 await stop();await m.command(1,{kind:'task_speed',mode,velocity_raw:Math.floor(rpm*COUNTS_PER_RPM)});await m.wait(1,10000,r=>r.motor?.drive===0);
 if(measure){await m.configureRtmi(1,{kind:'rtmi_config',enabled:true,sampling:127,addresses:[0x150,0x154,0x153,0x155,65535,65535,65535],decimation:2});await m.wait(1,10000,r=>r.motor?.drive===0);}
 const points=[],states=[];let boundary,cursor=0;
 if(measure){boundary=decodeRtmi((await m.command(1,{kind:'rtmi_state',cursor:0xffffffff})).rtmi);cursor=boundary.cursor;}
 await m.enable(1);const accepted=await m.command(1,{kind:'logical_move',position:String(Math.round(Number(backup.state.motor.logical_span)*percent/100))});
 let poll=0,arrived=false,arrivalAt=0;const deadline=Date.now()+30000;
 while(Date.now()<deadline){
  if(measure){const b=decodeRtmi((await m.command(1,{kind:'rtmi_state',cursor})).rtmi);cursor=b.cursor;if(b.lost||b.errors!==boundary.errors)throw Error('RTMI continuity');points.push(...b.samples);}
  if(Date.now()-poll>100){const r=await m.command(1,{kind:'position_state'});states.push(r);poll=Date.now();if(r.motor.fault||r.motor.last_error)throw Error('Motion failed '+JSON.stringify(r.motor));if(!r.motor.motion_active&&r.motor.arrival_phase===4){arrived=true;if(!arrivalAt)arrivalAt=Date.now();if(process.env.PI_SINGLE!=='1'||Date.now()-arrivalAt>=5000)break;}}
  await new Promise(r=>setTimeout(r,measure?2:50));
 }
 await stop();if(measure){await m.configureRtmi(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await m.wait(1,10000,r=>r.motor?.drive===0);}
 const summary={percent,mode,rpm,arrived,duration:states.at(-1).timestamp_ms-accepted.timestamp_ms,peakTargetRpm:Math.max(0,...points.filter(p=>p.ch===0).map(p=>Math.abs(p.raw)/COUNTS_PER_RPM)),peakActualRpm:Math.max(0,...points.filter(p=>p.ch===1).map(p=>Math.abs(p.raw)/COUNTS_PER_RPM))};
 results.push({summary,accepted,points,states});fs.writeFileSync(out+'-results.json',JSON.stringify(results));console.log('MOVE',JSON.stringify(summary));if(!arrived)throw Error('Motion timeout');
}
try{
 await m.open(1);await m.permit(1,true);
 let initial=await m.command(1,{kind:'position_state'});
 console.log('INITIAL_STATE',initial.motor);
 if(!initial.motor.config_verified){await m.command(1,{kind:'commission',action:1});await m.wait(1,20000,r=>r.motor?.config_verified&&!r.pending);}
 if(!initial.motor.coordinate_valid){
  console.log('HOMING_CONFIG',await m.command(1,{kind:'homing_config_read'}));
  await m.command(1,{kind:'homing_start',direction:1,step_unit:100,dual:true});
  initial=await m.wait(1,180000,r=>r.motor?.coordinate_valid&&!r.motor.motion_active);
  console.log('HOMED_STATE',initial.motor);
 }
 backup.state.motor.logical_span=initial.motor.logical_span;
 saved=await piAuto.livePi(1);console.log('START_PI',saved);
 if(process.env.PI_PAIR){const [p,i]=process.env.PI_PAIR.split(',').map(Number);const coeff=saved.slice(1);coeff[2]=p*65536+i;await m.command(1,{kind:'pi_tune',group:1,expected_config:saved[0],coefficients:coeff});await m.wait(1,10000,r=>r.motor?.drive===0);}
 await move(50,0,5000);
 if(process.env.PI_AUTO==='1'||process.env.PI_CAPTURE==='1'){
  const options={loop:2,amplitude:Math.round(Number(process.env.PI_AMP_RPM||500)*COUNTS_PER_RPM),durationMs:2000,travelCounts:655360,sampling:7,excitationSampling:255,useHomedTravel:true,travelPercentRange:[30,70]};
  const progress=event=>{if(event.phase==='complete'){fs.writeFileSync(out+'-capture-'+event.capture.generation+'.json',JSON.stringify(event.capture));console.log('CAPTURE',event.capture.generation,event.capture.count);}};
  const result=process.env.PI_AUTO==='1'?await piAuto.automatic(1,options,Number(process.env.PI_BW||30),true,progress,console.log,(t,n)=>console.log('TRIAL',n,t.p,t.i,t.score,t.peak)):await piAuto.capture(1,options,progress,console.log);
  fs.writeFileSync(out+'-auto.json',JSON.stringify(result));console.log('RESULT',result.best?{improved:result.improved,p:result.best.p,i:result.best.i,score:result.best.score}:trackingQuality(result,Number(process.env.PI_BW||30)));
 }
 if(process.env.PI_PULSE==='1'){for(const rpm of (process.env.PI_SPEEDS||'500,5000,15000').split(',').map(Number)){await move(50,0,5000);await pulse(rpm);await pulse(-rpm);}}
 else if(process.env.PI_SINGLE==='1'){await move(Number(process.env.PI_PERCENT||70),Number(process.env.PI_MODE||2),Number(process.env.PI_SPEEDS||15000),true);}
 else if(process.env.PI_CAPTURE!=='1')for(const rpm of (process.env.PI_SPEEDS||'15000').split(',').map(Number)){for(const percent of [40,60,50])await move(percent,Number(process.env.PI_MODE||2),rpm,true);}
}catch(e){console.error('FAILED',e.message);process.exitCode=1;}
finally{
 try{await stop();await m.configureRtmi(1,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await m.wait(1,10000,r=>r.motor?.drive===0);if(saved&&process.env.PI_KEEP!=='1'){await m.command(1,{kind:'pi_tune',group:1,expected_config:saved[0],coefficients:saved.slice(1)});await m.wait(1,10000,r=>r.motor?.drive===0);}console.log('FINAL_PI',await piAuto.livePi(1));console.log('W25_UNCHANGED',JSON.stringify((await readMotorProfile(1)).data)===JSON.stringify(backup.profile));console.log('FINAL_STATE',(await m.command(1,{kind:'position_state'})).motor);}
 catch(e){console.error('CLEANUP_FAILED',e.message);process.exitCode=1;}
 finally{try{await m.permit(1,false);await m.close();}finally{await h.close();}}
}
