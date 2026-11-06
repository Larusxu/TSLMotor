import { useState } from "react";
import { useApp } from "../lib/app-store";
import { semanticMotion } from "../lib/semantic-motion";
import { COUNTS_PER_RPM } from "../lib/motor-profile-ui";
import { HoldMotionButton } from "./HoldMotionButton";
import { Button, Card, Field, NumField } from "./ui";

export function OpenLoopJog() {
  const app=useApp();
  const [rpm,setRpm]=useState(300),[holding,setHolding]=useState(false),[authorizing,setAuthorizing]=useState(false);
  const s=app.semantic.motor===app.motor?app.semantic.state:null;
  const can=app.connected&&app.mode!=="direct"&&!!s?.permit&&!s.fault&&!holding;
  return <Card title="开环点动" bodyClass="stack" right={<Button size="sm" disabled={!app.connected||authorizing||app.mode==="direct"} onClick={()=>{setAuthorizing(true);void semanticMotion.permit(app.motor,!s?.permit).catch(e=>app.toast("error",String(e))).finally(()=>setAuthorizing(false));}}>{s?.permit?"取消运动授权":"开启运动授权"}</Button>}>
    <Field label="开环转速"><NumField value={rpm} onChange={setRpm} min={1} max={28730} unit="rpm"/></Field>
    <div className="row-wrap" style={{gap:8}}>
      {[-1,1].map(sign=><HoldMotionButton key={sign} canStart={can}
        interrupted={!app.connected||!!s?.fault||!s?.permit}
        onHolding={setHolding} onError={e=>app.toast("error",String(e))}
        start={()=>semanticMotion.openLoopJog(app.motor,-sign*Math.round(rpm*COUNTS_PER_RPM))}
        stop={()=>{void semanticMotion.stop(app.motor,true).catch(e=>app.toast("error",String(e)));}}>
        {sign<0?"负向点动":"正向点动"}
      </HoldMotionButton>)}
    </div>
  </Card>;
}
