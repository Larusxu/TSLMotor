import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/lib/semantic-motion.ts',import.meta.url),'utf8').split(String.fromCharCode(10)).filter(s=>!s.startsWith('import ')).join(String.fromCharCode(10));
const js=ts.transpileModule('const acquisitionLane={busy:()=>false};const readTelemetry=async()=>({result:12});\n'+source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {SemanticMotion}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const snapshot=(extra={})=>({boot_id:'123',pending:false,motor:{drive:2,pending_action:0,mode:0,limits_valid:true,config_verified:true,motion_active:false,fault:0,last_error:0,...extra}});
{const s=new SemanticMotion();let checks=0;const calls=[];s.open=async()=>{};s.prepared={motor:9,mode:0,speed:4581298,boot:'123'};s.call=async(m,c)=>{calls.push(c.kind);return m===0?{device:{stopping:++checks<3}}:snapshot();};await s.taskCommand(9,0,4581298,{kind:'jog_start',velocity_raw:4581298,lease_ms:700});assert(checks>=3);assert.equal(calls.filter(k=>k==='jog_start').length,1);assert.equal(calls.at(-1),'jog_start');}
{const s=new SemanticMotion();s.open=async()=>{};let reads=0,starts=0;s.call=async(m,c)=>{if(c.kind==='jog_start')starts++;if(m===0){if(++reads===2)s.motionEpoch++;return {device:{stopping:true}};}return snapshot();};await assert.rejects(s.command(9,{kind:'jog_start'}));assert.equal(starts,0);}
{const s=new SemanticMotion();let reads=0;s.command=async()=>({...snapshot({drive:0}),pending:++reads<3});await s.wait(9,2000,()=>true);assert.equal(reads,3);}
{const s=new SemanticMotion();s.open=async()=>{};let drive=2;const calls=[];s.call=async(m,c)=>{calls.push(c);if(m===0)return {device:{stopping:false}};if(c.kind==='stop'){assert.equal(c.after,2);drive=0;}return snapshot({drive});};await s.configureRtmi(9,{kind:'rtmi_config',enabled:true});assert.deepEqual(calls.filter(c=>c.kind!=='get_state').map(c=>c.kind),['stop','rtmi_config']);}
{const s=new SemanticMotion();s.open=async()=>{};const writes=[];s.call=async(m,c)=>{if(c.kind!=='get_state')writes.push(c.kind);return m===0?{device:{stopping:false}}:snapshot({motion_active:true});};await assert.rejects(s.configureRtmi(9,{kind:'rtmi_config',enabled:true}));assert.deepEqual(writes,[]);}
{const s=new SemanticMotion();s.open=async()=>{};let count=0;s.call=async(m,c)=>{if(c.kind==='jog_start'){count++;throw Error('BUSY');}return m===0?{device:{stopping:false}}:snapshot();};await assert.rejects(s.command(9,{kind:'jog_start'}),/BUSY/);assert.equal(count,1);}
{const s=new SemanticMotion();s.open=async()=>{};let submitted=false;s.call=async(m,c)=>{if(c.kind==='rtmi_config')submitted=true;return m===0?{device:{stopping:false}}:snapshot({drive:0,last_error:submitted?0:13});};await s.configureRtmi(9,{kind:'rtmi_config',enabled:true});assert(submitted,'historical last_error must not block a new idle request');}
console.log('PASS stop barrier, release cancellation, pending, RTMI gate-off, moving rejection, historical error recovery and no replay');
{const s=new SemanticMotion();s.command=async()=>snapshot({last_error:15,fault:0,drive:2});const r=await s.wait(9,1000,()=>true);assert.equal(r.motor.drive,2);}
{const s=new SemanticMotion();s.command=async()=>snapshot({fault:32});await assert.rejects(s.wait(9,1000,()=>true));}
console.log('PASS travel notice permits subsequent tasks; real IO fault still blocks');
