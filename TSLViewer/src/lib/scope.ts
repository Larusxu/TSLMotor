import type { Signal } from "./presets";
import type { RtmiBatch } from "./types";

const CAP = 24_000;

export interface Series {
  ch: number;
  signal: Signal;
  t: Float32Array;
  v: Float32Array;
  head: number;
  count: number;
  color: string;
}

/**
 * Per-channel ring buffers. RTMI frames arrive in batches, so we keep a
 * monotonic clock in ms and let the renderer window it.
 */
export class ScopeStore {
  series = new Map<number, Series>();
  latest = new Map<number, number>();
  totalFrames = 0;
  /** ms of history requested by the UI */
  windowMs = 5000;
  private start = 0;

  clear() {
    for (const s of this.series.values()) {
      s.head = 0;
      s.count = 0;
    }
    this.latest.clear();
    this.totalFrames = 0;
    this.start = 0;
  }

  ensure(ch: number, signal: Signal, color: string): Series {
    const existing = this.series.get(ch);
    if (existing && existing.signal.id === signal.id) return existing;
    const s: Series = {
      ch,
      signal,
      t: new Float32Array(CAP),
      v: new Float32Array(CAP),
      head: 0,
      count: 0,
      color,
    };
    this.series.set(ch, s);
    return s;
  }

  push(batch: RtmiBatch, convert: (ch: number, raw: number) => number) {
    if (!this.start) this.start = batch.t;
    for (const [ch, raw] of batch.pts) {
      const s = this.series.get(ch);
      if (!s) continue;
      const value = convert(ch, raw);
      s.t[s.head] = batch.t - this.start;
      s.v[s.head] = value;
      s.head = (s.head + 1) % CAP;
      if (s.count < CAP) s.count += 1;
      this.latest.set(ch, value);
      this.totalFrames += 1;
    }
  }

  /** Iterate samples inside the current window, oldest first. */
  forEachInWindow(ch: number, cb: (t: number, v: number) => void) {
    const s = this.series.get(ch);
    if (!s || s.count === 0) return;
    const now = this.now();
    const from = now - this.windowMs;
    const start = s.count === CAP ? s.head : 0;
    for (let i = 0; i < s.count; i++) {
      const idx = (start + i) % CAP;
      const t = s.t[idx];
      if (t >= from) cb(t, s.v[idx]);
    }
  }

  /**
   * Wall clock in ms relative to the first sample. Batches carry `Date.now()`
   * timestamps from the backend, so the renderer must use the same clock.
   */
  now(): number {
    if (!this.start) return 0;
    return Date.now() - this.start;
  }

  bounds(channels: number[]): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const ch of channels) {
      this.forEachInWindow(ch, (_t, v) => {
        if (v < min) min = v;
        if (v > max) max = v;
      });
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
    if (max - min < 1e-9) {
      const pad = Math.max(1, Math.abs(max) * 0.1);
      return { min: min - pad, max: max + pad };
    }
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }
}
