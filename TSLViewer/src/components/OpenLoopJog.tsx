import { useState } from "react";
import { useApp } from "../lib/app-store";
import { semanticMotion } from "../lib/semantic-motion";
import { COUNTS_PER_RPM } from "../lib/motor-profile-ui";
import { MultiOpenLoopJog, jogTargets } from "../lib/multi-open-loop-jog";
import { HoldMotionButton } from "./HoldMotionButton";
import { Card, Field, NumField } from "./ui";

export function OpenLoopJog() {
  const app=useApp();
  const [rpm,setRpm]=useState(300),[holding,setHolding]=useState(false);
  const [multiple,setMultiple]=useState(false),[motorText,setMotorText]=useState("");
  const [stopping,setStopping]=useState(false),[failed,setFailed]=useState(false);
  const [group]=useState(()=>new MultiOpenLoopJog(semanticMotion,error=>{
    setFailed(true);app.toast("error",String(error));
  }));
  const s=app.semantic.motor===app.motor?app.semantic.state:null;
  let motors:number[]=[],inputError="";
  try{motors=jogTargets(app.motor,multiple,motorText);}catch(error){inputError=String(error).replace(/^Error: /,"");}
  const can=app.connected&&app.mode!=="direct"&&!holding&&!stopping&&
    (multiple?!inputError:!!s&&!s.fault);
  const stop=()=>{
    setStopping(true);
    void (multiple?group.stop():semanticMotion.stop(app.motor,true))
      .catch(e=>app.toast("error",String(e))).finally(()=>setStopping(false));
  };
  return <Card title="开环点动" bodyClass="stack">
    <div className="row-wrap" style={{gap:12,alignItems:"end"}}>
      <Field label="开环转速"><NumField disabled={holding||stopping} value={rpm} onChange={setRpm} min={1} max={28730} unit="rpm"/></Field>
      <label className="row" style={{gap:8,minHeight:40}}>
        <input type="checkbox" checked={multiple} disabled={holding||stopping} onChange={e=>setMultiple(e.target.checked)}/>
        多路开环点动
      </label>
      <Field label="附加电机编号">
        <div className="input-wrap" style={{width:180,opacity:(!multiple||holding||stopping)?0.45:1}}>
        <input id="open-loop-motors" aria-label="多路点动附加电机编号" type="text" value={motorText} placeholder="1,5,9"
          disabled={!multiple||holding||stopping} aria-invalid={multiple&&!!motorText&&!!inputError}
          aria-describedby={multiple&&motorText&&inputError?"open-loop-motors-error":undefined}
          onChange={e=>setMotorText(e.target.value)}/>
        </div>
      </Field>
    </div>
    {multiple&&motorText&&inputError&&<div id="open-loop-motors-error" role="alert" className="tiny" style={{color:"var(--danger)"}}>{inputError}</div>}
    <div className="row-wrap" style={{gap:8}}>
      {[-1,1].map(sign=><HoldMotionButton key={`${app.motor}-${multiple}-${sign}`} canStart={can}
        interrupted={!app.connected||app.mode==="direct"||failed||(!multiple&&!!s?.fault)}
        onHolding={value=>{setHolding(value);if(!value)setFailed(false);}} onError={e=>app.toast("error",String(e))}
        start={()=>multiple?group.start(motors,-sign*Math.round(rpm*COUNTS_PER_RPM)):semanticMotion.openLoopJog(app.motor,-sign*Math.round(rpm*COUNTS_PER_RPM))}
        stop={stop}>
        {sign<0?"负向点动":"正向点动"}
      </HoldMotionButton>)}
    </div>
  </Card>;
}
