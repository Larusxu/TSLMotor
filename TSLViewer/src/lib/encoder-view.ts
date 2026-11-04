import { ENCODER_PRESETS, TESLA_PROFILE } from "./presets";
import { word } from "./motor-profile-ui";

/** Display defaults are expectations, never evidence of a successful read. */
export function encoderView(common: number[] | null, motor: number[] | null) {
  const preset = ENCODER_PRESETS[0];
  return {
    poles: motor?.[18] ?? TESLA_PROFILE.poles,
    cpr: common ? word(common, 12) : preset.cpr,
    offset: motor && (motor[16] & 1) ? word(motor, 20) & 65535 : null,
    frameBits: common?.[24] ?? preset.frameBits,
    spiMode: common?.[25] ?? preset.spiMode,
    spiHz: common ? word(common, 20) : preset.spiHz,
    idle: common?.[26] ?? preset.idleCycles,
    csa: common?.[27] ?? TESLA_PROFILE.csaGain,
    pwm: common ? word(common, 28) : TESLA_PROFILE.pwmMaxCount,
    velFrq: common ? word(common, 56) : null,
    velPer: common ? word(common, 60) : null,
  };
}

export function encoderCheck(want: number | null, got: number | null, mask: number) {
  if (want === null) return { tone: "neutral" as const, text: "待对齐" };
  if (got === null) return { tone: "neutral" as const, text: "未回读" };
  return ((want & mask) >>> 0) === ((got & mask) >>> 0)
    ? { tone: "ok" as const, text: "OK" }
    : { tone: "warn" as const, text: "差异" };
}
