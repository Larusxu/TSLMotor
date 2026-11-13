import type { SemanticMotion } from "./semantic-motion";

export function parseJogMotors(text: string): number[] {
  const parts = text.split(",").map(value => value.trim());
  if (parts.some(value => !/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 16))
    throw Error("请输入 1–16 的电机编号，使用英文逗号分隔，例如 1,5,9");
  return [...new Set(parts.map(Number))];
}

export function jogTargets(selected: number, multiple: boolean, text: string): number[] {
  return [...new Set([selected, ...(multiple && text.trim() ? parseJogMotors(text) : [])])];
}

/** Commands share the existing serial queue/session. Each accepted lane keeps
 * its own task ID and lease; releasing a button stops every attempted lane. */
export class MultiOpenLoopJog {
  private generation = 0;
  private active = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing = false;
  private starting: Promise<void> = Promise.resolve();
  constructor(private motion: Pick<SemanticMotion, "initialize" | "wait" | "command" | "stop" | "owned">,
    private onError: (error: unknown) => void) {}

  start(motors: number[], velocity: number): Promise<void> {
    if (!motors.length || motors.some(m => !Number.isInteger(m) || m < 1 || m > 16))
      return Promise.reject(Error("请选择有效电机编号"));
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const run = async () => {
      // Complete initialization before any lane moves.
      for (const motor of new Set(motors)) {
        if (!current()) return;
        await this.motion.initialize(motor);
        await this.motion.wait(motor, 5000, r => !!r.motor?.config_verified &&
          !!r.motor.limits_valid && !!r.motor.feedback_fresh);
      }
      if (!current()) return;
      this.timer = setInterval(() => void this.renew(generation), 150);
      for (const motor of new Set(motors)) {
        if (!current()) return;
        // Track before sending: a lost reply can still mean an accepted START.
        this.active.set(motor, Date.now());
        await this.motion.command(motor, {kind:"open_loop_start", velocity_raw:velocity, lease_ms:700}, current);
        if (!current()) return;
        await this.motion.wait(motor, 5000, r => !!r.motor?.motion_active);
      }
    };
    this.starting = run().catch(async error => {
      if (!current()) return;
      ++this.generation; this.clearTimer();
      await this.stopActive();
      throw error;
    });
    return this.starting;
  }

  private clearTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async renew(generation: number) {
    if (this.renewing || generation !== this.generation) return;
    this.renewing = true;
    try {
      if (!this.motion.owned()) throw Error("连接已结束，多路点动已停止");
      for (const [motor, sentAt] of this.active) {
        if (generation !== this.generation) return;
        if (Date.now() - sentAt >= 550) throw Error(`M${motor} 点动续租超时，已停止多路点动`);
        const at = Date.now();
        const r = await this.motion.command(motor, {kind:"jog_renew"}, () => generation === this.generation);
        if (r.motor?.fault) throw Error(`M${motor} 点动已停止`);
        if (generation === this.generation) this.active.set(motor, at);
      }
    } catch (error) {
      if (generation === this.generation) {
        try { await this.stop(); } catch (stopError) { this.onError(stopError); }
        this.onError(error);
      }
    } finally { this.renewing = false; }
  }
  private async stopActive() {
    const motors = [...this.active.keys()]; this.active.clear();
    const results = await Promise.allSettled(motors.map(motor => this.motion.stop(motor, true)));
    const failed = results.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async stop() {
    ++this.generation; this.clearTimer();
    await this.starting.catch(() => undefined);
    await this.stopActive();
  }
}
