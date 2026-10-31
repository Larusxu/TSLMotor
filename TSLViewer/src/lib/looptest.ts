/**
 * 环路测试（上位机侧引擎）。
 *
 * 分工：**上位机只做上位机的事**——
 *   1. 写模式 / 给定 / 限幅（0x100 / 0x14E / 0x150 / 0x152 / 0x14A / 0x14B / 0x14C / 0x14D）；
 *   2. 每 60 ms 读回位置与反馈，自己裁决「到没到测试行程边界」；
 *   3. 换速度环系数（0x145）并按评分选优；
 *   4. 采样打点、画波形、写日志。
 * 闭环控制、限幅裁决、故障保护全部在 TMC6460 + 主控固件里：上位机不给主控任何
 * 「测试行程」之类的概念，也不参与任何一拍的控制运算。
 *
 * 与 com_moto 老上位机的差异（依据 tmc6460.pdf）：
 *   · 电流上限用 0x14A[30:16]，它钳的是**力矩控制器目标的绝对值**，所以力矩模式
 *     （MOTION_MODE=TORQUE）下同样生效 —— 老固件「恒 Iq 无二级限流」的限制不存在了；
 *   · 速度环 PI 输出没有独立寄存器，用 0x153[31:16] 的力矩实际值代替（同刻度）；
 *   · 位置目标 0x152 / 位置反馈 0x155 都是 32 位多圈计数器，不是 16 位；
 *   · 写 0x155 会同时改写 0x152（除非 0x140 bit0 KEEP_POS_TARGET=1），所以清零靠写 0x155。
 */
import { api } from "./api";

/** 环路测试用到的全部寄存器（地址见 tmc6460.pdf p.155–166）。 */
export const LOOP_REG = {
  MOTOR_MOTION: 0x100,
  GDRV: 0x101,
  PID_CONFIG: 0x140,
  VEL_COEFF: 0x145,
  TF_LIMITS: 0x14a,
  VEL_LIMIT: 0x14b,
  POS_LIMIT_LOW: 0x14c,
  POS_LIMIT_HIGH: 0x14d,
  TF_TARGET: 0x14e,
  VEL_TARGET: 0x150,
  POS_TARGET: 0x152,
  TF_ACTUAL: 0x153,
  VEL_ACTUAL: 0x154,
  POS_ACTUAL: 0x155,
  VEL_ERROR: 0x159,
  VEL_INTEGRATOR: 0x15f,
} as const;

export const MODE_PWM_OFF = 0;
export const MODE_TORQUE = 2;
export const MODE_VELOCITY = 3;
export const MODE_POSITION = 4;
const MOTOR_TYPE_BLDC = 3;

export const MODE_NAMES: Record<number, string> = {
  0: "PWM_OFF",
  1: "PWM_ON",
  2: "力矩",
  3: "速度",
  4: "位置",
  5: "PRBS_UD",
  6: "PRBS_FLUX",
  7: "PRBS_TORQUE",
  8: "PRBS_VELOCITY",
  9: "PRBS_POSITION",
  10: "PWM_EXT",
  11: "VOLTAGE_EXT",
};

/** 行程裁决 60 ms 一拍足够；位置/速度读数不需要 32 kHz 采样。 */
export const TICK_MS = 60;
/** 32 位多圈计数器：一圈 = 65536 counts。 */
export const POS_PER_REV = 65536;

export type BoundaryAction = "stop" | "reverse";
export type PosKind = "hold" | "recip" | "sine";
export type LoopPhase = "idle" | "bounded" | "pos" | "tune";

export interface Travel {
  lo: number;
  hi: number;
}

/** `MCC_CONFIG.MOTOR_MOTION`：模式 [12:9] + 电机类型 [8:7] + 极对数 [6:0]。 */
export function motionWord(mode: number, poles: number): number {
  return ((mode & 0x0f) << 9) | (MOTOR_TYPE_BLDC << 7) | (poles & 0x7f);
}

export const modeOf = (word: number): number => (word >>> 9) & 0x0f;
export const s16hi = (v: number): number => ((((v >>> 16) & 0xffff) << 16) >> 16);
export const as32 = (v: number): number => v | 0;

export const degOf = (cnt: number): number => (cnt / POS_PER_REV) * 360;
export const turnsOf = (cnt: number): number => cnt / POS_PER_REV;

/** 完整行程按 1/8 分段：segA / segB ∈ [0, 8]。 */
export function travelOf(turns: number, segA: number, segB: number): Travel {
  const total = Math.round(turns * POS_PER_REV);
  const a = Math.max(0, Math.min(8, segA));
  const b = Math.max(0, Math.min(8, segB));
  return { lo: Math.round((a / 8) * total), hi: Math.round((b / 8) * total) };
}

export const travelValid = (t: Travel): boolean => t.hi > t.lo;

/** 行程标签：counts · 电机端角度 · 圈数。 */
export function travelLabel(t: Travel): string {
  return `${t.lo.toLocaleString("en-US")} … ${t.hi.toLocaleString("en-US")} · ${degOf(t.lo).toFixed(1)}° … ${degOf(
    t.hi
  ).toFixed(1)}° · ${turnsOf(t.lo).toFixed(2)} … ${turnsOf(t.hi).toFixed(2)} 圈`;
}

/**
 * 目标变化速率校核：位置测试的目标会被「速度限幅」削顶，
 * 需求速度超过限幅时波形变成梯形，这里提前算出来提示。
 */
export function demandRpm(kind: PosKind, o: { A: number; B: number; amp: number; periodS: number }): number {
  const T = Math.max(0.05, o.periodS);
  if (kind === "hold") return 0;
  // 往复：一个来回跨 |B-A|，平均速度 = 2·|B-A|/T（阶跃切换，峰值按 2 倍平均估）
  if (kind === "recip") return (Math.abs(o.B - o.A) / POS_PER_REV / T) * 60 * 2;
  // 正弦：峰值角速度 = A·2π/T
  return (((o.amp / POS_PER_REV) * 2 * Math.PI) / T) * 60;
}

/** 按倍率生成候选并去重，非法/非正数直接丢掉。 */
export function candidates(kp0: number, ki0: number, mults: number[]): { kp: number; ki: number }[] {
  const out: { kp: number; ki: number }[] = [];
  const seen = new Set<string>();
  for (const m of mults) {
    if (!Number.isFinite(m) || m <= 0) continue;
    const kp = Math.max(0, Math.min(32767, Math.round(kp0 * m)));
    const ki = Math.max(0, Math.min(32767, Math.round(ki0 * m)));
    const key = `${kp}/${ki}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kp, ki });
  }
  return out;
}

export interface TuneSample {
  err: number;
  iq: number;
}

export interface TuneScore {
  errRms: number;
  errMean: number;
  iqStd: number;
  score: number;
  n: number;
}

const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) * (v - m))));
};

/**
 * 评分 J = errRMS + 0.35·|errMean| + 0.20·σ(i_q)。
 * 三项量纲不同（前两项 RPM，第三项 mA），属工程折中：
 * 只能在同机同工况内排序，不能跨机器比较绝对大小。
 */
export function scoreOf(samples: TuneSample[]): TuneScore {
  const err = samples.map((s) => s.err);
  const iq = samples.map((s) => s.iq);
  const errRms = samples.length ? Math.sqrt(mean(err.map((v) => v * v))) : Infinity;
  const errMean = mean(err);
  const iqStd = std(iq);
  return {
    errRms,
    errMean,
    iqStd,
    score: errRms + 0.35 * Math.abs(errMean) + 0.2 * iqStd,
    n: samples.length,
  };
}

export interface LoopSample {
  /** 本次测试开始后的毫秒数 */
  t: number;
  pos: number;
  posTgt: number;
  rpm: number;
  rpmTgt: number;
  iqMa: number;
  iqTgtMa: number;
  velErrRpm: number;
}

export interface LoopState {
  phase: LoopPhase;
  mode: string;
  pos: number;
  posTgt: number;
  rpm: number;
  rpmTgt: number;
  iqMa: number;
  cycles: number;
  note: string;
}

export interface LoopHooks {
  onSample: (s: LoopSample) => void;
  onState: (patch: Partial<LoopState>) => void;
  onLog: (level: "info" | "ok" | "warn" | "error", msg: string) => void;
  onStep: (label: string, detail: string | undefined, status: "run" | "ok" | "fail") => void;
}

export interface BoundedCfg {
  kind: "iq" | "speed";
  /** 恒 Iq 给定，mA */
  iqMa: number;
  /** 恒速度给定，RPM（符号由初始方向决定，界面只填大小） */
  rpm: number;
  /** 电流上限，mA（写 0x14A[30:16]） */
  iqLimitMa: number;
  travel: Travel;
  action: BoundaryAction;
}

export interface PosCfg {
  kind: PosKind;
  A: number;
  B: number;
  center: number;
  amp: number;
  periodS: number;
  /** 0 = 无限跑；仅往复有效 */
  cycles: number;
  iqLimitMa: number;
  maxRpm: number;
  travel: Travel;
}

export interface TuneCfg {
  rpm: number;
  iqLimitMa: number;
  kp0: number;
  ki0: number;
  mults: number[];
  dwellS: number;
  apply: boolean;
  travel: Travel;
}

export interface TuneRow {
  kp: number;
  ki: number;
  s: TuneScore;
  sat: boolean;
  note: string;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 环路测试引擎。写操作都走 `api.writeReg`（带回读校验），
 * 读操作合并成一次 `api.readMany`，一拍一次往返。
 */
export class LoopEngine {
  private stopped = true;
  private phase: LoopPhase = "idle";
  private hooks: LoopHooks;
  private poles: number;
  private maPerCount: number;
  private countsPerRpm: number;
  /** 收尾用：原始限幅与速度环系数，失败时原样恢复 */
  private orig = {
    tf: 0x7fff7fff,
    vel: 0x7fffffff,
    coeff: 0,
    limits: { lo: -2147483647, hi: 2147483646 },
  };
  private t0 = 0;

  constructor(o: { poles: number; maPerCount: number; countsPerRpm: number; hooks: LoopHooks }) {
    this.poles = o.poles;
    this.maPerCount = o.maPerCount;
    this.countsPerRpm = o.countsPerRpm;
    this.hooks = o.hooks;
  }

  get busy(): boolean {
    return !this.stopped;
  }

  private stopFlag(): void {
    this.stopped = true;
    this.phase = "idle";
    this.hooks.onState({ phase: "idle" });
  }

  private async snap(addrs: number[]): Promise<number[]> {
    const items = await api.readMany(addrs);
    return items.map((it) => (it.value === null ? 0 : it.value >>> 0));
  }

  private async w(addr: number, value: number): Promise<void> {
    await api.writeReg(addr, value >>> 0, true);
  }

  private maCounts(ma: number): number {
    return Math.max(0, Math.min(0x7fff, Math.round(Math.abs(ma) / this.maPerCount)));
  }

  private rpmCounts(rpm: number): number {
    return Math.round(rpm * this.countsPerRpm);
  }

  // ---------------------------------------------------------------- 基础动作

  /** DRV_EN + 充电泵；不使能则力矩/速度/位置模式都不会输出。 */
  async enable(): Promise<void> {
    const [gdrv] = await this.snap([LOOP_REG.GDRV]);
    await this.w(LOOP_REG.GDRV, (gdrv | (1 << 31) | (1 << 16)) >>> 0);
  }

  async setMode(mode: number): Promise<void> {
    await this.w(LOOP_REG.MOTOR_MOTION, motionWord(mode, this.poles));
  }

  /** 力矩/磁链限幅：`0x14A[30:16]` = 力矩上限，`[14:0]` = 磁链上限（都是绝对值）。 */
  private tfLimitWord(torqueCounts: number, fluxCounts: number): number {
    return (((Math.abs(torqueCounts) & 0x7fff) << 16) | (Math.abs(fluxCounts) & 0x7fff)) >>> 0;
  }

  /** 力矩/磁链给定：`0x14E[31:16]` / `[15:0]` 都是**有符号** 16 位。 */
  private tfTargetWord(torqueCounts: number, fluxCounts: number): number {
    const t = Math.max(-0x8000, Math.min(0x7fff, Math.round(torqueCounts)));
    const f = Math.max(-0x8000, Math.min(0x7fff, Math.round(fluxCounts)));
    return (((t & 0xffff) << 16) | (f & 0xffff)) >>> 0;
  }

  async setIqLimit(ma: number): Promise<void> {
    const c = this.maCounts(ma);
    await this.w(LOOP_REG.TF_LIMITS, this.tfLimitWord(c, c));
  }

  async setSpeedLimit(rpm: number): Promise<void> {
    await this.w(LOOP_REG.VEL_LIMIT, this.rpmCounts(Math.abs(rpm)) >>> 0);
  }

  /** 位置限幅是「硬件护栏」：在上位机算的测试行程之外再兜一道，越界由芯片拦。 */
  async setPosLimits(lo: number, hi: number): Promise<void> {
    await this.w(LOOP_REG.POS_LIMIT_LOW, Math.round(lo) >>> 0);
    await this.w(LOOP_REG.POS_LIMIT_HIGH, Math.round(hi) >>> 0);
  }

  async writeIq(ma: number): Promise<void> {
    const c = Math.round(ma / this.maPerCount);
    await this.w(LOOP_REG.TF_TARGET, this.tfTargetWord(c, 0));
  }

  async writeSpeed(rpm: number): Promise<void> {
    await this.w(LOOP_REG.VEL_TARGET, this.rpmCounts(rpm) >>> 0);
  }

  async writePos(cnt: number): Promise<void> {
    await this.w(LOOP_REG.POS_TARGET, Math.round(cnt) >>> 0);
  }

  async readPos(): Promise<number> {
    const [pos] = await this.snap([LOOP_REG.POS_ACTUAL]);
    return as32(pos);
  }

  /** 空闲时的一次读数：只读不写，让页面在没跑测试时也有实时值。 */
  async poll(): Promise<Partial<LoopState>> {
    const v = await this.snap([
      LOOP_REG.POS_ACTUAL,
      LOOP_REG.VEL_ACTUAL,
      LOOP_REG.TF_ACTUAL,
      LOOP_REG.MOTOR_MOTION,
    ]);
    return {
      pos: as32(v[0]),
      rpm: as32(v[1]) / this.countsPerRpm,
      iqMa: s16hi(v[2]) * this.maPerCount,
      mode: MODE_NAMES[modeOf(v[3])] ?? "—",
    };
  }

  private async saveOriginals(): Promise<void> {
    const v = await this.snap([
      LOOP_REG.TF_LIMITS,
      LOOP_REG.VEL_LIMIT,
      LOOP_REG.VEL_COEFF,
      LOOP_REG.POS_LIMIT_LOW,
      LOOP_REG.POS_LIMIT_HIGH,
    ]);
    this.orig = { tf: v[0], vel: v[1], coeff: v[2], limits: { lo: as32(v[3]), hi: as32(v[4]) } };
  }

  private async restoreOriginals(): Promise<void> {
    try {
      await this.w(LOOP_REG.TF_LIMITS, this.orig.tf);
      await this.w(LOOP_REG.VEL_LIMIT, this.orig.vel);
      await this.w(LOOP_REG.VEL_COEFF, this.orig.coeff);
      await this.w(LOOP_REG.POS_LIMIT_LOW, this.orig.limits.lo >>> 0);
      await this.w(LOOP_REG.POS_LIMIT_HIGH, this.orig.limits.hi >>> 0);
    } catch {
      /* 链路断了就别在收尾里再抛错 */
    }
  }

  /** 停止测试 = 清目标 + 断使能 + 恢复原限幅。 */
  async stop(): Promise<void> {
    this.stopFlag();
    try {
      await this.w(LOOP_REG.TF_TARGET, 0);
      await this.w(LOOP_REG.VEL_TARGET, 0);
      await this.w(LOOP_REG.VEL_INTEGRATOR, 0);
      await delay(120);
      await this.setMode(MODE_PWM_OFF);
      await this.restoreOriginals();
      this.hooks.onLog("info", "已停止测试：清目标 + PWM_OFF，原限幅已恢复");
    } catch (e) {
      this.hooks.onLog("error", `停止失败：${String(e)}`);
    }
  }

  /** 只停周期性下发：仍使能、仍有保持力矩。 */
  stopPosOnly(): void {
    if (this.phase !== "pos") return;
    this.hooks.onLog("warn", "已停止位置测试：仍使能，电机仍保持力矩");
    this.stopFlag();
  }

  // ------------------------------------------------------- ① 恒 Iq / 恒速度

  async startBounded(cfg: BoundedCfg): Promise<void> {
    if (!travelValid(cfg.travel)) throw new Error("测试行程区间无效：止段必须大于起段");
    this.stopped = false;
    this.phase = "bounded";
    this.t0 = performance.now();
    this.hooks.onState({ phase: "bounded", cycles: 0, note: "" });
    await this.saveOriginals();

    const pos0 = await this.readPos();
    // 初始方向：朝离得远的那侧走，缩短第一次撞边界的距离
    const mid = (cfg.travel.lo + cfg.travel.hi) / 2;
    const dir: 1 | -1 = pos0 >= mid ? -1 : 1;

    this.hooks.onStep("保存原始限幅", `0x14A=0x${this.orig.tf.toString(16).toUpperCase()}`, "ok");
    await this.setIqLimit(cfg.iqLimitMa);
    this.hooks.onStep("写电流上限", `${cfg.iqLimitMa} mA → 0x14A[30:16]`, "ok");

    if (cfg.kind === "speed") await this.setSpeedLimit(Math.abs(cfg.rpm));
    await this.enable();
    await this.setMode(cfg.kind === "iq" ? MODE_TORQUE : MODE_VELOCITY);
    this.hooks.onStep(
      "使能并切模式",
      cfg.kind === "iq" ? "MOTION_MODE=TORQUE" : "MOTION_MODE=VELOCITY",
      "ok"
    );

    const mag = cfg.kind === "iq" ? Math.abs(cfg.iqMa) : Math.abs(cfg.rpm);
    // 配好到下发之间可能被「停止」打断（例如页面卸载），这里再确认一次
    if (this.stopped) return;
    if (cfg.kind === "iq") await this.writeIq(dir * mag);
    else await this.writeSpeed(dir * mag);
    this.hooks.onStep(
      "下发给定",
      `${dir > 0 ? "+" : "−"}${mag} ${cfg.kind === "iq" ? "mA" : "RPM"}`,
      "ok"
    );
    this.hooks.onLog(
      "info",
      `恒 ${cfg.kind === "iq" ? "Iq" : "速度"}测试开始：行程 ${travelLabel(cfg.travel)}，边界动作=${
        cfg.action === "stop" ? "停止" : "自动换向"
      }`
    );

    void this.boundedLoop(cfg, dir, mag);
  }

  private async boundedLoop(cfg: BoundedCfg, dir0: 1 | -1, mag: number): Promise<void> {
    let dir = dir0;
    let cycles = 0;
    while (!this.stopped) {
      const tickStart = performance.now();
      try {
        const v = await this.snap([
          LOOP_REG.POS_ACTUAL,
          LOOP_REG.VEL_ACTUAL,
          LOOP_REG.TF_ACTUAL,
          LOOP_REG.VEL_TARGET,
        ]);
        const pos = as32(v[0]);
        const rpm = as32(v[1]) / this.countsPerRpm;
        const iqMa = s16hi(v[2]) * this.maPerCount;
        const rpmTgt = as32(v[3]) / this.countsPerRpm;
        this.hooks.onState({
          pos,
          rpm,
          iqMa,
          rpmTgt,
          posTgt: 0,
          mode: cfg.kind === "iq" ? "力矩" : "速度",
          cycles,
        });
        this.hooks.onSample({
          t: performance.now() - this.t0,
          pos,
          posTgt: 0,
          rpm,
          rpmTgt,
          iqMa,
          iqTgtMa: cfg.kind === "iq" ? dir * mag : 0,
          velErrRpm: rpmTgt - rpm,
        });

        const out = dir > 0 ? pos >= cfg.travel.hi : pos <= cfg.travel.lo;
        if (out) {
          if (cfg.action === "reverse") {
            dir = dir > 0 ? -1 : 1;
            cycles += 1;
            if (cfg.kind === "iq") await this.writeIq(dir * mag);
            else await this.writeSpeed(dir * mag);
            this.hooks.onLog("warn", `到边界 ${pos}，自动换向（第 ${cycles} 次），给定已反向`);
          } else {
            this.hooks.onStep("到边界", `位置 ${pos}，按策略停止`, "ok");
            await this.stop();
            this.hooks.onLog("ok", `到边界 ${pos}，已停止测试并断使能`);
            return;
          }
        }
      } catch (e) {
        this.hooks.onLog("error", `采样失败：${String(e)}`);
        await this.stop();
        return;
      }
      const spent = performance.now() - tickStart;
      await delay(Math.max(8, TICK_MS - spent));
    }
  }

  // ------------------------------------------------------------ ③ 位置环测试

  async startPos(cfg: PosCfg): Promise<void> {
    if (!travelValid(cfg.travel)) throw new Error("位置行程区间无效：止段必须大于起段");
    const first = cfg.kind === "hold" ? cfg.A : cfg.kind === "recip" ? cfg.B : cfg.center + cfg.amp;
    if (first < cfg.travel.lo || first > cfg.travel.hi) {
      throw new Error(`首目标 ${Math.round(first)} 在行程之外，请先「到中心」再启动`);
    }
    this.stopped = false;
    this.phase = "pos";
    this.t0 = performance.now();
    this.hooks.onState({ phase: "pos", cycles: 0, note: "" });
    await this.saveOriginals();

    this.hooks.onStep(
      "保存原始限幅",
      `位置限幅 ${this.orig.limits.lo} … ${this.orig.limits.hi}`,
      "ok"
    );
    await this.setIqLimit(cfg.iqLimitMa);
    await this.setSpeedLimit(cfg.maxRpm);
    // 位置限幅兜底：比测试行程再放宽 1/8 段，避免上位机掉线时冲出行程
    const pad = Math.max(1, Math.round((cfg.travel.hi - cfg.travel.lo) / 8));
    await this.setPosLimits(cfg.travel.lo - pad, cfg.travel.hi + pad);
    this.hooks.onStep("写限幅与位置护栏", `电流 ${cfg.iqLimitMa} mA · 速度 ${cfg.maxRpm} RPM`, "ok");

    await this.enable();
    await this.setMode(MODE_POSITION);
    this.hooks.onStep("使能并切位置直通", "MOTION_MODE=POSITION，RAMP_EN=0（阶跃给定）", "ok");

    // 与「电机控制」页相反：先写首目标再使能 —— 这就是阶跃冲击的来源
    if (this.stopped) return;
    await this.writePos(first);
    this.hooks.onStep("下发首目标", `${Math.round(first)} counts`, "ok");
    this.hooks.onLog(
      "info",
      `位置环测试开始：${cfg.kind === "hold" ? "保持" : cfg.kind === "recip" ? "A/B 往复" : "正弦"}，周期 ${cfg.periodS} s`
    );

    void this.posLoop(cfg, first);
  }

  private async posLoop(cfg: PosCfg, first: number): Promise<void> {
    let cycles = 0;
    let lastK = -1;
    let lastAimed = first;
    const t0 = this.t0;
    while (!this.stopped) {
      const tickStart = performance.now();
      const t = (performance.now() - t0) / 1000;
      let target = cfg.A;
      if (cfg.kind === "hold") {
        target = cfg.A;
      } else if (cfg.kind === "recip") {
        const k = Math.floor((2 * t) / Math.max(0.05, cfg.periodS));
        target = k % 2 === 0 ? cfg.B : cfg.A;
        if (lastK >= 0 && k !== lastK && k % 2 === 0) cycles += 1;
        lastK = k;
        if (cfg.cycles > 0 && cycles >= cfg.cycles) {
          this.stopPosOnly();
          this.hooks.onLog("ok", `往复 ${cycles} 次已完成，停止下发（仍使能）`);
          return;
        }
      } else {
        target = cfg.center + cfg.amp * Math.sin((2 * Math.PI * t) / Math.max(0.05, cfg.periodS));
      }
      target = Math.max(cfg.travel.lo, Math.min(cfg.travel.hi, target));

      try {
        if (Math.abs(target - lastAimed) >= 1) {
          await this.writePos(target);
          lastAimed = target;
        }
        const v = await this.snap([
          LOOP_REG.POS_ACTUAL,
          LOOP_REG.VEL_ACTUAL,
          LOOP_REG.TF_ACTUAL,
          LOOP_REG.POS_TARGET,
        ]);
        const pos = as32(v[0]);
        const rpm = as32(v[1]) / this.countsPerRpm;
        const iqMa = s16hi(v[2]) * this.maPerCount;
        const posTgt = as32(v[3]);
        this.hooks.onState({ pos, rpm, iqMa, posTgt, rpmTgt: 0, mode: "位置", cycles });
        this.hooks.onSample({
          t: performance.now() - t0,
          pos,
          posTgt,
          rpm,
          rpmTgt: 0,
          iqMa,
          iqTgtMa: 0,
          velErrRpm: 0,
        });
      } catch (e) {
        this.hooks.onLog("error", `采样失败：${String(e)}`);
        await this.stop();
        return;
      }
      const spent = performance.now() - tickStart;
      await delay(Math.max(8, TICK_MS - spent));
    }
  }

  /** 一次性动作：切直通、写限幅、使能、写中心目标，不启动周期定时器。 */
  async moveToCenter(cfg: { center: number; iqLimitMa: number; maxRpm: number }): Promise<void> {
    this.stopped = true;
    this.phase = "idle";
    await this.saveOriginals();
    await this.setIqLimit(cfg.iqLimitMa);
    await this.setSpeedLimit(cfg.maxRpm);
    await this.enable();
    await this.setMode(MODE_POSITION);
    await this.writePos(cfg.center);
    const pos = await this.readPos();
    this.hooks.onState({ mode: "位置", pos, posTgt: cfg.center, note: "已下发中心目标" });
    this.hooks.onLog("info", `已下发中心目标 ${Math.round(cfg.center)}（当前位置 ${pos}）`);
  }

  // --------------------------------------------------- ② 速度 PI 自动辨识

  async tune(cfg: TuneCfg): Promise<TuneRow[]> {
    const list = candidates(cfg.kp0, cfg.ki0, cfg.mults);
    if (!list.length) throw new Error("倍率非法：至少要有一个正数");

    this.stopped = false;
    this.phase = "tune";
    this.t0 = performance.now();
    this.hooks.onState({ phase: "tune", cycles: 0, note: "辨识中" });
    await this.saveOriginals();
    this.hooks.onStep("读回原状态", `0x145=0x${this.orig.coeff.toString(16).toUpperCase()}`, "ok");

    // 行程巡检：不在 1/8~7/8 就先摆到中点，避免来回跑时撞到行程尽头
    const pos0 = await this.readPos();
    const span = Math.max(POS_PER_REV, cfg.travel.hi - cfg.travel.lo);
    const lo = cfg.travel.lo + Math.round(span / 8);
    const hi = cfg.travel.lo + Math.round((span * 7) / 8);
    if (pos0 < lo || pos0 > hi) {
      this.hooks.onStep("摆到行程内", `当前位置 ${pos0}，先切位置直通挪到中点`, "ok");
      await this.setIqLimit(cfg.iqLimitMa);
      await this.enable();
      await this.setMode(MODE_POSITION);
      await this.writePos(Math.round((lo + hi) / 2));
      await delay(1200);
    }

    await this.setIqLimit(cfg.iqLimitMa);
    await this.setSpeedLimit(Math.abs(cfg.rpm) * 1.2);
    await this.enable();
    await this.setMode(MODE_VELOCITY);
    this.hooks.onStep("进入速度模式", `电流上限 ${cfg.iqLimitMa} mA · 测试速度 ${cfg.rpm} RPM`, "ok");

    const rows: TuneRow[] = [];
    let best: { row: TuneRow; kp: number; ki: number } | null = null;
    const repeats = 3;
    const dwell = Math.max(0.4, cfg.dwellS);
    const settle = Math.min(0.4, dwell * 0.3);
    const satIq = 0.98 * cfg.iqLimitMa;

    for (let i = 0; i < list.length && !this.stopped; i++) {
      const { kp, ki } = list[i];
      const tStart = performance.now();
      await this.w(LOOP_REG.VEL_COEFF, (((kp & 0xffff) << 16) | (ki & 0xffff)) >>> 0);
      const samples: TuneSample[] = [];
      let sat = false;

      for (let r = 0; r < repeats && !this.stopped; r++) {
        for (const sgn of [1, -1] as const) {
          if (this.stopped) break;
          await this.writeSpeed(sgn * Math.abs(cfg.rpm));
          await delay(settle * 1000);
          const until = performance.now() + (dwell - settle) * 1000;
          while (performance.now() < until && !this.stopped) {
            const v = await this.snap([
              LOOP_REG.POS_ACTUAL,
              LOOP_REG.VEL_ACTUAL,
              LOOP_REG.TF_ACTUAL,
              LOOP_REG.VEL_TARGET,
              LOOP_REG.VEL_ERROR,
            ]);
            const pos = as32(v[0]);
            const rpm = as32(v[1]) / this.countsPerRpm;
            const rpmTgt = as32(v[3]) / this.countsPerRpm;
            const iqMa = s16hi(v[2]) * this.maPerCount;
            const err = as32(v[4]) / this.countsPerRpm;
            // 行程外的样本不计分；贴在限幅上的样本会把整组判废
            if (pos >= lo && pos <= hi) {
              if (Math.abs(iqMa) >= satIq) sat = true;
              samples.push({ err, iq: iqMa });
            }
            this.hooks.onSample({
              t: performance.now() - this.t0,
              pos,
              posTgt: 0,
              rpm,
              rpmTgt,
              iqMa,
              iqTgtMa: 0,
              velErrRpm: err,
            });
            await delay(80);
          }
        }
      }

      const s = scoreOf(samples);
      const row: TuneRow = {
        kp,
        ki,
        s,
        sat,
        note: sat ? "整组判废" : samples.length ? "" : "无有效样本",
      };
      rows.push(row);
      this.hooks.onStep(`候选 ${i + 1}/${list.length}`, `Kp=${kp} Ki=${ki}`, sat ? "fail" : "ok");
      this.hooks.onLog(
        sat ? "warn" : "info",
        `Kp=${kp} Ki=${ki} · errRMS=${Number.isFinite(s.errRms) ? s.errRms.toFixed(1) : "—"} · J=${
          Number.isFinite(s.score) ? s.score.toFixed(1) : "—"
        }${sat ? " · 顶限判废" : ""} · ${((performance.now() - tStart) / 1000).toFixed(1)} s`
      );
      if (!sat && samples.length && (!best || s.score < best.row.s.score)) best = { row, kp, ki };
    }

    // 收尾：清目标、断使能、写回最优或恢复原值、恢复限幅
    await this.writeSpeed(0);
    await this.writeIq(0);
    await this.w(LOOP_REG.VEL_INTEGRATOR, 0);
    await delay(150);
    await this.setMode(MODE_PWM_OFF);
    if (cfg.apply && best) {
      await this.w(LOOP_REG.VEL_COEFF, (((best.kp & 0xffff) << 16) | (best.ki & 0xffff)) >>> 0);
      this.hooks.onLog("ok", `已写回最优 Kp=${best.kp} Ki=${best.ki}`);
    } else {
      await this.w(LOOP_REG.VEL_COEFF, this.orig.coeff);
      this.hooks.onLog("info", "未启用「完成后应用最佳」，速度环系数已恢复原值");
    }
    await this.restoreOriginals();
    this.hooks.onState({ note: "辨识结束（电机停在 PWM_OFF）" });
    this.stopFlag();
    return rows;
  }
}
