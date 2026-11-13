import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';

const js=ts.transpileModule(readFileSync(new URL('../src/lib/cylinder.ts',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;

// Exercise the actual hook with navigation, device reads and a controlled timer.
function harness(){
  const slots=[],effects=[],timers=new Map(),calls=[],online=new Set([1]),enabled=new Set();
  let cursor=0,nextTimer=0,model,view=false,position=321,blockedRead=null;
  const changed=(a,b)=>!a||a.length!==b.length||a.some((x,i)=>x!==b[i]);
  const react={
    useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};
      return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},
    useRef(value){const i=cursor++;return slots[i]??(slots[i]={current:value});},
    useCallback(fn,deps){const i=cursor++;if(changed(slots[i]?.deps,deps))slots[i]={deps,fn};return slots[i].fn;},
    useEffect(fn,deps){const i=cursor++;if(changed(slots[i]?.deps,deps)){const prior=slots[i];
      slots[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const snapshot=(ch,full=false)=>({id:1,enabled:enabled.has(ch),online:online.has(ch),pending:false,result:0,ticket:0,
    position,target:900,current_ma:15,temperature_c:27,restart_c:60,fault:0,
    current_limit_ma:full?600:0,temperature_limit_c:full?90:0,
    lower:full?100:0,upper:full?1800:2000,initial:full?800:1000,storage_ready:true});
  const api={invokeCommand:async(_, {channel,request})=>{
    calls.push({channel,...request});
    if(request.kind==='enable'){if(request.enabled)enabled.add(channel);else enabled.delete(channel);}
    if(request.kind==='read'&&blockedRead)await blockedRead;
    return snapshot(channel,request.kind==='read');
  }};
  const exports={};
  new Function('exports','require','setTimeout','clearTimeout',js)(exports,
    name=>name==='react'?react:api,
    fn=>{timers.set(++nextTimer,fn);return nextTimer;},id=>timers.delete(id));
  function render(){cursor=0;model=exports.useCylinders(true,true,false,()=>{},view);
    while(effects.length)effects.shift()();return model;}
  async function flush(){await new Promise(setImmediate);render();}
  return {calls,online,render,flush,get model(){return model;},
    async enter(){view=true;render();await flush();},
    async leave(){view=false;render();await flush();},
    async tick(){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await flush();},
    position(value){position=value;},block(p){blockedRead=p;}};
}

test('entry reads online parameters once; live polling preserves edits and never moves',async()=>{
  const h=harness();h.render();await h.flush();assert(!h.calls.some(c=>c.kind==='read'));
  await h.enter();
  assert.deepEqual(h.calls.filter(c=>c.kind==='read').map(c=>c.channel),[1]);
  const r=h.model.rows[0];assert.equal(r.current,600);assert.equal(r.temperature,90);
  assert.deepEqual([r.lower,r.upper,r.initial],[100,1800,800]);
  h.model.update(1,{current:700,target:750});h.render();h.position(444);await h.tick();
  assert.equal(h.model.rows[0].status.position,444);assert.equal(h.model.rows[0].current,700);
  assert.equal(h.model.rows[0].target,750);assert.equal(h.calls.filter(c=>c.kind==='read').length,1);
  h.online.add(2);await h.tick();assert.equal(h.model.rows[1].current,600);
  assert.equal(h.calls.filter(c=>c.kind==='read'&&c.channel===2).length,1);
  await h.leave();await h.enter();assert.equal(h.model.rows[0].current,600);
  assert.equal(h.calls.filter(c=>c.kind==='read'&&c.channel===1).length,2);
  assert(h.calls.every(c=>['read','snapshot'].includes(c.kind)));
});

test('a late parameter read from a detached page does not overwrite edits',async()=>{
  const h=harness();h.render();await h.flush();let release;
  h.block(new Promise(resolve=>{release=resolve;}));
  await h.enter();assert(h.calls.some(c=>c.kind==='read'));
  await h.leave();h.model.update(1,{current:777});h.render();release();await h.flush();
  assert.equal(h.model.rows[0].current,777);
});

test('each card controls only its own enabled lane; disabling cancels queued targets',async()=>{
  const h=harness();h.render();await h.flush();
  h.model.setTarget(1,500);await h.flush();assert(!h.calls.some(c=>c.kind==='target'));
  await h.model.setEnabled(1,true);await h.flush();assert(h.model.rows[0].status.enabled);
  h.model.setTarget(1,550);await h.flush();
  assert.deepEqual(h.calls.filter(c=>c.kind==='target').map(c=>[c.channel,c.position]),[[1,550]]);
  h.online.add(2);await h.tick();h.model.setTarget(2,650);await h.flush();
  assert.equal(h.calls.filter(c=>c.kind==='target').length,1);
  h.model.setTarget(1,600);await h.model.setEnabled(1,false);await h.flush();
  assert(!h.model.rows[0].status.enabled);
  assert.equal(h.calls.filter(c=>c.kind==='target').length,1);
  h.model.setTarget(1,700);await h.model.command(1,{kind:'initial',id:1});await h.flush();
  assert(!h.calls.some(c=>c.kind==='initial'));
  assert(!('selected' in h.model));
});
