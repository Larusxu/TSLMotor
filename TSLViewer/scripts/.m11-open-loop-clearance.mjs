import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hardware} from './.m1-hardware.mjs';
const report='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/m11-open-loop-clearance';
const h=await hardware(report+'.json',{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};
globalThis.__piInvoke=(name,args)=>h.invoke(name,args);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{
  if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__piInvoke(...a)'));
  if(name==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=()=>{throw Error();}'));
  if(!name.startsWith('.'))throw Error('Unmapped runtime dependency '+name);
  return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),name+'.ts')));
 });
 const url=data(code);cache.set(file,url);return url;
}
const lib=file=>load(fileURLToPath(new URL('../src/lib/'+file+'.ts',import.meta.url)));
let motion;
try {
 motion=(await import(lib('semantic-motion'))).semanticMotion;
 const commission=(await import(lib('semantic-commission'))).semanticCommission;
 await motion.open(11);
 const before=await motion.command(11,{kind:'get_state'});
 const homeBefore=await motion.command(11,{kind:'homing_config_read'});
 console.log('BEFORE',JSON.stringify(before.motor));
 if(before.motor.fault||before.motor.motion_active)throw Error('M11 not idle and healthy');
 let printed=0;
 const result=await commission.align(11,{scanDegrees:720,stepDegrees:90,settleMs:700,currentMa:300},r=>{if(Date.now()-printed>2000){console.log('ALIGN',r.motor?.drive,r.motor?.last_error,r.motor?.fault);printed=Date.now();}});
 const homeAfter=await motion.command(11,{kind:'homing_config_read'});
 if(JSON.stringify(homeBefore.homing_config)!==JSON.stringify(homeAfter.homing_config))throw Error('Homing configuration changed');
 fs.writeFileSync(report+'-result.json',JSON.stringify(result,null,2));
 console.log('ALIGNMENT_PASS',JSON.stringify(result.motor),'HOMING_CONFIG_UNCHANGED');
} catch(e){console.error('ALIGNMENT_FAILED',e.message);process.exitCode=1;}
finally {try{if(motion?.owned()){await motion.permit(11,false);await motion.close();}}finally{await h.close();}}

