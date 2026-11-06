"""Unit conversions for TMC6460 (ported from src/lib/units.ts)."""

from __future__ import annotations

import math
from dataclasses import dataclass

MA_PER_COUNT = 0.20131
COUNTS_PER_RPM = 305.4
POS_PER_REV = 65536
POS_PER_DEG = POS_PER_REV / 360
PWM_CLOCK_HZ = 120_000_000
MODULATION_FULL_SCALE = 18900


def s16(v: int) -> int:
    v &= 0xFFFF
    return v - 0x10000 if v & 0x8000 else v


def s16lo(v: int) -> int:
    return s16(v & 0xFFFF)


def s16hi(v: int) -> int:
    return s16((v >> 16) & 0xFFFF)


def u16lo(v: int) -> int:
    return v & 0xFFFF


def u16hi(v: int) -> int:
    return (v >> 16) & 0xFFFF


def counts_from_ma(ma: float, ma_per_count: float = MA_PER_COUNT) -> int:
    return round(ma / ma_per_count)


def ma_from_counts(counts: float, ma_per_count: float = MA_PER_COUNT) -> float:
    return counts * ma_per_count


def counts_from_rpm(rpm: float, k: float = COUNTS_PER_RPM) -> int:
    return round(rpm * k)


def rpm_from_counts(counts: float, k: float = COUNTS_PER_RPM) -> float:
    return counts / k


def pwm_hz(max_count: int) -> float:
    return PWM_CLOCK_HZ / max(1, max_count)


def max_count_for_hz(hz: float) -> int:
    return round(PWM_CLOCK_HZ / max(1, hz))


def spi_half_period(hz: float) -> int:
    return max(0, min(255, round(60_000_000 / (2 * hz)) - 1))


def spi_hz_from_half(half: int) -> float:
    if half < 10:
        return 3_000_000
    return 60_000_000 / ((half + 1) * 2)


def ssi_frame_seconds(frame_bits: int, half: int, idle: int) -> float:
    transfer = (2 * frame_bits * (half + 1)) / 60_000_000
    csh = max(6e-6, (idle * (idle + 1)) / 60_000_000 + 3e-6)
    return transfer + csh


@dataclass
class PidBits:
    pos_sampling: int = 0
    vel_shift: int = 0
    pos_norm_i: int = 0
    pos_norm_p: int = 0
    vel_norm_i: int = 0
    vel_norm_p: int = 0
    cur_norm_i: int = 0
    cur_norm_p: int = 0
    overwrite_target: bool = False
    keep_pos_target: bool = False


def parse_pid_config(v: int) -> PidBits:
    return PidBits(
        pos_sampling=(v >> 16) & 0x7F,
        vel_shift=(v >> 12) & 0x0F,
        pos_norm_i=(v >> 10) & 0x03,
        pos_norm_p=(v >> 8) & 0x03,
        vel_norm_i=(v >> 6) & 0x03,
        vel_norm_p=(v >> 4) & 0x03,
        cur_norm_i=(v >> 3) & 0x01,
        cur_norm_p=(v >> 2) & 0x01,
        overwrite_target=bool((v >> 1) & 1),
        keep_pos_target=bool(v & 1),
    )


def compose_pid_config(b: PidBits) -> int:
    return (
        ((b.pos_sampling & 0x7F) << 16)
        | ((b.vel_shift & 0x0F) << 12)
        | ((b.pos_norm_i & 3) << 10)
        | ((b.pos_norm_p & 3) << 8)
        | ((b.vel_norm_i & 3) << 6)
        | ((b.vel_norm_p & 3) << 4)
        | ((b.cur_norm_i & 1) << 3)
        | ((b.cur_norm_p & 1) << 2)
        | ((1 << 1) if b.overwrite_target else 0)
        | (1 if b.keep_pos_target else 0)
    )


P_FRACS = (0, 8, 16, 24)
I_FRACS_CURRENT = (0, 8)
I_FRACS = (8, 16, 24, 32)

NORM_P_LABELS = ["No shift / Q16.0", "Shift by 8 / Q8.8", "Shift by 16 / Q0.16", "Shift by 24 / Q0.24"]
NORM_I_LABELS = ["Shift by 8 / Q8.8", "Shift by 16 / Q0.16", "Shift by 24 / Q0.24", "Shift by 32 / Q0.32"]
CUR_NORM_LABELS = ["No shift / Q16.0", "Shift by 8 / Q8.8"]


def p_frac(sel: int) -> int:
    return P_FRACS[max(0, min(3, sel))]


def i_frac(sel: int, current: bool = False) -> int:
    table = I_FRACS_CURRENT if current else I_FRACS
    return table[max(0, min(len(table) - 1, sel))]


def coef_to_gain(reg: int, frac: int) -> float:
    return reg / (2**frac)


def gain_to_coef(gain: float, frac: int) -> int:
    return round(gain * (2**frac))


def clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def suggest_pi(r_ohm: float, l_uh: float, f_bw: float, f_pwm: float) -> tuple[int, int, float, float]:
    """Suggested PI, matching the bench-verified legacy tuning."""
    l = l_uh * 1e-6
    kp = 2 * math.pi * f_bw * l
    ki = 2 * math.pi * f_bw * r_ohm
    p = int(clamp(round(kp * 256), 1, 32767))
    i = int(clamp(round((ki / max(1, f_pwm)) * 256), 0, 32767))
    return p, i, kp, ki


def fmt(v: float | None, digits: int = 1) -> str:
    if v is None or not math.isfinite(v):
        return "—"
    return f"{v:.{digits}f}"


def hexs(v: int | None, width: int = 8) -> str:
    if v is None:
        return "—"
    return "0x" + f"{v & 0xFFFFFFFF:0{width}X}"


def bins(v: int, width: int = 32) -> str:
    return f"{v & 0xFFFFFFFF:0{width}b}"


def temp_c(raw: int, offset: float = 0) -> float:
    """TMC6460 Rev.0 p56: signed TEMP_INT is the high half of ADC.TEMP_RAW."""
    return (s16hi(raw) * 1.25 / 32768 - 0.622) * 1250 / 3 + offset
