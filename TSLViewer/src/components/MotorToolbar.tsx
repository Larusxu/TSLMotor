import { useState } from "react";
import { useApp } from "../lib/app-store";
import { semanticMotion } from "../lib/semantic-motion";
import { api } from "../lib/api";
import { Button, SelectField, Icon } from "./ui";
import MotorEnable from "./MotorEnable";

export default function MotorToolbar() {
  const app = useApp(), [busy, setBusy] = useState(false);
  const s = app.semantic.motor === app.motor ? app.semantic.state : null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); try { await fn(); } catch (e) { app.toast("error", String(e)); } finally { setBusy(false); }
  };
  return <div className="motor-toolbar" aria-label="当前电机操作">
    <span className="motor-toolbar-label">当前电机</span>
    <SelectField value={app.motor} onChange={app.setMotor} width={92}
      disabled={app.busy || app.jobRunning || app.motionActive || app.acquiring}
      options={Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `M${i + 1}` }))}/>
    <MotorEnable/>
    {app.mode !== "direct" && <Button disabled={!app.connected || busy || app.acquiring || !s?.config_verified}
      onClick={() => void run(() => semanticMotion.permit(app.motor, !s?.permit))}>{s?.permit ? "取消运动授权" : "开启运动授权"}</Button>}
    <Button disabled={!app.connected || busy} icon={<Icon.Stop width={14} height={14}/>}
      onClick={() => void run(() => app.mode === "direct" ? api.stopMotion(app.cal.poles) : semanticMotion.stop(app.motor))}>停止运行</Button>
    <Button disabled={!app.connected || busy} onClick={()=>void run(()=>semanticMotion.clearFault(app.motor))}>清除故障</Button>
    <span className="motor-toolbar-status">{app.acquiring ? "参数整定中 · 切页继续执行" : s?.motion_active ? "运动中" : "待命"}</span>
    <Button variant="danger" disabled={!app.connected} icon={<Icon.Stop width={14} height={14}/>}
      onClick={() => void run(() => app.mode === "direct" ? api.emergencyStop() : semanticMotion.emergency(app.motor))}>急停</Button>
  </div>;
}
