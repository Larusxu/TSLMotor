import { useEffect, useRef, useState } from "react";
import { api, invokeCommand } from "./api";
import type { MotorState, SemanticReply } from "./semantic-state";
import { acquisitionLane } from "./pi-auto/acquisition";

export interface FleetMotor { state: MotorState | null; at: number; sampleAt: number; error: string }

/** One MAX20087 output channel: the supply of exactly one motor. */
export interface PowerOutput {
  enabled: boolean | null;
  fault: string;
  live: boolean;
  /** Output current in mA (3 mA per ADC count). */
  current_ma: number | null;
  /** Output voltage in mV (70 mV per ADC count). */
  voltage_mv: number | null;
  /** The motor answered the boot discovery pass. */
  tmcOnline: boolean;
  /** The motor is left at the board rate instead of the factory 115200. */
  tmcBoardRate: boolean;
}

export interface MaxChannel {
  output: number; motor: number | null; enabled: boolean | null; fault: string;
  current_ma: number | null; voltage_mv: number | null;
}

/** One MAX20087 chip: chip-locally measured rails plus its four channels. */
export interface MaxChip {
  index: number; name: string; valid: boolean; id: number; config: number;
  diagnosticsLive: boolean; stat1: number; stat2: [number, number];
  fault: string; vin_mv: number | null; vdd_mv: number | null; viset_mv: number | null;
  current_limit_ma: number | null;
  channels: MaxChannel[];
}

/** Chip order fixed by the board file: U10, U7, U14, U13. */
export const MAX_CHIPS = ["U10", "U7", "U14", "U13"];
/** Static channel ownership from boards/hpm6e8y_evk.dts `motor-ids` (OUT1..OUT4). */
export const STATIC_CHANNEL_MOTORS: number[][] = [
  [3, 5, 4, 6],      // U10
  [2, 15, 1, 16],    // U7
  [9, 8, 10, 7],     // U14
  [13, 11, 14, 12],  // U13
];
const MOTOR_WORDS = 8, MOTOR_COUNT = 16, CHIP_WORDS = 12, CHIP_COUNT = 4;
/** Snapshot blocks read with main-control operation 10 (BOARD). */
export const CHIP_BLOCK = { offset: 80, count: CHIP_COUNT * CHIP_WORDS };
export const MOTOR_BLOCK_A = { offset: 128, count: 64 };
export const MOTOR_BLOCK_B = { offset: 192, count: 64 };

export function words(bytes: number[], count: number) {
  if (bytes.length !== count * 2) throw Error("主控快照长度错误");
  return Array.from({ length: count }, (_, i) => bytes[i * 2] * 256 + bytes[i * 2 + 1]);
}

const CHIP_FAULTS: [number, string][] = [
  [32, "限流设置异常"], [8, "输入过压"], [4, "输入欠压"], [2, "逻辑电源过压"], [1, "逻辑电源欠压"],
];
const CHANNEL_FAULTS: [number, string][] = [
  [8, "供电过温"], [4, "供电过流"], [2, "输入过压"], [1, "输入欠压"],
];
const join = (bits: number, table: [number, string][]) =>
  table.filter(([bit]) => bits & bit).map(([, label]) => label).join(" / ");

function supplyFault(enabled: boolean, common: number, channel: number) {
  return enabled ? [join(common, CHIP_FAULTS), join(channel, CHANNEL_FAULTS)].filter(Boolean).join(" / ") : "";
}
function measuredVoltageFault(row: number[]) {
  if(row[5]!==1 || !(row[7]&8))return "";
  const mv=row[4]*70;
  return mv<4500 ? "输入欠压" : mv>5500 ? "输入过压" : "";
}
/** MAX20087 Rev.7 pp3,17: 12.5uA typ; ILIM=600mA*RISET/100kohm.
 * ADC-derived estimate, not a calibrated current-trip measurement. */
export function currentLimitEstimate(mv: number, fault: boolean) {
  const ma = mv * 0.48;
  return !fault && ma >= 100 && ma <= 600 ? ma : null;
}

export function decodePower(chips: number[], motors: number[]): PowerOutput[] {
  if (chips.length !== CHIP_COUNT * CHIP_WORDS || motors.length !== MOTOR_COUNT * MOTOR_WORDS)
    throw Error("供电快照不完整");
  const unknown: PowerOutput = {
    enabled: null, fault: "", live: false, current_ma: null, voltage_mv: null,
    tmcOnline: false, tmcBoardRate: false,
  };
  return Array.from({ length: MOTOR_COUNT }, (_, i) => {
    const row = motors.slice(i * MOTOR_WORDS, i * MOTOR_WORDS + MOTOR_WORDS), base = row[1] * CHIP_WORDS, output = row[2] - 1;
    if (base > (CHIP_COUNT - 1) * CHIP_WORDS || output < 0 || output > 3 || !row[6] || !chips[base])
      return { ...unknown, tmcOnline: !!(row[7] & 2), tmcBoardRate: !!(row[7] & 4) };
    const common = chips[base + 4] & 0x2f;
    const channel = (chips[base + 5 + Math.floor(output / 2)] >>> (4 * (output % 2))) & 15;
    return {
      enabled: row[5] === 0xffff ? null : row[5] === 1,
      fault: supplyFault(row[5] === 1, common, channel) || measuredVoltageFault(row),
      live: !!chips[base + 3],
      current_ma: row[3] * 3,
      voltage_mv: row[4] * 70,
      tmcOnline: !!(row[7] & 2),
      tmcBoardRate: !!(row[7] & 4),
    };
  });
}

/** Chip cards need the same snapshot re-grouped by device instead of by motor. */
export function decodeChips(chips: number[], motors: number[]): MaxChip[] {
  if (chips.length !== CHIP_COUNT * CHIP_WORDS || motors.length !== MOTOR_COUNT * MOTOR_WORDS) return [];
  const rows = Array.from({ length: MOTOR_COUNT }, (_, i) =>
    motors.slice(i * MOTOR_WORDS, i * MOTOR_WORDS + MOTOR_WORDS));
  return Array.from({ length: CHIP_COUNT }, (_, c) => {
    const base = c * CHIP_WORDS, valid = !!chips[base], stat2: [number, number] = [chips[base + 5], chips[base + 6]];
    return {
      index: c, name: MAX_CHIPS[c], valid, id: chips[base + 1], config: chips[base + 2],
      diagnosticsLive: !!chips[base + 3], stat1: chips[base + 4], stat2,
      fault: chips[base+3] && (chips[base+2]&15) ? join(chips[base + 4] & 0x2f, CHIP_FAULTS) : "",
      vin_mv: valid ? chips[base + 8] * 70 : null,
      vdd_mv: valid ? chips[base + 9] * 25 : null,
      viset_mv: valid ? chips[base + 10] * 5 : null,
      current_limit_ma: valid ? currentLimitEstimate(chips[base+10]*5, !!(chips[base+4]&32)) : null,
      channels: Array.from({ length: 4 }, (_, o) => {
        const index = rows.findIndex((r) => r[1] === c && r[2] === o + 1);
        const row = index < 0 ? null : rows[index];
        return {
          output: o + 1,
          motor: index < 0 ? STATIC_CHANNEL_MOTORS[c]?.[o] ?? null : index + 1,
          enabled: row ? (row[5] === 0xffff ? null : row[5] === 1) : null,
          fault: supplyFault(row?.[5] === 1, chips[base+4]&0x2f, (stat2[Math.floor(o / 2)] >>> (4 * (o % 2))) & 15) || (row ? measuredVoltageFault(row) : ""),
          current_ma: row ? row[3] * 3 : null,
          voltage_mv: row ? row[4] * 70 : null,
        };
      }),
    };
  });
}

/** Read MCU snapshots only: never focus a UART, claim a session or probe a TMC. */
export function useFleet(connected: boolean, mode: string, streaming: boolean) {
  const streamingRef = useRef(streaming); streamingRef.current = streaming;
  const [motors, setMotors] = useState<Record<number, FleetMotor>>({});
  const [power, setPower] = useState<PowerOutput[]>([]);
  const [chips, setChips] = useState<MaxChip[]>([]);
  const [powerAt, setPowerAt] = useState(0);
  const [firmware, setFirmware] = useState("");
  const [bootId, setBootId] = useState("");
  const refresh = useRef<() => Promise<PowerOutput[]>>(async () => []);
  useEffect(() => {
    setMotors({}); setPower([]); setChips([]); setPowerAt(0); setFirmware(""); setBootId("");
    if (!connected || mode === "direct") return;
    let alive = true, pending = false, motor = 1, sequence = 0, boot = "", nextPower = 0, versionRead = false;
    /** One supply snapshot: chip block plus both motor halves of the same sequence. */
    let powerRead: Promise<PowerOutput[]> | null = null;
    const readPower = (): Promise<PowerOutput[]> => {
      if (powerRead) return powerRead;
      powerRead = (async () => {
      const chipWords = words(await api.mainControl(0, 10, [CHIP_BLOCK.offset, CHIP_BLOCK.count]), CHIP_BLOCK.count);
      if (!alive) return [];
      const first = words(await api.mainControl(0, 10, [MOTOR_BLOCK_A.offset, MOTOR_BLOCK_A.count]), MOTOR_BLOCK_A.count);
      if (!alive) return [];
      const last = words(await api.mainControl(0, 10, [MOTOR_BLOCK_B.offset, MOTOR_BLOCK_B.count]), MOTOR_BLOCK_B.count);
      if (!alive) return [];
      const rows = [...first, ...last];
      const result = decodePower(chipWords, rows);
      setPower(result); setChips(decodeChips(chipWords, rows)); setPowerAt(Date.now());
      return result;
      })().finally(() => { powerRead = null; });
      return powerRead;
    };
    // A switch flip must show its new state without waiting for the slow poll.
    refresh.current = async () => {
      if (!alive) throw Error("连接已改变");
      // Explicit power commands read MCU/MAX snapshots, outside the TMC sampling lane.
      // Finish an older read first, then confirm the state after the command.
      if (powerRead) await powerRead.catch(() => []);
      const result = await readPower(); nextPower = Date.now() + 1500; return result;
    };
    const poll = async () => {
      if (!alive || pending || acquisitionLane.busy() || streamingRef.current) return;
      pending = true;
      try {
        const reply = await invokeCommand<SemanticReply>("motor_semantic", { motor, request: {
          request_id: ++sequence, boot_id: "0", session_id: 0, task_id: 0, command: { kind: "get_state" },
        } });
        if (!alive) return;
        if (reply.result || !reply.motor) throw Error(reply.result_name);
        if (boot && boot !== reply.boot_id) {
          setMotors({}); setPower([]); setChips([]); setPowerAt(0); versionRead = false;
        }
        boot = reply.boot_id; setBootId(boot);
        const id = motor;
        const sampleAt = Date.now() - ((reply.timestamp_ms - reply.motor.sampled_at_ms) >>> 0);
        setMotors(old => ({ ...old, [id]: { state: reply.motor, at: Date.now(), sampleAt, error: "" } }));
        motor = motor % 16 + 1;
        if (Date.now() >= nextPower && !acquisitionLane.busy()) {
          nextPower = Date.now() + 2000;
          try { await readPower(); } catch { /* keep the last complete snapshot */ }
        }
        if (!versionRead && !acquisitionLane.busy()) {
          const data = await api.mainControl(0, 10, [8, 32]);
          if (alive) setFirmware(String.fromCharCode(...data).replace(/\0/g, " ").trim());
          versionRead = true;
        }
      } catch (e) {
        const id = motor;
        if (alive) setMotors(old => ({ ...old, [id]: { state: old[id]?.state ?? null, at: old[id]?.at ?? 0, sampleAt: old[id]?.sampleAt ?? 0, error: String(e) } }));
        motor = motor % 16 + 1;
      } finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 200);
    return () => { alive = false; refresh.current = async () => []; clearInterval(timer); };
  }, [connected, mode]);
  return { motors, power, chips, powerAt, firmware, bootId, refreshPower: () => refresh.current() };
}
