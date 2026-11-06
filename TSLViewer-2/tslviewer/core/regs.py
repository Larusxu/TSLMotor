"""Register addresses and bit layouts used by the backend procedures.

Names follow tmc6460.pdf rev.0 "Register Map" (p.121-199) and mirror
``src-tauri/src/regs.rs``.
"""

from __future__ import annotations

CHIP_ID = 0x000
CHIP_VARIANT = 0x001
CHIP_REVISION = 0x002
CHIP_IO_MATRIX = 0x006
CHIP_STATUS_FLAGS = 0x009
CHIP_EVENTS = 0x00A

ADC_I2_I1_RAW = 0x082
ADC_VM_I3_RAW = 0x083
ADC_TEMP_RAW = 0x084
MCC_ADC_CSA_GAIN = 0x0C3

MCC_MOTOR_MOTION = 0x100
MCC_GDRV = 0x101
MCC_PWM = 0x102
MCC_PWM_PERIOD = 0x103
MCC_STATUS = 0x105

FOC_PID_CONFIG = 0x140
FOC_PID_FLUX_COEFF = 0x142
FOC_PID_TORQUE_COEFF = 0x143
FOC_PID_VELOCITY_COEFF = 0x145
FOC_PID_POSITION_COEFF = 0x146
FOC_PID_UQ_UD_LIMITS = 0x149
FOC_PID_TORQUE_FLUX_LIMITS = 0x14A
FOC_PID_VELOCITY_LIMIT = 0x14B
FOC_PID_POSITION_LIMITS = 0x14C
FOC_PID_TORQUE_FLUX_TARGET = 0x14E
FOC_PID_VELOCITY_TARGET = 0x150
FOC_PID_POSITION_TARGET = 0x152
FOC_PID_TORQUE_FLUX_ACTUAL = 0x153
FOC_PID_VELOCITY_ACTUAL = 0x154
FOC_PID_POSITION_ACTUAL = 0x155
FOC_PID_VELOCITY_ERROR = 0x159
FOC_PID_TORQUE_INTEGRATOR = 0x15D
FOC_PID_FLUX_INTEGRATOR = 0x15E
FOC_PID_VELOCITY_INTEGRATOR = 0x15F
FOC_PID_POSITION_INTEGRATOR = 0x160
FOC_FOC_IQ_ID = 0x168
FOC_FOC_UQ_UD = 0x169
FOC_U_S_ACTUAL_I_S_ACTUAL = 0x171
FOC_P_MOTOR = 0x172

RAMPER_PHI_E = 0x1C3
RAMPER_A1 = 0x1C4
RAMPER_A_MAX = 0x1C6
RAMPER_V_START = 0x1CA
RAMPER_V_MAX = 0x1CE
RAMPER_V_ACTUAL = 0x1D0
RAMPER_POSITION = 0x1D1

EXT_CTRL_VOLTAGE = 0x200

FEEDBACK_CONF_CH_A = 0x240
FEEDBACK_PHI_E_OFFSET = 0x242
FEEDBACK_VELOCITY_FRQ_CONF = 0x244
FEEDBACK_VELOCITY_PER_CONF = 0x245
FEEDBACK_PHI_CONVERTED = 0x247
FEEDBACK_VELOCITY_FRQ = 0x24A
FEEDBACK_VELOCITY_PER = 0x24B
FEEDBACK_PHI_EXT_A = 0x24D
FEEDBACK_OUTPUT_CONF = 0x250
FEEDBACK_PHI_E = 0x251

UART_CONTROL = 0x340
UART_STATUS = 0x342
UART_EVENTS = 0x343
UART_RTMI_CH_BASE = 0x344

IO_CONTROL = 0x380
IO_COMMAND = 0x381
IO_RESPONSE_0 = 0x382
IO_RESPONSE_1 = 0x383
IO_RESPONSE_2 = 0x384
IO_RESPONSE_3 = 0x385

MODE_PWM_OFF = 0
MODE_PWM_ON = 1
MODE_TORQUE = 2
MODE_VELOCITY = 3
MODE_POSITION = 4
MODE_VOLTAGE_EXT = 11

MOTOR_TYPE_BLDC = 3

MODE_NAMES = [
    "PWM_OFF",
    "PWM_ON",
    "TORQUE",
    "VELOCITY",
    "POSITION",
    "PRBS_UD",
    "PRBS_FLUX",
    "PRBS_TORQUE",
    "PRBS_VELOCITY",
    "PRBS_POSITION",
    "PWM_EXT",
    "VOLTAGE_EXT",
]


def motor_motion(mode: int, poles: int, ramp_en: bool = False, ramp_mode_vel: bool = False) -> int:
    value = (mode & 0x0F) << 9 | (MOTOR_TYPE_BLDC << 7) | (poles & 0x7F)
    if ramp_en:
        value |= 1 << 14
    if ramp_mode_vel:
        value |= 1 << 13
    return value


def motor_motion_openloop(mode: int, poles: int, ramp_mode_vel: bool = False) -> int:
    return motor_motion(mode, poles, True, ramp_mode_vel) | (1 << 15)


def mcc_pwm_period(max_count: int) -> int:
    return (max_count & 0xFFFF) | (0xFFFF << 16)


def rtmi_channel(addr: int) -> int:
    return (1 << 16) | (addr & 0x03FF)


def uart_control_rtmi(base: int, sampling: int, crc: bool) -> int:
    v = base & ~(0xFF << 24) & ~(1 << 22) & ~(1 << 21)
    v |= (sampling & 0xFF) << 24 | (1 << 22)
    if crc:
        v |= 1 << 21
    return v


def uart_control_rtmi_off(base: int) -> int:
    return base & ~(1 << 22) & ~(0xFF << 24)


def cpr_inv_for(cpr: int) -> int:
    """CPR_INV = 2^24 / CPR (rounded)."""
    if cpr <= 0:
        return 0
    return round(16_777_216 / cpr)
