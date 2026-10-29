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
  uq_ud_limit: number;
  ma_per_count: number;
  counts_per_rpm: number;
}

export interface CalibCfgPayload {
  flux_ma: number;
  poles: number;
  settle_ms: number;
  step_deg: number;
  end_deg: number;
  ma_per_count: number;
  write_back: boolean;
  dry_run: boolean;
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