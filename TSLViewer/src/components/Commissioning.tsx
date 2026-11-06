import { useEffect, useState } from "react";
import { useApp } from "../lib/app-store";
import { chipDirection } from "../lib/motor-control";
import { useMotorConfiguration } from "../lib/motor-configuration";
import type { HomingConfig } from "../lib/types";
import { Button, Card, Check, Field, Notice, NumField, SelectField, Steps } from "./ui";

export function Commissioning({ config, dir, homing, dualLimit }: { config: HomingConfig; dir: -1 | 1; homing: boolean; dualLimit: boolean }) {
  const app = useApp();
  const [kind, setKind] = useState("home");
  const [save, setSave] = useState(false);
  const [safe, setSafe] = useState(false);
  const [flux, setFlux] = useState(300);
  const { pid } = useMotorConfiguration(app.motor);
  useEffect(() => { setSafe(false); }, [app.motor, dir, config, dualLimit]);
  const start = async () => {
    if (!safe || app.motionActive || app.jobRunning || homing) return;
    await app.stopStream();
    await app.runJob("commission", {
      motor: app.motor, kind, save, home: config,
      seek: { dir: chipDirection(dir), step_unit: 100, timed_seek: false, dual_limit: dualLimit },
      encoder: { preset: "MT6701 SSI 14-bit", frame_bits: 14, spi_mode: 1, spi_hz: 2000000,
        idle_cycles: 16, data_mask: 0x3fff, send_data: 0, csn_via_enc_n: true, cpr: app.cal.cpr,
        poles: app.cal.poles, phi_e_offset: 0, write_phi_e_offset: false,
        pwm_max_count: app.cal.pwmMaxCount, csa_gain: app.cal.csaGain,
        vel_frq_conf: 0x0002bb12, vel_per_conf: 0xfff00001, write_velocity_cfg: true },
      alignment: { flux_ma: flux, poles: app.cal.poles, settle_ms: 700, step_deg: 90, end_deg: 720,
        ma_per_count: app.cal.maPerCount, write_back: true, dry_run: false, cpr: app.cal.cpr },
      pid: { ...pid, ma_per_count: app.cal.maPerCount, counts_per_rpm: app.cal.countsPerRpm },
    });
    setSafe(false);
  };
  return <Card bodyClass="stack" title="重新标定" sub="复用现有编码器、对齐、主控找零与 EEPROM 协议">
    <div className="param-grid">
      <Field label="流程"><SelectField value={kind} onChange={v => { setKind(String(v)); setSafe(false); }} options={[
        { value: "rehome", label: "强制重新找零（必要时先对齐）" },
        { value: "full", label: "完整流程（跳过已有效）" },
        { value: "force", label: "完整强制重标" },
        { value: "encoder", label: "仅编码器与电角度对齐" },
        { value: "home", label: "仅找零（保留已写回的对齐）" },
      ]} /></Field>
      <Field label="对齐电流" hint="仅在需要重新对齐时使用"><NumField value={flux} onChange={setFlux} min={50} max={500} unit="mA" /></Field>
    </div>
    <div className="tiny muted">复用PID页编辑档案：Iq {pid.torque_p}/{pid.torque_i} · Id {pid.flux_p}/{pid.flux_i} · 速度 {pid.vel_p}/{pid.vel_i} · 位置 {pid.pos_p}/{pid.pos_i}。请在PID页修改和核对。</div>
    <Check checked={save} onChange={setSave}>完成后保存电角度与 PID 到电机板 EEPROM（运行零点不落盘）</Check>
    <Check checked={safe} onChange={setSafe}>已确认方向和空间；需要对齐时机构位于行程中段，允许电机端转动约两圈</Check>
    <div className="row-wrap" style={{ gap: 8 }}>
      <Button variant="primary" disabled={!app.connected || app.mode === "direct" || !safe || app.jobRunning || app.motionActive || homing || flux < 50 || flux > 500}
        onClick={() => void start().catch(e => app.toast("error", String(e)))}>执行所选流程</Button>
      <Button disabled={!app.jobRunning} onClick={app.cancel}>取消流程</Button>
    </div>
    <Notice tone="warn">需先开启该路逻辑电源。“跳过已有效”仅信任当前主控有效零点。组合流程复用PID页档案，限幅不再从找零任务反写成驱动器上限；其它电机须先配置对应档案。</Notice>
    {!!app.stepsByKind.commission?.length && <Steps steps={app.stepsByKind.commission} />}
    {app.lastDone?.job.startsWith("commission:") && <Notice tone={app.lastDone.ok ? "ok" : "warn"}>{app.lastDone.ok ? "所选流程结束，PWM已关闭，逻辑电源保留；行程是否有效以主控双端状态为准" : app.lastDone.message}</Notice>}
  </Card>;
}
