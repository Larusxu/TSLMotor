import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

test('passive pose loading and device refresh never send motion; user slider changes do',async()=>{
 const source=readFileSync(new URL('../src/pages/Actions.tsx',import.meta.url),'utf8');
 const row=source.slice(source.indexOf('function AxisRow('),source.indexOf('export default function Actions('));
 const slots=[],effects=[];let cursor=0;
 const hooks={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
  useRef(value){const i=cursor++;return slots[i]??=( {current:value} );},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,n)=>d!==slots[i][n])){slots[i]=deps;effects.push(fn);}}
 };
 const out={},jsx=(type,props)=>({type,props});
 const code='import {useState,useRef,useEffect} from "react";import {Field,Button,NumField} from "./ui";export '+row;
 new Function('exports','require',ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n==='react'?hooks:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:{Field:'Field',Button:'Button',NumField:'NumField'});
 let sent=0,changed=0;
 const props={name:'axis',actual:25,ready:true,editable:true,stoppable:true,limits:{min:0,max:100},passive:{version:'edit:1',value:75},onTarget:()=>changed++,onMove:async()=>sent++,onStop:async()=>{},onSave:async()=>{}};
 const render=()=>{cursor=0;const tree=out.AxisRow(props);while(effects.length)effects.shift()();return tree;};
 const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found;}return null;};
 render();let tree=render();
 assert.equal(find(tree,n=>n.type==='input'&&n.props.type==='range').props.value,75);
 assert.equal(sent,0);assert.equal(changed,0);
 find(tree,n=>n.type==='input'&&n.props.type==='range').props.onChange({target:{value:'35'}});
 await new Promise(r=>setTimeout(r,80));
 assert.equal(sent,1);assert.equal(changed,1);
 props.passive={version:'device:2',value:42};render();tree=render();
 assert.equal(find(tree,n=>n.type==='input'&&n.props.type==='range').props.value,42);
 assert.equal(sent,1);assert.equal(changed,1);
});
