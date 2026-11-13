import { useSyncExternalStore } from "react";
import { TESLA_PROFILE as p } from "./presets";
import { MA_PER_COUNT } from "./units";
import type { PidCfgPayload } from "./types";
import type { ControlConfig } from "./motor-control";

/** Edits only. Verified register/profile ownership is in the Rust ParameterBank.
 * Per-motor drafts survive page navigation; never restored/enabled on a chip automatically. */
import { DEFAULT_RAMP, type RampConfig } from "./motor-ramp";
interface Draft { pid: PidCfgPayload; pidLoaded:boolean; task: ControlConfig; ramp:RampConfig }
const drafts = new Map<number, Draft>();
const listeners = new Set<() => void>();
/** Copy PI tuning fields only; verified physical readback must never quantize limit inputs. */
export function mergePiTuning(draft: PidCfgPayload, actual: PidCfgPayload): PidCfgPayload {
  const next={...draft};
  const keys=['flux_p','flux_i','torque_p','torque_i','vel_p','vel_i','pos_p','pos_i',
    'cur_norm_p','cur_norm_i','vel_norm_p','vel_norm_i','pos_norm_p','pos_norm_i',
    'vel_shift','pos_sampling','overwrite_target','keep_pos_target'] as const;
  for(const key of keys)Object.assign(next,{[key]:actual[key]});
  return next;
}
function get(motor: number): Draft {
  if (!drafts.has(motor)) drafts.set(motor, {
    ramp:{...DEFAULT_RAMP},
    pidLoaded:false,
    pid: { flux_p: NaN, flux_i: NaN, torque_p: NaN, torque_i: NaN,
      vel_p: NaN, vel_i: NaN, pos_p: NaN, pos_i: NaN,
      cur_norm_p: 1, cur_norm_i: 1, vel_norm_p: 1, vel_norm_i: 1, pos_norm_p: 1, pos_norm_i: 1,
      vel_shift: 8, pos_sampling: 0, overwrite_target: true, keep_pos_target: false,
      torque_limit_ma: p.limits.torqueMa, flux_limit_ma: p.limits.fluxMa,
      vel_limit_rpm: p.limits.velRpm, velocity_mode_limit_rpm:28730, uq_ud_limit: p.limits.uqUd,
      ma_per_count: MA_PER_COUNT, counts_per_rpm: 1099511627776 / 3600000000 },
    task: { motor, poles: 1, min_deg: 0, max_deg: 54600, max_rpm: 15000, limit_ma: 1000, trip_ma: 1000,
      trajectory: true, duration_ms: 2000, accel_deg_s2: 6000, decel_deg_s2: 6000,
      mode: "position_direct", planning: "limits", over_ms: 180, sample_ms: 60, comm_timeout_ms: 1000, fault_action: "disable" },
  });
  return drafts.get(motor)!;
}
export function useMotorConfiguration(motor: number) {
  const draft = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => get(motor));
  const update = <K extends keyof Draft>(key: K, value: Draft[K] | ((old: Draft[K]) => Draft[K])) => {
    const old = get(motor);
    const next={ ...old, [key]: typeof value === "function" ? (value as (old: Draft[K]) => Draft[K])(old[key]) : value };
    // Old direct-mode API aliases refer to the same current/speed ownership.
    if(key==="pid")next.task={...next.task,limit_ma:next.pid.torque_limit_ma};
    drafts.set(motor,next);
    listeners.forEach(cb => cb());
  };
  return { ...draft, setPid: (value: Draft["pid"] | ((p: Draft["pid"]) => Draft["pid"])) => update("pid", value),
    loadPid:(value:Draft['pid'])=>{const old=get(motor);drafts.set(motor,{...old,pid:value,pidLoaded:true});listeners.forEach(cb=>cb());},
    setRamp: (value: Draft["ramp"] | ((p: Draft["ramp"]) => Draft["ramp"])) => update("ramp", value),
    setTask: (value: Draft["task"] | ((p: Draft["task"]) => Draft["task"])) => update("task", value) };
}
