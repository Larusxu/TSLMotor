import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { api, on } from "./api";
import { convertSignal, SIGNALS, TESLA_PROFILE, type Signal } from "./presets";
import { ScopeStore } from "./scope";
import { applyTheme, loadSettings, saveSettings, type Settings } from "./settings";
import { pwmHz } from "./units";
import type { AxisState, JobDone, JobProgress, LinkStats, LogLine, PortInfo } from "./types";
import type { StepState, ToastItem } from "../components/ui";

/** 任务中文名，用于运行日志的开头/结尾行。 */
const JOB_LABEL: Record<string, string> = {
  encoder: "编码器写入",
  calibrate: "电角度对齐",
  pid: "PID 与限幅写入",
  step: "阶跃测试",
  sequence: "自动测试序列",
  looptest: "环路测试",
};

/** 从任务结果里摘一句能直接读的"结果"，没有就返回空串。 */
function jobResultText(done: JobDone): string {
  const d = done.data as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return "";
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  if ("offset_hex" in d) {
    const r2 = num(d.r2);
    const slope = num(d.slope);
    return `PHI_E_OFFSET ${String(d.offset_hex)}${r2 !== undefined ? ` · R²=${r2.toFixed(5)}` : ""}${
      slope !== undefined ? ` · 斜率 ${slope.toFixed(4)} LSB/°` : ""
    }`;
  }
  if ("metrics" in d) {
    const m = d.metrics as Record<string, unknown> | undefined;
    const rise = m ? num(m.rise_ms) : undefined;
    const over = m ? num(m.overshoot_pct) : undefined;
    if (rise !== undefined) {
      return `上升 ${rise.toFixed(1)} ms${over !== undefined ? ` · 超调 ${over.toFixed(1)} %` : ""}`;
    }
  }
  if ("summary" in d && Array.isArray(d.summary)) {
    const rows = d.summary as { verdict?: string }[];
    const pass = rows.filter((r) => r.verdict === "pass").length;
    return `${pass}/${rows.length} 档通过`;
  }
  if ("csv_path" in d) return `报告 ${String(d.csv_path)}`;
  if ("message" in d) return String(d.message);
  return "";
}

export interface Cal {
  poles: number;
  cpr: number;
  pwmMaxCount: number;
  maPerCount: number;
  countsPerRpm: number;
  csaGain: number;
  polarity: number;
  tempOffset: number;
}

const DEFAULT_CAL: Cal = {
  poles: TESLA_PROFILE.poles,
  cpr: TESLA_PROFILE.cpr,
  pwmMaxCount: TESLA_PROFILE.pwmMaxCount,
  maPerCount: TESLA_PROFILE.maPerCount,
  countsPerRpm: TESLA_PROFILE.countsPerRpm,
  csaGain: TESLA_PROFILE.csaGain,
  polarity: 1,
  tempOffset: 0,
};

interface AppCtx {
  fwVersion: string;
  handId: number | null;
  updateHandId: (id: number) => Promise<void>;
  mode: string; setMode: (v:string)=>void; motor:number; setMotor:(v:number)=>void;
  /** CHIP.ID probe state of the selected motor, shown by the top-bar enable pill. */
  motorTmc: "unknown" | "online" | "offline";
  enableMotor: () => Promise<void>;
  ports: PortInfo[];
  port: string;
  baud: number;
  connected: boolean;
  busy: boolean;
  stats: LinkStats | null;
  setPort: (p: string) => void;
  setBaud: (b: number) => void;
  refreshPorts: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  armed: boolean;
  setArmed: (v: boolean) => void;

  cal: Cal;
  setCal: (patch: Partial<Cal>) => void;

  scope: ScopeStore;
  channels: (string | null)[];
  setChannel: (ch: number, signalId: string | null) => void;
  streaming: boolean;
  sampling: number;
  sampleHz: number;
  setSampleHz: (hz: number) => void;
  windowMs: number;
  setWindowMs: (ms: number) => void;
  startStream: (override?: { ch: number; id: string }) => Promise<void>;  stopStream: () => Promise<void>;

  steps: StepState[];
  /** 按任务类型分开存，便于同屏并排显示「编码器写入」与「电角度对齐」两段流程 */
  stepsByKind: Record<string, StepState[]>;
  /** 上位机自己产生的日志行（不经过后端，例如环路测试的行程裁决） */
  hostLog: (level: LogLine["level"], source: string, message: string) => void;
  /** 上位机自己推进的步骤：环路测试没有后端任务，流程由页面驱动 */
  hostStep: (
    kind: string,
    step: { idx: number; total: number; label: string; status: StepState["status"]; detail?: string }
  ) => void;
  /** 流程开头：清空该 kind 的步骤序列，并写「▶ 开始」到运行日志 */
  hostJobStart: (kind: string) => void;
  /** 流程结尾：把「■ 结束」与结果摘要写进运行日志 */
  hostJobEnd: (kind: string, ok: boolean, result?: string) => void;
  jobRunning: boolean;
  lastDone: JobDone | null;
  runJob: (kind: string, payload: unknown) => Promise<void>;
  cancel: () => void;

  logs: LogLine[];
  clearLogs: () => Promise<void>;
  toasts: ToastItem[];
  toast: (tone: ToastItem["tone"], text: string) => void;
  dismissToast: (id: number) => void;
  reportsPath: string;

  axis: AxisState | null;
  setAxis: (st: AxisState) => void;
  refreshAxis: () => Promise<void>;

  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [fwVersion, setFwVersion] = useState("");
  const [handId, setHandId] = useState<number | null>(null);
  const [mode, setMode] = useState("direct");
  const [motor, setMotorState] = useState(1);
  const [motorTmc, setMotorTmc] = useState<"unknown" | "online" | "offline">("unknown");
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState("COM6");
  const [baud, setBaud] = useState(115200);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<LinkStats | null>(null);
  const [armed, setArmed] = useState(false);
  const [cal, setCalState] = useState<Cal>(DEFAULT_CAL);
  const [channels, setChannels] = useState<(string | null)[]>([
    "vel_act",
    "vel_tgt",
    "torque",
    null,
    null,
    null,
    null,
  ]);
  const [streaming, setStreaming] = useState(false);
  const [sampleHz, setSampleHz] = useState(1000);
  const [windowMs, setWindowMs] = useState(5000);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [stepsByKind, setStepsByKind] = useState<Record<string, StepState[]>>({});
  const [jobRunning, setJobRunning] = useState(false);
  const [lastDone, setLastDone] = useState<JobDone | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  /** 追加一条日志（与 tsl:log 共用同一份，超过上限自动裁掉最旧的） */
  const appendLog = useCallback((line: LogLine) => {
    setLogs((prev) => {
      const next = [...prev, line];
      return next.length > 2500 ? next.slice(next.length - 2000) : next;
    });
  }, []);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [reportsPath, setReportsPath] = useState("");
  const [axis, setAxis] = useState<AxisState | null>(null);
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const scope = useMemo(() => new ScopeStore(), []);
  const calRef = useRef(cal);
  calRef.current = cal;
  /** 当前任务的启动时刻，用于结尾行计算耗时 */
  const jobStartedAt = useRef(0);
  const chRef = useRef(channels);
  chRef.current = channels;

  const toast = useCallback((tone: ToastItem["tone"], text: string) => {
    setToasts((prev) => [...prev.slice(-3), { id: Date.now() + Math.random(), tone, text }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setChannel = useCallback((ch: number, signalId: string | null) => {
    setChannels((prev) => {
      const next = [...prev];
      if (signalId) {
        for (let i = 0; i < next.length; i++) if (next[i] === signalId) next[i] = null;
      }
      next[ch] = signalId;
      return next;
    });
  }, []);

  const setCal = useCallback((patch: Partial<Cal>) => {
    setCalState((prev) => ({ ...prev, ...patch }));
  }, []);

  const refreshPorts = useCallback(async () => {
    try {
      const list = await api.listPorts();
      setPorts(list);
      if (list.length && !list.some((p) => p.name === port)) setPort(list[0].name);
    } catch (e) {
      toast("error", `枚举串口失败：${String(e)}`);
    }
  }, [port, toast]);

  const connect = useCallback(async () => {
    setBusy(true);
    setFwVersion("");setHandId(null);
    try {
      const st = await api.connect(port, mode==="main485" ? 460800 : mode==="maincan" ? 2000000 : baud, mode, motor);
      setStats(st);
      setConnected(st.connected);
      setMotorTmc("unknown");
      if(st.connected && mode!=="direct") {
        try {
          const version=await api.mainControl(0,10,[8,8]);
          setFwVersion(String.fromCharCode(...version).replace(/\0/g,"").trim());
          const id=await api.mainControl(0,10,[73,1]);
          if(id.length!==2 || !(id[0]*256+id[1]))throw new Error("固件未提供有效 HandID");
          setHandId(id[0]*256+id[1]);
        } catch(e) {toast("warn",`主控身份读取失败：${String(e)}`);}
      }
      toast("ok", `已连接 ${port} @ ${st.baud}`);
    } catch (e) {
      toast("error", `连接失败：${String(e)}`);
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }, [port, baud, mode, motor, toast]);

  const updateHandId = useCallback(async (id:number) => {
    if(!connected || mode==="direct" || !Number.isInteger(id) || id<1 || id>65535)
      throw new Error("HandID 必须是 1～65535 的整数，且需连接主控");
    await api.mainControl(0,11,[id>>8,id&255]);
    const data=await api.mainControl(0,10,[73,1]);
    if(data.length!==2 || data[0]*256+data[1]!==id)throw new Error("HandID 读回不一致");
    setHandId(id);
  },[connected,mode]);

  const stopStream = useCallback(async () => {
    try {
      await api.stopRtmi();
    } catch {
      /* ignore */
    }
    setStreaming(false);
  }, []);

  const disconnect = useCallback(async () => {
    await stopStream();
    try {
      const st = await api.disconnect();
      setStats(st);
    } catch {
      /* ignore */
    }
    setConnected(false);
    setArmed(false);
    setFwVersion("");setHandId(null);
    setMotorTmc("unknown");
    toast("warn", "已断开连接");
  }, [stopStream, toast]);

  /** Gateway keeps one downstream UART focused, so switching motor is a link
   *  operation, not just local state. Capture stops and the probe resets. */
  const setMotor = useCallback((v: number) => {
    if (v === motor) return;
    if (!connected || mode === "direct") {
      setMotorState(v);
      setMotorTmc("unknown");
      return;
    }
    void (async () => {
      try {
        await stopStream();
        await api.focusMotor(v);
        setMotorState(v);
        setMotorTmc("unknown");
        await api.axisState().then(setAxis).catch(() => undefined);
        toast("warn", `已切到 M${v}：采集已停止，软限位与标定需重新确认`);
      } catch (e) {
        toast("error", `切换电机失败：${String(e)}`);
      }
    })();
  }, [motor, connected, mode, stopStream, toast]);

  /** Power the selected motor's logic 5V, then poll CHIP.ID until it answers. */
  const enableMotor = useCallback(async () => {
    if (!connected || busy) return;
    if (!armed) {
      toast("warn", "请先解锁 ARM 再上电");
      return;
    }
    setBusy(true);
    setMotorTmc("unknown");
    try {
      if (mode !== "direct") await api.mainControl(motor, 5, [1]);
      const [hit] = await api.probeTmc([motor], 6);
      if (hit?.online) {
        setMotorTmc("online");
        const id = ((hit.chip_id ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, "0");
        toast("ok", `M${motor} 已使能 · CHIP.ID 0x${id}`);
      } else {
        setMotorTmc("offline");
        toast("error", `M${motor} 上电后读不到 CHIP.ID（轮询 ${hit?.tries ?? 6} 次）`);
      }
    } catch (e) {
      setMotorTmc("offline");
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  }, [connected, busy, armed, mode, motor, toast]);

  const sampling = useMemo(() => {
    const f = pwmHz(cal.pwmMaxCount);
    return Math.max(0, Math.min(255, Math.round(f / Math.max(50, sampleHz)) - 1));
  }, [cal.pwmMaxCount, sampleHz]);

  const startStream = useCallback(async (override?: { ch: number; id: string }) => {
    const map = override
      ? channels.map((c, i) => (i === override.ch ? override.id : c))
      : channels;
    const assigned: [number, number][] = [];
    const sigByCh = new Map<number, Signal>();
    map.forEach((id, ch) => {
      if (!id) return;
      const sig = SIGNALS.find((s) => s.id === id);
      if (!sig) return;
      assigned.push([ch, sig.addr]);
      sigByCh.set(ch, sig);
    });
    if (!assigned.length) {
      toast("warn", "请先选择至少一个信号");
      return;
    }
    try {
      await stopStream();
      // Rebuild buffers so stale traces never mix with a new configuration.
      scope.clear();
      sigByCh.forEach((sig, ch) => scope.ensure(ch, sig, sig.color));
      await api.startRtmi(assigned, sampling, false);
      setStreaming(true);
      toast("ok", `RTMI 已启动 · ${assigned.length} 通道 @ ${sampleHz} Hz`);
    } catch (e) {
      toast("error", `启动数据流失败：${String(e)}`);
    }
  }, [channels, sampling, sampleHz, scope, stopStream, toast]);

  const runJob = useCallback(
    async (kind: string, payload: unknown) => {
      if (!armed) {
        toast("warn", "请先解锁 ARM 再执行任务");
        return;
      }
      const label = JOB_LABEL[kind] ?? kind;
      jobStartedAt.current = Date.now();
      setSteps([]);
      setStepsByKind((prev) => ({ ...prev, [kind]: [] }));
      setLastDone(null);
      setJobRunning(true);
      appendLog({ ts: Date.now(), level: "info", source: `job/${kind}`, message: `▶ 开始 ${label}` });
      try {
        await api.runJob(kind, payload);
      } catch (e) {
        setJobRunning(false);
        appendLog({ ts: Date.now(), level: "error", source: `job/${kind}`, message: `■ 未能启动：${String(e)}` });
        toast("error", String(e));
      }
    },
    [armed, toast, appendLog]
  );

  const cancel = useCallback(() => {
    appendLog({
      ts: Date.now(),
      level: "warn",
      source: "job",
      message: "已请求取消当前任务",
    });
    void api.cancelJob();
  }, [appendLog]);

  const hostLog = useCallback(
    (level: LogLine["level"], source: string, message: string) => {
      appendLog({ ts: Date.now(), level, source, message });
    },
    [appendLog]
  );

  const hostStep = useCallback(
    (
      kind: string,
      step: { idx: number; total: number; label: string; status: StepState["status"]; detail?: string }
    ) => {
      const entry: StepState = {
        idx: step.idx,
        total: step.total,
        label: step.label,
        status: step.status,
        detail: step.detail ?? "",
      };
      setStepsByKind((prev) => {
        const list = [...(prev[kind] ?? [])];
        const at = list.findIndex((s) => s.idx === step.idx && s.status === "run");
        if (at >= 0) list[at] = entry;
        else list.push(entry);
        return { ...prev, [kind]: list.slice(-400) };
      });
      // 过程行落日志，方便事后按时间顺序复盘（与后端任务的写法保持一致）
      if (step.status !== "run") {
        const level: LogLine["level"] =
          step.status === "fail" ? "error" : step.status === "ok" ? "ok" : "info";
        appendLog({
          ts: Date.now(),
          level,
          source: `job/${kind}`,
          message: `${String(step.idx).padStart(2, "0")}${
            step.total > 0 ? `/${step.total}` : ""
          } ${step.label}${step.detail ? ` · ${step.detail}` : ""}`,
        });
      }
    },
    [appendLog]
  );

  const hostJobStart = useCallback(
    (kind: string) => {
      setStepsByKind((prev) => ({ ...prev, [kind]: [] }));
      appendLog({
        ts: Date.now(),
        level: "info",
        source: `job/${kind}`,
        message: `▶ 开始 ${JOB_LABEL[kind] ?? kind}`,
      });
    },
    [appendLog]
  );

  const hostJobEnd = useCallback(
    (kind: string, ok: boolean, result?: string) => {
      const label = JOB_LABEL[kind] ?? kind;
      if (result) {
        appendLog({
          ts: Date.now(),
          level: ok ? "ok" : "error",
          source: `job/${kind}`,
          message: `◆ 结果 ${result}`,
        });
      }
      appendLog({
        ts: Date.now(),
        level: ok ? "ok" : "error",
        source: `job/${kind}`,
        message: `■ 结束 ${label}·${ok ? "成功" : "失败"}`,
      });
    },
    [appendLog]
  );

  const clearLogs = useCallback(async () => {
    await api.clearLogs();
    setLogs([]);
  }, []);

  const refreshAxis = useCallback(async () => {
    try {
      setAxis(await api.axisState());
    } catch {
      /* link down */
    }
  }, []);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      applyTheme(next.theme);
      return next;
    });
  }, []);

  // make sure the theme from storage is applied even before the first paint of
  // a preference-dependent component
  useEffect(() => {
    applyTheme(settings.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------- effects
  // Materialise channel metadata up front so legends read correctly before the
  // first frame arrives.
  useEffect(() => {
    channels.forEach((id, ch) => {
      if (!id) return;
      const sig = SIGNALS.find((s) => s.id === id);
      if (sig) scope.ensure(ch, sig, sig.color);
    });
  }, [channels, scope]);

  useEffect(() => {
    void refreshPorts();
    void api.reportsPath().then(setReportsPath).catch(() => undefined);
    void api.logs().then(setLogs).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const offs: (() => void)[] = [];
    let disposed = false;
    void (async () => {
      const a = await on("tsl:rtmi", (batch) => {
        if (!batch.pts.length) return;
        scope.push(batch, (ch, raw) => {
          const id = chRef.current[ch];
          const sig = id ? SIGNALS.find((s) => s.id === id) : undefined;
          if (!sig) return raw;
          return convertSignal(sig, raw, {
            maPerCount: calRef.current.maPerCount,
            countsPerRpm: calRef.current.countsPerRpm,
            poles: calRef.current.poles,
            polarity: calRef.current.polarity,
            tempOffset: calRef.current.tempOffset,
          });
        });
      });
      const b = await on("tsl:log", (line) => {
        appendLog(line);
      });
      const c = await on("tsl:job:progress", (p: JobProgress) => {
        const kind = p.job.split(":")[0] || "job";
        const entry: StepState = {
          idx: p.idx,
          total: p.total,
          label: p.label,
          status: p.status,
          detail: p.detail,
        };
        setSteps((prev) => {
          const next = [...prev];
          const at = next.findIndex((s) => s.idx === p.idx && s.status === "run");
          if (at >= 0) next[at] = entry;
          else next.push(entry);
          return next.slice(-400);
        });
        setStepsByKind((prev) => {
          const list = [...(prev[kind] ?? [])];
          const at = list.findIndex((s) => s.idx === p.idx && s.status === "run");
          if (at >= 0) list[at] = entry;
          else list.push(entry);
          return { ...prev, [kind]: list.slice(-400) };
        });
        // 每一步的细节也落到运行日志，便于事后分析（只记结果行，避免「开始+完成」两条重复）
        if (p.status !== "run") {
          const level: LogLine["level"] =
            p.status === "fail" ? "error" : p.status === "ok" ? "ok" : "info";
          appendLog({
            ts: Date.now(),
            level,
            source: `job/${kind}`,
            message: `${String(p.idx).padStart(2, "0")}/${p.total} ${p.label}${p.detail ? ` · ${p.detail}` : ""}`,
          });
        }
      });
      const d = await on("tsl:job:done", (done: JobDone) => {
        setJobRunning(false);
        setLastDone(done);
        const kind = done.job.split(":")[0] || "job";
        const label = JOB_LABEL[kind] ?? kind;
        const secs = jobStartedAt.current ? (Date.now() - jobStartedAt.current) / 1000 : 0;
        // 结果行：把各任务的关键产出摘出来，方便在日志页直接分析
        const result = jobResultText(done);
        if (result) {
          appendLog({ ts: Date.now(), level: done.ok ? "ok" : "error", source: `job/${kind}`, message: `◆ 结果 ${result}` });
        }
        appendLog({
          ts: Date.now(),
          level: done.ok ? "ok" : "error",
          source: `job/${kind}`,
          message: `■ 结束 ${label}·${done.ok ? "成功" : "失败"}（${secs.toFixed(1)} s）${
            done.message ? ` · ${done.message}` : ""
          }`,
        });
        toast(done.ok ? "ok" : "error", done.ok ? "任务完成" : `任务失败：${done.message}`);
      });
      const e = await on("tsl:limit", (ev) => {
        toast("error", `软限位触发：位置 ${ev.pos}（限 ${ev.min}…${ev.max}）`);
        void api.axisState().then(setAxis).catch(() => undefined);
      });
      if (disposed) {
        a();
        b();
        c();
        d();
        e();
      } else offs.push(a, b, c, d, e);
    })();
    return () => {
      disposed = true;
      offs.forEach((f) => f());
    };
  }, [scope, toast]);

  useEffect(() => {
    if (!connected) return;
    let pending = false;
    const t = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void api
        .stats()
        .then((s) => {
          setStats(s);
          setConnected(s.connected);
        })
        .catch(() => undefined)
        .finally(() => { pending = false; });
    }, 1000);
    return () => window.clearInterval(t);
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    void refreshAxis();
    const t = window.setInterval(() => void refreshAxis(), 300);
    return () => window.clearInterval(t);
  }, [connected, refreshAxis]);

  const value: AppCtx = {
    fwVersion, handId, updateHandId,
    mode, setMode, motor, setMotor,
    motorTmc, enableMotor,
    ports,
    port,
    baud,
    connected,
    busy,
    stats,
    setPort,
    setBaud,
    refreshPorts,
    connect,
    disconnect,
    armed,
    setArmed,
    cal,
    setCal,
    scope,
    channels,
    setChannel,
    streaming,
    sampling,
    sampleHz,
    setSampleHz,
    windowMs,
    setWindowMs,
    startStream,
    stopStream,
    steps,
    stepsByKind,
    hostLog,
    hostStep,
    hostJobStart,
    hostJobEnd,
    jobRunning,
    lastDone,
    runJob,
    cancel,
    logs,
    clearLogs,
    toasts,
    toast,
    dismissToast,
    reportsPath,
    axis,
    setAxis,
    refreshAxis,
    settings,
    setSettings,
    settingsOpen,
    setSettingsOpen,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
