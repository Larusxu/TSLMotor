// Pure production codecs and trace adapter. No browser, serial ports or motion.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const source = p => read(p).replace(/^import .*;\r?\n/gm, '');
const url = s => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(s, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64');
const presetsUrl = url(source('../src/lib/presets.ts'));
const unitsUrl = url(source('../src/lib/units.ts'));
const profileUrl = url(`const {composePidConfig,parsePidConfig}=await import('${unitsUrl}');\n`+source('../src/lib/motor-profile-ui.ts'));
const {encoderView,encoderCheck}=await import(url(`const {ENCODER_PRESETS,TESLA_PROFILE}=await import('${presetsUrl}');const {word}=await import('${profileUrl}');\n`+source('../src/lib/encoder-view.ts')));
const fallback=encoderView(null,null);
assert.equal(fallback.frameBits,14); assert.equal(fallback.cpr,16384);
assert.equal(fallback.spiHz,2000000); assert.equal(fallback.pwm,4800);
assert.equal(fallback.offset,null);
assert.equal(encoderCheck(123,null,0xffffffff).text,'未回读');
assert.equal(encoderCheck(null,123,65535).text,'待对齐');
assert.equal(encoderCheck(4800,0xbeef12c0,65535).text,'OK');
assert.equal(encoderCheck(4800,4799,65535).text,'差异');
const {decodeRtmi}=await import(url(source('../src/lib/native-rtmi.ts')));
const {ScopeStore}=await import(url(source('../src/lib/scope.ts')));
const {SIGNALS,convertSignal}=await import(presetsUrl);
const data=new Uint8Array(47),v=new DataView(data.buffer);
v.setUint32(0,3,true);v.setUint32(12,1,true);data[16]=1;data[17]=255;data[18]=7;data[19]=3;
const raws=[-3054,(-100&65535)<<16,32768];
for(let i=0;i<3;i++){v.setUint32(20+9*i,1000,true);data[24+9*i]=i;v.setUint32(25+9*i,raws[i],true);}
const decoded=decodeRtmi([...data]);assert.equal(decoded.samples.length,3);assert.equal(decoded.sampling,255);
assert.throws(()=>decodeRtmi([...data.slice(1)]));data[24]=7;assert.throws(()=>decodeRtmi([...data]));data[24]=0;
const store=new ScopeStore(),ids=['vel_act','torque','pos_act'];
ids.forEach((id,ch)=>{const s=SIGNALS.find(s=>s.id===id);store.ensure(ch,s,s.color);});
store.push({t:1000,pts:decoded.samples.map(s=>[s.ch,s.raw])},(ch,raw)=>convertSignal(SIGNALS.find(s=>s.id===ids[ch]),raw,{countsPerRpm:305.4,maPerCount:.20131,polarity:1,poles:1,tempOffset:0}));
assert(Math.abs(store.latest.get(0)+10)<1e-8);assert(Math.abs(store.latest.get(1)+20.131)<1e-8);assert.equal(store.latest.get(2),180);
assert(!read('../src/lib/app-store.tsx').includes('SemanticTrace'));
console.log('PASS encoder masked validation, native RTMI decoding/bounds and original ScopeStore conversions');
