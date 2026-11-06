import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const stubs={
 './presets':'export const reproductionOptions=loop=>({loop,bandwidthHz:loop<2?100:loop===2?30:10});',
 '../semantic-motion':'export const semanticMotion={report(...a){globalThis.__piReport?.(...a)},command(...a){return globalThis.__piCommand(...a)},configureRtmi(){return Promise.resolve()},wait(){return Promise.resolve({boot_id:"boot",motor:{drive:0}})}};',
 '../motor-profile-ui':'export const COUNTS_PER_RPM=1099511627776/3600000000,word=()=>0,RUN2_TAG=0x324e5552;export const readMotorProfile=async()=>({data:globalThis.__piProfile}),pidFromProfile=p=>({...p}),tuneMotorPi=(...a)=>globalThis.__piTune(...a),applyMotorPi=()=>{throw Error("Unexpected persistent write")};',
 './model':'export const decodeCapture=()=>{},decodeCapturePage=()=>{},decodeCaptureDiagnostic=()=>{},trialCoefficients=(original,loop,p,i,shared)=>{const next=[...original];if(loop<2&&shared){next[0]=p*65536+i;next[1]=p*65536+i;}else next[loop]=p*65536+i;return next;};',
 '../units':'export const parsePidConfig=()=>{};',
 '../native-rtmi':'export const decodeRtmi=b=>b;',
 './capture-policy':'export const amplitudeText=()=>{},captureFailure=()=>{},permittedAmplitude=()=>{},validatePositionExcitation=()=>{},resolveCaptureTravel=()=>{},percentCaptureTravel=()=>{},diagnosticText=()=>{};',
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
globalThis.__piCommand=async()=>({boot_id:"boot",motor:{motion_active:false}});
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

const seq=new PiAutoService(),loops=[];
seq.automatic=async (_m,o,bw,shared,_p,_n,_t,internal)=>{assert(shared);assert(internal);loops.push([o.loop,bw]);return {improved:true};};
assert.equal((await seq.sequence(9,true,()=>{},()=>{},()=>{})).length,3);
assert.deepEqual(loops,[[1,100],[2,30],[3,10]]);assert(!seq.sequenceRunning);
seq.before=original;seq.trial=innerTrial;seq.trialMotor=9;seq.verified=true;seq.trialBoot="boot";seq.checkTrial=async()=>{};
seq.restoreValues=async(_m,p)=>{restored=p;};
seq.automatic=async(_m,o)=>{if(o.loop===1){seq.trial={vel_p:999};return {improved:true};}throw Error('ROUND_FAILED');};
await assert.rejects(seq.sequence(9,true,()=>{},()=>{},()=>{}),/ROUND_FAILED/);
assert.deepEqual(seq.trial,{vel_p:999});assert(!seq.sequenceRunning);
const presentation=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/presentation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {emptyCaptureView,updateCaptureView}=await import(url(presentation));
let view=emptyCaptureView();const complete={samples:[1,2],generation:1};
view=updateCaptureView(view,{phase:'complete',capture:complete,received:2});
for(const phase of ['capturing','downloading']){view=updateCaptureView(view,{phase,capture:{samples:[],generation:2},received:0});assert.equal(view.capture,complete);}
console.log('PASS three-loop sequencing, failure checkpoint and retained completed waveform');
const presetCode=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/presets.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {reproductionOptions}=await import(url(presetCode));
assert.deepEqual([1,2,3].map(loop=>{
 const p=reproductionOptions(loop);return [p.amplitude,p.durationMs,p.sampling,p.excitationSampling,p.bandwidthHz];
}),[[993,1000,7,7,100],[30542,2000,31,255,30],[18204,3000,31,255,10]]);
const cancelled=new PiAutoService();let steps=0;
cancelled.automatic=async()=>{steps++;await cancelled.cancel();return {improved:false};};
await assert.rejects(cancelled.sequence(9,true,()=>{},()=>{},()=>{}),/已取消/);
assert.equal(steps,1);assert(!cancelled.sequenceRunning);
console.log('PASS historical physical-unit presets and cancellation between loops');

// A changed boot discards old trials, but must not block a fresh automatic run.
const rebooted=new PiAutoService();rebooted.before={vel_p:100};rebooted.trial={vel_p:200};rebooted.trialMotor=9;rebooted.trialBoot='old';rebooted.verified=true;
globalThis.__piCommand=async()=>({boot_id:'new',motor:{motion_active:false}});
globalThis.__piRound=async()=>({improved:false});
await rebooted.automatic(9,{},30,true,()=>{},()=>{});
assert(!rebooted.hasTrial(9));assert.equal(rebooted.before,null);assert.equal(rebooted.verified,false);
// Three-loop settings and stroke percentages survive the sequence; completed rings are reported immediately.
const configured=new PiAutoService(),selected=[],completed=[];
configured.automatic=async(_m,o,bw)=>{selected.push([o.loop,o.amplitude,bw,o.travelPercentRange]);return {improved:true};};
await configured.sequence(9,true,()=>{},()=>{},()=>{},undefined,[30,70],{1:{options:{loop:1,amplitude:2484,durationMs:1000,travelCounts:1},bandwidthHz:150}},(_r,loop)=>completed.push(loop));
assert.deepEqual(selected[0],[1,2484,150,[30,70]]);assert.deepEqual(completed,[1,2,3]);
console.log('PASS reboot cache recovery, configured three-loop ordering and completed-inner-loop retention');

const temporary=new PiAutoService();
const trialBase={flux_p:64,flux_i:48,torque_p:64,torque_i:48,vel_p:750,vel_i:5,pos_p:200,pos_i:0};
globalThis.__piProfile=trialBase;
globalThis.__piCommand=async(_m,q)=>{assert.equal(q.kind,'get_state');return {boot_id:'boot',motor:{drive:2,motion_active:true}};};
let writes=[];globalThis.__piTune=async(...a)=>writes.push(a);
temporary.patch=(p,loop,c,shared)=>({...p,flux_p:c.p,flux_i:c.i,torque_p:c.p,torque_i:c.i});
const output=await temporary.tryResult(9,1,179,384,true);
assert.equal(writes.length,1);assert.equal(writes[0][1],0);assert.equal(output.flux_p,179);assert.equal(output.torque_i,384);assert.equal(output.vel_p,750);
assert(!temporary.hasTrial(9));
temporary.active=true;await assert.rejects(temporary.tryResult(9,1,200,300,true));assert.equal(writes.length,1);
console.log('PASS volatile result trial uses per-loop API while moving, preserves other groups and rejects overlapping acquisition');

// Saved W25 and volatile working PI may differ. Candidate validation belongs
// to the actual capture plus a fresh live snapshot, not the saved preset.
const candidateService=new PiAutoService();
const captured={motor:1,loop:2,pidConfig:0x855c,coefficients:[64*65536+48,64*65536+48,500*65536+250,500*65536]};
globalThis.__piProfile={...trialBase};
globalThis.__piCommand=async()=>({boot_id:'boot',motor:{drive:0,motion_active:false}});
let candidateWrites=0,liveReads=0;
globalThis.__piTune=async()=>candidateWrites++;
candidateService.patch=p=>({...p,vel_p:400,vel_i:100});
candidateService.livePi=async()=>[captured.pidConfig,...(++liveReads===1?captured.coefficients:[captured.coefficients[0],captured.coefficients[1],400*65536+100,captured.coefficients[3]])];
await assert.rejects(candidateService.apply(2,captured,{p:400,i:100},false),/另一电机/);
candidateService.livePi=async()=>[captured.pidConfig^4,...captured.coefficients];
await assert.rejects(candidateService.apply(1,captured,{p:400,i:100},false),/TMC归一化、速度右移或位置采样已改变/);
assert.equal(candidateWrites,0,'Actual config changes must still be rejected');

candidateService.livePi=async()=>[captured.pidConfig,...(++liveReads===1?captured.coefficients:[captured.coefficients[0],captured.coefficients[1],400*65536+100,captured.coefficients[3]])];
await candidateService.apply(1,captured,{p:400,i:100},false);
assert.equal(candidateWrites,1,'Archived normalization mismatch must not block a verified live capture');
assert.equal(candidateService.trial.vel_p,400);
console.log('PASS candidate uses captured/live normalization rather than stale W25; actual motor/config changes remain rejected');
