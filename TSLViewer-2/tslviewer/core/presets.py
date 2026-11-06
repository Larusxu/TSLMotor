"""Machine profiles and the streaming signal catalogue.

Values are taken from the legacy firmware (Tesla_hand_temp_176) and the bench
console (tmc6460_upper_pc), exactly like the TypeScript original.
"""

from __future__ import annotations

from dataclasses import dataclass

BAUD_RATES = [115200, 230400, 460800, 921600, 1_500_000, 2_000_000, 3_000_000]


@dataclass(frozen=True)
class EncoderPreset:
    id: str
    label: str
    frame_bits: int
    spi_mode: int
    spi_hz: int
    idle_cycles: int
    send_data: int
    cpr: int
    csn_via_enc_n: bool = True


ENCODER_PRESETS = [
    EncoderPreset(
        id="mt6701-14",
        label="MT6701 · SSI 14-bit - ENC_N",
        frame_bits=14,
        spi_mode=1,
        spi_hz=2_000_000,
        idle_cycles=16,
        send_data=0x00000000,
        cpr=16_384,
    ),
    EncoderPreset(
        id="mt6701-24",
        label="MT6701 · SSI 24-bit 完整帧 - ENC_N",
        frame_bits=24,
        spi_mode=1,
        spi_hz=2_000_000,
        idle_cycles=48,
        send_data=0x00000000,
        cpr=16_384,
    ),
]


@dataclass(frozen=True)
class StoragePreset:
    id: str
    label: str
    spec: str


STORAGE_PRESETS = [
    StoragePreset("m24c02", "M24C02-FMH6TG · 256 字节 - HALL_N", "I²C EEPROM · 2 Kbit"),
    StoragePreset("none", "无 / 不使用", "未装存储"),
]


@dataclass(frozen=True)
class TeslaProfile:
    name: str
    poles: int
    cpr: int
    csa_gain: int
    pwm_max_count: int
    ma_per_count: float
    counts_per_rpm: float
    pid: tuple[int, int, int, int, int, int]
    torque_ma: float
    flux_ma: float
    vel_rpm: float
    uq_ud: int
    r_ohm: float
    l_uh: float
    bandwidth_hz: float
    bench_p: int
    bench_i: int


TESLA_PROFILE = TeslaProfile(
    name="Tesla hand · TMC6460",
    poles=1,
    cpr=16_384,
    csa_gain=3,
    pwm_max_count=4800,
    ma_per_count=0.20131,
    counts_per_rpm=305.4,
    pid=(64, 48, 500, 250, 500, 0),
    torque_ma=800,
    flux_ma=0,
    vel_rpm=25_000,
    uq_ud=0x5A81,
    r_ohm=2.01,
    l_uh=111.8,
    bandwidth_hz=2000,
    bench_p=359,
    bench_i=129,
)

PHI_E_OFFSETS = [
    ("TMC_01", 0x3663),
    ("TMC_03", 0x4667),
    ("TMC_04", 0x5F41),
    ("TMC_06", 0x0E0F),
    ("TMC_09", 0xDC65),
    ("TMC_10", 0x0F6A),
    ("TMC_11", 0x3E43),
    ("TMC_12", 0xF847),
    ("TMC_13", 0x698C),
    ("TMC_14", 0xC69D),
    ("TMC_15", 0x2265),
    ("TMC_16", 0xC15A),
    ("TMC_17", 0x41D9),
    ("TMC_18", 0x5C26),
]

COUNTS_PER_RPM = TESLA_PROFILE.counts_per_rpm
MA_PER_COUNT = TESLA_PROFILE.ma_per_count


@dataclass(frozen=True)
class Signal:
    id: str
    addr: int
    label: str
    unit: str
    kind: str
    ch: int


SIGNALS = [
    Signal("vel_act", 0x154, "实际转速", "RPM", "velocity", 0),
    Signal("vel_tgt", 0x150, "目标转速", "RPM", "velocity", 1),
    Signal("torque", 0x153, "力矩电流 iQ", "mA", "torque", 2),
    Signal("flux", 0x153, "磁链电流 iD", "mA", "flux", 3),
    Signal("is", 0x171, "电流矢量", "LSB", "current", 4),
    Signal("us", 0x171, "电压矢量", "LSB", "voltage", 5),
    Signal("pos_act", 0x155, "实际位置", "°", "position", 6),
    Signal("pos_tgt", 0x152, "目标位置", "°", "position", 1),
    Signal("phi_e", 0x251, "电角度", "°e", "raw", 0),
    Signal("vel_err", 0x159, "速度误差", "RPM", "velocity", 2),
    Signal("temp", 0x084, "芯片结温", "°C", "temp", 3),
    Signal("iq", 0x168, "Iq", "LSB", "raw", 4),
    Signal("uq", 0x169, "Uq", "LSB", "raw", 5),
    Signal("ramp_v", 0x1D0, "斜坡速度", "RPM", "velocity", 6),
]

SIGNAL_BY_ID = {s.id: s for s in SIGNALS}


def convert_signal(sig: Signal, raw: int, cal: dict) -> float:
    p = cal.get("polarity", 1)
    raw &= 0xFFFFFFFF
    signed = raw - 0x100000000 if raw & 0x80000000 else raw
    if sig.kind == "velocity":
        return signed / cal.get("counts_per_rpm", COUNTS_PER_RPM) * p
    if sig.kind == "position":
        import math

        return math.fmod(signed, 65536) / 65536 * 360
    if sig.kind == "torque":
        hi = (raw >> 16) & 0xFFFF
        s = hi - 0x10000 if hi & 0x8000 else hi
        return s * cal.get("ma_per_count", MA_PER_COUNT) * p
    if sig.kind == "flux":
        lo = raw & 0xFFFF
        s = lo - 0x10000 if lo & 0x8000 else lo
        return s * cal.get("ma_per_count", MA_PER_COUNT) * p
    if sig.kind == "current":
        return float(raw & 0xFFFF)
    if sig.kind == "voltage":
        return float((raw >> 16) & 0xFFFF)
    if sig.kind == "temp":
        return (raw >> 16) / 16 + cal.get("temp_offset", 0)
    return float(raw)
