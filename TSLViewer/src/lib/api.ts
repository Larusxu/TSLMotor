/**
 * Thin typed wrapper over the Rust commands.
 *
 * 只有桌面（Tauri）后端：所有串口/运动/存储操作都在 Rust 侧完成，前端只发指令、渲染事件。
 * 没有浏览器模拟器——上位机必须在 `src-tauri/target/release/tslviewer.exe` 里运行。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AxisLimits,
  AxisState,
  JobDone,
  JobProgress,
  LimitEvent,
  LinkStats,
  LogLine,
  MoveCfgPayload,
  PidSnapshot,
  PortInfo,
  RtmiBatch,
  SnapItem,
  TmcProbe,
  StoreParams,
  EepromProbe,
  EepromSave,
  EepromLoad,
  HomingConfig,
  HomingParams,
  HomingState,
} from "./types";

type EventMap = {
  "tsl:rtmi": RtmiBatch;
  "tsl:log": LogLine;
  "tsl:job:progress": JobProgress;
  "tsl:job:done": JobDone;
  "tsl:limit": LimitEvent;
};

/**
 * 浏览器里跑（`start-web.ps1` 的排版预览）时没有桌面后端：明确拒绝，不伪造任何数据。
 * 文案要一眼能看出"不是坏了，是没后端"。
 */
const DESKTOP =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);

const NO_BACKEND = "当前是浏览器排版预览，没有桌面通信后端。请用 tslviewer.exe 或 npm run app:dev 打开";

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!DESKTOP) return Promise.reject(new Error(NO_BACKEND));
  return tauriInvoke<T>(command, args);
}

/** 其它模块（语义状态/运动、控制、存储）统一走这里，浏览器里得到同一条可读错误。 */
export function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export async function on<K extends keyof EventMap>(
  event: K,
  cb: (payload: EventMap[K]) => void
): Promise<UnlistenFn> {
  if (!DESKTOP) return () => undefined;
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
  homingStart: (params: HomingParams, motor: number) => invoke<void>("homing_start", { params, motor }),
  homingState: (motor: number) => invoke<HomingState>("homing_state", { motor }),
  homingCancel: (motor: number) => invoke<void>("homing_cancel", { motor }),
  homingWriteConfig: (cfg: HomingConfig, motor: number) =>
    invoke<void>("homing_write_config", { cfg, motor }),
  homingReadConfig: (motor: number) => invoke<HomingConfig>("homing_read_config", { motor }),
};

export const api = real;
