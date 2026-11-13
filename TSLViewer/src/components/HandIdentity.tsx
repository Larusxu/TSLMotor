import {formatHandId,parseHandId} from "../lib/hand-id";
import {useEffect,useState} from "react";
import {useApp} from "../lib/app-store";
import {semanticFresh} from "../lib/semantic-state";

export default function HandIdentity(){
  const app=useApp();
  const valid=app.connected&&app.motorValidity&&Date.now()-app.motorValidity.at<2000?app.motorValidity:null;
  // The selected motor's complete semantic snapshot is authoritative. The
  // legacy bitmap deliberately reports zero while drive-enable is pending.
  const state=app.connected&&app.semantic.motor===app.motor&&semanticFresh(app.semantic)?app.semantic.state:null;
  const [editing,setEditing]=useState(false);
  const [value,setValue]=useState("");
  const [saving,setSaving]=useState(false);
  useEffect(()=>{setEditing(false);setValue(app.handId===null?"":formatHandId(app.handId));},[app.handId,app.connected]);
  async function save(){
    setSaving(true);
    try{await app.updateHandId(parseHandId(value));setEditing(false);app.toast("ok","HandID 已保存并读回确认");}
    catch(e){app.toast("error",String(e));}
    finally{setSaving(false);}
  }
  return <>
    <div className="rail-meta"><span>FW_Version</span><b>{app.connected&&app.fwVersion?app.fwVersion:"—"}</b></div>
    <div className="rail-meta"><span>HandID</span>
      {editing?<form onSubmit={e=>{e.preventDefault();void save();}} style={{display:"flex",gap:4}}>
        <input aria-label="HandID" type="text" maxLength={5} value={value} disabled={saving} onChange={e=>setValue(e.target.value)} style={{width:88}}/>
        <button type="submit" disabled={saving||!value}>{saving?"保存中":"保存"}</button>
        <button type="button" disabled={saving} onClick={()=>setEditing(false)}>取消</button>
      </form>:<button type="button" title="修改手编号 TS-00～TS-ZZ" disabled={!app.connected||app.mode==="direct"||app.busy||app.streaming||app.handId===null} onClick={()=>{setValue(formatHandId(app.handId));setEditing(true);}} style={{color:"var(--text)",background:"transparent",border:0,cursor:"pointer",fontFamily:"inherit"}}>
        {app.connected&&app.handId!==null?`${formatHandId(app.handId)} · 修改`:"—"}
      </button>}
    </div>
    {app.mode!=="direct"&&<>
      <div className="rail-meta"><span>编码器 · M{app.motor}</span><b>{state?(state.align_valid?"有效":"待标定"):valid?(valid.encoder&(1<<(app.motor-1))?"有效":"待标定"):"未确认"}</b></div>
      <div className="rail-meta"><span>找零 · M{app.motor}</span><b style={{display:"flex",gap:8}}>{([['正端',state?.home_pos_valid],['负端',state?.home_neg_valid]] as const).map(([name,ok])=><span key={name} title={`${name}${ok?"有效":"无效"}`} style={{color:ok?"var(--ok)":"var(--muted)"}}>{name}</span>)}</b></div>
    </>}
  </>;
}
