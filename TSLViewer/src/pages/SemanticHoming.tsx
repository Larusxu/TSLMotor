import { useEffect, useState } from "react";
import { useApp } from "../lib/app-store";
import { readSharedHome } from "../lib/shared-settings";
import { semanticMotion } from "../lib/semantic-motion";
import { semanticFresh } from "../lib/semantic-state";
import { SemanticControls } from "../components/SemanticControls";
import { fmt, tempC } from "../lib/units";
import { Button, Card, Field, SelectField, Badge, Icon, Stat } from "../components/ui";

/** Mainboard telemetry only. Missing optional firmware fields must never be guessed. */
function LiveStats() {
  const app = useApp();
  const s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const sampled = !!s?.feedback_fresh;
  const speed = sampled && app.streaming ? app.scope.latest.get(0) : null;
  const torque = sampled && app.streaming ? app.scope.latest.get(2) : null;
  const rpm = speed ?? (sampled ? -s!.velocity_raw / app.cal.countsPerRpm : null);
  const iq = torque ?? (sampled ? s!.iq_raw * app.cal.maPerCount : null);
  const temperature = sampled && s?.temperature_raw != null
    ? tempC(s.temperature_raw * 65536, app.cal.tempOffset) : null;
  const voltage = sampled && s?.bus_voltage_mv != null && Number.isFinite(s.bus_voltage_mv)
    ? s.bus_voltage_mv / 1000 : null;
  const position = sampled && s?.coordinate_valid && s.logical_position != null ? s.logical_position : null;
  const target = sampled && s?.coordinate_valid && s.target_logical_position != null ? s.target_logical_position : null;
  const percentError = (() => {
    if (!position || !target || !s?.span_valid || !s.logical_span) return null;
    try {
      const span = BigInt(s.logical_span);
      if (span <= 0n) return null;
      const difference = BigInt(target) - BigInt(position);
      // Bound conversion before Number to avoid rounding overflow on large counters.
      const basisPoints = (difference < 0n ? -difference : difference) * 10000n / span;
      return Number(basisPoints) / 100;
    } catch { return null; }
  })();
  const arrivalLabels = ["无位置任务", "轨迹进行中", "等待容差", "稳定确认中", "已到位"];
  const arrival = sampled && s?.arrival_phase != null
    ? arrivalLabels[s.arrival_phase] ?? "未确认" : "未确认";
  return <div className="homing-telemetry-grid">
    <Stat label="母线电压" value={voltage == null ? "—" : fmt(voltage, 1)} unit="V" />
    <Stat label="实际转速" value={rpm == null ? "—" : fmt(rpm, 0)} unit="RPM" />
    <Stat label="力矩电流 Iq" value={iq == null ? "—" : fmt(iq, 0)} unit="mA"
      tone={iq != null && Math.abs(iq) > 700 ? "var(--warn)" : undefined} />
    <Stat label="温度" value={temperature == null ? "—" : fmt(temperature, 1)} unit="°C" />
    <Stat label="实际位置" value={position ?? "—"} unit="Count" />
    <Stat label="目标位置" value={target ?? "—"} unit="Count" />
    <Stat label="位置误差" value={percentError == null ? "—" : fmt(percentError, 2)} unit="%" />
    <Stat label="到位状态" value={arrival} tone={arrival === "已到位" ? "var(--ok)" : undefined} />
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
  const stateText = (present: boolean | undefined, yes: string, no: string) =>
    !s ? "未确认" : present ? yes : no;
  const homing = !s ? "未确认" : s.motion_owner === 2 ? "进行中" : s.span_valid ? "已完成" : "待找零";
  const arrivalLabels = ["无位置任务", "轨迹进行中", "等待容差", "稳定确认中", "已到位"];
  const arrival = s?.feedback_fresh && s.arrival_phase != null
    ? arrivalLabels[s.arrival_phase] ?? "未确认" : "未确认";
  const id = s?.feedback_fresh && s.id_raw != null
    ? fmt(s.id_raw * app.cal.maPerCount, 1) + " mA" : "—";
  const protection = !s ? "未确认" : s.fault ? "故障" :
    s.protection_state != null ? (s.protection_state === 0 ? "正常" : `状态 ${s.protection_state}`) : "未确认";
  const markers = [
    { label: "驱动", value: !s ? "未确认" : (["未使能", "初始化", "已使能", "故障"][s.drive] ?? "未确认"), tone: s?.drive === 2 ? "ok" : "warn" },
    { label: "运动", value: stateText(s?.permit, "已授权", "未授权"), tone: s?.permit ? "ok" : "warn" },
    { label: "找零", value: homing, tone: s?.span_valid ? "ok" : "warn" },
    { label: "电角度", value: stateText(s?.align_valid, "已对齐", "未对齐"), tone: s?.align_valid ? "ok" : "warn" },
    { label: "配置", value: stateText(s?.config_verified, "已校验", "未校验"), tone: s?.config_verified ? "ok" : "warn" },
    { label: "行程", value: stateText(s?.span_valid, "有效", "未建立"), tone: s?.span_valid ? "ok" : "warn" },
    { label: "保护", value: protection, tone: s?.fault ? "warn" : protection === "正常" ? "ok" : "neutral" },
    { label: "Id 电流", value: id, tone: "neutral" },
    { label: "位置到位", value: arrival, tone: arrival === "已到位" ? "ok" : "neutral" },
    { label: "故障", value: !s ? "未确认" : s.fault || s.last_error ? String(s.fault || s.last_error) : "无", tone: s?.fault || s?.last_error ? "warn" : "neutral" },
  ];
  return <div className="homing-workspace">
    <section className="homing-dashboard" aria-label="当前电机实时状态">
      <LiveStats />
      <div className="homing-state-line" role="status">
        {markers.map(({label,value,tone}) => <span key={label} className="homing-state-item">
          <span className="homing-state-label">{label}：</span>
          <b className={`homing-state-value is-${tone}`}>{value}</b>
        </span>)}
      </div>
    </section>
    <div className="homing-operations"><SemanticControls>
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
  </SemanticControls></div></div>;
}
