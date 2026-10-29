#![allow(dead_code)]
//! Register addresses used by the backend procedures.
//! Names follow tmc6460.pdf rev.0 "Register Map" (p.121-199).

// ---- CHIP -------------------------------------------------------------
pub const CHIP_ID: u16 = 0x000;
pub const CHIP_VARIANT: u16 = 0x001;
pub const CHIP_REVISION: u16 = 0x002;
pub const CHIP_IO_MATRIX: u16 = 0x006;
pub const CHIP_STATUS_FLAGS: u16 = 0x009;
pub const CHIP_EVENTS: u16 = 0x00A;

// ---- ADC --------------------------------------------------------------
pub const ADC_TEMP_RAW: u16 = 0x084;
pub const ADC_I2_I1_RAW: u16 = 0x082;
pub const ADC_VM_I3_RAW: u16 = 0x083;
pub const MCC_ADC_CSA_GAIN: u16 = 0x0C3;

// ---- MCC_CONFIG -------------------------------------------------------
pub const MCC_MOTOR_MOTION: u16 = 0x100;
pub const MCC_GDRV: u16 = 0x101;
pub const MCC_PWM: u16 = 0x102;
pub const MCC_PWM_PERIOD: u16 = 0x103;
pub const MCC_STATUS: u16 = 0x105;

// ---- FOC / PID --------------------------------------------------------
pub const FOC_PID_CONFIG: u16 = 0x140;
pub const FOC_PID_FLUX_COEFF: u16 = 0x142;
pub const FOC_PID_TORQUE_COEFF: u16 = 0x143;
pub const FOC_PID_VELOCITY_COEFF: u16 = 0x145;
pub const FOC_PID_POSITION_COEFF: u16 = 0x146;
pub const FOC_PID_UQ_UD_LIMITS: u16 = 0x149;
pub const FOC_PID_TORQUE_FLUX_LIMITS: u16 = 0x14A;
pub const FOC_PID_VELOCITY_LIMIT: u16 = 0x14B;
pub const FOC_PID_TORQUE_FLUX_TARGET: u16 = 0x14E;
pub const FOC_PID_VELOCITY_TARGET: u16 = 0x150;
pub const FOC_PID_POSITION_TARGET: u16 = 0x152;
pub const FOC_PID_TORQUE_FLUX_ACTUAL: u16 = 0x153;
pub const FOC_PID_VELOCITY_ACTUAL: u16 = 0x154;
pub const FOC_PID_POSITION_ACTUAL: u16 = 0x155;
pub const FOC_PID_VELOCITY_ERROR: u16 = 0x159;
pub const FOC_PID_TORQUE_INTEGRATOR: u16 = 0x15D;
pub const FOC_PID_FLUX_INTEGRATOR: u16 = 0x15E;
pub const FOC_PID_VELOCITY_INTEGRATOR: u16 = 0x15F;
pub const FOC_PID_POSITION_INTEGRATOR: u16 = 0x160;
pub const FOC_FOC_IQ_ID: u16 = 0x168;
pub const FOC_FOC_UQ_UD: u16 = 0x169;
pub const FOC_U_S_ACTUAL_I_S_ACTUAL: u16 = 0x171;
pub const FOC_P_MOTOR: u16 = 0x172;

// ---- RAMPER -----------------------------------------------------------
pub const RAMPER_PHI_E: u16 = 0x1C3;
pub const RAMPER_A1: u16 = 0x1C4;
pub const RAMPER_A_MAX: u16 = 0x1C6;
pub const RAMPER_V_START: u16 = 0x1CA;
pub const RAMPER_V_MAX: u16 = 0x1CE;
pub const RAMPER_V_ACTUAL: u16 = 0x1D0;
pub const RAMPER_POSITION: u16 = 0x1D1;

// ---- EXT_CTRL ---------------------------------------------------------
pub const EXT_CTRL_VOLTAGE: u16 = 0x200;

// ---- FEEDBACK ---------------------------------------------------------
pub const FEEDBACK_CONF_CH_A: u16 = 0x240;
pub const FEEDBACK_PHI_E_OFFSET: u16 = 0x242;
pub const FEEDBACK_VELOCITY_FRQ_CONF: u16 = 0x244;
pub const FEEDBACK_VELOCITY_PER_CONF: u16 = 0x245;
pub const FEEDBACK_PHI_CONVERTED: u16 = 0x247;
pub const FEEDBACK_VELOCITY_FRQ: u16 = 0x24A;
pub const FEEDBACK_VELOCITY_PER: u16 = 0x24B;
pub const FEEDBACK_PHI_EXT_A: u16 = 0x24D;
pub const FEEDBACK_OUTPUT_CONF: u16 = 0x250;
pub const FEEDBACK_PHI_E: u16 = 0x251;

// ---- UART -------------------------------------------------------------
pub const UART_CONTROL: u16 = 0x340;
pub const UART_STATUS: u16 = 0x342;
pub const UART_EVENTS: u16 = 0x343;
pub const UART_RTMI_CH_BASE: u16 = 0x344;

// ---- IO CONTROLLER ----------------------------------------------------
pub const IO_CONTROL: u16 = 0x380;
pub const IO_COMMAND: u16 = 0x381;
pub const IO_RESPONSE_0: u16 = 0x382;
pub const IO_RESPONSE_1: u16 = 0x383;
pub const IO_RESPONSE_2: u16 = 0x384;
pub const IO_RESPONSE_3: u16 = 0x385;

// ---- enums ------------------------------------------------------------
pub const MODE_PWM_OFF: u32 = 0;
pub const MODE_PWM_ON: u32 = 1;
pub const MODE_TORQUE: u32 = 2;
pub const MODE_VELOCITY: u32 = 3;
pub const MODE_POSITION: u32 = 4;
pub const MODE_VOLTAGE_EXT: u32 = 11;

pub const MOTOR_TYPE_BLDC: u32 = 3;

/// `MCC_CONFIG.MOTOR_MOTION` bit layout (p.155).
pub fn motor_motion(mode: u32, poles: u32, ramp_en: bool, ramp_mode_vel: bool) -> u32 {
    (mode & 0x0F) << 9
        | (MOTOR_TYPE_BLDC << 7)
        | (poles & 0x7F)
        | if ramp_en { 1 << 14 } else { 0 }
        | if ramp_mode_vel { 1 << 13 } else { 0 }
}

/// Same, but routed through the internally generated `phi_e` (open loop).
pub fn motor_motion_openloop(mode: u32, poles: u32, ramp_mode_vel: bool) -> u32 {
    motor_motion(mode, poles, true, ramp_mode_vel) | (1 << 15)
}

/// `MCC_CONFIG.PWM_PERIOD`: `MAX_COUNT` in bits [15:0], auto-Kirchhoff limit above.
pub fn mcc_pwm_period(max_count: u32) -> u32 {
    (max_count & 0xFFFF) | (0xFFFF << 16)
}

/// `UART.RTMI_CH_x` value: enable + 10-bit register address.
pub fn rtmi_channel(addr: u16) -> u32 {
    (1 << 16) | (addr as u32 & 0x03FF)
}

/// `UART.CONTROL` with RTMI enabled at the requested down-sampling.
pub fn uart_control_rtmi(base: u32, sampling: u8, crc: bool) -> u32 {
    let mut v = base & !(0xFF << 24) & !(1 << 22) & !(1 << 21);
    v |= (sampling as u32) << 24;
    v |= 1 << 22;
    if crc {
        v |= 1 << 21;
    }
    v
}

/// `UART.CONTROL` with RTMI disabled, preserving baud/filter settings.
pub fn uart_control_rtmi_off(base: u32) -> u32 {
    base & !(1 << 22) & !(0xFF << 24)
}

/// `MANTISSA_LIMIT` for a target baud rate (f_SYS = 60 MHz, p.35).
pub fn mantissa_for_baud(baud: u32) -> u32 {
    if baud == 0 {
        return 0;
    }
    (60_000_000u32 / baud).max(5)
}

/// Baud rate achievable for a `MANTISSA_LIMIT` value.
pub fn baud_for_mantissa(m: u32) -> u32 {
    if m == 0 {
        return 0;
    }
    60_000_000 / m
}
