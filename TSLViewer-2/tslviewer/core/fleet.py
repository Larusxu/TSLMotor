"""16-motor fleet snapshot decoding (ported from ``src/lib/fleet.ts``)."""

from __future__ import annotations

from dataclasses import dataclass, field

MAX_CHIPS = ["U10", "U7", "U14", "U13"]
STATIC_CHANNEL_MOTORS = [
    [3, 5, 4, 6],
    [2, 15, 1, 16],
    [9, 8, 10, 7],
    [13, 11, 14, 12],
]
MOTOR_WORDS = 8
MOTOR_COUNT = 16
CHIP_WORDS = 12
CHIP_COUNT = 4
CHIP_BLOCK = (80, CHIP_COUNT * CHIP_WORDS)
MOTOR_BLOCK_A = (128, 64)
MOTOR_BLOCK_B = (192, 64)

CHIP_FAULTS = [(32, "限流设置异常"), (8, "输入过压"), (4, "输入欠压"), (2, "逻辑电源过压"), (1, "逻辑电源欠压")]
CHANNEL_FAULTS = [(8, "供电过温"), (4, "供电过流"), (2, "输入过压"), (1, "输入欠压")]


def words(data: list[int], count: int) -> list[int]:
    if len(data) != count * 2:
        raise ValueError("主控快照长度错误")
    return [data[i * 2] * 256 + data[i * 2 + 1] for i in range(count)]


def join_bits(bits: int, table: list[tuple[int, str]]) -> str:
    return " / ".join(label for bit, label in table if bits & bit)


@dataclass
class PowerOutput:
    enabled: bool | None = None
    fault: str = ""
    live: bool = False
    current_ma: int | None = None
    voltage_mv: int | None = None
    tmc_online: bool = False
    tmc_board_rate: bool = False


@dataclass
class MaxChannel:
    output: int
    motor: int | None = None
    enabled: bool | None = None
    fault: str = ""
    current_ma: int | None = None
    voltage_mv: int | None = None


@dataclass
class MaxChip:
    index: int
    name: str
    valid: bool = False
    id: int = 0
    config: int = 0
    diagnostics_live: bool = False
    stat1: int = 0
    stat2: tuple[int, int] = (0, 0)
    fault: str = ""
    vin_mv: int | None = None
    vdd_mv: int | None = None
    viset_mv: int | None = None
    current_limit_ma: float | None = None
    channels: list[MaxChannel] = field(default_factory=list)


def current_limit_estimate(mv: float, fault: bool) -> float | None:
    ma = mv * 0.48
    return None if fault or not (100 <= ma <= 600) else ma


def _supply_fault(enabled: bool, common: int, channel: int) -> str:
    if not enabled:
        return ""
    return " / ".join(filter(None, [join_bits(common, CHIP_FAULTS), join_bits(channel, CHANNEL_FAULTS)]))


def _measured_voltage_fault(row: list[int]) -> str:
    if row[5] != 1 or not (row[7] & 8):
        return ""
    mv = row[4] * 70
    return "输入欠压" if mv < 4500 else "输入过压" if mv > 5500 else ""


def decode_power(chips: list[int], motors: list[int]) -> list[PowerOutput]:
    if len(chips) != CHIP_COUNT * CHIP_WORDS or len(motors) != MOTOR_COUNT * MOTOR_WORDS:
        raise ValueError("供电快照不完整")
    out: list[PowerOutput] = []
    for i in range(MOTOR_COUNT):
        row = motors[i * MOTOR_WORDS : i * MOTOR_WORDS + MOTOR_WORDS]
        base = row[1] * CHIP_WORDS
        output = row[2] - 1
        if base > (CHIP_COUNT - 1) * CHIP_WORDS or output < 0 or output > 3 or not row[6] or not chips[base]:
            out.append(PowerOutput(tmc_online=bool(row[7] & 2), tmc_board_rate=bool(row[7] & 4)))
            continue
        common = chips[base + 4] & 0x2F
        channel = (chips[base + 5 + output // 2] >> (4 * (output % 2))) & 15
        out.append(
            PowerOutput(
                enabled=None if row[5] == 0xFFFF else row[5] == 1,
                fault=_supply_fault(row[5] == 1, common, channel) or _measured_voltage_fault(row),
                live=bool(chips[base + 3]),
                current_ma=row[3] * 3,
                voltage_mv=row[4] * 70,
                tmc_online=bool(row[7] & 2),
                tmc_board_rate=bool(row[7] & 4),
            )
        )
    return out


def decode_chips(chips: list[int], motors: list[int]) -> list[MaxChip]:
    if len(chips) != CHIP_COUNT * CHIP_WORDS or len(motors) != MOTOR_COUNT * MOTOR_WORDS:
        return []
    rows = [motors[i * MOTOR_WORDS : i * MOTOR_WORDS + MOTOR_WORDS] for i in range(MOTOR_COUNT)]
    out: list[MaxChip] = []
    for c in range(CHIP_COUNT):
        base = c * CHIP_WORDS
        valid = bool(chips[base])
        stat2 = (chips[base + 5], chips[base + 6])
        channel_list = []
        for o in range(4):
            index = next((i for i, r in enumerate(rows) if r[1] == c and r[2] == o + 1), -1)
            row = rows[index] if index >= 0 else None
            channel_list.append(
                MaxChannel(
                    output=o + 1,
                    motor=(index + 1) if index >= 0 else (STATIC_CHANNEL_MOTORS[c][o] if c < len(STATIC_CHANNEL_MOTORS) else None),
                    enabled=None if row is None else (None if row[5] == 0xFFFF else row[5] == 1),
                    fault=(
                        _supply_fault(bool(row and row[5] == 1), chips[base + 4] & 0x2F,
                                      (stat2[o // 2] >> (4 * (o % 2))) & 15)
                        or (_measured_voltage_fault(row) if row else "")
                    ),
                    current_ma=row[3] * 3 if row else None,
                    voltage_mv=row[4] * 70 if row else None,
                )
            )
        out.append(
            MaxChip(
                index=c,
                name=MAX_CHIPS[c],
                valid=valid,
                id=chips[base + 1],
                config=chips[base + 2],
                diagnostics_live=bool(chips[base + 3]),
                stat1=chips[base + 4],
                stat2=stat2,
                fault=(join_bits(chips[base + 4] & 0x2F, CHIP_FAULTS) if chips[base + 3] and (chips[base + 2] & 15) else ""),
                vin_mv=chips[base + 8] * 70 if valid else None,
                vdd_mv=chips[base + 9] * 25 if valid else None,
                viset_mv=chips[base + 10] * 5 if valid else None,
                current_limit_ma=current_limit_estimate(chips[base + 10] * 5, bool(chips[base + 4] & 32)) if valid else None,
                channels=channel_list,
            )
        )
    return out
