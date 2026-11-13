import fs from 'node:fs';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {hardware} from './pi-hardware.mjs';
const modules=new Map();
export function moduleUrl(name){if(modules.has(name))return modules.get(name);let source=fs.readFileSync(new URL('../src/lib/pi-auto/'+name+'.ts',import.meta.url),'utf8');let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;code=code.replace(/from ['"]\.\/([^'"]+)['"]/g,(_,key)=>'from '+JSON.stringify(moduleUrl(key)));const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');modules.set(name,url);return url;}
export const numeric=await import(moduleUrl('model'));
const {trackingQuality,automaticTune}=await import(moduleUrl('automatic'));
const root='D:/WorkeSpace/work/comp_proj/TeslaHand/build/rebuild/';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]){
 const prefix=root+process.argv[3],h=await hardware(prefix+'.json');let original=null,profile=null,changed=false;
 const loop=Number(process.env.PI_LOOP??1),sampling=Number(process.env.PI_SAMPLE??7),excitation=Number(process.env.PI_EXCITE??255),amplitude=Number(process.env.PI_AMP??497);
 const duration=Number(process.env.PI_DURATION??1000),travel=Number(process.env.PI_TRAVEL??327680),shared=process.env.PI_SHARED!=='0',target=Number(process.env.PI_BW??100);
 let generation=0;
 const apply=async(c,p,i)=>{const coeff=numeric.trialCoefficients(c.coefficients,loop,p,i,shared);changed=true;await h.wait(9,3000,r=>r.motor.drive===0&&r.motor.feedback_fresh);await h.command(9,{kind:'pi_tune',group:loop<2?0:loop===2?1:2,expected_config:c.pidConfig,coefficients:coeff});await h.wait(9,10000,r=>r.motor.drive===0);const back=await h.registers([0x140,0x142,0x143,0x145,0x146]);if(back[0]!==c.pidConfig||back.slice(1).some((v,k)=>v!==coeff[k]))throw Error('PI readback differs');};
 const restore=async()=>{if(!original||!changed)return;await h.wait(9,3000,r=>r.motor.drive===0&&r.motor.feedback_fresh);for(const group of [0,1,2]){await h.command(9,{kind:'pi_tune',group,expected_config:original[0],coefficients:original.slice(1)});await h.wait(9,10000,r=>r.motor.drive===0);}const back=await h.registers([0x140,0x142,0x143,0x145,0x146]);if(JSON.stringify(back)!==JSON.stringify(original))throw Error('Original PI restore failed');changed=false;};
 const capture=async()=>{

  const prev=numeric.decodeCapture((await h.command(9,{kind:'ident_state',cursor:0})).identification);
  await h.command(9,{kind:'ident_start',loop_id:loop,amplitude,duration_ms:duration,travel_counts:travel,sampling,excitation_sampling:excitation});
  let c,end=Date.now()+duration+20000;
  for(;;){await new Promise(r=>setTimeout(r,80));c=numeric.decodeCapture((await h.command(9,{kind:'ident_state',cursor:0})).identification);if(c.generation!==prev.generation&&(c.state===2||c.state===3))break;if(Date.now()>end)throw Error('Capture deadline');}
  const samples=[];let cursor=0;
  while(cursor<c.count){const chunk=numeric.decodeCapture((await h.command(9,{kind:'ident_state',cursor})).identification);if(chunk.cursor<=cursor||chunk.generation!==c.generation)throw Error('Download stalled');samples.push(...chunk.samples);cursor=chunk.cursor;}
  c={...c,samples,cursor};fs.writeFileSync(prefix+'-capture-'+(++generation)+'.json',JSON.stringify(c));console.log('capture',generation,'state',c.state,'error',c.error,'PI',c.coefficient>>>16,c.coefficient&65535,'n',c.count,'Hz',c.sampleHz);
  if(c.state!==2)throw Error('Identification error '+c.error);return c;
 };
 try{
  let s=(await h.command(9,{kind:'get_state'})).motor;if(s.fault){await h.command(9,{kind:'clear_fault'});s=(await h.wait(9,15000,r=>r.motor.drive===0)).motor;}if(!s.config_verified){await h.command(9,{kind:'commission',action:1});s=(await h.wait(9,15000,r=>r.motor.drive===0&&r.motor.config_verified)).motor;}
  if(!s.align_valid)throw Error('Encoder invalid');if(s.drive!==0){await h.command(9,{kind:'stop',after:2});await h.wait(9,15000,r=>r.motor.drive===0);}
  original=await h.registers([0x140,0x142,0x143,0x145,0x146]);profile=await h.profile();
  console.log('baseline',original.map(v=>v.toString(16)));
  if(process.env.PI_SEED){const seed=JSON.parse(process.env.PI_SEED);if(seed.length!==4||seed.some(v=>!Number.isInteger(v)||v<0||v>0xffffffff))throw Error('Invalid seed coefficients');changed=true;for(const group of [0,1,2]){await h.command(9,{kind:'pi_tune',group,expected_config:original[0],coefficients:seed});await h.wait(9,10000,r=>r.motor.drive===0);}const back=await h.registers([0x140,0x142,0x143,0x145,0x146]);if(back.slice(1).some((v,i)=>v!==seed[i]))throw Error('Seed readback differs');}
  if(process.argv[2]==='capture'){const c=await capture();console.log(trackingQuality(c,target));}
  else{const result=await automaticTune({capture,apply,restore,cancelled:()=>false,notice:console.log},target,Number(process.env.PI_TRIALS??12));fs.writeFileSync(prefix+'-result.json',JSON.stringify(result));console.log('AUTO_RESULT',result.improved,result.best.p,result.best.i);}
 }finally{try{await restore();if(profile&&JSON.stringify(await h.profile())!==JSON.stringify(profile))throw Error('W25 changed');}finally{await h.close();}}
}
