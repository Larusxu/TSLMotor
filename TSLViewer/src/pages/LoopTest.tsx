import { useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../lib/app-store";
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
  LoopEngine,
  demandRpm,
  degOf,
  POS_PER_REV,
  travelLabel,
  travelOf,
  travelValid,
  type BoundaryAction,
  type LoopPhase,
  type LoopSample,
  type LoopState,
  type PosKind,
  type TuneRow,
} from "../lib/looptest";
import { fmt } from "../lib/units";

const PHASE_TEXT: Record<LoopPhase, string> = {
  idle: "空闲",
  bounded: "恒给定测试中",
  pos: "位置测试中",
  tune: "辨识中",
};

/** 单通道波形：给定用虚线，反馈用实线，纵轴自适应。 */
function LoopChart({ samples, kind }: { samples: LoopSample[]; kind: "pos" | "rpm" | "iq" }) {
  const W = 760;
  const H = 240;
  const padL = 52;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  if (samples.length < 2) return <div className="empty">开始一次测试以采样</div>;

  const tMax = Math.max(1, samples[samples.length - 1].t);
  const series: { key: string; values: number[]; dash?: boolean; color: string }[] =
    kind === "pos"
      ? [
          { key: "位置给定", values: samples.map((s) => s.posTgt), dash: true, color: "var(--ch-1)" },
          { key: "位置实际", values: samples.map((s) => s.pos), color: "var(--ch-0)" },
        ]
      : kind === "rpm"
        ? [
            { key: "速度给定", values: samples.map((s) => s.rpmTgt), dash: true, color: "var(--ch-1)" },
            { key: "速度反馈", values: samples.map((s) => s.rpm), color: "var(--ch-0)" },
          ]
        : [
            { key: "Iq 实测", values: samples.map((s) => s.iqMa), color: "var(--ch-2)" },
            { key: "速度误差", values: samples.map((s) => s.velErrRpm), dash: true, color: "var(--ch-1)" },
          ];

  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-6) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;
  const x = (t: number) => padL + (t / tMax) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const path = (arr: number[]) =>
    arr
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(samples[i].t).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");

  return (
    <div className="stack" style={{ gap: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={padL}
              x2={W - padR}
              y1={padT + f * (H - padT - padB)}
              y2={padT + f * (H - padT - padB)}
              className="chart-grid"
            />
            <text
              x={4}
              y={padT + f * (H - padT - padB) + 3}
              fontSize="9"
              className="chart-ink"
              fontFamily="Consolas, monospace"
            >
              {fmt(max - f * (max - min), Math.abs(max) > 100 ? 0 : 1)}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text
            key={f}
            x={padL + f * (W - padL - padR)}
            y={H - 6}
            fontSize="9"
            className="chart-ink"
            textAnchor="middle"
            fontFamily="Consolas, monospace"
          >
            {(f * tMax / 1000).toFixed(1)}s
          </text>
        ))}
        {series.map((s) => (
          <path
            key={s.key}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.6}
            strokeDasharray={s.dash ? "4 3" : undefined}
          />
        ))}
      </svg>
      <div className="row-wrap" style={{ gap: 12 }}>
        {series.map((s) => (
          <span key={s.key} className="tiny muted">
            <span style={{ color: s.color }}>■</span> {s.key}
          </span>
        ))}
        <span className="tiny muted">{samples.length} 点 · 60 ms 采样</span>
      </div>
    </div>
  );
}

/**
 * 环路测试（闭环特性验证与参数整定）。
 *
 * 上位机只做四件事：写模式/给定/限幅、每 60 ms 读位置判边界、换系数打分选优、采样画波形。
 * 闭环运算、限幅裁决与故障保护都在 TMC6460 + 主控固件里 —— 本页不下发任何"测试行程"协议。
 */
export default function LoopTestPage() {
  const app = useApp();

  // ---- 整程与行程分段 ------------------------------------------------
  /** 完整软件行程（圈），8 等分后供各测试选区间 */
  const [turns, setTurns] = useState(4);
  const [bSegA, setBSegA] = useState(0);
  const [bSegB, setBSegB] = useState(8);
  const [pSegA, setPSegA] = useState(1);
  const [pSegB, setPSegB] = useState(7);
  const bTravel = travelOf(turns, bSegA, bSegB);
  const pTravel = travelOf(turns, pSegA, pSegB);

  // ---- ① 恒 Iq / 恒速度 ---------------------------------------------
  const [bKind, setBKind] = useState<"iq" | "speed">("iq");
  const [bIq, setBIq] = useState(80);
  const [bRpm, setBRpm] = useState(300);
  const [bLimit, setBLimit] = useState(300);
  const [bAction, setBAction] = useState<BoundaryAction>("stop");

  // ---- ② 速度 PI 辨识 -----------------------------------------------
  const [tRpm, setTRpm] = useState(300);
  const [tLimit, setTLimit] = useState(300);
  const [tKp0, setTKp0] = useState(500);
  const [tKi0, setTKi0] = useState(250);
  const [tMults, setTMults] = useState("0.5,0.75,1,1.25,1.5");
  const [tDwell, setTDwell] = useState(1.5);
  const [tApply, setTApply] = useState(true);
  const [rows, setRows] = useState<TuneRow[]>([]);

  // ---- ③ 位置环测试 -------------------------------------------------
  const [pKind, setPKind] = useState<PosKind>("recip");
  const [pA, setPA] = useState(() => Math.round(pTravel.lo + (pTravel.hi - pTravel.lo) * 0.1));
  const [pB, setPB] = useState(() => Math.round(pTravel.lo + (pTravel.hi - pTravel.lo) * 0.9));
  const [pCenter, setPCenter] = useState(() => Math.round((pTravel.lo + pTravel.hi) / 2));
  const [pAmp, setPAmp] = useState(() => Math.round((pTravel.hi - pTravel.lo) / 6));
  const [pPeriod, setPPeriod] = useState(2);
  const [pCycles, setPCycles] = useState(0);
  const [pMaxRpm, setPMaxRpm] = useState(1000);
  const [pLimit, setPLimit] = useState(300);

  // 改行程分段时把 A/B/中心/幅值拉回区间内，避免"填好了却被行程拒绝"
  useEffect(() => {
    const lo = pTravel.lo;
    const hi = pTravel.hi;
    setPA(Math.round(lo + (hi - lo) * 0.1));
    setPB(Math.round(lo + (hi - lo) * 0.9));
    setPCenter(Math.round((lo + hi) / 2));
    setPAmp(Math.round((hi - lo) / 6));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, pSegA, pSegB]);

  // ---- 安全与状态 ----------------------------------------------------
  const [safety, setSafety] = useState(false);
  const [st, setSt] = useState<LoopState>({
    phase: "idle",
    mode: "—",
    pos: 0,
    posTgt: 0,
    rpm: 0,
    rpmTgt: 0,
    iqMa: 0,
    cycles: 0,
    note: "",
  });
  const [samples, setSamples] = useState<LoopSample[]>([]);
  const [chan, setChan] = useState<"pos" | "rpm" | "iq">("rpm");

  const hostLogRef = useRef(app.hostLog);
  hostLogRef.current = app.hostLog;
  const hostStepRef = useRef(app.hostStep);
  hostStepRef.current = app.hostStep;
  const stepIdx = useRef(0);

  const engine = useMemo(
    () =>
      new LoopEngine({
        poles: app.cal.poles,
        maPerCount: app.cal.maPerCount,
        countsPerRpm: app.cal.countsPerRpm,
        hooks: {
          onSample: (s) =>
            setSamples((prev) => {
              const next = [...prev, s];
              return next.length > 900 ? next.slice(next.length - 900) : next;
            }),
          onState: (patch) => setSt((prev) => ({ ...prev, ...patch })),
          onLog: (level, msg) => hostLogRef.current(level, "loop", msg),
          onStep: (label, detail, status) => {
            stepIdx.current += 1;
            hostStepRef.current("looptest", { idx: stepIdx.current, total: 0, label, status, detail });
          },
        },
      }),
    [app.cal.poles, app.cal.maPerCount, app.cal.countsPerRpm]
  );

  // 页面离开 / 断开时别把电机留在使能状态
  useEffect(() => {
    return () => {
      if (engine.busy) void engine.stop();
    };
  }, [engine]);

  // 流程收尾：phase 回到 idle 时补一条「■ 结束」，结果文字由各测试自己填
  const pendingResult = useRef("");
  const prevPhase = useRef<LoopPhase>("idle");
  useEffect(() => {
    if (prevPhase.current !== "idle" && st.phase === "idle") {
      app.hostJobEnd("looptest", true, pendingResult.current || st.note || "已结束");
      pendingResult.current = "";
    }
    prevPhase.current = st.phase;
  }, [st.phase, st.note, app]);

  // 空闲时每 500 ms 读一次位置/速度/模式：页面不跑测试时也要有实时值
  useEffect(() => {
    if (!app.connected || st.phase !== "idle") return;
    let alive = true;
    const tick = async () => {
      try {
        const patch = await engine.poll();
        if (alive) setSt((prev) => ({ ...prev, ...patch }));
      } catch {
        /* 链路抖动忽略 */
      }
    };
    void tick();
    const h = window.setInterval(tick, 500);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [app.connected, st.phase, engine]);

  const busy = st.phase !== "idle";
  const canRun = app.connected && app.armed && safety;

  const begin = (label: string, chan0: "pos" | "rpm" | "iq" = "rpm") => {
    stepIdx.current = 0;
    setSamples([]);
    setRows([]);
    setChan(chan0);
    app.hostJobStart("looptest");
    app.hostLog("info", "loop", `测试目标：${label}`);
  };

  const fail = (e: unknown) => {
    app.toast("error", String(e));
    app.hostLog("error", "loop", String(e));
  };

  const startBounded = async () => {
    if (!travelValid(bTravel)) return fail("测试行程区间无效：上限必须大于下限");
    begin(`恒 ${bKind === "iq" ? `Iq ${bIq} mA` : `速度 ${bRpm} RPM`}（行程 ${travelLabel(bTravel)}）`);
    try {
      await engine.startBounded({
        kind: bKind,
        iqMa: bIq,
        rpm: bRpm,
        iqLimitMa: bLimit,
        travel: bTravel,
        action: bAction,
      });
    } catch (e) {
      fail(e);
    }
  };

  const startPos = async () => {
    if (!travelValid(pTravel)) return fail("位置行程区间无效：上限必须大于下限");
    begin(`位置环 · ${pKind === "hold" ? "保持" : pKind === "recip" ? "A/B 往复" : "正弦"}`, "pos");
    try {
      await engine.startPos({
        kind: pKind,
        A: pA,
        B: pB,
        center: pCenter,
        amp: pAmp,
        periodS: pPeriod,
        cycles: pCycles,
        iqLimitMa: pLimit,
        maxRpm: pMaxRpm,
        travel: pTravel,
      });
    } catch (e) {
      fail(e);
    }
  };

  const runTune = async () => {
    const mults = tMults
      .split(/[,，\s]+/)
      .map((s) => Number(s))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!mults.length) return fail("倍率非法：至少要有一个正数，用逗号分隔");
    begin(`速度 PI 辨识（基准 Kp=${tKp0} Ki=${tKi0}，倍率 ${mults.join("/")})`);
    try {
      const out = await engine.tune({
        rpm: tRpm,
        iqLimitMa: tLimit,
        kp0: tKp0,
        ki0: tKi0,
        mults,
        dwellS: tDwell,
        apply: tApply,
        travel: bTravel,
      });
      setRows(out);
      const best = out.filter((r) => !r.sat).sort((a, b) => a.s.score - b.s.score)[0];
      app.toast(best ? "ok" : "warn", best ? `最优 Kp=${best.kp} Ki=${best.ki}` : "所有候选都顶限，请加大电流上限或降速");
      pendingResult.current = best
        ? `最优 Kp=${best.kp} Ki=${best.ki} · J=${fmt(best.s.score, 1)}`
        : "全部候选顶限判废";
    } catch (e) {
      fail(e);
      pendingResult.current = String(e);
    }
  };

  const stopAll = async () => {
    pendingResult.current = "手动停止";
    app.hostStep("looptest", { idx: stepIdx.current + 1, total: 0, label: "停止测试", status: "ok", detail: "清目标 + PWM_OFF" });
    stepIdx.current += 1;
    await engine.stop();
  };

  const segOptions = Array.from({ length: 9 }, (_, i) => ({ value: i, label: `${i}/8` }));
  const need = demandRpm(pKind, { A: pA, B: pB, amp: pAmp, periodS: pPeriod });
  const posErr = st.posTgt ? st.pos - st.posTgt : 0;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid cols-3" style={{ gap: 14 }}>
        <Stat3 label="测试状态" value={PHASE_TEXT[st.phase]} tone={busy ? "var(--accent)" : undefined} extra={st.note} />
        <Stat3
          label="位置"
          value={st.pos.toLocaleString("en-US")}
          unit="cnt"
          extra={`${degOf(st.pos).toFixed(1)}° · ${(st.pos / POS_PER_REV).toFixed(2)} 圈`}
        />
        <Stat3 label="速度 / 电流" value={`${fmt(st.rpm, 0)} RPM`} extra={`Iq ${fmt(st.iqMa, 0)} mA · 模式 ${st.mode}`} />
      </div>

      <Notice tone="warn">
        先完成<b>机械找零</b>再测：本页位置坐标与「机械行程」页共用同一个零点，未找零时所有位置类结论都不可信。
        本页所有闭环与限幅都在主控 / TMC6460 里执行，上位机只给给定、盯行程、打分、画波形。
      </Notice>

      <div className="grid cols-2" style={{ gap: 14 }}>
        <Card
          title="① 恒 Iq / 恒速度"
          right={<Badge tone="neutral">{bKind === "iq" ? "MOTION_MODE=TORQUE" : "MOTION_MODE=VELOCITY"}</Badge>}
        >
          <div className="stack" style={{ gap: 12 }}>
            <Segmented
              value={bKind}
              onChange={(v) => setBKind(v)}
              options={[
                { value: "iq", label: "恒 Iq（力矩直通）" },
                { value: "speed", label: "恒速度" },
              ]}
            />
            <div className="grid cols-3" style={{ gap: 10 }}>
              {bKind === "iq" ? (
                <Field label="Iq 给定" hint={`${Math.round(bIq / app.cal.maPerCount)} counts`}>
                  <NumField value={bIq} onChange={setBIq} min={1} max={1500} step={10} unit="mA" />
                </Field>
              ) : (
                <Field label="速度给定" hint={`${Math.round(bRpm * app.cal.countsPerRpm)} su`}>
                  <NumField value={bRpm} onChange={setBRpm} min={1} max={3000} step={25} unit="RPM" />
                </Field>
              )}
              <Field label="电流上限" hint="0x14A[30:16]">
                <NumField value={bLimit} onChange={setBLimit} min={50} max={1600} step={10} unit="mA" />
              </Field>
              <Field label="边界策略" hint="到边界后">
                <SelectField
                  value={bAction}
                  onChange={(v) => setBAction(v as BoundaryAction)}
                  options={[
                    { value: "stop", label: "停止（断使能）" },
                    { value: "reverse", label: "自动换向" },
                  ]}
                />
              </Field>
            </div>

            <div className="grid cols-3" style={{ gap: 10 }}>
              <Field label="整程圈数" hint="8 等分的基准">
                <NumField value={turns} onChange={setTurns} min={1} max={200} step={1} unit="圈" />
              </Field>
              <Field label="测试行程起段">
                <SelectField value={bSegA} onChange={setBSegA} options={segOptions} />
              </Field>
              <Field label="测试行程止段">
                <SelectField value={bSegB} onChange={setBSegB} options={segOptions} />
              </Field>
            </div>
            <div className="tiny" style={{ color: travelValid(bTravel) ? "var(--ok)" : "var(--danger)" }}>
              {travelValid(bTravel) ? travelLabel(bTravel) : "区间无效：止段必须大于起段，否则拒绝启动"}
            </div>

            <div className="row-wrap" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Bolt width={14} height={14} />}
                disabled={!canRun || busy || !travelValid(bTravel)}
                onClick={() => void startBounded()}
              >
                {bKind === "iq" ? "启动恒 Iq" : "启动恒速度"}
              </Button>
              <Button variant="ghost" disabled={!busy} onClick={() => void stopAll()}>
                停止测试
              </Button>
              {!app.connected && <span className="tiny muted">串口未连接</span>}
              {app.connected && !app.armed && <span className="tiny muted">需解锁 ARM</span>}
            </div>
            <div className="tiny muted">
              恒 Iq 不设堵转保护：机构卡死时位置不动、边界永不触发，测试时人必须在场。
              在 TMC6460 上「电流上限」对力矩模式同样生效（它钳的是力矩控制器的目标值）。
            </div>
          </div>
        </Card>

        <Card
          title="② 速度 PI 自动辨识"
          right={<Badge tone="neutral">0x145</Badge>}
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label="测试速度" hint="符号按行程自动换">
                <NumField value={tRpm} onChange={setTRpm} min={20} max={3000} step={25} unit="RPM" />
              </Field>
              <Field label="电流上限" hint="顶限判废的门槛">
                <NumField value={tLimit} onChange={setTLimit} min={50} max={1600} step={10} unit="mA" />
              </Field>
              <Field label="基准 Kp">
                <NumField value={tKp0} onChange={setTKp0} min={0} max={32767} step={10} />
              </Field>
              <Field label="基准 Ki">
                <NumField value={tKi0} onChange={setTKi0} min={0} max={32767} step={10} />
              </Field>
              <Field label="倍率" hint="逗号分隔">
                <input
                  className="mono"
                  value={tMults}
                  onChange={(e) => setTMults(e.target.value)}
                  style={{ width: "100%" }}
                />
              </Field>
              <Field label="每组时间" hint="稳定时间取 30%">
                <NumField value={tDwell} onChange={setTDwell} min={0.5} max={8} step={0.1} unit="s" />
              </Field>
            </div>
            <Check checked={tApply} onChange={setTApply}>
              完成后应用最佳（不勾则恢复原 Kp/Ki）
            </Check>
            <div className="row-wrap" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Tuning width={14} height={14} />}
                disabled={!canRun || busy}
                onClick={() => void runTune()}
              >
                开始辨识
              </Button>
              <span className="tiny muted">每组重复 3 次、正反各一遍，饱和样本整组判废</span>
            </div>

            {rows.length > 0 ? (
              <div className="scroll-y" style={{ maxHeight: 220 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Kp</th>
                      <th>Ki</th>
                      <th>errRMS</th>
                      <th>|errMean|</th>
                      <th>Iqσ</th>
                      <th>J</th>
                      <th>顶限</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.kp}-${r.ki}`}>
                        <td className="mono">{r.kp}</td>
                        <td className="mono">{r.ki}</td>
                        <td className="mono">{Number.isFinite(r.s.errRms) ? fmt(r.s.errRms, 1) : "—"}</td>
                        <td className="mono">{Number.isFinite(r.s.errMean) ? fmt(Math.abs(r.s.errMean), 1) : "—"}</td>
                        <td className="mono">{fmt(r.s.iqStd, 1)}</td>
                        <td className="mono" style={{ color: r.sat ? "var(--warn)" : undefined }}>
                          {r.sat || !Number.isFinite(r.s.score) ? r.note || "判废" : fmt(r.s.score, 1)}
                        </td>
                        <td>{r.sat ? "是" : "否"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">还没有候选结果</div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid cols-2" style={{ gap: 14 }}>
        <Card title="③ 位置环测试" right={<Badge tone="neutral">MOTION_MODE=POSITION</Badge>}>
          <div className="stack" style={{ gap: 12 }}>
            <Segmented
              value={pKind}
              onChange={(v) => setPKind(v)}
              options={[
                { value: "hold", label: "保持 A" },
                { value: "recip", label: "A/B 往复" },
                { value: "sine", label: "正弦" },
              ]}
            />
            <div className="grid cols-3" style={{ gap: 10 }}>
              <Field label="位置行程起段">
                <SelectField value={pSegA} onChange={setPSegA} options={segOptions} />
              </Field>
              <Field label="位置行程止段">
                <SelectField value={pSegB} onChange={setPSegB} options={segOptions} />
              </Field>
              <Field label="周期" hint={pKind === "hold" ? "本类型不用" : "一个来回"}>
                <NumField value={pPeriod} onChange={setPPeriod} min={0.2} max={30} step={0.1} unit="s" disabled={pKind === "hold"} />
              </Field>
              <Field label="A 点">
                <NumField value={pA} onChange={setPA} min={pTravel.lo} max={pTravel.hi} step={1000} />
              </Field>
              <Field label="B 点" hint={pKind === "sine" ? "正弦不用" : undefined}>
                <NumField value={pB} onChange={setPB} min={pTravel.lo} max={pTravel.hi} step={1000} />
              </Field>
              <Field label="循环数" hint="0 = 无限，仅往复">
                <NumField value={pCycles} onChange={setPCycles} min={0} max={9999} step={1} unit="次" disabled={pKind !== "recip"} />
              </Field>
              <Field label="中心" hint="正弦中心 / 到中心">
                <NumField value={pCenter} onChange={setPCenter} min={pTravel.lo} max={pTravel.hi} step={1000} />
              </Field>
              <Field label="幅值" hint={`上限 ${Math.round((pTravel.hi - pTravel.lo) / 2)}`}>
                <NumField
                  value={pAmp}
                  onChange={setPAmp}
                  min={0}
                  max={Math.max(1, Math.round((pTravel.hi - pTravel.lo) / 2))}
                  step={500}
                  disabled={pKind !== "sine"}
                />
              </Field>
              <Field label="速度限制" hint="写 0x14B">
                <NumField value={pMaxRpm} onChange={setPMaxRpm} min={50} max={4000} step={50} unit="RPM" />
              </Field>
              <Field label="电流限制" hint="写 0x14A">
                <NumField value={pLimit} onChange={setPLimit} min={50} max={1600} step={10} unit="mA" />
              </Field>
            </div>
            <div className="tiny muted">{travelValid(pTravel) ? travelLabel(pTravel) : "区间无效：止段必须大于起段"}</div>
            {need > pMaxRpm && (
              <Notice tone="warn">
                需求速度约 {fmt(need, 0)} RPM，超过速度限制 {pMaxRpm} RPM：波形会被削顶成梯形，请加大周期或减小幅值。
              </Notice>
            )}
            <div className="row-wrap" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Target width={14} height={14} />}
                disabled={!canRun || busy || !travelValid(pTravel)}
                onClick={() => void startPos()}
              >
                启动位置测试
              </Button>
              <Button variant="ghost" disabled={st.phase !== "pos"} onClick={() => engine.stopPosOnly()}>
                停止位置测试
              </Button>
              <Button
                variant="ghost"
                disabled={!canRun || busy}
                onClick={async () => {
                  try {
                    await engine.moveToCenter({ center: pCenter, iqLimitMa: pLimit, maxRpm: pMaxRpm });
                    app.toast("ok", "已下发中心目标");
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                到中心
              </Button>
              <Button variant="ghost" disabled={!busy} onClick={() => void stopAll()}>
                停止测试
              </Button>
            </div>
            <div className="tiny muted">
              「停止位置测试」只停下发，电机仍保持力矩；「停止测试」才清目标并断使能。
              窄行程上先用「到中心」把机构摆到中间再启动最稳。
            </div>
          </div>
        </Card>

        <Card title="实时值" right={<Badge tone="neutral">60 ms</Badge>}>
          <div className="stack" style={{ gap: 12 }}>
            <KV
              cols={2}
              rows={[
                ["模式", <span key="m" className="mono">{st.mode}</span>],
                ["位置", <span key="p" className="mono">{st.pos.toLocaleString("en-US")} cnt</span>],
                ["位置给定", <span key="pt" className="mono">{st.posTgt ? st.posTgt.toLocaleString("en-US") : "—"}</span>],
                ["位置误差", <span key="pe" className="mono">{st.posTgt ? posErr.toLocaleString("en-US") : "—"}</span>],
                ["速度反馈", <span key="v" className="mono">{fmt(st.rpm, 1)} RPM</span>],
                ["速度 su", <span key="vs" className="mono">{Math.round(st.rpm * app.cal.countsPerRpm)}</span>],
                ["速度给定", <span key="vt" className="mono">{fmt(st.rpmTgt ?? 0, 1)} RPM</span>],
                ["Iq 实测", <span key="iq" className="mono">{fmt(st.iqMa, 1)} mA</span>],
                ["Iq counts", <span key="iqc" className="mono">{Math.round(st.iqMa / app.cal.maPerCount)}</span>],
                ["往复次数", <span key="c" className="mono">{st.cycles}</span>],
                ["测试行程", <span key="tv" className="mono">{travelValid(bTravel) ? travelLabel(bTravel) : "—"}</span>],
                ["采样点", <span key="n" className="mono">{samples.length}</span>],
              ]}
            />
            <div className="tiny muted">
              速度环 PI 输出在 TMC6460 上没有独立寄存器，用「Iq 实测」代替（同刻度）；位置环误差由
              0x152 与 0x155 相减得到，全部在上位机算，不额外读状态位。
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="波形"
        right={
          <div className="row" style={{ gap: 6 }}>
            <Segmented
              value={chan}
              onChange={(v) => setChan(v)}
              options={[
                { value: "pos", label: "位置" },
                { value: "rpm", label: "速度" },
                { value: "iq", label: "电流" },
              ]}
            />
            <Button size="sm" variant="ghost" disabled={!samples.length} onClick={() => setSamples([])}>
              清空波形
            </Button>
          </div>
        }
      >
        <LoopChart samples={samples} kind={chan} />
        <div className="tiny muted" style={{ marginTop: 8 }}>
          采样跟着 60 ms 的行程巡检走，历史 900 点 ≈ 54 s。看不到 25 kHz 电流环尺度 —— 那是 RTMI
          抓 0x153/0x168 的活，不是这一页。
        </div>
      </Card>

      <div className="grid flow-2-1">
        <Card title="测试流程" right={<Badge tone="neutral">上位机执行</Badge>}>
          <Steps steps={app.stepsByKind["looptest"] ?? []} emptyText="尚未执行" />
        </Card>

        <div className="col-stack">
          <Card title="TMC6460 侧要改的地方">
            <div className="stack" style={{ gap: 10 }}>
              <div className="tiny">
                本页只写标准寄存器，没有一条新协议。但 com_moto 老上位机那套映射搬到 TMC6460
                上，有六处必须改：
              </div>
              <KV
                rows={[
                  ["电流刻度", <span key="1" className="mono">s16A / 归一值两套 → 统一 mA（0.20131 mA/LSB）</span>],
                  ["恒 Iq 限流", <span key="2" className="mono">0x14A[30:16] 钳的是力矩目标，力矩模式也生效</span>],
                  ["速度环系数", <span key="3" className="mono">0x145[31:16]=P / [15:0]=I，受 0x140 归一化影响</span>],
                  ["PI 输出", <span key="4" className="mono">无独立寄存器，用 0x153[31:16] 代替</span>],
                  ["位置计数器", <span key="5" className="mono">0x152/0x155 是 32 位多圈，不是 16 位</span>],
                  ["行程护栏", <span key="6" className="mono">0x14C/0x14D 可做硬件兜底，老固件只有上位机看门</span>],
                ]}
              />
              <Notice tone="ok">
                固件侧还需要：模式仲裁（谁能切 MOTION_MODE）、急停后清积分器、以及把 0x14C/0x14D
                的默认值改成上电重算 —— 详见 doc/TODO/TODO-02-环路测试.md。
              </Notice>
              <div className="tiny muted">
                TMC6460 还自带 PRBS 注入（MOTION_MODE = 5…9）与速度前馈（0x100[19] VELOCITY_FF_EN），
                这两个能力老固件没有：扫频/前馈辨识可以直接交给芯片，不必上位机逐点下发。
              </div>
            </div>
          </Card>

          <Card title="安全门控">
            <div className="stack" style={{ gap: 10 }}>
              <Check checked={safety} onChange={setSafety}>
                我已确认行程内无人员无异物，急停可达（本页会驱动电机）
              </Check>
              {!safety && <div className="tiny muted">未勾选安全确认时所有启动按钮禁用。</div>}
              {busy && (
                <Button variant="danger" icon={<Icon.Stop width={13} height={13} />} onClick={() => void stopAll()}>
                  立即停止（清目标 + 断使能）
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** 顶部三张状态卡：Stat 只接受单值，这里补一行小字说明。 */
function Stat3({
  label,
  value,
  unit,
  extra,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  extra?: string;
  tone?: string;
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {extra && <div className="stat-delta">{extra}</div>}
    </div>
  );
}
