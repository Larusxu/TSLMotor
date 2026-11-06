import { invokeCommand } from "./api";

/** Mechanism sign, shared by homing, goals and feedback. Wire protocol is unchanged. */
export const MECHANISM_SIGN = -1;
export const chipDirection = (direction: -1 | 1): -1 | 1 => direction === 1 ? -1 : 1;
export interface ControlConfig {
  motor: number; poles: number; min_deg: number; max_deg: number; max_rpm: number;
  limit_ma: number; trip_ma: number; trajectory: boolean; duration_ms: number; accel_deg_s2: number;
  decel_deg_s2: number; mode: MotionMode; planning: "limits" | "time";
  over_ms: number; sample_ms: number; comm_timeout_ms: number; fault_action: "disable" | "controlled_stop";
}
export type MotionMode = "position_direct" | "position_ramp" | "velocity_direct" | "velocity_ramp";
export interface ParameterState {
  driver: { registers: import("./types").PidSnapshot; ma_per_count: number; counts_per_rpm: number } | null;
  observed: import("./types").PidSnapshot | null; consistent: boolean; message: string;
  effective_current_ma: number | null; effective_velocity_rpm: number | null;
}
export interface ControlState {
  motor: number; active: boolean; enabled: boolean; power: boolean; zero_valid: boolean;
  position: number | null; target: number | null; rpm: number | null; iq_ma: number | null;
  travel_deg: number | null;
  effective_current_ma: number | null; effective_velocity_rpm: number | null;
  safety_phase: "NORMAL" | "OVER_THRESHOLD" | "FAULT_LATCHED" | "RECOVERY";
  fault: number | null; offset: number | null; kind: string; cycles: number; message: string;
}
export interface ControlCommand {
  kind: "hold" | "stop_profile" | "jog" | "goto" | "recip" | "sine" | "velocity" | "decel_stop";
  target: number; b: number; amplitude: number; period_s: number; cycles: number; rpm: number;
}
async function real<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(command, args);
}
export const controlApi = {
  start: (cfg: ControlConfig) => real<void>("motor_control_start", { cfg }),
  limits: (cfg: ControlConfig) => real<void>("motor_control_limits", { cfg }),
  command: (command: ControlCommand) => real<void>("motor_control_command", { command }),
  pulse: () => real<void>("motor_control_pulse"),
  stop: () => real<void>("motor_control_stop"),
  state: () => real<ControlState>("motor_control_state"),
  read: (motor: number) => real<ControlState>("motor_control_read", { motor }),
  parameters: (motor: number) => real<ParameterState>("motor_parameter_state", { motor }),
  clearSafety: (motor: number) => real<void>("motor_safety_clear", { motor }),
};
