export interface PortInfo {
  name: string;
  kind: string;
  detail: string;
}

export interface LinkStats {
  connected: boolean;
  port: string;
  baud: number;
  rtmi_running: boolean;
  tx_bytes: number;
  rx_bytes: number;
  rtmi_frames: number;
  rtmi_dropped: number;
  frame_rate: number;
  channels: number[];
  sampling: number;
  trigger_hz: number;
}

export interface LogLine {
  ts: number;
  level: "info" | "ok" | "warn" | "error";
  source: string;
  message: string;
}

export interface RtmiBatch {
  t: number;
  pts: [number, number][];
}

/** Result of one CHIP.ID probe; `tries` counts read attempts spent. */
export interface TmcProbe {
  motor: number;
  online: boolean;
  chip_id: number | null;
  tries: number;
}

export interface SnapItem {
  addr: number;
  value: number | null;
  error: string | null;
}

export interface JobProgress {
  job: string;
  idx: number;
  total: number;
  label: string;
  status: "run" | "ok" | "fail" | "info";
  detail: string;
}

export interface JobDone {
  job: string;
  ok: boolean;
  message: string;
  data: unknown;
}

export interface PidSnapshot {
  config: number;
  flux_coeff: number;
  torque_coeff: number;
  vel_coeff: number;
  pos_coeff: number;
  tf_limits: number;
  vel_limit: number;
  uq_ud_limit: number;
  integrators?: number[];
}

export interface CalibGroup {
  deg: number;
  n: number;
  avg: number;
  unwrapped: number;
  residual: number;
}

export interface CalibResult {
  offset: number;
  offset_hex: string;
  intercept: number;
  slope: number;
  r2: number;
  points: { deg: number; enc: number }[];
  groups: CalibGroup[];
  written: boolean;
}

export interface StepMetrics {
  rise_ms: number;
  settle_ms: number;
  overshoot_pct: number;
  steady_error: number;
  peak: number;
  ripple: number;
  samples: number;
}

export interface StepResult {
  kind: string;
  amplitude: number;
  unit: string;
  time: number[];
  target: number[];
  actual: number[];
  metrics: StepMetrics;
  p_reg: number;
  i_reg: number;
}

export interface SeqRow {
  t_ms: number;
  target_rpm: number;
  actual_rpm: number;
  current_ma: number;
  temp_c: number;
}

export interface SeqSummary {
  window: string;
  n: number;
  mean_rpm: number;
  std_rpm: number;
  ripple_pct: number;
  mean_current_ma: number;
  max_current_ma: number;
  max_temp_c: number;
  verdict: string;
}

export interface SeqResult {
  rows: SeqRow[];
  summary: SeqSummary[];
  csv_path: string;
}

export interface EncoderCfgPayload {
  preset: string;
  frame_bits: number;
  spi_mode: number;
  spi_hz: number;
  idle_cycles: number;
  data_mask: number;
  send_data: number;
  csn_via_enc_n: boolean;
  cpr: number;
  poles: number;
  phi_e_offset: number;
  pwm_max_count: number;
  csa_gain: number;
  vel_frq_conf: number;
  vel_per_conf: number;
  write_velocity_cfg: boolean;
}

export interface PidCfgPayload {
  flux_p: number;
  flux_i: number;
  torque_p: number;
  torque_i: number;
  vel_p: number;
  vel_i: number;
  pos_p: number;
  pos_i: number;
  cur_norm_p: number;
  cur_norm_i: number;
  vel_norm_p: number;
  vel_norm_i: number;
  pos_norm_p: number;
  pos_norm_i: number;
  vel_shift: number;
  pos_sampling: number;
  overwrite_target: boolean;
  keep_pos_target: boolean;
  torque_limit_ma: number;
  flux_limit_ma: number;
  vel_limit_rpm: number;
    velocity_mode_limit_rpm?: number;
  uq_ud_limit: number;
  ma_per_count: number;
  counts_per_rpm: number;
}

export interface CalibCfgPayload {  flux_ma: number;
  poles: number;
  settle_ms: number;
  step_deg: number;
  end_deg: number;
  ma_per_count: number;
  write_back: boolean;
  dry_run: boolean;
  /** 编码器 CPR，决定 16 位换算比例 65536/CPR（16384 → ×4） */
  cpr: number;
}

export interface StepCfgPayload {
  kind: "current" | "velocity";
  amplitude: number;
  duration_ms: number;
  poles: number;
  ma_per_count: number;
  counts_per_rpm: number;
  r_ohm: number;
  l_uh: number;
  bandwidth_hz: number;
  sampling: number;
  current_p: number;
  current_i: number;
  velocity_p: number;
  velocity_i: number;
}

export interface SeqCfgPayload {
  serial: string;
  operator: string;
  note: string;
  steps: { rpm: number; hold_s: number }[];
  poles: number;
  counts_per_rpm: number;
  ma_per_count: number;
  tolerance_pct: number;
  settle_s: number;
  mode: "closed" | "open";
  open_ud: number;
}

export interface AxisLimits {
  enabled: boolean;
  /** RTMI channel carrying the position feedback. */
  ch: number;
  /** Soft limits in encoder counts. */
  min: number;
  max: number;
  /** "loose" keeps the loop holding, "brake" drops PWM + gate drive. */
  action: string;
}

export interface AxisState {
  limits: AxisLimits;
  pos: number;
  tripped: boolean;
  done: boolean;
  moving: boolean;
  cmd_rpm: number;
}

export interface MoveCfgPayload {
  target: number;
  tol: number;
  max_rpm: number;
  accel: number;
  cpr: number;
  poles: number;
}

export interface LimitEvent {
  pos: number;
  min: number;
  max: number;
  action: string;
  at: number;
}
// --------------------------------------------------------------- EEPROM 存储

/** 与 Rust `storage::StoreParams` 一一对应（字段顺序即 EEPROM 载荷顺序）。 */
export interface StoreParams {
  cpr: number;
  poles: number;
  csa_gain: number;
  pwm_max_count: number;
  phi_e_offset: number;
  torque_limit_ma: number;
  flux_limit_ma: number;
  vel_limit_rpm: number;
  uq_ud_limit: number;
  cur_p: number;
  cur_i: number;
  vel_p: number;
  vel_i: number;
  pos_p: number;
  pos_i: number;
  /** bit0 = 电角度已标定 */
  flags: number;
  motor_id: number;
  axis_origin: number;
  axis_min: number;
  axis_max: number;
  lead_um: number;
  counts_per_rpm_x10: number;
  ma_per_count_ua: number;
}

export interface EepromProbe {
  ok: boolean;
  i2c_hz: number;
  matrix_before: number;
  matrix_after: number;
  addr: number;
  saved: number;
  written: [number, number];
  read_back: [number, number];
  message: string;
}

export interface EepromSave {
  seq: number;
  block: string;
  bytes_written: number;
  verified: boolean;
  elapsed_ms: number;
}

// --------------------------------------------------------------- 机械找零
/**
 * 上位机唯一下发的找零工艺参数。
 * 门控、推进、电流判据、超时、零点写入全部由**主控固件**裁决，上位机不参与。
 */
export interface HomingParams {
  /** 找零方向：-1 = 负方向（默认，对应缩回侧限位） */
  dir: -1 | 1;
  /** 每拍推进量，单位 0.01°（电机端）。默认 1500 = 15° */
  step_unit: number;
  /** 连续轨迹模式；需配套2026-11-01及之后的主控固件。缺省保留步进模式。 */
  timed_seek?: boolean;
  dual_limit?: boolean;
}

/**
 * 找零工艺参数。**存在主控里**（内存，掉电不保存），字段与 `op 15/16`
 * 的 16 字节载荷一一对应（全部 u16）。
 */
export interface HomingConfig {
  /** 判定系数 k ×1000（0.4 → 400）；阈值 = k × 额定电流 */
  k_x1000: number;
  /** 额定电流刻度，mA */
  rated_ma: number;
  /** 连续超阈确认时间，ms */
  confirm_ms: number;
  /** 找零期间电流上限，mA；必须大于阈值 */
  limit_ma: number;
  /** 推进速度上限，RPM */
  max_rpm: number;
  /** 到位后反向退开量，电机端角度 */
  retreat_deg: number;
  /** 退开后稳定等待，ms */
  settle_ms: number;
  /** 找零超时，s */
  timeout_s: number;
}

/** 主控上报的找零状态。上位机只读，不推算、不覆盖。 */
export interface HomingState {
  complex?: boolean; pair_phase?: number; pair_repeats?: number; candidate_position?: number;
  /** 0 空闲 / 1 进行中 / 2 成功 / 3 失败 */
  stage: number;
  /** 行程零点有效；上电必清 */
  zero_valid: boolean;
  /** q 轴实测电流，mA */
  iq_ma: number;
  /** 本次找零已用时，ms */
  elapsed_ms: number;
  /** 错误码 0 无 / 1 超时 / 2 控制器故障 / 3 取消 / 4 断使能 / 5 编码器无效 / 6 保留 */
  error: number;
  /** 主控给出的说明（可为空） */
  message: string;
  dual_supported?: boolean;
  limit_phase?: number;
  negative_valid?: boolean;
  positive_valid?: boolean;
  negative_contact?: number;
  positive_contact?: number;
  travel_counts?: number;
  adaptive?: boolean;
  adaptive_phase?: number;
  load_phase?: number;
  sample_position?: number;
  sample_velocity?: number;
  sample_target?: number;
  edge_score?: number;
  park_position?: number;
}

export interface EepromLoad {
  found: boolean;
  block: string;
  seq: number;
  crc_a: boolean;
  crc_b: boolean;
  params: StoreParams | null;
  message: string;
}
