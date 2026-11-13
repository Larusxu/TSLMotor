import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const js=ts.transpileModule(readFileSync(new URL('../src/lib/multi-open-loop-jog.ts',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
function harness(){
  let tick,now=1000,reject=0,block,unblock;
  const log=[],errors=[],active=new Set();
  const exports={};
  new Function('exports','Date','setInterval','clearInterval',js)(exports,{now:()=>now},fn=>{tick=fn;return 1;},()=>{tick=null;});
  const motion={
    owned:()=>true,
    initialize:async motor=>{log.push([motor,'initialize']);},
    wait:async motor=>({pending:false,motor:{config_verified:true,limits_valid:true,feedback_fresh:true,motion_active:active.has(motor)}}),
    command:async(motor,c,current=()=>true)=>{
      log.push([motor,c.kind]);
      if(block===motor&&c.kind==='open_loop_start')await new Promise(resolve=>{unblock=resolve;});
      if(!current())throw Error('cancelled');
      if(c.kind==='open_loop_start'){active.add(motor);if(reject===motor)throw Error('lost start reply');}
      return {motor:{fault:0}};
    },
    stop:async motor=>{log.push([motor,'stop']);active.delete(motor);},
  };
  const group=new exports.MultiOpenLoopJog(motion,e=>errors.push(String(e)));
  return {group,log,errors,active,parse:exports.parseJogMotors,targets:exports.jogTargets,
    tick:async()=>{tick();for(let i=0;i<40;i++)await Promise.resolve();},advance:ms=>now+=ms,reject:m=>reject=m,
    block:m=>block=m,unblock:()=>{block=0;unblock();}};
}
test('comma-separated IDs accept whitespace and deduplicate, reject incomplete/out-of-range lists',()=>{
  const h=harness();assert.deepEqual(h.parse('1, 5,9,01'),[1,5,9]);
  for(const text of ['', '1,', '0,1', '17', '1.5', '1，5','M1','1,,5'])assert.throws(()=>h.parse(text));
});
test('multi jog adds entered lanes to the selected motor; single jog ignores the list',()=>{
  const h=harness();
  assert.deepEqual(h.targets(15,true,'16'),[15,16]);
  assert.deepEqual(h.targets(15,true,'15,16,16'),[15,16]);
  assert.deepEqual(h.targets(15,false,'16'),[15]);
  assert.deepEqual(h.targets(15,true,''),[15]);
});
test('all lanes stay active together, renew individually, and release stops every lane',async()=>{
  const h=harness();await h.group.start([1,5,9],91626);
  assert.deepEqual([...h.active],[1,5,9]);
  h.advance(150);await h.tick();
  assert.deepEqual(h.log.filter(([,k])=>k==='jog_renew').map(([m])=>m),[1,5,9]);
  await h.group.stop();assert.equal(h.active.size,0);
  assert.deepEqual(h.log.filter(([,k])=>k==='stop').map(([m])=>m),[1,5,9]);
});
test('release during a delayed start cancels later lanes and stops the attempted lane',async()=>{
  const h=harness();h.block(1);const start=h.group.start([1,5,9],91626);
  for(let i=0;i<50&&!h.log.some(([,k])=>k==='open_loop_start');i++)await Promise.resolve();
  const stop=h.group.stop();h.unblock();await start;await stop;
  assert.deepEqual(h.log.filter(([,k])=>k==='open_loop_start').map(([m])=>m),[1]);
  assert.deepEqual(h.log.filter(([,k])=>k==='stop').map(([m])=>m),[1]);
  assert.equal(h.active.size,0);
});
test('a lost START reply stops earlier lanes and the uncertain lane without starting the rest',async()=>{
  const h=harness();h.reject(5);await assert.rejects(h.group.start([1,5,9],91626),/lost start reply/);
  assert.equal(h.active.size,0);
  assert.deepEqual(h.log.filter(([,k])=>k==='stop').map(([m])=>m),[1,5]);
  assert(!h.log.some(([m,k])=>m===9&&k==='open_loop_start'));
});
test('a missed renewal deadline stops the whole group without replaying START',async()=>{
  const h=harness();await h.group.start([1,5,9],91626);h.advance(600);await h.tick();
  // Timer callbacks deliberately fire-and-forget; allow the stop continuation.
  for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(h.active.size,0);assert.equal(h.errors.length,1);
  assert.equal(h.log.filter(([,k])=>k==='open_loop_start').length,3);
});
