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
  TmcProbe,
  StoreParams,
  EepromProbe,
  EepromSave,
  EepromLoad,
  HomingParams,
  HomingState,
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
  connect: (port: string, baud: number, mode = "direct", motor = 1) => invoke<LinkStats>("connect", { port, baud, mode, motor }),
  mainControl: (motor: number, op: number, data: number[] = []) => invoke<number[]>("main_control", {motor,op,data}),
  focusMotor: (motor: number) => invoke<void>("focus_motor", { motor }),
  probeTmc: (motors: number[], attempts = 6) => invoke<TmcProbe[]>("probe_tmc", { motors, attempts }),
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
  logs: () => invoke<LogLine[]>("get_logs"),  clearLogs: () => invoke<void>("clear_logs"),
  reportsPath: () => invoke<string>("reports_path"),
  openReportsDir: () => invoke<void>("open_reports_dir"),
  suggestPi: (rOhm: number, lUh: number, bandwidthHz: number, fPwm: number) =>
    invoke<[number, number, number, number]>("suggest_pi", { rOhm, lUh, bandwidthHz, fPwm }),
  readPid: () => invoke<PidSnapshot>("read_pid"),
  jobBusy: () => invoke<boolean>("job_busy"),
  cancelJob: () => invoke<void>("cancel_job"),
  runJob: (kind: string, payload: unknown) => invoke<void>("run_job", { kind, payload }),
  eepromProbe: () => invoke<EepromProbe>("eeprom_probe"),
  eepromDump: () => invoke<number[]>("eeprom_dump"),
  eepromSave: (params: StoreParams) => invoke<EepromSave>("eeprom_save", { params }),
  eepromLoad: () => invoke<EepromLoad>("eeprom_load"),
  eepromErase: () => invoke<number>("eeprom_erase"),
  homingStart: (params: HomingParams) => invoke<void>("homing_start", { params }),
  homingState: () => invoke<HomingState>("homing_state"),
  homingCancel: () => invoke<void>("homing_cancel"),
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

/** uart, device index, OUT channel, SYS branch, CN connector — mirrors the firmware DTS. */
const MOCK_ROUTES = [
  [11, 1, 3, 32, 26], [7, 1, 1, 22, 22], [6, 0, 1, 21, 20], [5, 0, 3, 14, 19],
  [4, 0, 2, 13, 18], [2, 0, 4, 11, 16], [17, 2, 4, 44, 32], [16, 2, 2, 43, 31],
  [3, 2, 1, 12, 17], [15, 2, 3, 42, 30], [14, 3, 2, 41, 29], [10, 3, 4, 31, 25],
  [8, 3, 1, 23, 23], [9, 3, 3, 24, 24], [13, 1, 2, 34, 28], [12, 1, 4, 33, 27],
];

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
  const mockPower=[0,0,0,0];
  let mockHandId=1;
  // ---- M24C02 behind the I/O controller (browser preview only) ------------
  const mockEeprom = new Uint8Array(256).fill(0xff);
  let mockParams: StoreParams | null = null;
  let mockSeq = 0;

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
  // mirrors the Rust guard: only the low 16 bits of the (multiturn) position
  // counter are used, and the turns are re-integrated; one tick integrates the
  // commanded speed over 40 ms
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

  // ---- 机械找零：模拟「主控固件」的状态机 --------------------------------
  // 上位机只做两件事：下发方向与步进（homingStart）、轮询状态（homingState）。
  // 门控、推进、电流判据、超时、零点写入、退开全部在这里（= 固件侧）完成，
  // 与 doc/TODO/TODO-01-机械找零.md 的约定一致。
  const HOMING_FW = {
    /** 额定电流刻度（本工程取力矩限幅 800 mA） */
    ratedMa: 800,
    /** 判定系数 k：阈值 = k × 额定 */
    k: 0.4,
    /** 连续超阈确认时间 */
    confirmMs: 50,
    /** 找零期间的电流上限，必须 > 阈值 */
    limitMa: 600,
    /** 推进速度上限，仅用于仿真时长 */
    maxRpm: 2000,
    /** 找零超时 */
    timeoutMs: 60_000,
    /** 退开量（电机端） */
    retreatDeg: 360,
    /** 退开后的稳定等待 */
    settleMs: 2000,
  };
  const HOMING_THRESHOLD_MA = HOMING_FW.ratedMa * HOMING_FW.k;
  type HomingPhase = "idle" | "approach" | "contact" | "retreat" | "settle";
  const homing = {
    stage: 0,
    zeroValid: false,
    iq: 0,
    error: 0,
    message: "",
    phase: "idle" as HomingPhase,
    dir: -1 as -1 | 1,
    stepUnit: 1500,
    elapsed: 0,
    contactMs: 0,
    togoDeg: 0,
    retreatLeft: 0,
    settleLeft: 0,
    timer: null as number | null,
  };
  const homingSnapshot = (): HomingState => ({
    stage: homing.stage,
    zero_valid: homing.zeroValid,
    iq_ma: Math.round(homing.iq),
    elapsed_ms: homing.elapsed,
    error: homing.error,
    message: homing.message,
  });
  const homingStop = () => {
    if (homing.timer !== null) window.clearInterval(homing.timer);
    homing.timer = null;
    homing.phase = "idle";
  };
  const homingFail = (code: number, why: string) => {
    homingStop();
    homing.stage = 3;
    homing.error = code;
    homing.message = why;
    homing.iq = 0; // 卸力
    homing.contactMs = 0;
    log("error", "homing", `找零失败：${why}（零点不写入）`);
  };
  const homingTick = () => {
    const dt = 40;
    homing.elapsed += dt;
    if (homing.elapsed > HOMING_FW.timeoutMs) {
      homingFail(1, "找零超时");
      return;
    }
    // 电流判据：连续超阈才算接触，任何一拍掉回阈值以下立即清零
    const above = Math.abs(homing.iq) >= HOMING_THRESHOLD_MA;
    homing.contactMs = above ? homing.contactMs + dt : 0;

    switch (homing.phase) {
      case "approach": {
        // 未接触：只克服摩擦；偶发尖峰不足以撑满确认时间
        const spike = Math.random() < 0.08 ? 120 : 0;
        homing.iq = homing.dir * (140 + Math.random() * 40 + spike);
        // 预览用的推进速率（固件按 2000 RPM 上限跑，这里放慢便于观察状态）
        homing.togoDeg -= (900 * dt) / 1000;
        if (homing.togoDeg <= 0) {
          homing.phase = "contact";
          homing.contactMs = 0;
        }
        break;
      }
      case "contact": {
        // 顶住挡块：给定继续跑，电流被限幅钳住
        homing.iq = homing.dir * (HOMING_FW.limitMa + (Math.random() - 0.5) * 30);
        if (homing.contactMs >= HOMING_FW.confirmMs) {
          // 记录实测位置作为零点，并立即退开（避免长期顶紧）
          homing.zeroValid = false;
          homing.phase = "retreat";
          homing.retreatLeft = HOMING_FW.retreatDeg;
          log("info", "homing", `检测到接触（${homing.contactMs} ms 连续超阈），零点已记录`);
        }
        break;
      }
      case "retreat": {
        homing.iq = -homing.dir * 120;
        homing.retreatLeft -= (HOMING_FW.maxRpm * 6 * dt) / 1000;
        if (homing.retreatLeft <= 0) {
          homing.phase = "settle";
          homing.settleLeft = HOMING_FW.settleMs;
        }
        break;
      }
      case "settle": {
        homing.iq *= 0.6;
        homing.settleLeft -= dt;
        if (homing.settleLeft <= 0) {
          homingStop();
          homing.stage = 2;
          homing.zeroValid = true;
          homing.error = 0;
          homing.message = "找零完成";
          log("ok", "homing", "行程零点有效");
        }
        break;
      }
      default:
        break;
    }
  };
  /** 门控在固件侧裁决：这里只模拟「未连接 / 已在跑」两种拒绝。 */
  const homingStart = (params: HomingParams) => {
    if (homing.stage === 1) throw new Error("找零进行中，请先取消或等待结束");
    homing.stage = 1;
    homing.error = 0;
    homing.message = "进行中";
    homing.dir = params.dir;
    homing.stepUnit = params.step_unit;
    homing.elapsed = 0;
    homing.contactMs = 0;
    // 起点到限位的距离由机构决定，这里随机取一段行程
    homing.togoDeg = 1200 + Math.random() * 2400;
    homing.phase = "approach";
    log(
      "info",
      "homing",
      `已请求找零：方向 ${params.dir > 0 ? "+" : "−"}${(params.step_unit / 100).toFixed(2)}°/拍（固件裁决后开始推进）`
    );
    if (homing.timer !== null) window.clearInterval(homing.timer);
    homing.timer = window.setInterval(homingTick, 40);
  };

  // ---- 环路测试：被控对象仿真（仅浏览器预览） --------------------------
  // 环路测试页只做上位机的事：写给定/限幅寄存器、每 60 ms 读回反馈。
  // 这里用最简单的模型把写进寄存器的给定跑成位置/速度/电流，好让页面在没有
  // 硬件时也能验证「边界裁决/评分/波形」这套上位机逻辑。
  const PLANT = {
    lo: 0,
    hi: 65536 * 4,
    /** 每 mA 的稳态转速贡献，RPM/mA */
    rpmPerMa: 6,
    /** 机械等效时间常数，s */
    tau: 0.08,
    /** 静摩擦，mA */
    frictionMa: 45,
    maPerCount: 0.20131,
    countsPerRpm: 305.4,
  };
  const plant = { pos: 0x4000, rpm: 0, iq: 0, integ: 0 };
  const i16 = (v: number) => ((((v >>> 16) & 0xffff) << 16) >> 16);
  window.setInterval(() => {
    if (!connected) return;
    const mode = (seed(0x100) >>> 9) & 0x0f;
    const drv = ((seed(0x101) >>> 16) & 1) === 1;
    const powered = drv && mode !== 0;
    const iqTgtMa = i16(seed(0x14e)) * PLANT.maPerCount;
    const rpmTgt = (seed(0x150) | 0) / PLANT.countsPerRpm;
    const posTgt = seed(0x152) | 0;
    const limitMa = ((seed(0x14a) >>> 16) & 0x7fff) * PLANT.maPerCount;
    const velLimit = seed(0x14b) / PLANT.countsPerRpm;
    const coeff = seed(0x145);
    const kp = (coeff >>> 16) & 0xffff;
    const ki = coeff & 0xffff;
    // 归一化增益的"相对倍率"，让辨识不同候选时行为真的变（夹在 0.2…4 防止发散）
    const g = Math.max(0.2, Math.min(4, (kp + ki) / 750));
    const dt = 0.02;
    let iqCmd = 0;
    if (!powered) {
      plant.integ = 0;
    } else if (mode === 2) {
      iqCmd = iqTgtMa;
      plant.integ = 0;
    } else if (mode === 3 || mode === 4) {
      const vt =
        mode === 3
          ? rpmTgt
          : Math.max(-Math.abs(velLimit), Math.min(Math.abs(velLimit), (posTgt - plant.pos) * 0.02));
      const err = vt - plant.rpm;
      plant.integ = Math.max(-limitMa, Math.min(limitMa, plant.integ + err * dt * 0.9 * g));
      iqCmd = err * 0.12 * g + plant.integ;
    }
    plant.iq = Math.max(-limitMa, Math.min(limitMa, iqCmd));
    const drive =
      Math.abs(plant.iq) > PLANT.frictionMa ? plant.iq - Math.sign(plant.iq) * PLANT.frictionMa : 0;
    const accel = (drive * PLANT.rpmPerMa - plant.rpm) / PLANT.tau;
    plant.rpm += accel * dt;
    plant.pos += (plant.rpm / 60) * 65536 * dt;
    if (plant.pos <= PLANT.lo) {
      plant.pos = PLANT.lo;
      if (plant.rpm < 0) plant.rpm = 0;
    }
    if (plant.pos >= PLANT.hi) {
      plant.pos = PLANT.hi;
      if (plant.rpm > 0) plant.rpm = 0;
    }
    regCache.set(0x155, Math.round(plant.pos) >>> 0);
    regCache.set(0x154, Math.round(plant.rpm * PLANT.countsPerRpm) >>> 0);
    regCache.set(0x153, (((Math.round(plant.iq / PLANT.maPerCount) & 0xffff) << 16) | 0) >>> 0);
    regCache.set(0x159, Math.round((rpmTgt - plant.rpm) * PLANT.countsPerRpm) >>> 0);
    regCache.set(0x15f, Math.round(plant.integ / PLANT.maPerCount) & 0xffff);
  }, 20);

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
    async connect(p: string, b: number, _mode = "direct", _motor = 1): Promise<LinkStats> {
      await delay(260);
      connected = true;
      port = p;
      baud = b;
      log("info", "link", `已打开 ${p} @ ${b} 8N1（模拟）`);
      log("info", "link", "CHIP.ID = 0x64600001");
      return stats();
    },
    async mainControl(motor: number, op: number, data: number[] = []) {
      const routes = MOCK_ROUTES;
      if (op===10 && data[0]===73) return [mockHandId>>8,mockHandId&255];
      if (op===11) {mockHandId=data[0]*256+data[1];return [];}
      if (op===10) return Array.from("SIMULATED firmware").map(c=>c.charCodeAt(0));
      if (op===6) {mockPower.fill(0);return [];}
      const r=routes[motor-1];
      if (op===4) return motor===0 ? [1,16,1,1] : [...r,1,0,1,mockPower.some(v=>v!==0)?1:0,16|mockPower[r[1]]];
      if (op===5 && r) {const bit=1<<(r[2]-1);mockPower[r[1]]=data[0]?mockPower[r[1]]|bit:mockPower[r[1]]&~bit;}
      return [];
    },
    async focusMotor(_motor: number): Promise<void> {
      await delay(40);
    },
    async probeTmc(motors: number[], attempts = 6): Promise<TmcProbe[]> {
      await delay(180);
      if (!connected) throw new Error("串口未连接");
      return motors.map((m) => {
        const r = MOCK_ROUTES[m - 1];
        const on = !!r && (mockPower[r[1]] & (1 << (r[2] - 1))) !== 0;
        return { motor: m, online: on, chip_id: on ? 0x64600001 : null, tries: on ? 1 : attempts };
      });
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
    async eepromProbe(): Promise<EepromProbe> {
      await delay(120);
      if (!connected) throw new Error("串口未连接");
      return {
        ok: true,
        i2c_hz: 100_000,
        matrix_before: 0x0000_703f,
        matrix_after: 0x0000_71bf,
        addr: 0xfe,
        saved: mockEeprom[0xfe],
        written: [0xa5, 0x5a],
        read_back: [0xa5, 0x5a],
        message: "EEPROM 可读可写（模拟）",
      };
    },
    async eepromDump(): Promise<number[]> {
      await delay(80);
      if (!connected) throw new Error("串口未连接");
      return Array.from(mockEeprom);
    },
    async eepromSave(params: StoreParams): Promise<EepromSave> {
      await delay(400);
      if (!connected) throw new Error("串口未连接");
      mockParams = { ...params };
      mockSeq = (mockSeq + 1) & 0xffff;
      // 只写头 + seq，内容留 0xFF：浏览器的十六进制视图主要是给布局用的。
      const enc = new TextEncoder().encode("TSL1");
      for (const base of [0x00, 0x70]) {
        mockEeprom.fill(0xff, base, base + 112);
        mockEeprom.set(enc, base);
        mockEeprom[base + 4] = 1;
        mockEeprom[base + 5] = 92;
        mockEeprom[base + 6] = mockSeq & 0xff;
        mockEeprom[base + 7] = (mockSeq >> 8) & 0xff;
        mockEeprom[base + 100] = 0x5a; // 占位 CRC，模拟层不校验
      }
      log("info", "storage", `参数块写入 EEPROM（模拟，seq=${mockSeq}）`);
      return { seq: mockSeq, block: "A+B", bytes_written: 224, verified: true, elapsed_ms: 380 };
    },
    async eepromLoad(): Promise<EepromLoad> {
      await delay(120);
      if (!connected) throw new Error("串口未连接");
      return {
        found: mockParams !== null,
        block: mockParams ? "A" : "—",
        seq: mockSeq,
        crc_a: mockParams !== null,
        crc_b: mockParams !== null,
        params: mockParams,
        message: mockParams ? `有效参数块（A，seq=${mockSeq}）` : "未找到有效参数块（模拟）",
      };
    },
    async eepromErase(): Promise<number> {
      await delay(120);
      if (!connected) throw new Error("串口未连接");
      mockParams = null;
      mockEeprom.fill(0xff);
      return 8;
    },
    async homingStart(params: HomingParams, _motor?: number): Promise<void> {
      await delay(60);
      if (!connected) throw new Error("串口未连接");
      homingStart(params);
    },
    async homingState(_motor?: number): Promise<HomingState> {
      return homingSnapshot();
    },
    async homingCancel(_motor?: number): Promise<void> {
      await delay(40);
      if (homing.stage !== 1) return;
      homingFail(3, "已取消");
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
