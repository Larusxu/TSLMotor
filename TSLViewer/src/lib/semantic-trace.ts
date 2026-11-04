import type { SemanticView } from "./semantic-state";
import type { RtmiBatch } from "./types";

export const MAIN_TRACE_SIGNALS = ["vel_act", "torque", "pos_act"];

/** Adapter to the original raw-batch ScopeStore pipeline. It never polls UART,
 * invents missing register values, or converts duplicate state replies to samples. */
export class SemanticTrace {
  private motor = 0;
  private boot = "";
  private last = -1;
  private channels: (string | null)[] = [];
  start(motor: number, boot: string, channels: (string | null)[]) {
    const missing = channels.filter(id => id && !MAIN_TRACE_SIGNALS.includes(id));
    if (missing.length) throw Error(`当前主控固件未提供这些遥测信号：${missing.join("、")}。请使用实际转速、力矩电流或实际位置。`);
    if (!channels.some(Boolean)) throw Error("请先选择至少一个信号");
    this.motor = motor; this.boot = boot; this.last = -1; this.channels = [...channels];
  }
  stop() { this.motor = 0; this.last = -1; this.channels = []; }
  accept(view: SemanticView, now: number): RtmiBatch | null {
    const s = view.state;
    if (!this.motor || view.motor !== this.motor || view.bootId !== this.boot ||
        !view.device || !s?.feedback_fresh || now < view.receivedAt || now-view.receivedAt > 2000 ||
        s.sampled_at_ms === this.last) return null;
    this.last = s.sampled_at_ms;
    const raw: Record<string, number> = {
      vel_act: s.velocity_raw,
      torque: (s.iq_raw & 65535) << 16,
      pos_act: Number(BigInt(s.position)),
    };
    return { t: now, pts: this.channels.flatMap((id, ch) => id ? [[ch, raw[id]] as [number, number]] : []) };
  }
}
