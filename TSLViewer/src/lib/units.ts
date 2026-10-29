/**
 * Unit conversions for TMC6460.
 *
 * Current: tmc6460.pdf Table 20 — LS_RES_ON=11b (55 mΩ), CSA 4x:
 *   1 LSB = 0.00164 A / 8 × 4/4 × 0.982 = 0.20131 mA, full scale 8192 LSB = 1.65 A
 * Velocity: Table 19 with CPR × CPR_INV = 2^24 → k = 2^48 / (60 MHz × 60 × 256) = 305.4 counts/RPM
 * Position: 16-bit mechanical angle, 65536 counts = 1 rev
 * PWM: fPWM = 120 MHz / MAX_COUNT
 */

export const MA_PER_COUNT = 0.20131;
export const COUNTS_PER_RPM = 305.4;
export const POS_PER_REV = 65536;
export const POS_PER_DEG = POS_PER_REV / 360;
export const PWM_CLOCK_HZ = 120_000_000;
/** HARMONIC / BOTTOM modulation saturate at 18900 counts of the voltage vector. */
export const MODULATION_FULL_SCALE = 18900;

export const s16 = (v: number): number => (v << 16) >> 16;
export const s16lo = (v: number): number => s16(v & 0xffff);
export const s16hi = (v: number): number => s16((v >>> 16) & 0xffff);
export const u16lo = (v: number): number => v & 0xffff;
export const u16hi = (v: number): number => (v >>> 16) & 0xffff;

export const countsFromMa = (ma: number, maPerCount = MA_PER_COUNT): number =>
  Math.round(ma / maPerCount);
export const maFromCounts = (c: number, maPerCount = MA_PER_COUNT): number => c * maPerCount;
export const countsFromRpm = (rpm: number, k = COUNTS_PER_RPM): number => Math.round(rpm * k);
export const rpmFromCounts = (c: number, k = COUNTS_PER_RPM): number => c / k;

export const pwmHz = (maxCount: number): number => PWM_CLOCK_HZ / Math.max(1, maxCount);
export const maxCountForHz = (hz: number): number => Math.round(PWM_CLOCK_HZ / Math.max(1, hz));

/** SPI SCK half period field for `IO_CONTROLLER.COMMAND` (p.115). */
export const spiHalfPeriod = (hz: number): number =>
  Math.max(0, Math.min(255, Math.round(60_000_000 / (2 * hz)) - 1));

/** Effective SCK frequency for a half period value. */
export const spiHzFromHalf = (half: number): number => {
  if (half < 10) return 3_000_000;
  return 60_000_000 / ((half + 1) * 2);
};

export interface PidBits {
  pos_sampling: number;
  vel_shift: number;
  pos_norm_i: number;
  pos_norm_p: number;
  vel_norm_i: number;
  vel_norm_p: number;
  cur_norm_i: number;
  cur_norm_p: number;
  overwrite_target: boolean;
  keep_pos_target: boolean;
}

export function parsePidConfig(v: number): PidBits {
  return {
    pos_sampling: (v >>> 16) & 0x7f,
    vel_shift: (v >>> 12) & 0x0f,
    pos_norm_i: (v >>> 10) & 0x03,
    pos_norm_p: (v >>> 8) & 0x03,
    vel_norm_i: (v >>> 6) & 0x03,
    vel_norm_p: (v >>> 4) & 0x03,
    cur_norm_i: (v >>> 3) & 0x01,
    cur_norm_p: (v >>> 2) & 0x01,
    overwrite_target: ((v >>> 1) & 1) === 1,
    keep_pos_target: (v & 1) === 1,
  };
}

export function composePidConfig(b: PidBits): number {
  return (
    ((b.pos_sampling & 0x7f) << 16) |
    ((b.vel_shift & 0x0f) << 12) |
    ((b.pos_norm_i & 3) << 10) |
    ((b.pos_norm_p & 3) << 8) |
    ((b.vel_norm_i & 3) << 6) |
    ((b.vel_norm_p & 3) << 4) |
    ((b.cur_norm_i & 1) << 3) |
    ((b.cur_norm_p & 1) << 2) |
    (b.overwrite_target ? 1 << 1 : 0) |
    (b.keep_pos_target ? 1 : 0)
  );
}

/** Fractional bits for the P coefficients, per controller. */
export const P_FRACS = [0, 8, 16, 24] as const;
/** Fractional bits for the I coefficients: index 0 is Q8.8. */
export const I_FRACS_CURRENT = [0, 8] as const;
export const I_FRACS = [8, 16, 24, 32] as const;

export function pFrac(sel: number): number {
  return P_FRACS[Math.max(0, Math.min(3, sel))];
}
export function iFrac(sel: number, current = false): number {
  const table = current ? I_FRACS_CURRENT : I_FRACS;
  return table[Math.max(0, Math.min(table.length - 1, sel))];
}

/** Convert a raw coefficient register into a real gain. */
export function coefToGain(reg: number, frac: number): number {
  return reg / Math.pow(2, frac);
}
/** Convert a real gain into a raw coefficient register value. */
export function gainToCoef(gain: number, frac: number): number {
  return Math.round(gain * Math.pow(2, frac));
}

export const NORM_P_LABELS = ["No shift / Q16.0", "Shift by 8 / Q8.8", "Shift by 16 / Q0.16", "Shift by 24 / Q0.24"];
export const NORM_I_LABELS = ["Shift by 8 / Q8.8", "Shift by 16 / Q0.16", "Shift by 24 / Q0.24", "Shift by 32 / Q0.32"];
export const CUR_NORM_LABELS = ["No shift / Q16.0", "Shift by 8 / Q8.8"];

/** Suggested PI for a target bandwidth; matches the bench-verified legacy tuning. */
export function suggestPi(rOhm: number, lUh: number, fBw: number, fPwm: number) {
  const l = lUh * 1e-6;
  const kp = 2 * Math.PI * fBw * l;
  const ki = 2 * Math.PI * fBw * rOhm;
  const p = clamp(Math.round(kp * 256), 1, 32767);
  const i = clamp(Math.round((ki / Math.max(1, fPwm)) * 256), 0, 32767);
  return { p, i, kp, ki };
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function fmt(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

export function hex(v: number | null | undefined, width = 8): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const n = v >>> 0;
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

export function bin(v: number, width = 32): string {
  return (v >>> 0).toString(2).padStart(width, "0");
}

/** Die temperature raw → °C. The datasheet only publishes a 12-bit ADC; the
 * 16-bit field is left-shifted, so 1 LSB ≈ 1/16 °C once calibrated. */
export function tempC(raw: number, offset = 0): number {
  return s16(raw) / 16 + offset;
}

/** MT6701 SSI CRC-6, polynomial x^6 + x + 1, over D[13:0] + Mg[3:0]. */
export function mt6701Crc6(data18: number): number {
  let crc = 0;
  for (let i = 17; i >= 0; i--) {
    const bit = (data18 >>> i) & 1;
    crc = ((crc << 1) | bit) & 0x7f;
    if (crc & 0x40) crc ^= 0x43;
  }
  return crc & 0x3f;
}

export interface SsiFrame {
  angle: number;
  mg: number;
  crc: number;
  crcOk: boolean | null;
}

/** Decode a 24-bit MT6701 SSI word (D13..D0 | Mg3..0 | CRC5..0). */
export function decodeMt6701(word: number): SsiFrame {
  const w = word & 0xffffff;
  const angle = (w >>> 10) & 0x3fff;
  const mg = (w >>> 6) & 0x0f;
  const crc = w & 0x3f;
  const data18 = w >>> 6;
  return { angle, mg, crc, crcOk: mt6701Crc6(data18) === crc };
}

export const MG_LABELS: Record<number, string> = {
  0: "磁场正常",
  1: "磁场过强",
  2: "磁场太弱",
  3: "—",
};

export function mgText(mg: number): string {
  const field = MG_LABELS[mg & 0x03];
  const push = mg & 0x04 ? " · 按压" : "";
  const speed = mg & 0x08 ? " · 超速" : "";
  return field + push + speed;
}
