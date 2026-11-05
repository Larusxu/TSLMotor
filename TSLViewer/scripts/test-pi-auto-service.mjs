import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const stubs={
 '../semantic-motion':'export const semanticMotion={report(...a){globalThis.__piReport?.(...a)},command(...a){return globalThis.__piCommand(...a)},configureRtmi(){return Promise.resolve()},wait(){return Promise.resolve({boot_id:"boot",motor:{drive:0}})}};',
 '../motor-profile-ui':'export const readMotorProfile=()=>{},pidFromProfile=()=>{},tuneMotorPi=()=>{},applyMotorPi=()=>{};',
 './model':'export const decodeCapture=()=>{},trialCoefficients=()=>{};',
 '../units':'export const parsePidConfig=()=>{};',
 '../native-rtmi':'export const decodeRtmi=b=>b;',
 './capture-policy':'export const amplitudeText=()=>{},captureFailure=()=>{},permittedAmplitude=()=>{},validatePositionExcitation=()=>{};',
 './automatic':'export const automaticTune=(port)=>globalThis.__piRound(port);',
 './acquisition':'export const acquisitionLane={async enter(){return ()=>{}}};',
 './endpoint':'export const optimizeEndpoint=()=>{};',
 './motion-trial':'export const measureEndpoint=()=>{};',
};
let code=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/service.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
code=code.replace(/from ['"]([^'"]+)['"]/g,(_,name)=>'from '+JSON.stringify(url(stubs[name]??(()=>{throw Error(name)})())));
const {PiAutoService}=await import(url(code));
const laneCode=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/acquisition.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {AcquisitionLane}=await import(url(laneCode));
const lane=new AcquisitionLane();let normalStopped=0;
const off=lane.beforeCapture(async()=>{assert(lane.busy());normalStopped++;});
const release=await lane.enter();assert.equal(normalStopped,1);assert(lane.busy());
await assert.rejects(lane.enter(),/正在使用RTMI/);
release();release();assert(!lane.busy());off();
const removeFailure=lane.beforeCapture(async()=>{throw Error('STOP_FAILED');});
await assert.rejects(lane.enter(),/STOP_FAILED/);assert(!lane.busy());removeFailure();
const service=new PiAutoService(),original={vel_p:750},innerTrial={vel_p:263};
service.before=original;service.trial=innerTrial;service.trialMotor=9;service.trialBoot='boot';service.verified=true;
service.checkTrial=async motor=>assert.equal(motor,9);
let restored;
service.restoreValues=async (motor,values)=>{assert.equal(motor,9);restored={...values};};
service.apply=async()=>{service.trial={vel_p:400};service.verified=true;};
globalThis.__piRound=async port=>{await port.apply({},400,3);await port.restore();return {improved:false};};
await service.automatic(9,{},30,true,()=>{},()=>{});
assert.deepEqual(restored,innerTrial);assert.deepEqual(service.trial,innerTrial);
assert.equal(service.before,original);assert(service.verified);assert(!service.automaticRunning);
// A successful outer-loop round keeps the original whole-set backup.
globalThis.__piRound=async port=>{await port.apply({},400,3);return {improved:true};};
await service.automatic(9,{},30,true,()=>{},()=>{});
assert.equal(service.trial.vel_p,400);assert.equal(service.before,original);
// An exceptional round uses the same checkpoint, preserving the prior trial.
globalThis.__piRound=async port=>{await port.apply({},500,3);await port.restore();throw Error('CAPTURE_FAILED');};
await assert.rejects(service.automatic(9,{},30,true,()=>{},()=>{}),/CAPTURE_FAILED/);
assert.equal(service.trial.vel_p,400);assert.equal(service.before,original);assert(!service.automaticRunning);
// A damaged snapshot invalidates all partial observations. Two matching
// observations must follow the error; a pre-error value cannot count.
const snapshotService=new PiAutoService();let snapshots=0,warnings=0;
const blocks=[[],[{ch:0,raw:123}],[{ch:0,raw:999}],[{ch:0,raw:123}],[{ch:0,raw:123}]];
globalThis.__piReport=level=>{if(level==='warn')warnings++;};
globalThis.__piCommand=async (_motor,q)=>q.kind==='rtmi_state'?{boot_id:'boot',rtmi:{cursor:snapshots+1,generation:1,lost:0,errors:snapshots<2?0:1,enabled:true,samples:blocks[snapshots++]}}:{};
assert.deepEqual(await snapshotService.liveRegisters(9,[0x140]),[123]);
assert.equal(snapshots,5);assert.equal(warnings,1);
console.log('PASS sequential loop tuning checkpoints, whole-set original backup and failed-round recovery');
