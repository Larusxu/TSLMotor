// Actual component event handlers in a minimal hook harness. This verifies
// React state transitions, not browser layout or OS pointer delivery.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
const js=ts.transpileModule(readFileSync(new URL('../src/components/HoldMotionButton.tsx',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
function harness(){
  let cursor=0,stops=0,starts=0,failures=0;
  const slots=[],pending=[],listeners=new Map();
  const hooks={
    useState(value){const i=cursor++;if(!(i in slots))slots[i]=value;return [slots[i],v=>{slots[i]=v;}];},
    useRef(value){const i=cursor++;if(!(i in slots))slots[i]={current:value};return slots[i];},
    useEffect(fn,deps){const i=cursor++,old=slots[i];
      if(!old||deps.some((d,j)=>d!==old.deps[j]))pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
  };
  const events={addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:(k,fn)=>{if(listeners.get(k)===fn)listeners.delete(k);}};
  const exports={};new Function('exports','require','window','document',js)(exports,
    n=>n==='react'?hooks:jsx,events,{...events,hidden:false});
  let resolveStart;
  const props={canStart:true,interrupted:false,start:()=>{starts++;return new Promise(resolve=>{resolveStart=resolve;});},
    stop:()=>{stops++;},onError:()=>{failures++;},onHolding:()=>{},children:'点动'};
  const render=()=>{cursor=0;const el=exports.HoldMotionButton(props);pending.splice(0).forEach(fn=>fn());return el.props;};
  let captured=0;
  const down={button:0,isPrimary:true,pointerId:7,preventDefault(){},currentTarget:{setPointerCapture:id=>{captured=id;}}};
  return {props,render,down,resolve:()=>resolveStart(),get starts(){return starts;},get stops(){return stops;},
    get captured(){return captured;},get failures(){return failures;},blur:()=>listeners.get('blur')?.()};
}
test('press remains enabled/captured during drive initialization and stops exactly once on release',async()=>{
  const h=harness();h.render().onPointerDown(h.down);assert.equal(h.captured,7);assert.equal(h.starts,1);
  h.props.canStart=false;let p=h.render();assert.equal(p.disabled,false);assert.equal(p['aria-pressed'],true);
  h.resolve();await Promise.resolve();p=h.render();assert.equal(p['aria-pressed'],true);assert.equal(h.stops,0);
  p.onPointerUp();p.onLostPointerCapture();p=h.render();assert.equal(p['aria-pressed'],false);assert.equal(h.stops,1);
});
test('release during asynchronous preparation does not later restore pressed state',async()=>{
  const h=harness();let p=h.render();p.onPointerDown(h.down);p.onPointerUp();
  h.resolve();await Promise.resolve();p=h.render();assert.equal(p['aria-pressed'],false);assert.equal(h.stops,1);
});
test('confirmed interruption or window blur stops an owned hold; background buttons cannot start',()=>{
  for(const fault of [true,false]){
    const h=harness();h.render().onPointerDown(h.down);h.render();
    if(fault){h.props.interrupted=true;h.render();}else h.blur();
    assert.equal(h.stops,1);assert.equal(h.render()['aria-pressed'],false);
  }
  const h=harness();h.props.canStart=false;h.render().onPointerDown(h.down);assert.equal(h.starts,0);
});

test('synchronous speed validation failure releases press and reports the reason',async()=>{
  const h=harness();h.props.start=()=>{throw Error('超过公共上限 2000 rpm');};
  h.render().onPointerDown(h.down);
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(h.render()['aria-pressed'],false);assert.equal(h.failures,1);assert.equal(h.stops,1);
});
