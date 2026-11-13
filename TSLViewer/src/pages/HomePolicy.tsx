import {useEffect,useState} from "react";
import {Card,Field,NumField,SelectField} from "../components/ui";
import {useApp} from "../lib/app-store";
import {useHomePolicy,readHomePolicy,saveHomePolicy,updateHomePolicy} from "../lib/home-policy";
export default function HomePolicy({method,embedded=false}:{method:1|2;embedded?:boolean}){
 const app=useApp(),p=useHomePolicy(),[note,setNote]=useState("");
 useEffect(()=>{if(app.connected)void readHomePolicy().catch(e=>setNote(String(e)));},[app.connected]);
 const save=()=>void saveHomePolicy().then(()=>setNote("已写入并回读确认")).catch(e=>setNote(String(e)));
 const content=<fieldset disabled={!app.connected} style={{border:0,padding:0,margin:0,minWidth:0}}>
 <div className="row-wrap" style={{gap:12}}><Field label={method===1?"联动电机":"适用电机"}><input aria-label={method===1?"联动电机":"适用电机"} value={method===1?p.linked:p.motors} disabled={!app.connected} onChange={e=>updateHomePolicy(method===1?{linked:e.target.value}:{motors:e.target.value})} onBlur={save} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/></Field>
 {method===1?<><Field label="找零方向"><SelectField value={p.direction} options={[{value:0,label:"双端找零，先负端后正端"},{value:1,label:"负向单端找零"},{value:2,label:"双端找零，先正端后负端"}]} onChange={v=>{updateHomePolicy({direction:Number(v)});save();}}/></Field>{([["复杂工况","complex"],["找零结束回到行程中点","middle"]] as const).map(([label,key])=><label key={key}><input type="checkbox" checked={p[key]} onChange={e=>{updateHomePolicy({[key]:e.target.checked});save();}}/>{label}</label>)}</>:<><Field label="负端识别转速"><NumField value={p.rpm} unit="rpm" min={500} max={60000} onChange={rpm=>updateHomePolicy({rpm})} onCommit={save}/></Field><label><input type="checkbox" checked={p.positive} onChange={e=>{updateHomePolicy({positive:e.target.checked});save();}}/>找零后回到正端零点</label></>}
 </div><div className="tiny muted" role="status">{note}</div></fieldset>;
 return embedded?content:<Card title={method===1?"方法1 · 联动与返回":"找零参数-方法2（单电机丝杠）"}>{content}</Card>;
}
