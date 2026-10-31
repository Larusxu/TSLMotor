import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { TESLA_PROFILE } from "../lib/presets";
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
  Steps,
} from "../components/ui";
import {
  coefToGain,
  composePidConfig,
  countsFromMa,
  CUR_NORM_LABELS,
  fmt,
  iFrac,
  NORM_I_LABELS,
  NORM_P_LABELS,
  pFrac,
  parsePidConfig,
  pwmHz,
  suggestPi,
} from "../lib/units";
import type { PidCfgPayload, StepCfgPayload, StepResult } from "../lib/types";

function StepChart({ data }: { data: StepResult }) {
  const W = 640;
  const H = 220;
  const padL = 44;
  const padB = 20;
  const padT = 8;
  const n = data.time.length;
  if (!n) return <div className="empty">无数据</div>;
  const tMax = data.time[n - 1] || 1;
  const all = [...data.target, ...data.actual].filter((v) => Number.isFinite(v));
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < 1e-6) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;
  const x = (t: number) => padL + (t / tMax) * (W - padL - 8);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(data.time[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - 8} y1={padT + f * (H - padT - padB)} y2={padT + f * (H - padT - padB)} className="chart-grid" />
          <text x={4} y={padT + f * (H - padT - padB) + 3} fontSize="8.5" className="chart-ink" fontFamily="Consolas, monospace">
            {fmt(max - f * (max - min), Math.abs(max) > 100 ? 0 : 2)}
          </text>
        </g>
      ))}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} x={padL + f * (W - padL - 8)} y={H - 6} fontSize="8.5" className="chart-ink" textAnchor="middle" fontFamily="Consolas, monospace">
          {fmt(f * tMax, 0)}ms
        </text>
      ))}
      <path d={path(data.target)} fill="none" stroke="var(--ch-1)" strokeWidth="1.4" strokeDasharray="4 3" />
      <path d={path(data.actual)} fill="none" stroke="var(--ch-0)" strokeWidth="1.7" />
    </svg>
  );
}

export default function TuningPage() {
  const app = useApp();
  const p = TESLA_PROFILE;

  const [curP, setCurP] = useState(p.pid.curP);
  const [curI, setCurI] = useState(p.pid.curI);
  const [velP, setVelP] = useState(p.pid.velP);
  const [velI, setVelI] = useState(p.pid.velI);
  const [posP, setPosP] = useState(p.pid.posP);
  const [posI, setPosI] = useState(p.pid.posI);

  const [curNp, setCurNp] = useState(1);
  const [curNi, setCurNi] = useState(1);
  const [velNp, setVelNp] = useState(1);
  const [velNi, setVelNi] = useState(1);
  const [posNp, setPosNp] = useState(1);
  const [posNi, setPosNi] = useState(1);
  const [velShift, setVelShift] = useState(8);
  const [posSampling, setPosSampling] = useState(0);
  const [overwrite, setOverwrite] = useState(false);
  const [keepPos, setKeepPos] = useState(false);

  const [torqueLimit, setTorqueLimit] = useState(p.limits.torqueMa);
  const [fluxLimit, setFluxLimit] = useState(p.limits.fluxMa);
  const [velLimit, setVelLimit] = useState(p.limits.velRpm);
  const [uqUd, setUqUd] = useState(p.limits.uqUd);
  const [confirm, setConfirm] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [kind, setKind] = useState<"current" | "velocity">("current");
  const [amp, setAmp] = useState(500);
  const [duration, setDuration] = useState(1500);
  const [rOhm, setROhm] = useState(p.bench.rOhm);
  const [lUh, setLUh] = useState(p.bench.lUh);
  const [bw, setBw] = useState(p.bench.bandwidthHz);
  const [stepSafety, setStepSafety] = useState(false);
  const [step, setStep] = useState<StepResult | null>(null);

  useEffect(() => {
    const d = app.lastDone;
    if (d?.ok && d.data && typeof d.data === "object" && "metrics" in (d.data as object)) {
      setStep(d.data as StepResult);
    }
  }, [app.lastDone]);

  const fPwm = pwmHz(app.cal.pwmMaxCount);
  const suggestion = useMemo(() => suggestPi(rOhm, lUh, bw, fPwm), [rOhm, lUh, bw, fPwm]);

  const payload: PidCfgPayload = {
    flux_p: curP,
    flux_i: curI,
    torque_p: curP,
    torque_i: curI,
    vel_p: velP,
    vel_i: velI,
    pos_p: posP,
    pos_i: posI,
    cur_norm_p: curNp,
    cur_norm_i: curNi,
    vel_norm_p: velNp,
    vel_norm_i: velNi,
    pos_norm_p: posNp,
    pos_norm_i: posNi,
    vel_shift: velShift,
    pos_sampling: posSampling,
    overwrite_target: overwrite,
    keep_pos_target: keepPos,
    torque_limit_ma: torqueLimit,
    flux_limit_ma: fluxLimit,
    vel_limit_rpm: velLimit,
    uq_ud_limit: uqUd,
    ma_per_count: app.cal.maPerCount,
    counts_per_rpm: app.cal.countsPerRpm,
  };

  const stepCfg: StepCfgPayload = {
    kind,
    amplitude: amp,
    duration_ms: duration,
    poles: app.cal.poles,
    ma_per_count: app.cal.maPerCount,
    counts_per_rpm: app.cal.countsPerRpm,
    r_ohm: rOhm,
    l_uh: lUh,
    bandwidth_hz: bw,
    sampling: Math.max(0, Math.min(255, Math.round(fPwm / 1000) - 1)),
    current_p: curP,
    current_i: curI,
    velocity_p: velP,
    velocity_i: velI,
  };

  const pidConfig = composePidConfig({
    pos_sampling: posSampling,
    vel_shift: velShift,
    pos_norm_i: posNi,
    pos_norm_p: posNp,
    vel_norm_i: velNi,
    vel_norm_p: velNp,
    cur_norm_i: curNi,
    cur_norm_p: curNp,
    overwrite_target: overwrite,
    keep_pos_target: keepPos,
  });

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid flow-2-1">
        <div className="col-stack">
        <Card
          title="PID 参数"
          sub="CASCADE GAINS"
          right={
            <div className="row" style={{ gap: 6 }}>
              <Badge tone="neutral" >
                PID_CONFIG {`0x${pidConfig.toString(16).toUpperCase().padStart(8, "0")}`}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={!app.connected}
                onClick={async () => {
                  try {
                    const snap = await api.readPid();
                    const cfg = parsePidConfig(snap.config);
                    const set = (v: number) => [(v >>> 16) & 0xffff, v & 0xffff] as const;
                    const [tp, ti] = set(snap.torque_coeff);
                    const [vp, vi] = set(snap.vel_coeff);
                    const [pp, pi] = set(snap.pos_coeff);
                    setCurP(tp);
                    setCurI(ti);
                    setVelP(vp);
                    setVelI(vi);
                    setPosP(pp);
                    setPosI(pi);
                    setCurNp(cfg.cur_norm_p);
                    setCurNi(cfg.cur_norm_i);
                    setVelNp(cfg.vel_norm_p);
                    setVelNi(cfg.vel_norm_i);
                    setPosNp(cfg.pos_norm_p);
                    setPosNi(cfg.pos_norm_i);
                    setVelShift(cfg.vel_shift);
                    setPosSampling(cfg.pos_sampling);
                    setOverwrite(cfg.overwrite_target);
                    setKeepPos(cfg.keep_pos_target);
                    const tRaw = (snap.tf_limits >>> 16) & 0x7fff;
                    setTorqueLimit(tRaw * app.cal.maPerCount);
                    setFluxLimit((snap.tf_limits & 0x7fff) * app.cal.maPerCount);
                    setVelLimit(snap.vel_limit / app.cal.countsPerRpm);
                    setUqUd(snap.uq_ud_limit & 0xffff);
                    setLoaded(true);
                    app.toast("ok", "已从芯片读取当前 PID 与限幅");
                  } catch (e) {
                    app.toast("error", String(e));
                  }
                }}
              >
                从芯片读取
              </Button>
            </div>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="pid-grid">
              <div className="pid-col accent">
                <div className="pid-head">
                  电流环 · 力矩 / 磁链
                  <span className="pid-gain">0x142 / 0x143</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Field label="P" style={{ flex: 1 }}>
                    <NumField value={curP} onChange={setCurP} min={0} max={32767} width="100%" />
                  </Field>
                  <Field label="I" style={{ flex: 1 }}>
                    <NumField value={curI} onChange={setCurI} min={0} max={32767} width="100%" />
                  </Field>
                </div>
                <Field label="P 归一化">
                  <SelectField value={curNp} onChange={setCurNp} width="100%" options={CUR_NORM_LABELS.map((l, i) => ({ value: i, label: l }))} />
                </Field>
                <Field label="I 归一化">
                  <SelectField value={curNi} onChange={setCurNi} width="100%" options={CUR_NORM_LABELS.map((l, i) => ({ value: i, label: l }))} />
                </Field>
                <span className="pid-gain">
                  Kp={fmt(coefToGain(curP, pFrac(curNp)), 4)} · Ki={fmt(coefToGain(curI, iFrac(curNi, true)), 4)}
                </span>
              </div>

              <div className="pid-col">
                <div className="pid-head">
                  速度环
                  <span className="pid-gain">0x145</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Field label="P" style={{ flex: 1 }}>
                    <NumField value={velP} onChange={setVelP} min={0} max={32767} width="100%" />
                  </Field>
                  <Field label="I" style={{ flex: 1 }}>
                    <NumField value={velI} onChange={setVelI} min={0} max={32767} width="100%" />
                  </Field>
                </div>
                <Field label="P 归一化">
                  <SelectField value={velNp} onChange={setVelNp} width="100%" options={NORM_P_LABELS.map((l, i) => ({ value: i, label: l }))} />
                </Field>
                <Field label="I 归一化">
                  <SelectField value={velNi} onChange={setVelNi} width="100%" options={NORM_I_LABELS.map((l, i) => ({ value: i, label: l }))} />
                </Field>
                <span className="pid-gain">
                  Kp={fmt(coefToGain(velP, pFrac(velNp)), 4)} · Ki={fmt(coefToGain(velI, iFrac(velNi)), 4)} · shift {velShift}
                </span>
              </div>

              <div className="pid-col">
                <div className="pid-head">
                  位置环
                  <span className="pid-gain">0x146</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Field label="P" style={{ flex: 1 }}>
                    <NumField value={posP} onChange={setPosP} min={0} max={32767} width="100%" />
                  </Field>
                  <Field label="I" style={{ flex: 1 }}>
                    <NumField value={posI} onChange={setPosI} min={0} max={32767} width="100%" />
                  </Field>
                </div>
                <Field label="P 归一化">
                  <SelectField value={posNp} onChange={setPosNp} width="100%" options={NORM_P_LABELS.map((l, i) => ({ value: i, label: l }))} />
                </Field>
                <Field label="I 归一化">
                  <SelectField value={posNi} onChange={setPosNi} width="100%" options={NORM_I_LABELS.map((l, i) => ({ value: i, label: l }))} />
                </Field>
                <span className="pid-gain">
                  Kp={fmt(coefToGain(posP, pFrac(posNp)), 4)} · Ki={fmt(coefToGain(posI, iFrac(posNi)), 4)}
                </span>
              </div>
            </div>

            <div className="grid cols-4" style={{ gap: 10 }}>
              <Field label="速度输出右移" hint="0x140[15:12]">
                <NumField value={velShift} onChange={setVelShift} min={0} max={15} />
              </Field>
              <Field label="位置降采样" hint="0x140[22:16]">
                <NumField value={posSampling} onChange={setPosSampling} min={0} max={127} />
              </Field>
              <Field label="平滑切换" hint="OVERWRITE_TARGET">
                <SelectField
                  value={overwrite ? "1" : "0"}
                  onChange={(v) => setOverwrite(v === "1")}
                  options={[
                    { value: "0", label: "关闭" },
                    { value: "1", label: "开启" },
                  ]}
                />
              </Field>
              <Field label="写实际位置不改目标" hint="KEEP_POS_TARGET">
                <SelectField
                  value={keepPos ? "1" : "0"}
                  onChange={(v) => setKeepPos(v === "1")}
                  options={[
                    { value: "0", label: "关闭" },
                    { value: "1", label: "开启" },
                  ]}
                />
              </Field>
            </div>

            <div className="divider" />
            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
              <Field label="力矩限幅" hint={`${countsFromMa(torqueLimit, app.cal.maPerCount)} counts`}>
                <NumField value={torqueLimit} onChange={setTorqueLimit} min={0} max={1600} step={10} unit="mA" />
              </Field>
              <Field label="磁链限幅">
                <NumField value={fluxLimit} onChange={setFluxLimit} min={0} max={1600} step={10} unit="mA" />
              </Field>
              <Field label="速度限幅" hint={`${Math.round(velLimit * app.cal.countsPerRpm)}`}>
                <NumField value={velLimit} onChange={setVelLimit} min={0} max={60000} step={500} unit="RPM" />
              </Field>
              <Field label="电压限幅" hint={`${fmt((Math.min(uqUd, 18900) / 18900) * 100, 1)}% 调制`}>
                <NumField value={uqUd} onChange={setUqUd} min={0} max={32767} step={500} />
              </Field>
            </div>

            <div className="divider" />
            <Check checked={confirm} onChange={setConfirm}>
              确认写入 PID 与限幅（会清零四个积分器）
            </Check>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Save width={14} height={14} />}
                disabled={!app.connected || !app.armed || !confirm || app.jobRunning}
                onClick={() => void app.runJob("pid", payload)}
              >
                写入参数
              </Button>
              <Button
                variant="ghost"
                disabled={!app.armed}
                onClick={() => {
                  setCurP(p.pid.curP);
                  setCurI(p.pid.curI);
                  setVelP(p.pid.velP);
                  setVelI(p.pid.velI);
                  setPosP(p.pid.posP);
                  setPosI(p.pid.posI);
                  setCurNp(1);
                  setCurNi(1);
                  setVelNp(1);
                  setVelNi(1);
                  setPosNp(1);
                  setPosNi(1);
                  setVelShift(8);
                  setTorqueLimit(p.limits.torqueMa);
                  setFluxLimit(p.limits.fluxMa);
                  setVelLimit(p.limits.velRpm);
                  setUqUd(p.limits.uqUd);
                  app.toast("ok", "已载入 Tesla 生产固件参数");
                }}
              >
                载入生产参数
              </Button>
              <Button
                variant="ghost"
                disabled={!app.armed}
                onClick={() => {
                  setCurP(p.bench.p);
                  setCurI(p.bench.i);
                  setCurNp(1);
                  setCurNi(1);
                  app.toast("ok", "已载入实测电流环 359/129");
                }}
              >
                载入实测电流环
              </Button>
              {loaded && <span className="tiny muted">已从芯片读取</span>}
            </div>
            <Notice tone="danger">
              新上位机默认“电流归一化 = No shift（Q16.0）”。若把 64/48 或 359/129 直接写进去而不改成 <b>Shift by 8</b>，
              实际增益会放大 256 倍。
            </Notice>
          </div>
        </Card>
        </div>

        <div className="col-stack">
          <Card title="单位换算" sub="DERIVED">
            <KV
              rows={[
                ["PWM 频率", <span key="a" className="mono">{fmt(fPwm / 1000, 2)} kHz</span>],
                ["电流分辨率", <span key="b" className="mono">{fmt(app.cal.maPerCount, 5)} mA/LSB</span>],
                ["4× 满量程", <span key="c" className="mono">8192 LSB = 1.65 A</span>],
                ["速度换算", <span key="d" className="mono">{fmt(app.cal.countsPerRpm, 1)} LSB/RPM</span>],
                ["位置换算", <span key="e" className="mono">65536 LSB / 圈</span>],
                ["调制满幅", <span key="f" className="mono">18900 = 100%</span>],
              ]}
            />
          </Card>

          <Card title="生产参数对照" sub="TESLA PROFILE">
            <table className="table">
              <thead>
                <tr>
                  <th>项</th>
                  <th>生产</th>
                  <th>实测</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>电流 P / I</td>
                  <td className="mono">64 / 48</td>
                  <td className="mono">359 / 129</td>
                </tr>
                <tr>
                  <td>近似带宽</td>
                  <td className="mono">356 Hz</td>
                  <td className="mono">2000 Hz</td>
                </tr>
                <tr>
                  <td>速度 P / I</td>
                  <td className="mono">500 / 250</td>
                  <td className="mono">—</td>
                </tr>
                <tr>
                  <td>力矩限幅</td>
                  <td className="mono">800 mA</td>
                  <td className="mono">1000 mA</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <div className="grid flow-1-2">
        <div className="col-stack">
        <Card title="阶跃测试" sub="STEP RESPONSE">
          <div className="stack" style={{ gap: 10 }}>
            <Segmented
              value={kind}
              onChange={(v) => setKind(v)}
              options={[
                { value: "current", label: "电流环 iD" },
                { value: "velocity", label: "速度环" },
              ]}
            />
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label="阶跃幅度" hint={kind === "current" ? "mA" : "RPM"}>
                <NumField value={amp} onChange={setAmp} min={1} max={kind === "current" ? 1600 : 3000} step={50} />
              </Field>
              <Field label="采集时长">
                <NumField value={duration} onChange={setDuration} min={300} max={8000} step={100} unit="ms" />
              </Field>
            </div>
            {kind === "current" && (
              <>
                <div className="grid cols-2" style={{ gap: 10 }}>
                  <Field label="R" hint="Ω">
                    <NumField value={rOhm} onChange={setROhm} min={0.05} max={100} step={0.01} unit="Ω" />
                  </Field>
                  <Field label="L" hint="µH">
                    <NumField value={lUh} onChange={setLUh} min={5} max={5000} step={1} unit="µH" />
                  </Field>
                </div>
                <Field label="带宽" hint="用于反算 PI">
                    <NumField value={bw} onChange={setBw} min={100} max={Math.round(fPwm / 10)} step={100} unit="Hz" />
                  </Field>
                <div className="notice">
                  <Icon.Info />
                  <div>
                    建议 P={suggestion.p} / I={suggestion.i}（Kp={fmt(suggestion.kp, 4)}，Ki={fmt(suggestion.ki, 1)}）。
                    按 25 kHz 折算的积分项已包含 1/fPWM。
                    <button
                      className="btn sm ghost"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        setCurP(suggestion.p);
                        setCurI(suggestion.i);
                        setCurNp(1);
                        setCurNi(1);
                      }}
                    >
                      应用到电流环
                    </button>
                  </div>
                </div>
              </>
            )}
            <Check checked={stepSafety} onChange={setStepSafety}>
              我已确认电机固定，阶跃会让电机转动/发热
            </Check>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Bolt width={14} height={14} />}
                disabled={!app.connected || !app.armed || !stepSafety || app.jobRunning}
                onClick={() => {
                  setStep(null);
                  void app.runJob("step", { cfg: stepCfg, frameBits: 14 });
                }}
              >
                执行阶跃
              </Button>
              <Button variant="ghost" disabled={!app.jobRunning} onClick={app.cancel}>
                取消
              </Button>
            </div>
          </div>
        </Card>

        <Card title="参数写入流程" sub="APPLY SEQUENCE">
          <div className="scroll-y" style={{ maxHeight: 260 }}>
            <Steps steps={app.steps} />
          </div>
        </Card>
        </div>

        <Card
          title="阶跃响应"
          sub={step ? `${step.kind === "current" ? "电流环" : "速度环"} · ${step.amplitude} ${step.unit}` : "RESPONSE"}
          right={
            step ? (
              <div className="row" style={{ gap: 6 }}>
                <Badge tone={step.metrics.overshoot_pct < 10 ? "ok" : "warn"}>
                  超调 {fmt(step.metrics.overshoot_pct, 1)}%
                </Badge>
                <Badge tone={Math.abs(step.metrics.steady_error) < 3 ? "ok" : "warn"}>
                  稳态误差 {fmt(step.metrics.steady_error, 2)}%
                </Badge>
              </div>
            ) : undefined
          }
        >
          {!step ? (
            <div className="empty">
              <Icon.Tuning width={22} height={22} />
              执行一次阶跃以获取实测响应
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <StepChart data={step} />
              <div className="grid cols-4" style={{ gap: 8 }}>
                {[
                  ["上升 10–90%", `${fmt(step.metrics.rise_ms, 2)} ms`],
                  ["调节时间 ±5%", `${fmt(step.metrics.settle_ms, 2)} ms`],
                  ["峰值", `${fmt(step.metrics.peak, 1)} ${step.unit}`],
                  ["纹波", `${fmt(step.metrics.ripple, 1)} ${step.unit}`],
                ].map(([k, v]) => (
                  <div className="matrix" key={k}>
                    <div className="cell">
                      <b>{k}</b>
                      <span className="mono">{v}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="tiny muted">
                P={step.p_reg} · I={step.i_reg} · {step.metrics.samples} 点。采样经 RTMI 1 kHz 上传，已重采样到 900 点显示。
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
