import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
const js=ts.transpileModule(readFileSync(new URL('../src/components/ui.tsx',import.meta.url),'utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}
}).outputText;
function field(clampOnCommit){
 let cursor=0,value=2000;const slots=[];
 const hooks={useState(v){const i=cursor++;if(!(i in slots))slots[i]=v;return[slots[i],v=>slots[i]=v];},useEffect(){},useRef:v=>({current:v})};
 const exports={};new Function('exports','require',js)(exports,n=>n==='react'?hooks:jsx);
 const render=()=>{cursor=0;return exports.NumField({value,onChange:v=>value=v,min:1,max:2000,clampOnCommit}).props.children[0].props;};
 return {render,value:()=>value};
}
test('task input keeps 15000 on blur even if old public max is 2000; validation owns rejection',()=>{
 const h=field(false);h.render().onChange({target:{value:'15000'}});h.render().onBlur();assert.equal(h.value(),15000);
});
test('other numeric fields retain their existing clamping behavior',()=>{
 const h=field(true);h.render().onChange({target:{value:'15000'}});h.render().onBlur();assert.equal(h.value(),2000);
});
