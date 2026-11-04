import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SemanticHoming from "./SemanticHoming";

import { M9_HOMING, checkHomingStart } from "../lib/homing";
import { chipDirection } from "../lib/motor-control";
import { MotorControls } from "../components/MotorControls";
import { Commissioning } from "../components/Commissioning";
import { SemanticStatus } from "../components/SemanticStatus";
import TuningPage from "./Tuning";
import EncoderPage from "./Encoder";
import StoragePage from "./Storage";
import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import type { HomingConfig, HomingState } from "../lib/types";
import { Badge, Button, Card, Check, Field, Icon, Notice, NumField, SelectField, Stat } from "../components/ui";

/** 界面上的可编辑形态：k 用小数（0.4），其余是各自的工程单位。 */
interface Cfg {
  k: number;
  ratedMa: number;
  confirmMs: number;
  limitMa: number;
  maxRpm: number;
  retreatDeg: number;
  settleMs: number;
  timeoutS: number;
}

/** 默认值 = 固件参考实现（doc/TODO/TODO-01-机械找零.md 第 5 章）。 */
const HOMING_DEFAULT: Cfg = {
  k: 0.4,
  ratedMa: 800,
  confirmMs: 50,
  limitMa: 600,
  maxRpm: 2000,
  retreatDeg: 360,
  settleMs: 2000,
  timeoutS: 60,
};

/** 主控侧参数 → 界面形态。 */
function fromWire(w: HomingConfig): Cfg {
  return {
    k: w.k_x1000 / 1000,
    ratedMa: w.rated_ma,
    confirmMs: w.confirm_ms,
    limitMa: w.limit_ma,
    maxRpm: w.max_rpm,
    retreatDeg: w.retreat_deg,
    settleMs: w.settle_ms,
    timeoutS: w.timeout_s,
  };
}

/** 界面形态 → 主控载荷（与 op 15 的 16 字节一一对应）。 */
function toWire(c: Cfg): HomingConfig {
  return {
    k_x1000: Math.round(c.k * 1000),
    rated_ma: Math.round(c.ratedMa),
    confirm_ms: Math.round(c.confirmMs),
    limit_ma: Math.round(c.limitMa),
    max_rpm: Math.round(c.maxRpm),
    retreat_deg: Math.round(c.retreatDeg),
    settle_ms: Math.round(c.settleMs),
    timeout_s: Math.round(c.timeoutS),
  };
}

const WIRE_KEYS: (keyof HomingConfig)[] = [
  "k_x1000",
  "rated_ma",
  "confirm_ms",
  "limit_ma",
  "max_rpm",
  "retreat_deg",
  "settle_ms",
  "timeout_s",
];

/** 回读校验：逐字段比对，返回不一致的字段名。 */
function diffFields(a: HomingConfig, b: HomingConfig): string[] {
  return WIRE_KEYS.filter((k) => a[k] !== b[k]);
}

/** 与固件同款的越界检查，先在界面上挡一遍。 */
function localCheck(c: Cfg): string | null {
  const wire = toWire(c);
  const fields: [string, number, number, number][] = [
    ["判定系数 k", wire.k_x1000, 100, 2000],
    ["额定电流", wire.rated_ma, 100, 3000],
    ["连续确认", wire.confirm_ms, 10, 1000],
    ["找零电流上限", wire.limit_ma, 100, 2000],
    ["推进速度上限", wire.max_rpm, 100, 6000],
    ["退开量", wire.retreat_deg, 0, 1080],
    ["退开稳定等待", wire.settle_ms, 0, 10000],
    ["找零超时", wire.timeout_s, 5, 300],
  ];
  for (const [name, v, lo, hi] of fields) {
    if (!Number.isFinite(v) || v < lo || v > hi) return `${name} 需在 ${lo}…${hi} 之间（当前 ${v}）`;
  }
  if (wire.limit_ma <= (wire.k_x1000 * wire.rated_ma) / 1000) {
    return `找零电流上限 ${wire.limit_ma} mA 不大于判定阈值 ${Math.round((wire.k_x1000 * wire.rated_ma) / 1000)} mA，判据永远无法满足`;
  }
  return null;
}

/** 找零子状态 + 零点有效性 → 直接可读的一句话。 */
function homingStatus(stage: number, zeroValid: boolean): { text: string; tone?: string } {
  if (stage === 1) return { text: "进行中", tone: "var(--accent)" };
  if (stage === 3) return { text: "失败", tone: "var(--danger)" };
  if (zeroValid) return { text: "已找零", tone: "var(--ok)" };
  return { text: "需找零", tone: "var(--warn)" };
}

/**
 * 机械找零（撞限位回零）。上位机下发方向/步进、把工艺参数写进主控、显示主控上报的状态；
 * 门控、推进、电流判据、超时与零点写入全部在主控固件里（TODO-01）。
 */
export default function HomingPage() {
  const app = useApp();
  return app.mode !== "direct" ? <SemanticHoming key={app.motor} /> : <LegacyHomingPage />;
}
function LegacyHomingPage() {
  const app = useApp();
  const [dir, setDir] = useState<-1 | 1 | 0>(0);
  const [stepDeg, setStepDeg] = useState(app.motor === 9 ? 1 : 15);
  const [safety, setSafety] = useState(false);
  const [hom, setHom] = useState<HomingState | null>(null);
  const [note, setNote] = useState("");
  const [cfg, setCfg] = useState<Cfg>(app.motor === 9 ? fromWire(M9_HOMING) : HOMING_DEFAULT);
  /** 主控里当前生效的参数；null = 还没读过。 */
  const [applied, setApplied] = useState<HomingConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [details, setDetails] = useState("");
  const selectedMotor = useRef(app.motor);
  selectedMotor.current = app.motor;
  const running = hom?.stage === 1;
  const thresholdMa = Math.round(cfg.k * cfg.ratedMa);

  const wire = useMemo(() => toWire(cfg), [cfg]);
  const invalid = localCheck(cfg);
  const pending = applied ? diffFields(wire, applied).length > 0 : true;
  const configurable = app.connected && app.mode !== "direct" && !running && !app.jobRunning && !app.motionActive;

  useEffect(() => {
    if (!app.connected || app.mode === "direct") {
      setHom(null);
      setNote("");
      setApplied(null);
      return;
    }
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || app.jobRunning || app.motionActive) return;
      inFlight = true;
      try {
        const s = await api.homingState(app.motor);
        if (alive) {
          setHom(s);
          setNote("");
        }
      } catch (e) {
        if (alive) setNote(String(e));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const t = window.setInterval(tick, 400);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [app.connected, app.mode, app.motor, app.jobRunning, app.motionActive]);

  /** 连接后先读一次主控里的参数，避免界面显示的和实际生效的不一致。 */
  const pull = useCallback(async () => {
    setBusy(true);
    try {
      const w = await api.homingReadConfig(app.motor);
      setApplied(w);
      setCfg(fromWire(w));
      app.toast("ok", "已读取主控里的找零参数");
    } catch (e) {
      app.toast("error", `读取找零参数失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [app.motor, app.toast]);

  useEffect(() => {
    setApplied(null);
    setHom(null);
    setSafety(false);
    setActionError("");
    setCfg(app.motor === 9 ? fromWire(M9_HOMING) : HOMING_DEFAULT);
    setDir(0);
    setStepDeg(app.motor === 9 ? 1 : 15);
    if (!app.connected || app.mode === "direct") return;
    let alive = true;
    void (async () => {
      try {
        const w = await api.homingReadConfig(app.motor);
        if (!alive) return;
        setApplied(w);
        // M9 展示实测预设；旧主控参数用 pending 标记，必须明确写入。
        if (app.motor !== 9) setCfg(fromWire(w));
      } catch {
        // 固件没实现 op16 或还没连上：保持界面默认值，写入时再报错
      }
    })();
    return () => {
      alive = false;
    };
  }, [app.connected, app.mode, app.motor]);

  const write = async () => {
    const bad = localCheck(cfg);
    if (bad) {
      app.toast("error", bad);
      return;
    }
    setBusy(true);
    try {
      await api.homingWriteConfig(wire, app.motor);
      // 回读校验：只认主控真的存下来的值
      const back = await api.homingReadConfig(app.motor);
      setApplied(back);
      const bad2 = diffFields(wire, back);
      if (bad2.length) {
        app.toast("error", `回读不一致：${bad2.join("、")}，请重试`);
      } else {
        app.toast("ok", "找零参数已写入主控并回读校验通过");
      }
    } catch (e) {
      app.toast("error", `写入找零参数失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!configurable || !app.armed || !safety || busy || invalid || pending) return;
    const motor = app.motor;
    const stillSelected = () => {
      if (selectedMotor.current !== motor) throw new Error("电机已切换，请重新确认参数与方向");
    };
    setActionError("");
    setBusy(true);
    try {
      await app.stopStream();
      await checkHomingStart(api, motor, wire, stillSelected, setApplied);
      await api.homingStart({ dir: chipDirection(dir === 0 ? -1 : dir), step_unit: Math.round(stepDeg * 100), timed_seek: false, dual_limit: dir === 0 }, motor);
      const state = await api.homingState(motor);
      stillSelected();
      setHom(state);
      if (state.stage === 3) throw new Error(state.message || `找零失败，错误码 ${state.error}`);
      setSafety(false);
      app.toast("ok", "已请求找零：主控将裁决门控并开始推进");
    } catch (e) {
      setActionError(String(e));
      app.toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api.homingCancel(app.motor);
      app.toast("warn", "已请求取消找零");
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const status = homingStatus(hom?.stage ?? 0, hom?.zero_valid ?? false);
  const bothValid = !!hom?.zero_valid && !!hom?.negative_valid && !!hom?.positive_valid;
  const zeroText = bothValid ? `0 / ${((hom?.travel_counts ?? 0) * 360 / 65536).toFixed(2)}°` : `${hom?.negative_valid ? '负端有效' : '负端未定'} / ${hom?.positive_valid ? '正端有效' : '正端未定'}`;

  return (
    <div className="grid" style={{ gap: 14 }}>
      {app.mode !== "direct" ? <SemanticStatus /> : <div className="grid cols-3" style={{ gap: 14 }}>
        <Stat label="找零状态" value={running ? (hom?.limit_phase === 1 ? "负端检测中" : hom?.limit_phase === 2 ? "正端检测中" : "进行中") : status.text} tone={status.tone} />
        <Stat
          label="机械限位 · 负端 / 正端"
          value={zeroText}
          tone={hom?.zero_valid ? "var(--ok)" : "var(--text-4)"}
        />
        <Stat label="i_q 实测" value={(hom?.iq_ma ?? 0).toFixed(0)} unit="mA" />
      </div>}

      <MotorControls key={app.motor} homing={running || busy} />

      <div className="homing-split">
        <Card
          title="找零参数"
          sub="HOMING PARAMS · 存在主控"
          right={
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              {applied === null ? (
                <Badge tone="neutral">未读取</Badge>
              ) : pending ? (
                <Badge tone="warn" dot="warn">
                  有未写入修改
                </Badge>
              ) : (
                <Badge tone="ok" dot="on">
                  已写入主控
                </Badge>
              )}
              {app.motor === 9 && <Button size="sm" variant="ghost" disabled={running || busy || app.jobRunning} onClick={() => {
                setCfg(fromWire(M9_HOMING)); setDir(0); setStepDeg(1); setSafety(false);
              }}>载入 M9 实测参数</Button>}
              <Button size="sm" variant="ghost" disabled={!configurable || busy} onClick={() => void pull()}>
                从主控读取
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!configurable || busy || !!invalid || (!!applied && !pending)}
                onClick={() => void write()}
              >
                {busy ? "处理中…" : "写入配置"}
              </Button>
            </div>
          }
        >
          <div className="param-grid">
            <Field label="判定系数 k" hint={`阈值 = ${thresholdMa} mA`}>
              <NumField value={cfg.k} onChange={(v) => setCfg({ ...cfg, k: v })} min={0.1} max={2} step={0.05} label="判定系数 k" />
            </Field>
            <Field label="额定电流" hint="判据基准">
              <NumField
                value={cfg.ratedMa}
                onChange={(v) => setCfg({ ...cfg, ratedMa: v })}
                min={100}
                max={3000}
                step={50}
                unit="mA"
                label="额定电流"
              />
            </Field>
            <Field label="连续确认" hint="抗瞬态">
              <NumField
                value={cfg.confirmMs}
                onChange={(v) => setCfg({ ...cfg, confirmMs: v })}
                min={10}
                max={1000}
                step={10}
                unit="ms"
                label="连续确认"
              />
            </Field>
            <Field label="找零电流上限" hint={cfg.limitMa <= thresholdMa ? "必须 > 阈值" : `> 阈值 ${thresholdMa}`}>
              <NumField
                value={cfg.limitMa}
                onChange={(v) => setCfg({ ...cfg, limitMa: v })}
                min={100}
                max={2000}
                step={50}
                unit="mA"
                label="找零电流上限"
              />
            </Field>
            <Field label="推进速度上限">
              <NumField
                value={cfg.maxRpm}
                onChange={(v) => setCfg({ ...cfg, maxRpm: v })}
                min={100}
                max={6000}
                step={100}
                unit="RPM"
                label="推进速度上限"
              />
            </Field>
            <Field label="找零超时">
              <NumField
                value={cfg.timeoutS}
                onChange={(v) => setCfg({ ...cfg, timeoutS: v })}
                min={5}
                max={300}
                step={5}
                unit="s"
                label="找零超时"
              />
            </Field>
            <Field label="退开量" hint="电机端">
              <NumField
                value={cfg.retreatDeg}
                onChange={(v) => setCfg({ ...cfg, retreatDeg: v })}
                min={0}
                max={1080}
                step={30}
                unit="°"
                label="退开量"
              />
            </Field>
            <Field label="退开稳定等待">
              <NumField
                value={cfg.settleMs}
                onChange={(v) => setCfg({ ...cfg, settleMs: v })}
                min={0}
                max={10000}
                step={100}
                unit="ms"
                label="退开稳定等待"
              />
            </Field>
          </div>
          {invalid ? (
            <Notice tone="warn">{invalid}</Notice>
          ) : (
            <div className="tiny muted">
              参数存在主控内存里（掉电不保存，上电回固件默认值）；点「写入配置」后会用 op 16 回读逐字段校验。
              找零进行中主控拒收参数。此处不写 PID；对齐成功不代表速度环、位置环已配置。
              M9 实测速度 P=500/I=250、位置 P=500/I=0，机构负向（协议+1）、连续推进。
            </div>
          )}
        </Card>

        <Card title="找零控制" sub="HOMING · HARD-STOP" right={<Badge tone="neutral">主控执行</Badge>}>
          {actionError && <div role="alert"><Notice tone="warn">{actionError}</Notice></div>}
          <Button size="sm" variant="ghost" disabled={running || busy || app.motionActive} onClick={() => setDetails("pid")}>在本页配置 PID 与限幅</Button>
          <div className="grid cols-2" style={{ gap: 10 }}>
            <Field label="找零方向" hint="按机构方向，已反转芯片符号">
              <SelectField
                value={dir}
                onChange={(v) => {setDir(v as -1 | 1 | 0);setSafety(false);}}
                options={[
                  { value: 0, label: "双端找零（先负端 → 再正端）" },
                  { value: -1, label: "负方向（机构 −）" },
                  { value: 1, label: "正方向（机构 +）" },
                ]}
              />
            </Field>
            {dir !== 0 && <Field label="每拍步进" hint="电机端角度">
              <NumField value={stepDeg} onChange={setStepDeg} min={1} max={60} step={1} unit="°" />
            </Field>}
          </div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            位置直通：直接更新芯片位置目标，不使用五次轨迹。双端找零固定先机构负端、再正端，各端接触后退开确认；只有两端都有效才完成。正向/负向选项保留单端调试，不能代替完整双端行程。
          </div>
          <div className="divider" />
          <Check checked={safety} onChange={setSafety}>
            我已确认行程内无人员、无异物，且找零方向指向正确的限位端
          </Check>
          <div className="row-wrap" style={{ gap: 8 }}>
            <Button
              variant="primary"
              icon={<Icon.Target width={14} height={14} />}
              disabled={!app.connected || !app.armed || app.mode === "direct" || !safety || running || busy || app.jobRunning || app.motionActive || pending || !!invalid}
              onClick={() => void start()}
            >
              开始找零
            </Button>
            <Button variant="ghost" disabled={!running} onClick={() => void cancel()}>
              取消找零
            </Button>
            {app.mode === "direct" && <span className="tiny muted">需切到主控模式（485 / CAN）</span>}
            {app.connected && app.mode !== "direct" && !app.armed && (
              <span className="tiny muted">需解锁 ARM</span>
            )}
            {!app.connected && <span className="tiny muted">串口未连接</span>}
            {pending && <span className="tiny muted">请先写入找零配置并回读确认</span>}
            {running && <span className="tiny muted">找零进行中，参数暂不可写</span>}
            {hom?.message && <span className="tiny muted">主控：{hom.message}</span>}
            {note && <span className="tiny muted">{note}</span>}
          </div>
        </Card>
      </div>
      <Commissioning config={wire} dir={dir === 0 ? -1 : dir} dualLimit={dir === 0} homing={running || busy} />
      <Card title="详细配置与存储" sub="留在本页完成编码器、对齐、PID和参数保存">
        <div className="row-wrap" style={{gap:8}}>
          {[['encoder','编码器与对齐'],['pid','PID 与限幅'],['storage','EEPROM 参数']].map(([id,label]) =>
            <Button key={id} disabled={running || busy || app.motionActive || app.jobRunning} onClick={() => setDetails(details === id ? '' : id)}>{label}</Button>)}
        </div>
        <fieldset disabled={running || busy || app.motionActive} style={{border:0,padding:0,marginTop:12}}>
          {details === 'encoder' && <EncoderPage key={app.motor} />}
          {details === 'pid' && <TuningPage key={app.motor} />}
          {details === 'storage' && <StoragePage key={app.motor} />}
        </fieldset>
      </Card>
    </div>
  );
}
