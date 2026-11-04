import type { HomingConfig, PidSnapshot } from "./types";

/** M9 2026-11-01 实测；不包含电角度偏移，不自动写入电机。 */
export const M9_HOMING: HomingConfig = {
  k_x1000: 400, rated_ma: 1050, confirm_ms: 50, limit_ma: 500,
  max_rpm: 2000, retreat_deg: 360, settle_ms: 2000, timeout_s: 60,
};
// UI mechanism direction -1 maps to the historically verified chip +1.
export const M9_SEEK = { dir: -1 as const, step_unit: 100, timed_seek: true };

/** 与固件非零系数门控一致；完整反馈/使能/限位仍由主控裁决。 */
export function missingHomingPid(s: Pick<PidSnapshot, "flux_coeff" | "torque_coeff" | "vel_coeff" | "pos_coeff">): string[] {
  const fields = [
    ["磁链环 0x142", s.flux_coeff], ["转矩环 0x143", s.torque_coeff],
    ["速度环 0x145", s.vel_coeff], ["位置环 0x146", s.pos_coeff],
  ] as const;
  return fields.filter(([, value]) => !Number.isInteger(value) || value <= 0 || value > 0xffffffff).map(([label]) => label);
}

/** Read-only preflight. Never writes PID, offsets, power or a motion command. */
export async function checkHomingStart(
  api: { homingReadConfig: (motor: number) => Promise<HomingConfig>; readPid: () => Promise<PidSnapshot> },
  motor: number,
  expected: HomingConfig,
  stillSelected: () => void,
  onConfig: (config: HomingConfig) => void,
): Promise<void> {
  stillSelected();
  const actual = await api.homingReadConfig(motor);
  stillSelected();
  onConfig(actual);
  if ((Object.keys(expected) as (keyof HomingConfig)[]).some(key => expected[key] !== actual[key])) {
    throw new Error("主控参数已变化（可能重启），请重新写入找零配置");
  }
  const pid = await api.readPid();
  stillSelected();
  const missing = missingHomingPid(pid);
  if (missing.length) {
    throw new Error(`${missing.join("、")}未配置。对齐仅准备电流环；请在“PID 与限幅”写入并回读闭环系数，再返回找零。M9 实测速度 P=500/I=250、位置 P=500/I=0。`);
  }
}
