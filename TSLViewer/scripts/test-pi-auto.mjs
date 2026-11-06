import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const responseCode=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/response.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const responseUrl=`data:text/javascript;base64,${Buffer.from(responseCode).toString('base64')}`;
const code=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/model.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace("'./response'",JSON.stringify(responseUrl));
const m=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const policyCode=ts.transpileModule(fs.readFileSync(new URL('../src/lib/pi-auto/capture-policy.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const policy=await import(`data:text/javascript;base64,${Buffer.from(policyCode).toString('base64')}`);
const currentLimits=2483*65536;
// The MCU recenters native PRBS; original raw position is irrelevant.
assert.doesNotThrow(()=>policy.validatePositionExcitation(5461,9102));
assert.doesNotThrow(()=>policy.validatePositionExcitation(9102,9102));
assert.throws(()=>policy.validatePositionExcitation(9103,9102),/超过相对采集起点/);
// Capture policy regression cases.
assert.throws(()=>policy.permittedAmplitude(1,3974,currentLimits,100000),/Iq 转矩电流激励800.01 mA超过当前上限499.85 mA/);
assert.equal(policy.permittedAmplitude(1,497,currentLimits,100000),497);
assert.equal(policy.permittedAmplitude(1,2483,currentLimits,100000),2483);
assert.throws(()=>policy.permittedAmplitude(0,50,currentLimits,100000),/当前上限为0/);
assert.throws(()=>policy.permittedAmplitude(2,100001,currentLimits,100000),/转速限幅/);
assert.equal(policy.permittedAmplitude(3,100,currentLimits,0),100);
const range=policy.captureFailure({loop:1,error:6,currentLimits},3974,910);
assert.match(range,/800.01 mA超过当前上限499.85 mA/);
assert.match(range,/长期约束 → 转矩电流限幅/);
assert.match(range,/不自动降低激励/);
assert.doesNotMatch(range,/位置原点/);
assert.match(policy.captureFailure({loop:1,error:6,currentLimits},497,910),/PWM周期配置/);
const travelError=policy.captureFailure({loop:1,error:3,count:10},497,65536);
assert.match(travelError,/10组.*±360.00°/);
assert.match(travelError,/相对本次采集起点/);
assert.match(travelError,/不是电流超限/);
assert.equal(policy.captureFailure({loop:1,error:1},497,65536),'TMC读写失败');
assert.match(policy.captureFailure({loop:1,error:4},497,65536),/旧固件.*单点判定/);
const original=[0x400030,0x410031,0x2ee0005,0xc80000],same=80*65536+20;
for(const loop of [0,1]){
 assert.deepEqual(m.trialCoefficients(original,loop,80,20,true),[same,same,original[2],original[3]]);
 const separate=[...original];separate[loop]=same;
 assert.deepEqual(m.trialCoefficients(original,loop,80,20,false),separate);
}
assert.deepEqual(m.trialCoefficients(original,2,80,20,true),[original[0],original[1],same,original[3]]);
assert.deepEqual(original,[0x400030,0x410031,0x2ee0005,0xc80000]);
function dataset(a=.97,b=.02,loop=2){
  let state=0xfffff,y=0,u=0;const samples=[];
  for(let k=0;k<600;k++){
    const bit=((state>>>16)^(state>>>19))&1;state=((state<<1)|bit)&0xfffff;
    const reference=state&1?100:-100;y=a*y+b*u;u=reference-.4*y;
    samples.push({at:k*10,reference,actual:y,effort:u});
  }
  return {state:2,motor:9,loop,generation:1,count:samples.length,error:0,sampleHz:100,pidConfig:0x0050005c,
    pwmHz:25000,velocityHz:1000,coefficient:0,currentLimits:0,velocityLimit:0,events:0,cursor:samples.length,samples,coefficients:[0,0,0,0]};
}
const c=dataset(), model=m.identify(c);
// Millisecond wire stamps can repeat at native kHz sampling rates.
for(const sampleHz of [1000,2083.333,3125]){
 const fast=dataset();fast.sampleHz=sampleHz;
 fast.samples=fast.samples.map((s,k)=>({...s,at:Math.floor(k*1000/sampleHz)}));
 assert.doesNotThrow(()=>m.identify(fast));
 assert.throws(()=>m.identify({...fast,samples:fast.samples.map(s=>({...s,at:0}))}),/采样时间/);
 assert.throws(()=>m.identify({...fast,samples:fast.samples.map((s,k)=>({...s,at:s.at+(k>100?10:0)}))}),/采样时间/);
}
assert(Math.abs(model.a-.97)<1e-7);assert(Math.abs(model.b-.02)<1e-7);assert(model.fit>.999);
assert(model.validationFit>.999);
const changed=dataset();for(let k=350;k<changed.samples.length;k++)changed.samples[k].actual+=100;
assert.throws(()=>m.identify(changed),/独立自由响应/);
const pi=m.calculate(c,2);assert(pi.p>0&&pi.i>0);assert(pi.model.fit>.999);
const p=Math.exp(-2*Math.PI*2/100),kp=pi.kp,ki=pi.kiPerSecond/100;
assert(Math.abs(-1-.97+.02*(kp+ki)+2*p)<1e-8);
assert(Math.abs(.97-.02*kp-p*p)<1e-8);
assert.throws(()=>m.calculate(c,11),/1\/10/);
assert.throws(()=>m.calculate({...c,samples:c.samples.slice(0,10)},2));
assert.throws(()=>m.calculate({...c,events:8},2),/RTMI/);
assert.throws(()=>m.calculate({...c,samples:c.samples.map((s,i)=>({...s,at:i>100?s.at+50:s.at}))},2),/采样时间/);
assert.throws(()=>m.identify({...c,state:3,error:1}));
assert.throws(()=>m.identify({...c,samples:c.samples.map(s=>({...s,reference:1,actual:1,effort:1}))}));
const base=m.encodeGains(1,.5,1000,0x84,2),shift=m.encodeGains(1,.5,1000,0x1084,2);
assert.equal(shift.p,base.p*2);assert.equal(Math.abs(shift.i-base.i*2)<=1,true);
assert.throws(()=>m.encodeGains(Infinity,1,1000,0,0));
const raw=new Uint8Array(96),d=new DataView(raw.buffer);raw[0]=1;raw[1]=2;raw[2]=9;raw[3]=1;
d.setUint32(8,2,true);d.setUint32(48,2,true);d.setUint32(32,0x12340056,true);
d.setInt32(68,-100,true);d.setInt32(72,-200,true);d.setInt32(76,-300,true);
const decoded=m.decodeCapture([...raw]);assert.equal(decoded.samples.length,2);assert.equal(decoded.samples[0].effort,-300);assert.equal(decoded.coefficients[1],0x12340056);
assert.throws(()=>m.decodeCapture([...raw.slice(0,95)]));
if(process.argv[2]){
  const real=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const saved=real.findLast(x=>x.identification&&x.samples);
  assert(saved,'No downloaded hardware capture');
  const capture={...m.decodeCapture(saved.identification),samples:saved.samples};
  assert.equal(capture.count,capture.samples.length);
  try{console.log('Hardware candidate',m.calculate(capture,2));}catch(e){console.log('Hardware quality decision:',String(e));}
}
console.log('PASS PI identification: IV model, pole placement, Q/shift, bandwidth, malformed data and insufficient excitation');
const quality=await import(responseUrl);
const closed=dataset();let y1=0,y2=0,u1=0,u2=0;
for(const s of closed.samples){const y=.6*y1-.2*y2+.5*u1+.1*u2;y2=y1;y1=y;u2=u1;u1=s.reference;s.actual=y;}
assert(quality.evaluateResponse(closed).validationFit>.999999);
assert.equal(quality.compareResponse(closed,closed).accepted,false);
assert.throws(()=>quality.evaluateResponse({...closed,loop:0}),/速度PRBS/);
assert.throws(()=>quality.evaluateResponse({...closed,samples:closed.samples.map(v=>({...v,reference:0}))}));
assert.throws(()=>quality.compareResponse(closed,{...closed,count:closed.count/2}),/对照采集/);
if(process.argv[2]){
 const load=p=>{const r=JSON.parse(fs.readFileSync(p,'utf8')).findLast(x=>x.identification&&x.samples);return {...m.decodeCapture(r.identification),samples:r.samples};};
 const base=load(process.argv[2]);
 console.log('Closed-loop independent validation',quality.evaluateResponse(base));
 const small=m.velocityTrial(base);assert.equal(small.p,825);assert.equal(small.i,5);
 for(const path of process.argv.slice(3)){try{console.log(path,quality.compareResponse(base,load(path)));}catch(e){console.log(path,String(e));}}
 assert.throws(()=>quality.compareResponse(base,{...base,pidConfig:base.pidConfig+1}));
}

assert.equal(policy.resolveCaptureTravel(655360,true,{coordinate_valid:true,position:'5000000',negative_contact:'0',positive_contact:'10000000',margin_counts:1000}),3999200);
assert.equal(policy.resolveCaptureTravel(655360,false,{coordinate_valid:true}),655360);
assert.equal(policy.resolveCaptureTravel(655360,true,{coordinate_valid:false}),655360);
assert.throws(()=>policy.resolveCaptureTravel(10,true,{coordinate_valid:true,position:'0',negative_contact:'0',positive_contact:'100'}),/中段/);
const diag=new Uint8Array(96),dv=new DataView(diag.buffer);
dv.setUint32(48,0xfffffffe,true);dv.setUint32(64,0x31444950,true);dv.setUint32(68,1<<25,true);dv.setInt32(76,-123,true);
assert.equal(m.decodeCaptureDiagnostic([...diag]).delta,-123);
assert.match(policy.diagnosticText({loop:1,diagnostic:m.decodeCaptureDiagnostic([...diag])}),/削顶（警告）/);
assert.equal(m.decodeCaptureDiagnostic([...diag.slice(0,64)]),undefined);

const homed={coordinate_valid:true,position:'-500000',negative_contact:'-1000000',positive_contact:'0',margin_counts:1000};
for(const [range,counts] of [[[20,80],299000],[[30,70],199000],[[40,60],99000]])assert.equal(policy.percentCaptureTravel(range,homed),counts);
assert.throws(()=>policy.percentCaptureTravel([40,60],{...homed,position:'-700000'}),/中点/);
assert.throws(()=>policy.percentCaptureTravel([40,60],{...homed,coordinate_valid:false}),/找零/);
assert.throws(()=>policy.percentCaptureTravel([0,100],homed),/有效/);
console.log('PASS percentage-only homed travel windows, signed coordinates and endpoint exclusion');
const page=new Uint8Array(96),pd=new DataView(page.buffer),terminal={state:2,motor:9,loop:1,generation:7,count:10};
page.set([2,2,9,1]);pd.setUint32(4,7,true);pd.setUint32(8,10,true);pd.setUint32(12,5,true);
for(let i=0;i<5;i++){pd.setUint32(16+i*16,100+i,true);pd.setInt32(20+i*16,-123,true);}
const denseDecoded=m.decodeCapturePage([...page],terminal);assert.equal(denseDecoded.cursor,5);assert.equal(denseDecoded.samples.length,5);assert.equal(denseDecoded.samples[4].reference,-123);
assert.throws(()=>m.decodeCapturePage([...page],{...terminal,generation:8}),/身份/);
assert.throws(()=>m.decodeCapturePage([...page.slice(0,95)],terminal),/长度/);
console.log('PASS dense page identity, signed sample decoding and malformed page rejection');
