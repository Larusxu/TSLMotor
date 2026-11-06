/** Explicit CLI hardware transport using the viewer's production Rust codec. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function hardware(report,{managed=true}={}) {
 const directory=fileURLToPath(new URL('../src-tauri/target/debug/deps/',import.meta.url));
 const executables=fs.readdirSync(directory).filter(n=>/^tslviewer_lib-[0-9a-f]+\.exe$/.test(n)).map(n=>path.join(directory,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
 if(!executables.length)throw Error('Run cargo test --lib --no-run before hardware tests');
 const child=spawn(executables[0],['pi_auto_hil::bridge::m9_commands','--ignored','--nocapture'],{env:{...process.env,PI_AUTO_PORT:process.env.PI_AUTO_PORT||'COM10'},stdio:['pipe','pipe','pipe']});
 const records=[],queue=[];let readyResolve,readyReject;
 const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
 child.stderr.on('data',b=>process.stderr.write(b));
 createInterface({input:child.stdout}).on('line',line=>{if(line==='PI_BRIDGE_READY')readyResolve();else if(line.startsWith('PI_BRIDGE ')){const v=JSON.parse(line.slice(10)),q=queue.shift();if(q){v.error?q.reject(Error(v.error)):q.resolve(v.reply);}}});
 child.on('error',e=>readyReject(e));
 child.on('exit',code=>{const e=Error(`Hardware bridge exited ${code}`);readyReject(e);for(const q of queue.splice(0))q.reject(e);});
 await ready;
 const rpc=v=>new Promise((resolve,reject)=>{queue.push({resolve,reject});child.stdin.write(JSON.stringify(v)+'\n');});
 let seq=1,boot='0',session=0,task=0;
 let chain=Promise.resolve();
 const command=(motor,command)=>{
  const go=async()=>{const request={request_id:seq++,boot_id:boot,session_id:session,task_id:task,command};const r=await rpc({motor,request});
   records.push({command:JSON.stringify(command),response:r});if(report)fs.appendFileSync(report+'.jsonl',JSON.stringify(records.at(-1))+'\n');
   if(r.result)throw Error(`${r.result_name}: ${JSON.stringify(r.motor)}`);
   if(boot!=='0'&&r.boot_id!==boot)throw Error('Board restarted');if(motor&&r.motor)task=r.task_id;return r;};
  const p=chain.then(go);chain=p.catch(()=>{});return p;
 };
 if(managed){const first=await command(0,{kind:'get_state'});boot=first.boot_id;seq=first.device.request_floor+1;session=0x50491105;await command(0,{kind:'open'});}
 let busy=false;
 const pulse=managed?setInterval(async()=>{if(busy)return;busy=true;try{await command(0,{kind:'pulse'});await command(9,{kind:'permit',enabled:true,lease_ms:3000});}catch(e){console.error('Heartbeat',String(e));}finally{busy=false;}},500):null;
 const wait=async(motor,timeout,accept)=>{const end=Date.now()+timeout;for(;;){await new Promise(r=>setTimeout(r,60));const r=await command(motor,{kind:'get_state'});if(!r.pending&&!r.motor?.pending_action&&(r.motor?.fault||r.motor?.last_error))throw Error(`Motor fault ${JSON.stringify(r.motor)}`);if(!r.pending&&!r.motor?.pending_action&&r.motor?.drive!==1&&accept(r))return r;if(Date.now()>end)throw Error('Motor wait timeout');}};
 const registers=async addresses=>{
  await command(9,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[...addresses,...Array(7-addresses.length).fill(65535)],decimation:4});await wait(9,10000,r=>r.motor.drive===0);
  try{const boundary=Buffer.from((await command(9,{kind:'rtmi_state',cursor:0xffffffff})).rtmi);let cursor=boundary.readUInt32LE(0),errors=boundary.readUInt32LE(8);const values=Array(addresses.length).fill(null),seen=Array(addresses.length).fill(0),end=Date.now()+4000;
   while(seen.some(n=>n<2)){const r=await command(9,{kind:'rtmi_state',cursor});const b=Buffer.from(r.rtmi);cursor=b.readUInt32LE(0);if(b.readUInt32LE(4)||b.readUInt32LE(8)!==errors){console.warn('Register snapshot interrupted; discard partial values',b.readUInt32LE(4),errors,b.readUInt32LE(8));errors=b.readUInt32LE(8);values.fill(null);seen.fill(0);if(Date.now()>end)throw Error('Register snapshot remains interrupted');continue;}for(let k=20;k<b.length;k+=9){const ch=b[k+4];if(ch<values.length){const v=b.readUInt32LE(k+5);if(seen[ch]&&v!==values[ch])throw Error('Register changed during snapshot');values[ch]=v;seen[ch]++;}}if(Date.now()>end)throw Error('Register timeout');await new Promise(r=>setTimeout(r,5));}return values;
  }finally{await command(9,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});await wait(9,10000,r=>r.motor.drive===0);}
 };
 return {command,wait,registers,records,boot,
  async invoke(name,args){
   const input=name==='motor_semantic'?{motor:args.motor,request:args.request}:name==='motor_storage'?{motor:args.motor,storage:args.request}:name==='main_control'?{motor:args.motor,control:{op:args.op,data:args.data}}:null;
   if(!input)throw Error('Unsupported hardware invoke '+name);
   const reply=await rpc(input);records.push({invoke:name,...input,response:reply});
   if(report)fs.appendFileSync(report+'.jsonl',JSON.stringify(records.at(-1))+'\n');return reply;
  },
  async failure(){const r=await command(9,{kind:'rtmi_state',cursor:0xfffffffe}),b=Buffer.from(r.rtmi);const words=[];for(let k=20;k<b.length;k+=9)words.push(b.readUInt32LE(k+5));console.log('First IO failure [reg,expected,actual,uart,poison,age,phase,rc]',words.map(v=>'0x'+v.toString(16)));const trace=Buffer.from((await command(9,{kind:'rtmi_state',cursor:0xfffffffd})).rtmi),raw=[];for(let k=20;k<trace.length;k+=9)raw.push(...trace.subarray(k+5,k+9));console.log('RX trace',Buffer.from(raw).toString('hex'));return words;},
  async profile(){let q={id:Date.now()>>>0,operation:1,offset:0,data:[]};const end=Date.now()+10000;let r;do{r=await rpc({motor:9,storage:q});if(r.phase===4)break;if(Date.now()>end)throw Error('Profile timeout');q.operation=6;await new Promise(r=>setTimeout(r,40));}while(true);if(r.result)throw Error('Profile read');const data=[];for(const offset of [0,106]){r=await rpc({motor:9,storage:{...q,operation:6,offset}});if(r.result||r.phase!==4)throw Error('Profile fragment');data.push(...r.data);}return data;},
  async close(){
   if(!managed){if(report)fs.writeFileSync(report,JSON.stringify(records,null,2));child.stdin.end('quit\n');return;}
   try{
    try{await command(9,{kind:'ident_abort'});}catch(e){console.error('Cleanup abort',String(e));}
    try{const state=await command(9,{kind:'get_state'});if(state.pending||state.motor?.pending_action||state.motor?.drive!==0||state.motor?.motion_active){await command(9,{kind:'stop',after:2});await wait(9,15000,r=>r.motor.drive===0&&!r.motor.motion_active);}}catch(e){console.error('Cleanup stop',String(e));}
    clearInterval(pulse);await chain;
    await command(9,{kind:'permit',enabled:false,lease_ms:0});await command(0,{kind:'close'});
   }finally{clearInterval(pulse);if(report)fs.writeFileSync(report,JSON.stringify(records,null,2));child.stdin.end('quit\n');}
  }
 };
}
if(process.argv[2]==='diagnostics'){
 const h=await hardware(process.argv[3]);try{await h.command(9,{kind:'clear_fault'});await h.wait(9,15000,r=>r.motor.drive===0);await h.command(9,{kind:'commission',action:1});await h.wait(9,15000,r=>r.motor.config_verified);console.log('state',(await h.command(9,{kind:'position_state'})).motor);console.log('registers',await h.registers([0x100,0x140,0x174,0x175,0x180,0x102,0x149]));}finally{await h.close();}
}
