import assert from 'node:assert/strict';
import {moduleUrl} from './pi-auto-real.mjs';
const {spectrum,frequencyCandidate}=await import(moduleUrl('frequency'));
const {automaticTune,trackingQuality}=await import(moduleUrl('automatic'));
const {encodeGains}=await import(moduleUrl('model'));
function record(samples,hz=1000,p=64,i=8){return {state:2,motor:9,loop:1,generation:1,count:samples.length,error:0,sampleHz:hz,pidConfig:12,pwmHz:25000,velocityHz:2500,coefficient:p*65536+i,currentLimits:0,velocityLimit:0,events:0,cursor:samples.length,samples,coefficients:[p*65536+i,p*65536+i,0,0]};}
let random=123456789;
const rand=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return (random>>>0)/0xffffffff;};
let y=0,reference=0;
const known=record(Array.from({length:8192},(_,k)=>{if(k%4===0)reference=rand()>.5?100:-100;y=.83*y+.17*reference;return {at:k,reference,actual:y,effort:0};}));
const sp=spectrum(known);
assert(sp.coherence>.9);assert(sp.bandwidthHz>20&&sp.bandwidthHz<45);
const unrelated={...known,samples:known.samples.map(s=>({...s,actual:(rand()-.5)*100}))};
assert(spectrum(unrelated).coherence<.3);
assert.throws(()=>frequencyCandidate(unrelated,30),/覆盖目标带宽/);
assert.throws(()=>frequencyCandidate(known,500),/奈奎斯特/);
assert.throws(()=>spectrum({...known,events:8}),/无丢帧/);
assert.equal(encodeGains(1,0,25000,12,1).i,0);
// A real PI in feedback around a discrete first-order plant, independent of
// the optimizer. The optimizer receives only reference, output and effort.
function plant(p,i){let y=0,integral=0,u=0,r=0;random=987654321;return record(Array.from({length:2400},(_,k)=>{
 if(k%5===0)r=rand()>.5?100:-100;
 y=.92*y+.08*u;const e=r-y;integral+=i/256*.1*e;u=p/256*e+integral;
 return {at:k*5,reference:r,actual:y,effort:u};
}),200,p,i);}
let current=[32,1],restored=0,applied=0;
const port={capture:async()=>plant(...current),apply:async(_c,p,i)=>{current=[p,i];applied++;},restore:async()=>{current=[32,1];restored++;},cancelled:()=>false,notice:()=>{}};
const result=await automaticTune(port,5,12);
assert(applied>3);assert(result.improved);assert(trackingQuality(result.best.capture,5).score<trackingQuality(result.baseline.capture,5).score*.98);
assert.equal(result.candidate.method,'measured-search');
// Silence must never be accepted as a better tuned controller.
const silent=await automaticTune({...port,capture:async()=>({...plant(...current),samples:plant(...current).samples.map(s=>({...s,actual:0}))})},5,6);
assert.equal(silent.improved,false);
assert(restored>0);
// Errors while writing the model-derived first candidate must not be swallowed
// as a harmless fitting failure. Always run restoration and preserve the cause.
let attempts=0;
await assert.rejects(automaticTune({...port,capture:async()=>plant(32,1),apply:async()=>{attempts++;throw Error('WRITE_FAILED');}},5,8),/WRITE_FAILED/);
assert.equal(attempts,1);assert(restored>0);
let count=0;await assert.rejects(automaticTune({...port,capture:async()=>{count++;return plant(32,1);},cancelled:()=>count>0},5,8),/取消/);
await assert.rejects(automaticTune({...port,capture:async()=>{throw Error('CAPTURE_FAILED');},restore:async()=>{throw Error('RESTORE_FAILED');}},5),/CAPTURE_FAILED.*RESTORE_FAILED/);
console.log('PASS frequency coherence/bandwidth, desired response optimization, zero I, repeated trials, write failure, cancellation and restore failure');
const {motionQuality,motionScore,qualifiedMotion}=await import(moduleUrl('motion-quality'));
const {optimizeEndpoint}=await import(moduleUrl('endpoint'));
const points=Array.from({length:11},(_,k)=>[
 {at:k*100,channel:0,raw:Math.round(500*305.4198966044444)},
 {at:k*100,channel:1,raw:100<<16},
 {at:k*100,channel:2,raw:-k*100},
]).flat();
const q=motionQuality(points,0,1000,0,-1000,10000,500,-1000);
assert.equal(q.tailMs,100);assert.equal(q.overshootPercent,0);assert.equal(q.finalErrorPercent,0);assert(qualifiedMotion([q]));
const excess={...q,peakRpm:700,speedExcess:.4};assert(!qualifiedMotion([excess]));assert(motionScore([excess])>motionScore([q]));
const positionExcess=motionQuality([...points,{at:950,channel:2,raw:-1010}],0,1000,0,-1000,10000,500,-1000);
assert.equal(positionExcess.overshootPercent,.1);assert(!qualifiedMotion([positionExcess]));
let words=[1,2,263*65536+3,3200*65536],writes=[];
const endpoint=await optimizeEndpoint(words,{apply:async v=>{words=[...v];writes.push(v);},measure:async()=>[{...q,tailMs:words[2]>>>16===395?50:100}],cancelled:()=>false,notice:()=>{}});
assert(endpoint.improved);assert.equal(endpoint.best.coefficients[2]>>>16,395);assert.deepEqual(words,endpoint.best.coefficients);
assert(writes.some(v=>(v[2]&65535)===0));assert(writes.some(v=>(v[2]&65535)===2));
const starting=[...words];let cancelledNow=false;
await assert.rejects(optimizeEndpoint(starting,{apply:async v=>{words=[...v];},measure:async()=>{cancelledNow=true;return [q];},cancelled:()=>cancelledNow,notice:()=>{}}),/取消/);
assert.deepEqual(words,starting);
console.log('PASS endpoint direction, tail, separate speed/position overshoot, repeated selection and cancelled-round restoration');
