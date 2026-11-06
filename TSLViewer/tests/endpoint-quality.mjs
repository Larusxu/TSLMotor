import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
function load(file, deps={}) {
  const js=ts.transpileModule(readFileSync(new URL(`../src/lib/pi-auto/${file}.ts`,import.meta.url),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText;
  const exports={};new Function('exports','require',js)(exports,n=>deps[n]);return exports;
}
const quality=load('motion-quality');
const {optimizeEndpoint}=load('endpoint',{'./motion-quality':quality});
const move=(extra={})=>({rpm:15000,elapsedMs:1000,tailMs:100,peakRpm:15000,peakIqMa:200,
  overshootPercent:0,finalErrorPercent:0,speedExcess:0,reversePercent:0,...extra});
test('overshoot followed by pullback is measured in both directions',()=>{
  for(const direction of [1,-1]){
    const points=[0,500,1010,1000].flatMap((v,at)=>[
      {at,channel:2,raw:v*direction},{at,channel:0,raw:100},{at,channel:1,raw:65536}]);
    const m=quality.motionQuality(points,0,3,0,1000*direction,10000,500,1000*direction);
    assert.equal(m.overshootPercent,.1);assert.equal(m.reversePercent,.1);
    assert.equal(quality.qualifiedMotion([m]),false);
  }
});
test('one bad speed invalidates a combination even when other speeds are good',()=>{
  assert.equal(quality.qualifiedMotion([move(),move({reversePercent:.06}),move()]),false);
});
test('qualified slower candidate can replace faster disqualified baseline',async()=>{
  const original=[65537,65537,65537,65537];let current=original;
  const result=await optimizeEndpoint(original,{
    apply:async words=>{current=words;},
    measure:async()=>[current.every((v,i)=>v===original[i])?
      move({speedExcess:.26}):move({tailMs:10000})],
    cancelled:()=>false,notice:()=>{},
  });
  assert.equal(result.improved,true);assert(quality.qualifiedMotion(result.best.moves));
});
test('batch continues optimizing and retains best without a repeat rollback gate',async()=>{
  const original=[65537,65537,65537,65537];let current=original;
  const visits=new Map();
  const result=await optimizeEndpoint(original,{
    apply:async words=>{current=words;},
    measure:async()=>{
      const key=current.join(',');visits.set(key,(visits.get(key)??0)+1);
      return [current.every((v,i)=>v===original[i])?move({tailMs:5000}):
        move(visits.get(key)>1?{reversePercent:.1}:{})];
    },cancelled:()=>false,notice:()=>{},
  });
  assert.equal(result.improved,true);assert.deepEqual(current,result.best.coefficients);
  assert([...visits.values()].every(count=>count===1));
});
