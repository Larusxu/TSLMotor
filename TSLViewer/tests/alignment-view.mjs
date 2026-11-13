import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const js=ts.transpileModule(readFileSync(new URL('../src/lib/alignment-view.ts',import.meta.url),'utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
function harness(){
 const exports={};let unmount;
 new Function('exports','require',js)(exports,()=>({useSyncExternalStore:(subscribe,snapshot)=>{
  unmount?.();unmount=subscribe(()=>{});return snapshot();
 }}));
 return {...exports,unmount:()=>{unmount?.();unmount=null;}};
}
test('a running task and inputs survive unmount, advance in background, and restore on remount',()=>{
 const h=harness();h.useAlignmentView(16,1);
 h.patchAlignment(16,{fluxMa:500,busy:true,note:'scanning'});h.alignmentProgress(16,{stage:'start'});
 h.unmount();h.alignmentProgress(16,{stage:'scanning',detail:'background scan'});
 const returning=h.useAlignmentView(16,1);
 assert(returning.busy);assert.equal(returning.fluxMa,500);assert.equal(returning.steps.at(-1).detail,'background scan');
 h.unmount();h.patchAlignment(16,{busy:false,offset:5436,note:'completed'});h.alignmentProgress(16,{stage:'completed'});
 const completed=h.useAlignmentView(16,1);
 assert(!completed.busy);assert.equal(completed.offset,5436);assert.equal(completed.steps.at(-1).status,'ok');
});
test('changing motors isolates parameters and retains each motor result and failure',()=>{
 const h=harness();h.useAlignmentView(15,1);h.patchAlignment(15,{fluxMa:500,offset:123,note:'verified'});
 h.useAlignmentView(16,1);h.patchAlignment(16,{note:'failed'});h.alignmentProgress(16,{stage:'failed',detail:'read error'});
 assert.equal(h.useAlignmentView(15,1).offset,123);assert.equal(h.useAlignmentView(15,1).fluxMa,500);
 assert.equal(h.useAlignmentView(16,1).offset,null);assert.equal(h.useAlignmentView(16,1).steps.at(-1).status,'fail');
});
