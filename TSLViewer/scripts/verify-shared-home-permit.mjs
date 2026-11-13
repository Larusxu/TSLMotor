import fs from 'node:fs';
import ts from 'typescript';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {hardware} from './pi-hardware.mjs';
const h=await hardware(null,{managed:false});
globalThis.window={__TAURI_INTERNALS__:{}};
globalThis.__homeInvoke=async(...args)=>{const r=await h.invoke(...args);if(args[0]==='motor_semantic')console.log('SEM',args[1].request.command.kind,args[1].request.session_id,r.session_id,r.result);return r;};
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 let code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>{
  if(name==='react')return 'from '+JSON.stringify(data('export const useSyncExternalStore=(_,get)=>get();'));
  if(name==='@tauri-apps/api/core')return 'from '+JSON.stringify(data('export const invoke=(...a)=>globalThis.__homeInvoke(...a);'));
  if(name==='@tauri-apps/api/event')return 'from '+JSON.stringify(data('export const listen=async()=>()=>{};'));
  if(!name.startsWith('.'))throw Error('Unmapped '+name);
  return 'from '+JSON.stringify(load(path.resolve(path.dirname(file),name+'.ts')));
 });
 const url=data(code);cache.set(file,url);return url;
}
process.on('uncaughtException',e=>{console.error('FAILED',e.message);process.exit(1);});
let settings,original,motion,modified=false;
try {
 const lib=n=>load(fileURLToPath(new URL('../src/lib/'+n+'.ts',import.meta.url)));
 settings=await import(lib('shared-settings'));
 motion=(await import(lib('semantic-motion'))).semanticMotion;
 motion.subscribeErrors(e=>console.log('HOST_ERROR',e));

 original=[...await settings.readSharedDefaults()];
 console.log('ORIGINAL',settings.useSharedHome().config);

 // An unrelated unsaved default must not be persisted by homing autosave.
 settings.setDefaultWord(84,123);
 const old=[...settings.useSharedHome().config];
 const first=[...old];first[3]=1000;
 settings.useSharedHome().setConfig(first);modified=true;
 const a=settings.writeSharedHome(1);
 const second=[...first];second[4]=2100;
 settings.useSharedHome().setConfig(second);
 const b=settings.writeSharedHome(13);
 await Promise.all([a,b]);
 assert.deepEqual(settings.useSharedHome().config,second);
 assert.deepEqual(await settings.readSharedHome(9,true),second);
 const stored=await settings.readSharedDefaults(true);
 for(let i=0;i<120;i++)if(i<8||i>=20)assert.equal(stored[i],original[i],'unrelated byte '+i);
 assert.equal(settings.useSharedDefaults().data[84],123,'new draft retained');
 const state=await motion.command(1,{kind:'get_state'});assert.equal(state.motor.fault,0);
 console.log('PASS consecutive actual UI saves/readback, shared across motors, unrelated storage and draft retained');
} catch(e){console.error("TEST_FAILED",e.message);process.exitCode=1;} finally {
 try{if(modified){await motion.close();await new Promise(r=>setTimeout(r,3500));settings.acceptDefaults(original);await settings.saveSharedDefaults();assert.deepEqual(await settings.readSharedDefaults(),original);console.log('RESTORED original image');}}
 finally{try{if(motion)await motion.close();}finally{await h.close();}}
}
