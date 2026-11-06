import { useEffect, useState } from "react";
import { useApp } from "../lib/app-store";
import { readSharedHome } from "../lib/shared-settings";
import { semanticMotion } from "../lib/semantic-motion";
import { semanticFresh } from "../lib/semantic-state";
import { SemanticStatus } from "../components/SemanticStatus";
import { SemanticControls } from "../components/SemanticControls";
import { fmt, tempC } from "../lib/units";
import { Button, Card, Field, SelectField, Badge, Icon, Stat } from "../components/ui";

/** 实际转速 / 力矩电流 / 温度 of the selected motor, next to its controls. */
function LiveStats() {
  const app = useApp();
  const s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const speed = app.scope.latest.get(0), liveTorque = app.scope.latest.get(2);
  const rpm = speed ?? (s?.feedback_fresh ? -s.velocity_raw / app.cal.countsPerRpm : null);
  const iq = liveTorque ?? (s?.feedback_fresh ? s.iq_raw * app.cal.maPerCount : null);
  const temp = s?.temperature_raw;
  return <div className="grid cols-3">
    <Stat label="实际转速" value={rpm == null ? "—" : fmt(rpm, 0)} unit="RPM"
      delta={app.streaming ? "RTMI" : "主控反馈"} />
    <Stat label="力矩电流 iQ" value={iq == null ? "—" : fmt(iq, 0)} unit="mA"
      tone={iq != null && Math.abs(iq) > 700 ? "var(--warn)" : undefined} />
    <Stat label="温度" value={temp == null ? "—" : fmt(tempC(temp * 65536, app.cal.tempOffset), 1)} unit="°C" />
  </div>;
}

export default function SemanticHoming() {
  const app = useApp(), s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const [direction,setDirection]=useState(0);
  const [busy,setBusy]=useState(false),[note,setNote]=useState("");
  useEffect(()=>{if(app.connected)void readSharedHome(app.motor).catch(e=>setNote(String(e)));},[app.connected,app.motor]);
  const start = async () => {
    setBusy(true); setNote("");
    try {
      await app.stopStream();
      if(s?.drive===2){await semanticMotion.stop(app.motor,true);await semanticMotion.wait(app.motor,10000,r=>r.motor?.drive===0);}
      if(!s?.config_verified)await semanticMotion.initialize(app.motor);
      await semanticMotion.command(app.motor, { kind: "homing_start", direction: direction === 1 ? 0 : 1,
        step_unit: 100, dual: direction === 0 });
      setNote("主控已接收找零任务；以状态卡与双端有效标志判断结果");
    } catch (e) { setNote(String(e)); app.toast("error",`M${app.motor} 找零启动失败：${String(e)}`); } finally { setBusy(false); }
  };
  return <div className="grid" style={{ gap: 14 }}><SemanticStatus /><LiveStats /><SemanticControls>
    <Card title="找零控制" right={<Badge tone={s?.motion_owner===2?"accent":"neutral"}>{s?.motion_owner===2?"正在找零":"主控执行"}</Badge>}>
      <div className="grid homing-control-grid" style={{gap:14}}>
        <div className="homing-operation compact-homing" style={{gap:12}}>
          <Field label="找零方向" hint="双端或单端调试"><SelectField value={direction} onChange={v => { setDirection(Number(v)); }} disabled={busy || !!s?.motion_active} options={[
            { value: 0, label: "双端找零：负端 → 正端" }, { value: -1, label: "负向单端调试" }, { value: 1, label: "正向单端调试" }]} /></Field>
          <div className="row-wrap">
            <Button variant="primary" icon={<Icon.Target width={14} height={14}/>} disabled={busy || !s?.permit || !s.align_valid || !s.config_verified || s.drive === 1 || s.motion_active} onClick={() => void start()}>开始找零</Button>
            <Button variant="ghost" disabled={!s?.motion_active && !busy} onClick={() => void semanticMotion.close().catch(e => setNote(String(e)))}>取消找零</Button>
          </div>
          <div className="homing-message-slot" role="status" aria-live="polite">
            <div className="tiny muted">{s?.motion_owner===2 ? "主控正在找零，请观察实时位置、电流及端点状态" : s?.span_valid && s.config_verified && s.limits_valid ? "双端找零完成，供电保持；已恢复运行配置，可直接点动或定位" : s?.span_valid ? "双端接触已完成，正在恢复并验证运行配置" : ""}</div>
            <div className="tiny muted">{note}</div>
          </div>
        </div>
      </div>
    </Card>
  </SemanticControls></div>;
}
