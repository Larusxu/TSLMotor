import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import FleetOverview from "../components/FleetOverview";
import type { CylinderModel } from "../lib/cylinder";
import { OpenLoopJog } from "../components/OpenLoopJog";
import { semanticFresh } from "../lib/semantic-state";
import {
  Badge,
  Button,
  Card,
  Field,
  KV,
  Notice,
  NumField,
  Stat,
} from "../components/ui";
import { STATUS_BITS } from "../lib/registers";
import { fmt, hex, s16hi, tempC } from "../lib/units";

const MODES = [
  "PWM_OFF",
  "PWM_ON",
  "TORQUE",
  "VELOCITY",
  "POSITION",
  "PRBS_UD",
  "PRBS_FLUX",
  "PRBS_TORQUE",
  "PRBS_VELOCITY",
  "PRBS_POSITION",
  "PWM_EXT",
  "VOLTAGE_EXT",
];

export default function Overview({ cylinders }: { cylinders: CylinderModel }) {
  const app = useApp();
  const [regs, setRegs] = useState<Record<number, number>>({});
  const [, tick] = useState(0);


  const history = useRef<number[][]>([[], [], [], []]);

  const polling = useRef(false);
  const poll = useCallback(async () => {
    if (!app.connected || polling.current) return;
    polling.current = true;
    try {
      const items = await api.readMany([0x009, 0x083, 0x084, 0x100, 0x101, 0x105, 0x154, 0x153, 0x171]);
      const next: Record<number, number> = {};
      items.forEach((i) => {
        if (i.value !== null) next[i.addr] = i.value;
      });
      setRegs(next);
    } catch {
      /* link hiccup: keep the last values */
    } finally { polling.current = false; }
  }, [app.connected]);

  useEffect(() => {
    // Controller connection does not imply a powered, responding motor.
    // Gateway motor telemetry is explicit until an actual motor is commissioned.
    if (!app.connected || app.mode !== "direct") return;
    void poll();
    const t = window.setInterval(() => void poll(), 700);
    return () => window.clearInterval(t);
  }, [app.connected, app.mode, poll]);

  // The scope store lives outside React state; tick so the KPI tiles follow it.
  useEffect(() => {
    if (!app.streaming) return;
    const t = window.setInterval(() => tick((n) => n + 1), 260);
    return () => window.clearInterval(t);
  }, [app.streaming]);

  // Read straight from the store on every render; the tick effect above keeps
  // this component in sync while streaming.
  const speed = app.scope.latest.get(0);
  const liveTorque = app.scope.latest.get(2);
  useEffect(() => {
    if (speed === undefined) return;
    const h = history.current;
    h[0] = [...h[0].slice(-40), speed];
  }, [speed]);

  const mode = ((regs[0x100] ?? 0) >>> 9) & 0x0f;
  const poles = (regs[0x100] ?? 0) & 0x7f;
  const status = regs[0x009] ?? 0;
  const drvOn = ((regs[0x101] ?? 0) >>> 16) & 1;
  const vm = s16hi(regs[0x083] ?? 0);
  const observed=app.connected&&app.semantic.motor===app.motor&&semanticFresh(app.semantic)?app.semantic.state:null;
  const tempRaw=app.mode==="direct"?(regs[0x084]==null?null:s16hi(regs[0x084])):observed?.temperature_raw;
  const measuredRpm=app.mode==="direct"?(regs[0x154]??0)/app.cal.countsPerRpm:observed?.feedback_fresh?-observed.velocity_raw/app.cal.countsPerRpm:null;
  const torque = app.mode==="direct"?s16hi(regs[0x153] ?? 0)*app.cal.maPerCount:observed?.feedback_fresh?observed.iq_raw*app.cal.maPerCount:0;
  const iS = (regs[0x171] ?? 0) & 0xffff;

  const activeFaults = STATUS_BITS.filter(([bit, , tone]) => tone !== "info" && ((status >>> bit) & 1) === 1);

  return (
    <div className="grid" style={{ gap: 14 }}>
      {app.mode !== "direct" && <FleetOverview cylinders={cylinders}/>}
      {app.mode === "direct" && <div className="grid cols-3">
        <Stat
          label="实际转速"
          value={speed !== undefined ? fmt(speed, 0) : measuredRpm==null?"—":fmt(measuredRpm, 0)}
          unit="RPM"
          delta={app.streaming ? "RTMI" : app.mode==="direct"?"芯片读回":"主控反馈"}
          spark={history.current[0]}
        />
        <Stat
          label="力矩电流 iQ"
          value={fmt(liveTorque ?? torque, 0)}
          unit="mA"
          delta={observed?`限幅 ${fmt(observed.effective_iq_raw*app.cal.maPerCount,0)} mA`:undefined}
          tone={Math.abs(liveTorque ?? torque) > 700 ? "var(--warn)" : undefined}
        />
        <Stat
          label="温度"
          value={tempRaw == null ? "—" : fmt(tempC(tempRaw * 65536, app.cal.tempOffset), 1)}
          unit="°C"
        />
      </div>}

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <OpenLoopJog />

        <Card title="机器常数" sub="UNIT CONVERSION">
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8 }}>
              <Field label="极对数">
                <NumField value={app.cal.poles} onChange={(v) => app.setCal({ poles: v })} min={1} max={127} />
              </Field>
              <Field label="PWM MAX_COUNT">
                <NumField
                  value={app.cal.pwmMaxCount}
                  onChange={(v) => app.setCal({ pwmMaxCount: v })}
                  min={600}
                  max={20000}
                  step={10}
                />
              </Field>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Field label="mA / LSB">
                <NumField value={app.cal.maPerCount} onChange={(v) => app.setCal({ maPerCount: v })} step={0.0001} />
              </Field>
              <Field label="counts / RPM">
                <NumField value={app.cal.countsPerRpm} onChange={(v) => app.setCal({ countsPerRpm: v })} step={0.1} />
              </Field>
            </div>
            <Notice>
              Tesla 平台默认：极对数 1、16384 CPR、4× CSA → 0.20131 mA/LSB、305.4 counts/RPM、25 kHz PWM。
            </Notice>
            {app.mode !== "direct" && <div className="tiny muted">公共额定转速参考：{app.maximumRpm ?? "未读取"} rpm；任务转速仅受当前电机已保存的长期转速限幅约束。</div>}
          </div>
        </Card>
      </div>

      {app.mode === "direct" && <div className="grid cols-2" style={{ alignItems: "start" }}>
        <Card title="驱动状态" sub="MCC_STATUS / GDRV">
          <KV
            rows={[
              ["运动模式", <b key="m" className="mono">{MODES[mode] ?? `?? (${mode})`}</b>],
              ["极对数", <span key="p" className="mono">{poles}</span>],
              ["驱动使能", drvOn ? <span key="d" style={{ color: "var(--ok)" }}>已使能</span> : <span key="d2" style={{ color: "var(--text-3)" }}>未使能</span>],
              ["供电 VM (raw)", <span key="v" className="mono">{vm}</span>],
              ["电流矢量", <span key="i" className="mono">{iS} LSB ≈ {fmt(iS * app.cal.maPerCount, 0)} mA</span>],
              ["状态字", <span key="s" className="mono">{hex(status)}</span>],
            ]}
          />
          <div className="divider" />
          <div className="row-wrap">
            <Button size="sm" variant="ghost" onClick={() => void poll()}>
              重新读取
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!app.connected}
              onClick={async () => {
                try {
                  const reg = await api.readReg(0x101);
                  await api.writeReg(0x101, (reg | (1 << 31) | (1 << 16)) >>> 0, true);
                  app.toast("ok", "驱动已使能（DRV_EN + 电荷泵）");
                  void poll();
                } catch (e) {
                  app.toast("error", String(e));
                }
              }}
            >
              使能驱动
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!app.connected}
              onClick={async () => {
                try {
                  await api.writeReg(0x00a, 0xffffffff, false);
                  app.toast("ok", "事件锁存已清");
                  void poll();
                } catch (e) {
                  app.toast("error", String(e));
                }
              }}
            >
              清事件
            </Button>
          </div>
        </Card>

        <Card
          title="故障位"
          sub="STATUS_FLAGS 0x009"
          right={
            <Badge tone={activeFaults.length ? "danger" : "ok"} dot={activeFaults.length ? "err" : "on"}>
              {activeFaults.length ? `${activeFaults.length} 个告警` : "无故障"}
            </Badge>
          }
        >
          <div className="matrix">
            {STATUS_BITS.filter(([bit]) => ((status >>> bit) & 1) === 1).map(([bit, label, tone]) => (
              <div key={bit} className={`cell ${tone === "info" ? "good" : "bad"}`}>
                <b>{label}</b>
                <span className="mono">bit {bit}</span>
              </div>
            ))}
            {status === 0 && <div className="empty">尚未读取状态字</div>}
          </div>
        </Card>
      </div>}

    </div>
  );
}
