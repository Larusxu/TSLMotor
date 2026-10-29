/**
 * Thin typed wrapper over the Rust commands.
 *
 * Outside the Tauri shell (plain `npm run dev` in a browser) a deterministic
 * simulator takes over so the UI can be designed and reviewed without hardware.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AxisLimits,
  AxisState,
  CalibResult,
  JobDone,
  JobProgress,
  LimitEvent,
  LinkStats,
  LogLine,
  MoveCfgPayload,
  PidSnapshot,
  PortInfo,
  RtmiBatch,
  SeqCfgPayload,
  SeqResult,
  SnapItem,
  StepCfgPayload,
  StepResult,
} from "./types";

export const HAS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

type EventMap = {
  "tsl:rtmi": RtmiBatch;
  "tsl:log": LogLine;
  "tsl:job:progress": JobProgress;
  "tsl:job:done": JobDone;
  "tsl:limit": LimitEvent;
};

export async function on<K extends keyof EventMap>(
  event: K,
  cb: (payload: EventMap[K]) => void
): Promise<UnlistenFn> {
  if (!HAS_TAURI) return mockBus.on(event, cb);
  return listen<EventMap[K]>(event, (e) => cb(e.payload));
}

// ---------------------------------------------------------------------------
// real commands
// ---------------------------------------------------------------------------

const real = {
  listPorts: () => invoke<PortInfo[]>("list_ports"),
  connect: (port: string, baud: number) => invoke<LinkStats>("connect", { port, baud }),
  disconnect: () => invoke<LinkStats>("disconnect"),
  stats: () => invoke<LinkStats>("link_stats"),
  readReg: (addr: number) => invoke<number>("read_reg", { addr }),
  writeReg: (addr: number, value: number, verify = true) =>
    invoke<boolean>("write_reg", { addr, value, verify }),
  readMany: (addrs: number[]) => invoke<SnapItem[]>("read_many", { addrs }),
  startRtmi: (channels: [number, number][], sampling: number, crc = false) =>
    invoke<void>("start_rtmi", { channels, sampling, crc }),
  stopRtmi: () => invoke<void>("stop_rtmi"),
  emergencyStop: () => invoke<void>("emergency_stop"),
  setVelocity: (targetRpm: number, poles: number, countsPerRpm: number) =>
    invoke<void>("set_velocity", { targetRpm, poles, countsPerRpm }),
  stopMotion: (poles: number) => invoke<void>("stop_motion", { poles }),
  axisState: () => invoke<AxisState>("axis_state"),
  axisSetLimits: (limits: AxisLimits) => invoke<AxisState>("axis_set_limits", { limits }),
  axisJog: (rpm: number, poles: number, countsPerRpm: number) =>
    invoke<AxisState>("axis_jog", { rpm, poles, countsPerRpm }),
  axisMove: (cfg: MoveCfgPayload) => invoke<AxisState>("axis_move", { cfg }),
  axisHold: (poles: number) => invoke<AxisState>("axis_hold", { poles }),
  axisClear: () => invoke<AxisState>("axis_clear"),
  logs: () => invoke<LogLine[]>("get_logs"),
  clearLogs: () => invoke<void>("clear_logs"),
  reportsPath: () => invoke<string>("reports_path"),
  openReportsDir: () => invoke<void>("open_reports_dir"),
  suggestPi: (rOhm: number, lUh: number, bandwidthHz: number, fPwm: number) =>
    invoke<[number, number, number, number]>("suggest_pi", { rOhm, lUh, bandwidthHz, fPwm }),
  readPid: () => invoke<PidSnapshot>("read_pid"),
  jobBusy: () => invoke<boolean>("job_busy"),
  cancelJob: () => invoke<void>("cancel_job"),
  runJob: (kind: string, payload: unknown) => invoke<void>("run_job", { kind, payload }),
};

// ---------------------------------------------------------------------------
// simulator
// ---------------------------------------------------------------------------

class MockBus {
  private handlers = new Map<string, Set<(p: unknown) => void>>();

  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): UnlistenFn {
    const set = this.handlers.get(event) ?? new Set();
    set.add(cb as (p: unknown) => void);
    this.handlers.set(event, set);
    return () => set.delete(cb as (p: unknown) => void);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
    this.handlers.get(event)?.forEach((cb) => cb(payload));
  }
}

const mockBus = new MockBus();
export { mockBus };

const mock = (() => {
  let connected = false;
  let port = "DEMO";
  let baud = 115200;
  let rtmiTimer: number | null = null;
  let statsTimer: number | null = null;
  let t0 = performance.now();
  let frames = 0;
  let running = false;
  const regCache = new Map<number, number>();

  // ---- travel guard simulation -------------------------------------------
  let axisLimits: AxisLimits = { enabled: false, ch: 0, min: 0, max: 65535, action: "loose" };
  let axisPos = 32768;
  let axisRpm = 0;
  let axisMoving = false;
  let axisTripped = false;
  let axisDone = false;
  let axisGoal: number | null = null;
  const wrap = (v: number) => ((v % 65536) + 65536) % 65536;
  void wrap;
  const axisSnapshot = (): AxisState => ({
    limits: { ...axisLimits },
    pos: axisPos,
    tripped: axisTripped,
    done: axisDone,
    moving: axisMoving,
    cmd_rpm: axisRpm,
  });
  // mirrors the Rust guard: the position counter is unwrapped (no 16-bit wrap),
  // and one tick integrates the commanded speed over 40 ms
  window.setInterval(() => {
    if (!axisMoving || axisRpm === 0) return;
    axisPos = Math.round(axisPos + (axisRpm * 65536) / 60 / 25);
    if (axisGoal !== null && Math.abs(axisGoal - axisPos) < 800) {
      axisPos = axisGoal;
      axisMoving = false;
      axisRpm = 0;
      axisDone = true;
      axisGoal = null;
      log("info", "axis", "定位完成");
      return;
    }
    if (axisLimits.enabled && (axisPos < axisLimits.min || axisPos > axisLimits.max)) {
      axisMoving = false;
      axisRpm = 0;
      axisGoal = null;
      axisTripped = true;
      log("error", "safety", `软限位触发：位置 ${axisPos}`);
      mockBus.emit("tsl:limit", {
        pos: axisPos,
        min: axisLimits.min,
        max: axisLimits.max,
        action: axisLimits.action,
        at: Date.now(),
      });
    }
  }, 40);
  void wrap;

  const seed = (addr: number) => {
    if (!regCache.has(addr)) {
      const table: Record<number, number> = {
        0x000: 0x6460_0001,
        0x002: 0x0001_0200,
        0x009: 0x4000_0000,
        0x0c3: 3,
        0x100: 0x0000_0781,
        0x101: 0x8100_3433,
        0x103: 0xffff_12c0,
        0x140: 0x0000_855c,
        0x142: 0x0040_0030,
        0x143: 0x0040_0030,
        0x145: 0x01f4_00fa,
        0x146: 0x01f4_0000,
        0x149: 0x0000_5a81,
        0x14a: 0x0f86_0000,
        0x14b: 0x0074_8038,
        0x155: 0x0000_4000,
      };
      regCache.set(addr, table[addr] ?? 0);
    }
    return regCache.get(addr)!;
  };

  const log = (level: LogLine["level"], source: string, message: string) =>
    mockBus.emit("tsl:log", { ts: Date.now(), level, source, message });

  const stats = (): LinkStats => ({
    connected,
    port: connected ? port : "",
    baud,
    rtmi_running: running,
    tx_bytes: 1280 + frames * 6,
    rx_bytes: 4096 + frames * 5,
    rtmi_frames: frames,
    rtmi_dropped: 0,
    frame_rate: running ? 1000 : 0,
    channels: running ? [0, 1, 2] : [],
    sampling: 24,
    trigger_hz: running ? 1000 : 0,
  });

  const startStream = () => {
    if (rtmiTimer !== null) return;
    t0 = performance.now();
    rtmiTimer = window.setInterval(() => {
      const t = performance.now() - t0;
      const speed = 300 + Math.sin(t / 420) * 18 + Math.sin(t / 97) * 6;
      const target = 300;
      const current = 180 + Math.sin(t / 310) * 60 + (Math.random() - 0.5) * 14;
      const points: [number, number][] = [
        [0, Math.round(speed * 305.4)],
        [1, Math.round(target * 305.4)],
        [2, Math.round((current / 0.20131) * 65536)],
      ];
      frames += points.length;
      mockBus.emit("tsl:rtmi", { t: Date.now(), pts: points });
      if (frames % 60 === 0) mockBus.emit("tsl:log", {
        ts: Date.now(),
        level: "info",
        source: "rtmi",
        message: `模拟数据流 ${frames} 帧`,
      });
    }, 33);
    statsTimer = window.setInterval(() => mockBus.emit("tsl:rtmi", { t: Date.now(), pts: [] }), 400);
  };

  const stopStream = () => {
    if (rtmiTimer !== null) window.clearInterval(rtmiTimer);
    if (statsTimer !== null) window.clearInterval(statsTimer);
    rtmiTimer = null;
    statsTimer = null;
    running = false;
  };

  const runJob = (kind: string, payload: unknown) => {
    const job = `${kind}:${Date.now()}`;
    const labels: Record<string, string[]> = {
      encoder: [
        "桥臂安全态 (PWM_OFF)",
        "停止 IO Controller",
        "配置 IO_MATRIX (SCK/SDI/CSN)",
        "探测 IO Controller 固件",
        "反馈通道 A (0x240)",
        "速度测量配置 (0x244/0x245)",
        "反馈输出 (0x250)",
        "电角度偏移 (0x242)",
        "PWM 周期 / 电流采样增益",
        "SPI 数据掩码 / 发送数据",
        "启动 SPI 轮询",
        "校验 IO Controller 执行",
      ],
      pid: ["PID_CONFIG", "电流环系数", "速度环/位置环", "力矩限幅", "速度限幅", "电压限幅", "清零积分器", "回读校验"],
      calibrate: ["基础配置", "使能驱动", "开环力矩", "施加对齐电流", "扫描 0°", "扫描 90°", "扫描 180°", "扫描 270°", "拟合", "写回"],
      step: ["基础配置", "写入电流环", "进入模式", "启动 RTMI", "注入阶跃", "采集", "停止输出", "计算指标"],
      sequence: ["准备通道", "使能与模式", "档位 1", "档位 2", "档位 3", "停机", "导出"],
    };
    const list = labels[kind] ?? ["执行"];
    let i = 0;
    const tick = () => {
      if (i >= list.length) {
        let data: unknown = {};
        if (kind === "calibrate") {
          data = {
            offset: 13923,
            offset_hex: "0x3663",
            intercept: 3661.4,
            slope: 45.53,
            r2: 0.99962,
            points: [],
            groups: [
              { deg: 0, n: 2, avg: 3663, unwrapped: 3663, residual: 1.6 },
              { deg: 90, n: 2, avg: 7755, unwrapped: 7755, residual: -2.1 },
              { deg: 180, n: 2, avg: 11861, unwrapped: 11861, residual: 0.8 },
              { deg: 270, n: 2, avg: 15960, unwrapped: 15960, residual: -0.9 },
            ],
            written: true,
          } satisfies Partial<CalibResult>;
        }
        if (kind === "step") {
          const cfg = payload as { cfg?: StepCfgPayload };
          const amp = cfg?.cfg?.amplitude ?? 500;
          const n = 400;
          const time: number[] = [];
          const target: number[] = [];
          const actual: number[] = [];
          for (let k = 0; k < n; k++) {
            const t = (k / n) * 1200;
            const tgt = t > 200 ? amp : 0;
            const a = t > 200 ? amp * (1 - Math.exp(-(t - 200) / 22)) : 0;
            time.push(t);
            target.push(tgt);
            actual.push(a + (Math.random() - 0.5) * amp * 0.012);
          }
          data = {
            kind: cfg?.cfg?.kind ?? "current",
            amplitude: amp,
            unit: cfg?.cfg?.kind === "velocity" ? "RPM" : "mA",
            time,
            target,
            actual,
            metrics: {
              rise_ms: 9.4,
              settle_ms: 28.6,
              overshoot_pct: 1.8,
              steady_error: 0.4,
              peak: amp * 1.018,
              ripple: amp * 0.02,
              samples: n,
            },
            p_reg: cfg?.cfg?.current_p ?? 359,
            i_reg: cfg?.cfg?.current_i ?? 129,
          } satisfies Partial<StepResult>;
        }
        mockBus.emit("tsl:job:done", { job, ok: true, message: "模拟完成", data });
        log("info", "job", `${kind} 完成（模拟）`);
        return;
      }
      mockBus.emit("tsl:job:progress", {
        job,
        idx: i + 1,
        total: list.length,
        label: list[i],
        status: "run",
        detail: "",
      });
      const idx = i;
      window.setTimeout(() => {
        mockBus.emit("tsl:job:progress", {
          job,
          idx: idx + 1,
          total: list.length,
          label: list[idx],
          status: "ok",
          detail: idx % 3 === 0 ? formatDemoDetail(kind, idx) : "",
        });
      }, 220 + Math.random() * 180);
      i += 1;
      window.setTimeout(tick, 380 + Math.random() * 260);
    };
    log("info", "job", `开始任务 ${kind}（模拟）`);
    tick();
  };

  const formatDemoDetail = (kind: string, idx: number) => {
    if (kind === "encoder") {
      const vals = ["0x0781", "COMMAND=0", "0x0000003F→0x0000303F", "fw=0x646000", "CPR_INV=1024", "0x000DA71E", "MUL=1", "0x3663", "25.00 kHz", "mask=0x3FFF", "0xF2 0x8D 0x0E", "PHI_EXT_A=0x1A2B"];
      return vals[idx] ?? "";
    }
    if (kind === "step") return ["CSA=4x, DRV on", "P=359 I=129", "mode=2", "ch0=0x14E", "500 mA", "1075 帧", "PWM_OFF", "上升 9.4 ms"][idx] ?? "";
    return "";
  };

  return {
    async listPorts(): Promise<PortInfo[]> {
      await delay(120);
      return [
        { name: "COM6", kind: "USB", detail: "Silicon Labs CP210x · 0001" },
        { name: "COM9", kind: "USB", detail: "FTDI FT232R · A50285BI" },
      ];
    },
    async connect(p: string, b: number): Promise<LinkStats> {
      await delay(260);
      connected = true;
      port = p;
      baud = b;
      log("info", "link", `已打开 ${p} @ ${b} 8N1（模拟）`);
      log("info", "link", "CHIP.ID = 0x64600001");
      return stats();
    },
    async disconnect(): Promise<LinkStats> {
      stopStream();
      connected = false;
      log("info", "link", `关闭 ${port}`);
      return stats();
    },
    async stats() {
      return stats();
    },
    async readReg(addr: number): Promise<number> {
      await delay(12);
      if (!connected) throw new Error("串口未连接");
      return seed(addr);
    },
    async writeReg(addr: number, value: number): Promise<boolean> {
      await delay(16);
      if (!connected) throw new Error("串口未连接");
      regCache.set(addr, value >>> 0);
      return true;
    },
    async readMany(addrs: number[]): Promise<SnapItem[]> {
      await delay(60);
      if (!connected) throw new Error("串口未连接");
      return addrs.map((addr) => ({ addr, value: seed(addr), error: null }));
    },
    async startRtmi(): Promise<void> {
      await delay(60);
      running = true;
      startStream();
    },
    async stopRtmi(): Promise<void> {
      stopStream();
    },
    async emergencyStop(): Promise<void> {
      stopStream();
      log("warn", "safety", "急停：关闭 PWM 与驱动使能（模拟）");
    },
    async setVelocity(targetRpm: number, _poles: number, _k: number): Promise<void> {
      await delay(30);
      regCache.set(0x150, Math.round(targetRpm * 305.4) >>> 0);
      log("info", "motion", `速度目标 ${targetRpm.toFixed(0)} RPM`);
    },
    async stopMotion(): Promise<void> {
      await delay(30);
      regCache.set(0x150, 0);
      log("info", "motion", "已停止，PWM_OFF");
    },
    async axisState(): Promise<AxisState> {
      return axisSnapshot();
    },
    async axisSetLimits(limits: AxisLimits): Promise<AxisState> {
      await delay(30);
      if (limits.max <= limits.min) throw new Error("上限必须大于下限");
      if (limits.enabled && (axisPos < limits.min || axisPos > limits.max)) {
        throw new Error(`当前位置 ${axisPos} 已在软限位之外，请先移动或重新设原点`);
      }
      axisLimits = { ...limits };
      axisTripped = false;
      axisDone = false;
      log(
        "info",
        "axis",
        `软限位${limits.enabled ? "开启" : "关闭"} [${limits.min}, ${limits.max}] 动作=${limits.action}`
      );
      return axisSnapshot();
    },
    async axisJog(rpm: number, _poles: number, _k: number): Promise<AxisState> {
      await delay(30);
      axisGoal = null;
      axisRpm = rpm;
      axisMoving = rpm !== 0;
      axisDone = false;
      log("info", "motion", `点动 ${rpm.toFixed(0)} RPM`);
      return axisSnapshot();
    },
    async axisMove(cfg: MoveCfgPayload): Promise<AxisState> {
      await delay(30);
      if (axisLimits.enabled && (cfg.target < axisLimits.min || cfg.target > axisLimits.max)) {
        throw new Error(`目标 ${cfg.target} 超出软限位`);
      }
      axisGoal = cfg.target;
      axisRpm = Math.sign(cfg.target - axisPos) * Math.min(cfg.max_rpm, 150);
      axisMoving = true;
      axisDone = false;
      log("info", "motion", `定位 → ${cfg.target} counts`);
      return axisSnapshot();
    },
    async axisHold(): Promise<AxisState> {
      await delay(30);
      axisMoving = false;
      axisGoal = null;
      axisRpm = 0;
      log("info", "motion", "轴已停止");
      return axisSnapshot();
    },
    async axisClear(): Promise<AxisState> {
      await delay(20);
      axisTripped = false;
      axisDone = false;
      axisMoving = false;
      axisRpm = 0;
      axisGoal = null;
      return axisSnapshot();
    },
    async logs() {
      return [] as LogLine[];
    },
    async clearLogs() {},
    async reportsPath() {
      return "C:\\Users\\demo\\Documents\\TSLViewer\\reports";
    },
    async openReportsDir() {
      log("info", "app", "打开报告目录（模拟）");
    },
    async suggestPi(rOhm: number, lUh: number, bandwidthHz: number, fPwm: number) {
      const l = lUh * 1e-6;
      const kp = 2 * Math.PI * bandwidthHz * l;
      const ki = 2 * Math.PI * bandwidthHz * rOhm;
      return [
        Math.max(1, Math.round(kp * 256)),
        Math.max(0, Math.round((ki / Math.max(1, fPwm)) * 256)),
        kp,
        ki,
      ] as [number, number, number, number];
    },
    async readPid(): Promise<PidSnapshot> {
      await delay(30);
      return {
        config: seed(0x140),
        flux_coeff: seed(0x142),
        torque_coeff: seed(0x143),
        vel_coeff: seed(0x145),
        pos_coeff: seed(0x146),
        tf_limits: seed(0x14a),
        vel_limit: seed(0x14b),
        uq_ud_limit: seed(0x149),
      };
    },
    async jobBusy() {
      return false;
    },
    async cancelJob() {
      log("warn", "job", "已请求取消（模拟）");
    },
    async runJob(kind: string, payload: unknown) {
      runJob(kind, payload);
    },
    async sequence(cfg: SeqCfgPayload): Promise<SeqResult> {
      const job = `sequence:${Date.now()}`;
      const rows = [];
      const summary = [];
      let t = 0;
      for (const step of cfg.steps) {
        for (let k = 0; k < 400; k++) {
          t += 5;
          rows.push({
            t_ms: t,
            target_rpm: step.rpm,
            actual_rpm: step.rpm + Math.sin(k / 9) * 6 + (Math.random() - 0.5) * 9,
            current_ma: 120 + Math.abs(step.rpm) / 4 + Math.random() * 20,
            temp_c: 38 + t / 90000,
          });
        }
        summary.push({
          window: `${step.rpm.toFixed(0)} RPM`,
          n: 400,
          mean_rpm: step.rpm,
          std_rpm: 6.2,
          ripple_pct: 2.1,
          mean_current_ma: 120 + Math.abs(step.rpm) / 4,
          max_current_ma: 260,
          max_temp_c: 41.2,
          verdict: "pass",
        });
      }
      mockBus.emit("tsl:job:progress", { job, idx: 1, total: 2, label: "导出", status: "ok", detail: "demo.csv" });
      mockBus.emit("tsl:job:done", { job, ok: true, message: "模拟完成", data: { rows, summary, csv_path: "~/Documents/TSLViewer/reports/demo.csv" } });
      return { rows, summary, csv_path: "~/Documents/TSLViewer/reports/demo.csv" };
    },
  };
})();

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export const api = HAS_TAURI ? real : mock;
