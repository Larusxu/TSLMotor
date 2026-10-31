/**
 * Machine profiles and signal catalogue.
 *
 * The Tesla profile is taken from the legacy firmware
 * (Tesla_hand_temp_176/applications/motor_config.h) and the legacy bench
 * console (tmc6460_upper_pc). Values marked "legacy" reproduce the values that
 * were actually flashed in production.
 */

export interface EncoderPreset {
  id: string;
  label: string;
  frameBits: number;
  spiMode: number;
  spiHz: number;
  idleCycles: number;
  sendData: string;
  cpr: number;
  /** CPR_INV = 2^24 / cpr */
  csnViaEncN: boolean;
}

export const ENCODER_PRESETS: EncoderPreset[] = [
  {
    id: "mt6701-14",
    label: "MT6701 · SSI 14-bit",
    frameBits: 14,
    spiMode: 1,
    spiHz: 2_000_000,
    idleCycles: 16,
    sendData: "0x00000000",
    cpr: 16_384,
    csnViaEncN: true,
  },
  {
    id: "mt6701-24",
    label: "MT6701 · SSI 24-bit 完整帧",
    frameBits: 24,
    spiMode: 1,
    spiHz: 2_000_000,
    idleCycles: 48,
    sendData: "0x00000000",
    cpr: 16_384,
    csnViaEncN: true,
  },
];

export interface StoragePreset {
  id: string;
  label: string;
  /** 容量 / 接口，显示在下拉框右上角。 */
  spec: string;
}

/** 板上那颗存储芯片。选 "none" 表示板子上没有装。 */
export const STORAGE_PRESETS: StoragePreset[] = [
  {
    id: "m24c02",
    label: "M24C02-FMH6TG · 256 字节",
    spec: "I²C EEPROM · 2 Kbit",
  },
  {
    id: "none",
    label: "无 / 不使用",
    spec: "未装存储",
  },
];

export interface TeslaProfile {
  name: string;
  poles: number;
  cpr: number;
  csaGain: number;
  pwmMaxCount: number;
  maPerCount: number;
  countsPerRpm: number;
  pid: {
    curP: number;
    curI: number;
    velP: number;
    velI: number;
    posP: number;
    posI: number;
  };
  limits: {
    torqueMa: number;
    fluxMa: number;
    velRpm: number;
    uqUd: number;
  };
  /** Legacy bench-tuned current loop (upper_pc step_response.py). */
  bench: { rOhm: number; lUh: number; bandwidthHz: number; p: number; i: number };
}

export const TESLA_PROFILE: TeslaProfile = {
  name: "Tesla hand · TMC6460",
  poles: 1,
  cpr: 16_384,
  csaGain: 3,
  pwmMaxCount: 4800,
  maPerCount: 0.20131,
  countsPerRpm: 305.4,
  pid: { curP: 64, curI: 48, velP: 500, velI: 250, posP: 500, posI: 0 },
  limits: { torqueMa: 800, fluxMa: 0, velRpm: 25_000, uqUd: 0x5a81 },
  bench: { rOhm: 2.01, lUh: 111.8, bandwidthHz: 2000, p: 359, i: 129 },
};

/** Per-motor electrical offsets from the legacy firmware table. */
export const PHI_E_OFFSETS: { name: string; offset: number }[] = [
  { name: "TMC_01", offset: 0x3663 },
  { name: "TMC_03", offset: 0x4667 },
  { name: "TMC_04", offset: 0x5f41 },
  { name: "TMC_06", offset: 0x0e0f },
  { name: "TMC_09", offset: 0xdc65 },
  { name: "TMC_10", offset: 0x0f6a },
  { name: "TMC_11", offset: 0x3e43 },
  { name: "TMC_12", offset: 0xf847 },
  { name: "TMC_13", offset: 0x698c },
  { name: "TMC_14", offset: 0xc69d },
  { name: "TMC_15", offset: 0x2265 },
  { name: "TMC_16", offset: 0xc15a },
  { name: "TMC_17", offset: 0x41d9 },
  { name: "TMC_18", offset: 0x5c26 },
];

export const BAUD_RATES = [115200, 230400, 460800, 921600, 1_500_000, 2_000_000, 3_000_000];

// ---------------------------------------------------------------------------
// streaming signals
// ---------------------------------------------------------------------------

export type SignalKind =
  | "velocity"
  | "position"
  | "torque"
  | "flux"
  | "current"
  | "voltage"
  | "raw"
  | "temp";

export interface Signal {
  id: string;
  addr: number;
  label: string;
  unit: string;
  kind: SignalKind;
  color: string;
}

/** Registers worth watching live; `kind` drives the conversion. */
export const SIGNALS: Signal[] = [
  { id: "vel_act", addr: 0x154, label: "实际转速", unit: "RPM", kind: "velocity", color: "var(--ch-0)" },
  { id: "vel_tgt", addr: 0x150, label: "目标转速", unit: "RPM", kind: "velocity", color: "var(--ch-1)" },
  { id: "torque", addr: 0x153, label: "力矩电流 iQ", unit: "mA", kind: "torque", color: "var(--ch-2)" },
  { id: "flux", addr: 0x153, label: "磁链电流 iD", unit: "mA", kind: "flux", color: "var(--ch-3)" },
  { id: "is", addr: 0x171, label: "电流矢量", unit: "LSB", kind: "current", color: "var(--ch-4)" },
  { id: "us", addr: 0x171, label: "电压矢量", unit: "LSB", kind: "voltage", color: "var(--ch-5)" },
  { id: "pos_act", addr: 0x155, label: "实际位置", unit: "°", kind: "position", color: "var(--ch-6)" },
  { id: "pos_tgt", addr: 0x152, label: "目标位置", unit: "°", kind: "position", color: "var(--ch-1)" },
  { id: "phi_e", addr: 0x251, label: "电角度", unit: "°e", kind: "raw", color: "var(--ch-0)" },
  { id: "vel_err", addr: 0x159, label: "速度误差", unit: "RPM", kind: "velocity", color: "var(--ch-2)" },
  { id: "temp", addr: 0x084, label: "芯片结温", unit: "°C", kind: "temp", color: "var(--ch-3)" },
  { id: "iq", addr: 0x168, label: "Iq", unit: "LSB", kind: "raw", color: "var(--ch-4)" },
  { id: "uq", addr: 0x169, label: "Uq", unit: "LSB", kind: "raw", color: "var(--ch-5)" },
  { id: "ramp_v", addr: 0x1d0, label: "斜坡速度", unit: "RPM", kind: "velocity", color: "var(--ch-6)" },
];

export interface Polar { max: number; min: number }

/**
 * Convert a raw register value into engineering units.
 * `polarity` flips the sign for velocity/torque so the trace matches the
 * direction the motor actually turns.
 */
export function convertSignal(
  sig: Signal,
  raw: number,
  cal: { maPerCount: number; countsPerRpm: number; poles: number; polarity: number; tempOffset: number }
): number {
  const p = cal.polarity;
  switch (sig.kind) {
    case "velocity":
      return (raw / cal.countsPerRpm) * p;
    case "position":
      return ((raw % 65536) / 65536) * 360;
    case "torque":
      return ((raw >>> 16) << 16 >> 16) * cal.maPerCount * p;
    case "flux":
      return ((raw & 0xffff) << 16 >> 16) * cal.maPerCount * p;
    case "current":
      return raw & 0xffff;
    case "voltage":
      return (raw >>> 16) & 0xffff;
    case "temp":
      return raw / 16 + cal.tempOffset;
    default:
      return raw;
  }
}

/** Which half of the 32-bit register a signal reads (0 = whole word). */
export function signalSource(sig: Signal): "lo" | "hi" | "all" {
  if (sig.id === "torque" || sig.id === "us" || sig.id === "uq") return "hi";
  if (sig.id === "flux" || sig.id === "is" || sig.id === "iq" || sig.id === "phi_e") return "lo";
  return "all";
}
