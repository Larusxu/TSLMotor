import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hardware} from './pi-hardware.mjs';
const motor=Number(process.argv[2]||1);
if(![1,3].includes(motor))throw Error('Only authorized M1/M3');
const report=`D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/adaptive-m${motor}-${Date.now()}`;
const h=await hardware(report+'.json',{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};globalThis.__adaptiveInvoke=(...a)=>h.invoke(...a);
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64'),cache=new Map();
function load(file){if(cache.has(file))return cache.get(file);
 let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,n)=>{
  if(n==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__adaptiveInvoke(...a)'));
  if(n==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=async()=>()=>{}'));
  if(!n.startsWith('.'))throw Error('Unmapped '+n);
  return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),n+'.ts')));
 });const url=data(code);cache.set(file,url);return url;}
let motion,started=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 motion=(await import(load(fileURLToPath(new URL('../src/lib/semantic-motion.ts',import.meta.url))))).semanticMotion;
 for(let attempt=0;;attempt++) {
  try{await motion.open(motor);break;}
  catch(e){if(attempt>=60||!String(e).includes('主控错误 5'))throw e;await sleep(1000);}
 }
 let initial=await motion.command(motor,{kind:'get_state'});
 for(let n=0;n<60&&!initial.motor.align_valid&&!initial.motor.fault;n++) {
  await sleep(1000);initial=await motion.command(motor,{kind:'get_state'});
 }
 console.log('INITIAL',JSON.stringify(initial.motor));
 if(initial.motor.fault||!initial.motor.align_valid)throw Error('Motor not ready');
 if(!initial.motor.config_verified)await motion.initialize(motor);
 if(process.env.HOME_TASK_RPM){await motion.command(motor,{kind:'task_speed',velocity_raw:Math.round(Number(process.env.HOME_TASK_RPM)*1099511627776/3600000000),mode:0});await motion.wait(motor,15000,r=>!r.pending&&r.motor?.config_verified&&r.motor?.drive===0);}
 await motion.permit(motor,true);
 let config;
 for(let n=0;n<60;n++) {
  try{config=(await motion.command(motor,{kind:'homing_config_read'})).homing_config;break;}
  catch(e){if(!String(e).includes('主控错误 5')||n===59)throw e;await sleep(1000);}
 }
 console.log('CONFIG',config);
 await motion.command(motor,{kind:'homing_adaptive',velocity_rpm:Number(process.argv[3]||3000)});started=true;
 let seen=false,last='';const begin=Date.now();
 while(Date.now()-begin<190000) {
  if(fs.existsSync('scripts/.adaptive-stop'))throw Error('Test stop requested');
  const bytes=await h.invoke('main_control',{motor,op:13,data:[]});const b=Buffer.from(bytes);
  const r={stage:b[0],valid:b[1],error:b[2],elapsed:b.readUInt32LE(3),iq:b.readInt16LE(7),leg:b[10],ends:b[11],negative:b.readInt32LE(12),positive:b.readInt32LE(16),span:b.readInt32LE(20),phase:b[25],load:b[26]};
  if(b.length>=48)Object.assign(r,{position:b.readInt32LE(28),velocity:b.readInt32LE(32),target:b.readInt32LE(36),score:b.readInt32LE(40)/100,park:b.readInt32LE(44)});
  fs.appendFileSync(report+'.samples.jsonl',JSON.stringify({at:Date.now(),...r})+'\n');
  const key=[r.stage,r.phase,r.load,Math.round(r.iq/20)].join(':');if(key!==last){console.log('HOME',JSON.stringify(r));last=key;}
  if(process.env.HOME_POSITIVE_ONLY==='1' && (r.ends&2)){console.log('POSITIVE_ONLY',JSON.stringify(r));break;}
  if(r.stage===1)seen=true;
  if(seen&&[2,3].includes(r.stage)){
   await motion.wait(motor,15000,q=>!q.motor?.motion_active&&!q.pending);
   const final=(await motion.command(motor,{kind:'position_state'})).motor;console.log('FINAL',JSON.stringify(final));
   console.log('RESULT',JSON.stringify(r),'REPORT',report);
   if(r.stage!==2||!r.valid)process.exitCode=2;
   break;
  }
  await sleep(100);
 }
} finally {
 try {if(motion&&started){await motion.stop(motor,true);await motion.wait(motor,15000,q=>q.motor?.drive===0&&!q.motor.motion_active);}}catch(e){console.error('STOP',String(e));}
 try{if(motion){await motion.permit(motor,false);await motion.close();}}finally{await h.close();}
}
