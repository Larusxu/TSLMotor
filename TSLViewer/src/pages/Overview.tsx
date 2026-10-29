import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { SIGNALS } from "../lib/presets";
import { Scope } from "../components/Scope";
import {
  Badge,
  Button,
  Card,
  Check,
  Field,
  Icon,
  KV,
  Notice,
  NumField,
  Segmented,
  SelectField,
  Stat,
} from "../components/ui";
import { STATUS_BITS } from "../lib/registers";
import { fmt, hex, s16hi, s16lo, tempC } from "../lib/units";

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

export default function Overview() {
  const app = useApp();
  const [regs, setRegs] = useState<Record<number, number>>({});
  const [, tick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [target, setTarget] = useState(300);
  const [confirmRun, setConfirmRun] = useState(false);
  const [picker, setPicker] = useState<number>(0);
  const history = useRef<number[][]>([[], [], [], []]);

  const poll = useCallback(async () => {
    if (!app.connected) return;
    try {
      const items = await api.readMany([0x009, 0x083, 0x084, 0x100, 0x101, 0x105, 0x154, 0x153, 0x171]);
      const next: Record<number, number> = {};
      items.forEach((i) => {
        if (i.value !== null) next[i.addr] = i.value;
      });
      setRegs(next);
    } catch {
      /* link hiccup: keep the last values */
    }
  }, [app.connected]);

  useEffect(() => {
    void poll();
    if (!app.connected) return;
    const t = window.setInterval(() => void poll(), 700);
    return () => window.clearInterval(t);
  }, [app.connected, poll]);

  // The scope store lives outside React state; tick so the KPI tiles follow it.
  useEffect(() => {
    if (!app.streaming) return;
    const t = window.setInterval(() => tick((n) => n + 1), 260);
    return () => window.clearInterval(t);
  }, [app.streaming]);

  // Read straight from the store on every render; the tick effect above keeps
  // this component in sync while streaming.
  const speed = app.scope.latest.get(0);
  const liveTarget = app.scope.latest.get(1);
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
  const tempRaw = s16hi(regs[0x084] ?? 0);
  const torque = s16hi(regs[0x153] ?? 0) * app.cal.maPerCount;
  const actualRpm = (regs[0x154] ?? 0) / app.cal.countsPerRpm;
  const iS = (regs[0x171] ?? 0) & 0xffff;

  const activeFaults = STATUS_BITS.filter(([bit, , tone]) => tone !== "info" && ((status >>> bit) & 1) === 1);
  const assigned = app.channels.map((id, ch) => ({ ch, sig: SIGNALS.find((s) => s.id === id) ?? null }));

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid cols-4">
        <Stat
          label="实际转速"
          value={speed !== undefined ? fmt(speed, 0) : fmt(actualRpm, 0)}
          unit="RPM"
          delta={app.streaming ? `RTMI · CH0` : "Direct read · 0x154"}
          spark={history.current[0]}
        />
        <Stat
          label="目标转速"
          value={liveTarget !== undefined ? fmt(liveTarget, 0) : fmt((regs[0x150] ?? 0) / app.cal.countsPerRpm, 0)}
          unit="RPM"
          delta={`斜坡 ${mode === 3 ? "速度模式" : MODES[mode] ?? "—"}`}
        />
        <Stat
          label="力矩电流 iQ"
          value={fmt(liveTorque ?? torque, 0)}
          unit="mA"
          delta={`限幅 ${fmt(800, 0)} mA · ${(((liveTorque ?? torque) / 800) * 100).toFixed(0)}%`}
          tone={Math.abs(liveTorque ?? torque) > 700 ? "var(--warn)" : undefined}
        />
        <Stat
          label="结温"
          value={tempRaw === 0 ? "—" : fmt(tempC(tempRaw * 65536, app.cal.tempOffset), 1)}
          unit="°C"
          delta={tempRaw === 0 ? "未校准（原始 " + tempRaw + "）" : `原始 ${tempRaw}`}
        />
      </div>

      <div className="grid split-2-1" style={{ alignItems: "stretch" }}>
        <Card
          className="fill"
          title="实时遥测"
          sub="LIVE TELEMETRY"
          right={
            <div className="row" style={{ gap: 6 }}>
              <Segmented
                value={String(app.windowMs)}
                onChange={(v) => app.setWindowMs(Number(v))}
                options={[
                  { value: "2000", label: "2s" },
                  { value: "5000", label: "5s" },
                  { value: "15000", label: "15s" },
                  { value: "60000", label: "60s" },
                ]}
              />
              <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>
                {paused ? "继续" : "暂停"}
              </Button>
              {app.streaming ? (
                <Button size="sm" variant="ghost" onClick={() => void app.stopStream()}>
                  停止
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => void app.startStream()}>
                  开始采集
                </Button>
              )}
            </div>
          }
        >
          <Scope
            store={app.scope}
            channels={assigned.filter((a) => a.sig).map((a) => a.ch)}
            windowMs={app.windowMs}
            paused={paused}
            height="fill"
            onToggleChannel={(ch) => app.setChannel(ch, null)}
          />
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <Badge tone={app.streaming ? "accent" : "neutral"} dot={app.streaming ? "live" : undefined}>
              {app.streaming ? `${app.stats?.frame_rate.toFixed(0) ?? 0} 帧/s` : "未采集"}
            </Badge>
            <span className="tiny muted">
              触发 {app.sampleHz} Hz · sampling={app.sampling} · 丢弃 {app.stats?.rtmi_dropped ?? 0} 字节
            </span>
          </div>
        </Card>

        <div className="stack">
          <Card title="信号通道" sub="RTMI CHANNELS" right={<Badge tone="neutral">7 可用</Badge>}>
            <div className="stack" style={{ gap: 8 }}>
              {[0, 1, 2, 3].map((ch) => (
                <div className="row" key={ch} style={{ gap: 8 }}>
                  <span className="mono tiny" style={{ width: 26, color: "var(--text-4)" }}>
                    CH{ch}
                  </span>
                  <SelectField
                    value={app.channels[ch] ?? ""}
                    onChange={(v) => app.setChannel(ch, v === "" ? null : v)}
                    options={[
                      { value: "", label: "— 未使用 —" },
                      ...SIGNALS.map((s) => ({ value: s.id, label: `${s.label} (${s.unit})` })),
                    ]}
                  />
                </div>
              ))}
              <div className="row" style={{ gap: 8 }}>
                <Field label="采样率">
                  <SelectField
                    value={app.sampleHz}
                    onChange={app.setSampleHz}
                    options={[250, 500, 1000, 2000, 4000].map((v) => ({
                      value: v,
                      label: `${v} Hz`,
                    }))}
                  />
                </Field>
                <Field label="同步">
                  <SelectField value="pwm_z" onChange={() => undefined} options={[{ value: "pwm_z", label: "PWM_Z 起点" }]} />
                </Field>
              </div>
              <Notice tone="warn">
                串口 115200 下 4 通道 × 5 字节 ≈ 1.7 ms，触发周期需大于它。想上 1 kHz 请用 921600 以上。
              </Notice>
            </div>
          </Card>

          <Card title="手动运行" sub="VELOCITY MODE">
            <div className="stack" style={{ gap: 10 }}>
              <Field label="目标转速" hint="RPM">
                <NumField value={target} onChange={setTarget} min={-3000} max={3000} step={50} unit="RPM" />
              </Field>
              <Check checked={confirmRun} onChange={setConfirmRun}>
                我已确认电机固定、电源限流
              </Check>
              <div className="row" style={{ gap: 8 }}>
                <Button
                  variant="primary"
                  block
                  disabled={!app.connected || !app.armed || !confirmRun}
                  icon={<Icon.Bolt width={14} height={14} />}
                  onClick={async () => {
                    try {
                      // with the travel guard armed this goes through the limit
                      // check; without feedback it is a plain velocity command
                      if (app.axis?.limits.enabled) {
                        app.setAxis(await api.axisJog(target, app.cal.poles, app.cal.countsPerRpm));
                      } else {
                        await api.setVelocity(target, app.cal.poles, app.cal.countsPerRpm);
                      }
                      app.toast("ok", `速度目标 ${target} RPM`);
                    } catch (e) {
                      app.toast("error", String(e));
                    }
                  }}
                >
                  启动
                </Button>
                <Button
                  variant="ghost"
                  disabled={!app.connected}
                  icon={<Icon.Stop width={13} height={13} />}
                  onClick={async () => {
                    try {
                      await api.stopMotion(app.cal.poles);
                      app.toast("warn", "已停止");
                    } catch (e) {
                      app.toast("error", String(e));
                    }
                  }}
                >
                  停止
                </Button>
              </div>
              {!app.armed && <span className="tiny muted">需先解锁 ARM</span>}
              {app.axis?.limits.enabled ? (
                <span className="tiny" style={{ color: "var(--ok)" }}>
                  行程保护已生效：目标越界会被拒绝
                </span>
              ) : (
                <span className="tiny muted">软限位未开启，转速命令直通芯片（机械行程页可开启）</span>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid cols-3">
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
              disabled={!app.connected || !app.armed}
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
              disabled={!app.connected || !app.armed}
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
            <div className="row" style={{ gap: 6 }}>
              <span className="tiny muted">信号极性</span>
              <Segmented
                value={String(app.cal.polarity)}
                onChange={(v) => app.setCal({ polarity: Number(v) })}
                options={[
                  { value: "1", label: "正向" },
                  { value: "-1", label: "反向" },
                ]}
              />
              <span style={{ flex: 1 }} />
              <span className="tiny muted">CH</span>
              <select
                value={picker}
                onChange={(e) => setPicker(Number(e.target.value))}
                className="mono"
                style={{ background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 6, padding: "2px 4px" }}
              >
                {assigned.map((a) => (
                  <option key={a.ch} value={a.ch}>
                    CH{a.ch}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>
      </div>

      <Card title="原始遥测回显" sub="RAW REGISTER ECHO">
        <div className="grid cols-4" style={{ gap: 10 }}>
          {([
            [0x154, "速度实际", (v: number) => `${v} (${fmt(v / app.cal.countsPerRpm, 1)} RPM)`],
            [0x153, "力矩/磁链实际", (v: number) => `${s16hi(v)} / ${s16lo(v)}`],
            [0x171, "U_S / I_S", (v: number) => `${(v >>> 16) & 0xffff} / ${v & 0xffff}`],
            [0x084, "结温原始", (v: number) => `${s16hi(v)}`],
          ] as [number, string, (v: number) => string][]).map(([addr, label, fmtFn]) => (
            <div key={String(addr)} className="matrix">
              <div className="cell">
                <b>{label}</b>
                <span className="mono">{fmtFn(regs[addr] ?? 0)}</span>
                <span className="mono" style={{ color: "var(--text-4)" }}>
                  {hex(Number(addr), 3)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
