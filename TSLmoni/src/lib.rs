//! TSLHand main-controller simulator — no hardware required.
//!
//! Emulates one TSLHand main board plus its 16 TMC6460 motor nodes, behind the
//! same wire formats the firmware speaks:
//!
//! * `main485` — Modbus-RTU frames (`1, 0x41, len, payload, crc16`)
//! * `maincan` — USB-CAN-A frames on id 0x0600 / 0x0580, 6-byte fragments
//! * `direct`  — raw TMC6460 UART datagrams
//!
//! Behaviour mirrors the firmware in `TSLHand/application/TeslaHand/common`:
//! `moto/los_moto.c` (packet layout, ownership/lease, board snapshot, RX ring)
//! and `Modbus/los_motor_routes.c` (motor → power chip / UART routing).
//!
//! Two entry points:
//! * [`Simulator`] — byte-level (`write`/`read`) for embedding in a host app.
//! * `tslmoni --rpc` — packet-level hex lines on stdin/stdout, like the
//!   firmware host test double.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Port name a host app may offer in its picker.
pub const PORT_NAME: &str = "SIM1";

const MOTORS: usize = 16;
const REGS: usize = 1024;
/// Firmware RX ring per motor (`RING` in los_moto.c).
const RING: usize = 2048;
/// Board snapshot length (`q[7]+q[8]<=256` in los_moto.c).
const BOARD_WORDS: usize = 256;
/// Host link layer: 135-byte packet, 128-byte payload.
const PACKET_MAX: usize = 135;
const PAYLOAD_MAX: usize = 128;

/// `(uart, chip, output, sys branch, connector)` per motor, from the DTS the
/// firmware routes table is generated from.
pub const ROUTES: [(u8, u8, u8, u8, u8); MOTORS] = [
    (11, 1, 3, 32, 26),
    (7, 1, 1, 22, 22),
    (6, 0, 1, 21, 20),
    (5, 0, 3, 14, 19),
    (4, 0, 2, 13, 18),
    (2, 0, 4, 11, 16),
    (17, 2, 4, 44, 32),
    (16, 2, 2, 43, 31),
    (3, 2, 1, 12, 17),
    (15, 2, 3, 42, 30),
    (14, 3, 2, 41, 29),
    (10, 3, 4, 31, 25),
    (8, 3, 1, 23, 23),
    (9, 3, 3, 24, 24),
    (13, 1, 2, 34, 28),
    (12, 1, 4, 33, 27),
];

/// Firmware banner returned by `MOTO_BOARD` at offset 8 (16 chars).
pub const FW_TEXT: &[u8; 16] = b"TSL-SIM FWHOST01";
/// Board snapshot word carrying the hand id (`MOTO_BOARD` offset 73).
pub const HAND_ID_WORD: usize = 73;

// Status codes (`enum MOTO_*` in los_moto.h).
pub const MOTO_OK: u8 = 0;
pub const MOTO_BAD: u8 = 1;
pub const MOTO_NOT_READY: u8 = 2;
pub const MOTO_IO: u8 = 3;
pub const MOTO_OVERFLOW: u8 = 4;
pub const MOTO_BUSY: u8 = 5;

// Operation codes (`enum MOTO_*` in los_moto.h).
pub const OP_WRITE: u8 = 1;
pub const OP_READ: u8 = 2;
pub const OP_CLEAR: u8 = 3;
pub const OP_INFO: u8 = 4;
pub const OP_POWER: u8 = 5;
pub const OP_ALL_OFF: u8 = 6;
pub const OP_KEEPALIVE: u8 = 7;
pub const OP_OPEN: u8 = 8;
pub const OP_CLOSE: u8 = 9;
pub const OP_BOARD: u8 = 10;
pub const OP_HAND_ID: u8 = 11;

// Register addresses used by the model (TMC6460 register map).
mod regs {
    pub const CHIP_ID: u16 = 0x000;
    pub const CHIP_VARIANT: u16 = 0x001;
    pub const CHIP_REVISION: u16 = 0x002;
    pub const CHIP_STATUS_FLAGS: u16 = 0x009;
    pub const ADC_I2_I1_RAW: u16 = 0x082;
    pub const ADC_VM_I3_RAW: u16 = 0x083;
    pub const ADC_TEMP_RAW: u16 = 0x084;
    pub const MCC_MOTOR_MOTION: u16 = 0x100;
    pub const MCC_STATUS: u16 = 0x105;
    pub const RAMPER_V_ACTUAL: u16 = 0x1D0;
    pub const RAMPER_POSITION: u16 = 0x1D1;
    pub const RAMPER_PHI_E: u16 = 0x1C3;
    pub const FOC_PID_TORQUE_FLUX_ACTUAL: u16 = 0x153;
    pub const FOC_PID_VELOCITY_ACTUAL: u16 = 0x154;
    pub const FOC_PID_POSITION_ACTUAL: u16 = 0x155;
    pub const FOC_PID_VELOCITY_ERROR: u16 = 0x159;
    pub const FOC_FOC_IQ_ID: u16 = 0x168;
    pub const FOC_FOC_UQ_UD: u16 = 0x169;
    pub const FOC_PID_VELOCITY_TARGET: u16 = 0x150;
    pub const FOC_PID_POSITION_TARGET: u16 = 0x152;
    pub const FOC_PID_TORQUE_FLUX_TARGET: u16 = 0x14E;
    pub const FOC_PID_VELOCITY_LIMIT: u16 = 0x14B;
    pub const FEEDBACK_VELOCITY_FRQ: u16 = 0x24A;
    pub const FEEDBACK_VELOCITY_PER: u16 = 0x24B;
    pub const FEEDBACK_PHI_CONVERTED: u16 = 0x247;
    pub const FEEDBACK_PHI_E: u16 = 0x251;
    pub const UART_CONTROL: u16 = 0x340;
    pub const UART_RTMI_CH_BASE: u16 = 0x344;
    pub const MCC_PWM_PERIOD: u16 = 0x103;
    pub const MODE_PWM_OFF: u32 = 0;
    pub const MODE_TORQUE: u32 = 2;
    pub const MODE_VELOCITY: u32 = 3;
    pub const MODE_POSITION: u32 = 4;

    /// `MCC_CONFIG.PWM_PERIOD`: `MAX_COUNT` in bits [15:0].
    pub fn mcc_pwm_period(max_count: u32) -> u32 {
        (max_count & 0xFFFF) | (0xFFFF << 16)
    }
}

/// Wire format the host speaks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Direct,
    Rs485,
    Can,
}

impl Mode {
    pub fn parse(mode: &str) -> Mode {
        match mode {
            "maincan" => Mode::Can,
            "direct" => Mode::Direct,
            _ => Mode::Rs485,
        }
    }

    /// Packet `source` field in los_moto.c: 1 = RS485, 2 = CAN.
    fn source(self) -> u8 {
        if self == Mode::Can {
            2
        } else {
            1
        }
    }
}

pub fn is_sim_port(name: &str) -> bool {
    let n = name.trim();
    n.eq_ignore_ascii_case(PORT_NAME) || n.eq_ignore_ascii_case("SIM")
}

/// CRC-16/MODBUS as used by the gateway RTU framing (`gateway.rs`).
pub fn crc16(data: &[u8]) -> u16 {
    let mut c: u16 = 0xFFFF;
    for b in data {
        c ^= *b as u16;
        for _ in 0..8 {
            c = (c >> 1) ^ if c & 1 != 0 { 0xA001 } else { 0 };
        }
    }
    c
}

/// CRC-8 used by `UART.RTMI_CRC_EN` (poly 0x1D, reflected, init 0x00).
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc: u8 = 0x00;
    for byte in data {
        crc ^= byte.reverse_bits();
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 { (crc << 1) ^ 0x1D } else { crc << 1 };
        }
    }
    crc
}

pub fn read_request(addr: u16) -> [u8; 2] {
    [0x42 | (((addr >> 8) & 0x03) as u8) << 4, (addr & 0xFF) as u8]
}

pub fn write_request(addr: u16, value: u32) -> [u8; 6] {
    let d = value.to_be_bytes();
    [
        0x4A | (((addr >> 8) & 0x03) as u8) << 4,
        (addr & 0xFF) as u8,
        d[0],
        d[1],
        d[2],
        d[3],
    ]
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

// -------------------------------------------------------------------- device

struct Motor {
    regs: [u32; REGS],
    rx: VecDeque<u8>,
    overflow: bool,
    pos: f64,
    vel: f64,
    phase: f64,
    rtmi_acc: f64,
    write_cnt: u8,
}

impl Motor {
    fn new() -> Self {
        let mut regs = [0u32; REGS];
        regs[regs::CHIP_ID as usize] = 0x6460_0001;
        regs[regs::CHIP_VARIANT as usize] = 0x0001;
        regs[regs::CHIP_REVISION as usize] = 0x0003;
        // 120 MHz / 4800 = 25 kHz, the rate the viewer assumes by default.
        regs[regs::MCC_PWM_PERIOD as usize] = regs::mcc_pwm_period(4800);
        regs[regs::ADC_TEMP_RAW as usize] = 0x0A20;
        regs[regs::ADC_VM_I3_RAW as usize] = 0x0B40;
        Self {
            regs,
            rx: VecDeque::new(),
            overflow: false,
            pos: 0.0,
            vel: 0.0,
            phase: 0.0,
            rtmi_acc: 0.0,
            write_cnt: 0,
        }
    }

    fn set(&mut self, addr: u16, v: u32) {
        if (addr as usize) < REGS {
            self.regs[addr as usize] = v;
        }
    }

    fn get(&self, addr: u16) -> u32 {
        self.regs.get(addr as usize).copied().unwrap_or(0)
    }

    /// Same bounded ring semantics as the firmware: overflow latches until the
    /// host issues `MOTO_CLEAR`.
    fn push(&mut self, bytes: &[u8]) {
        for b in bytes {
            if self.rx.len() >= RING {
                self.overflow = true;
                break;
            }
            self.rx.push_back(*b);
        }
    }

    /// Raw TMC datagrams arriving on this motor's UART: read requests are
    /// answered immediately, writes land in the register file.
    fn push_uart(&mut self, bytes: &[u8]) {
        let mut i = 0usize;
        while i < bytes.len() {
            let b0 = bytes[i];
            if b0 & 0x07 != 0x02 {
                i += 1;
                continue;
            }
            let write = b0 & 0x08 != 0;
            let len = if write { 6 } else { 2 };
            if i + len > bytes.len() {
                break;
            }
            let addr = (((b0 >> 4) & 0x03) as u16) << 8 | bytes[i + 1] as u16;
            if write {
                let v = u32::from_be_bytes([bytes[i + 2], bytes[i + 3], bytes[i + 4], bytes[i + 5]]);
                self.set(addr, v);
            } else {
                let v = self.get(addr).to_be_bytes();
                self.push(&[b0, bytes[i + 1], v[0], v[1], v[2], v[3]]);
            }
            i += len;
        }
    }
}

struct Device {
    motors: Vec<Motor>,
    focus: usize,
    /// Power masks of the four MAX20087 banks.
    power: [u8; 4],
    hand_id: u16,
    /// `owner`/`lease` in los_moto.c: one host owns the rack at a time.
    owner: u8,
    lease: Instant,
    last: Instant,
    noise: u32,
}

impl Device {
    fn new(motor: u8) -> Self {
        let now = Instant::now();
        Self {
            motors: (0..MOTORS).map(|_| Motor::new()).collect(),
            focus: (motor.clamp(1, MOTORS as u8)) as usize - 1,
            power: [0; 4],
            hand_id: 1,
            owner: 0,
            lease: now,
            last: now,
            noise: 0x1234_5678,
        }
    }

    fn rand(&mut self) -> f64 {
        self.noise = self.noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((self.noise >> 16) & 0xFF) as f64 - 128.0
    }

    fn lease_touch(&mut self) {
        self.lease = Instant::now();
    }

    /// Drop the rack when the owning host stops talking for 5 s.
    fn expire(&mut self) {
        if self.owner != 0 && self.lease.elapsed() >= Duration::from_secs(5) {
            self.power = [0; 4];
            self.owner = 0;
        }
    }

    fn diagnostics_live(&self) -> bool {
        self.power.iter().any(|m| *m != 0)
    }

    /// Gateway dispatcher. `Err` carries the firmware `MOTO_*` status code.
    fn call(&mut self, source: u8, motor: u8, op: u8, data: &[u8]) -> Result<Vec<u8>, u8> {
        let result = self.dispatch(source, motor, op, data);
        if self.owner == source && result.is_ok() {
            self.lease_touch();
        }
        result
    }

    fn dispatch(&mut self, source: u8, motor: u8, op: u8, data: &[u8]) -> Result<Vec<u8>, u8> {
        self.expire();
        if motor > MOTORS as u8 {
            return Err(MOTO_BAD);
        }
        let board_level = matches!(
            op,
            OP_INFO | OP_ALL_OFF | OP_CLOSE | OP_KEEPALIVE | OP_BOARD | OP_HAND_ID
        );
        if motor == 0 && !board_level {
            return Err(MOTO_BAD);
        }

        if op == OP_BOARD {
            if motor != 0 {
                return Err(MOTO_BAD);
            }
            return self.board(data);
        }
        if op == OP_INFO {
            if !data.is_empty() {
                return Err(MOTO_BAD);
            }
            return self.info(motor);
        }
        if op == OP_ALL_OFF {
            if !data.is_empty() {
                return Err(MOTO_BAD);
            }
            self.power = [0; 4];
            self.owner = 0;
            return Ok(Vec::new());
        }
        if self.owner != 0 && self.owner != source {
            return Err(MOTO_BUSY);
        }
        match op {
            OP_OPEN => {
                if !data.is_empty() {
                    return Err(MOTO_BAD);
                }
                self.owner = source;
                self.focus = motor as usize - 1;
                Ok(Vec::new())
            }
            OP_KEEPALIVE => {
                if !data.is_empty() {
                    return Err(MOTO_BAD);
                }
                Ok(Vec::new())
            }
            OP_HAND_ID => {
                if motor != 0 || data.len() != 2 {
                    return Err(MOTO_BAD);
                }
                let id = u16::from_be_bytes([data[0], data[1]]);
                if id == 0 {
                    return Err(MOTO_BAD);
                }
                self.hand_id = id;
                Ok(Vec::new())
            }
            OP_CLOSE => {
                if !data.is_empty() {
                    return Err(MOTO_BAD);
                }
                self.power = [0; 4];
                self.owner = 0;
                Ok(Vec::new())
            }
            _ => self.motor_op(motor, op, data),
        }
    }

    fn motor_op(&mut self, motor: u8, op: u8, data: &[u8]) -> Result<Vec<u8>, u8> {
        if motor == 0 {
            return Err(MOTO_NOT_READY);
        }
        let idx = motor as usize - 1;
        match op {
            OP_WRITE => {
                if data.is_empty() {
                    return Err(MOTO_BAD);
                }
                self.motors[idx].push_uart(data);
                Ok(Vec::new())
            }
            OP_READ => {
                if !data.is_empty() {
                    return Err(MOTO_BAD);
                }
                let m = &mut self.motors[idx];
                if m.overflow {
                    return Err(MOTO_OVERFLOW);
                }
                let n = m.rx.len().min(PAYLOAD_MAX);
                Ok(m.rx.drain(..n).collect())
            }
            OP_CLEAR => {
                if !data.is_empty() {
                    return Err(MOTO_BAD);
                }
                let m = &mut self.motors[idx];
                m.rx.clear();
                m.overflow = false;
                Ok(Vec::new())
            }
            OP_POWER => {
                if data.len() != 1 || data[0] > 1 {
                    return Err(MOTO_BAD);
                }
                let (_, chip, output, _, _) = ROUTES[idx];
                let bit = 1u8 << (output - 1);
                let mask = if self.diagnostics_live() { self.power[chip as usize] & 0x0F } else { 0 };
                self.power[chip as usize] = if data[0] != 0 { mask | bit } else { mask & !bit };
                Ok(Vec::new())
            }
            _ => Err(MOTO_BAD),
        }
    }

    fn info(&mut self, motor: u8) -> Result<Vec<u8>, u8> {
        if motor == 0 {
            // [count_hi, count_lo, initialized, owner]
            return Ok(vec![1, MOTORS as u8, 1, self.owner]);
        }
        let idx = motor as usize - 1;
        let (uart, chip, output, sys, connector) = ROUTES[idx];
        let live = self.diagnostics_live();
        Ok(vec![
            uart,
            chip,
            output,
            sys,
            connector,
            1,
            self.motors[idx].overflow as u8,
            1,
            live as u8,
            16 | self.power[chip as usize],
        ])
    }

    /// `MOTO_BOARD`: `data = [start, count]`, `count` in 1..=64 words.
    fn board(&self, data: &[u8]) -> Result<Vec<u8>, u8> {
        if data.len() != 2 {
            return Err(MOTO_BAD);
        }
        let (base, count) = (data[0] as usize, data[1] as usize);
        if count == 0 || count > 64 || base + count > BOARD_WORDS {
            return Err(MOTO_BAD);
        }
        let mut out = Vec::with_capacity(count * 2);
        for i in base..base + count {
            out.extend_from_slice(&self.board_word(i).to_be_bytes());
        }
        Ok(out)
    }

    fn board_word(&self, i: usize) -> u16 {
        if (8..8 + FW_TEXT.len() / 2).contains(&i) {
            let k = (i - 8) * 2;
            return u16::from_be_bytes([FW_TEXT[k], FW_TEXT[k + 1]]);
        }
        if i == HAND_ID_WORD {
            return self.hand_id;
        }
        i as u16
    }

    /// Advance the motion model and synthesise RTMI frames.
    fn tick(&mut self) {
        let dt = self.last.elapsed().as_secs_f64().min(0.25);
        if dt < 0.000_5 {
            return;
        }
        self.last = Instant::now();
        for i in 0..MOTORS {
            self.step(i, dt);
        }
    }

    fn step(&mut self, idx: usize, dt: f64) {
        let noise = self.rand() * 0.02;
        let m = &mut self.motors[idx];
        let mm = m.get(regs::MCC_MOTOR_MOTION);
        let mode = (mm >> 9) & 0xF;
        let tau = (dt / 0.03).min(1.0);
        match mode {
            regs::MODE_VELOCITY => {
                let target = m.get(regs::FOC_PID_VELOCITY_TARGET) as i32 as f64;
                m.vel += (target - m.vel) * tau;
            }
            regs::MODE_POSITION => {
                let target = m.get(regs::FOC_PID_POSITION_TARGET) as i32 as f64;
                let limit = m.get(regs::FOC_PID_VELOCITY_LIMIT) as i32 as f64;
                let limit = if limit > 0.0 { limit } else { 200_000.0 };
                let desired = ((target - m.pos) * 8.0).clamp(-limit, limit);
                m.vel += (desired - m.vel) * tau;
            }
            regs::MODE_TORQUE => {
                let torque = m.get(regs::FOC_PID_TORQUE_FLUX_TARGET) as i32 as f64;
                m.vel += torque * dt * 2e-3;
            }
            _ => m.vel *= 1.0 - (dt / 0.05).min(1.0),
        }
        m.pos += m.vel * dt;
        m.phase += m.vel * dt * 0.125;

        let pos = m.pos as i32;
        let vel = m.vel as i32;
        let torque = (m.get(regs::FOC_PID_TORQUE_FLUX_TARGET) as i32 as f64 * 0.4
            + vel as f64 * 0.01
            + noise) as i32;
        let err = m.get(regs::FOC_PID_VELOCITY_TARGET) as i32 - vel;
        m.set(regs::FOC_PID_POSITION_ACTUAL, pos as u32);
        m.set(regs::FOC_PID_VELOCITY_ACTUAL, vel as u32);
        m.set(regs::FOC_PID_VELOCITY_ERROR, err as u32);
        m.set(regs::FOC_PID_TORQUE_FLUX_ACTUAL, torque as u32);
        m.set(regs::RAMPER_POSITION, pos as u32);
        m.set(regs::RAMPER_V_ACTUAL, vel as u32);
        m.set(regs::RAMPER_PHI_E, (m.phase as i32) as u32);
        m.set(regs::FEEDBACK_VELOCITY_FRQ, vel as u32);
        m.set(regs::FEEDBACK_VELOCITY_PER, vel as u32);
        m.set(regs::FEEDBACK_PHI_CONVERTED, (m.phase as i32) as u32);
        m.set(regs::FEEDBACK_PHI_E, (m.phase as i32) as u32);
        m.set(regs::FOC_FOC_IQ_ID, torque as u32);
        m.set(regs::FOC_FOC_UQ_UD, (torque / 2) as u32);
        m.set(regs::ADC_TEMP_RAW, (0x0A20i32 + noise as i32 / 8) as u32);
        m.set(regs::CHIP_STATUS_FLAGS, 0);
        m.set(regs::MCC_STATUS, if mode == regs::MODE_PWM_OFF { 0 } else { 1 });

        self.rtmi(idx, dt);
    }

    fn rtmi(&mut self, idx: usize, dt: f64) {
        let m = &mut self.motors[idx];
        let ctrl = m.get(regs::UART_CONTROL);
        if ctrl & (1 << 22) == 0 {
            m.rtmi_acc = 0.0;
            return;
        }
        let sampling = (ctrl >> 24) & 0xFF;
        let period = m.get(regs::MCC_PWM_PERIOD) & 0xFFFF;
        let pwm = if period == 0 { 25_000.0 } else { 120_000_000.0 / period as f64 };
        let trigger = (pwm / (sampling as f64 + 1.0)).max(1.0);
        m.rtmi_acc += dt * trigger;
        let frames = m.rtmi_acc.min(64.0) as u32;
        m.rtmi_acc -= m.rtmi_acc.trunc().min(64.0);
        if frames == 0 {
            return;
        }
        let with_crc = ctrl & (1 << 21) != 0;
        let mut batch = Vec::with_capacity(frames as usize * 42);
        for _ in 0..frames {
            for ch in 0..7u16 {
                let cfg = m.get(regs::UART_RTMI_CH_BASE + ch);
                if cfg & (1 << 16) == 0 {
                    continue;
                }
                let value = m.get((cfg as u16) & 0x3FF) as i32;
                let head = 0x01 | ((ch as u8) << 1) | ((m.write_cnt & 0x07) << 4);
                batch.push(head);
                batch.extend_from_slice(&value.to_be_bytes());
                if with_crc {
                    batch.push(crc8(&batch[batch.len() - 5..]));
                }
            }
            m.write_cnt = m.write_cnt.wrapping_add(1);
        }
        m.push(&batch);
    }
}

// ---------------------------------------------------------------- simulator

/// A TSLHand main board with 16 motor nodes, driven by host bytes.
pub struct Simulator {
    dev: Device,
    mode: Mode,
    inbuf: Vec<u8>,
    can_seq: Option<(u8, Vec<u8>)>,
    out: VecDeque<u8>,
}

impl Simulator {
    pub fn new(mode: &str, motor: u8) -> Self {
        Self {
            dev: Device::new(motor),
            mode: Mode::parse(mode),
            inbuf: Vec::new(),
            can_seq: None,
            out: VecDeque::new(),
        }
    }

    // ------------------------------------------------------------ byte level

    /// Host → device wire bytes.
    pub fn write(&mut self, bytes: &[u8]) {
        self.dev.tick();
        if self.mode == Mode::Direct {
            let focus = self.dev.focus;
            self.dev.motors[focus].push_uart(bytes);
            self.pump();
            return;
        }
        self.inbuf.extend_from_slice(bytes);
        if self.inbuf.len() > 4096 {
            let drop = self.inbuf.len() - 512;
            self.inbuf.drain(..drop);
        }
        loop {
            if self.mode == Mode::Can {
                let Some((valid, seq, idx, data, used)) = can_take(&self.inbuf) else {
                    break;
                };
                self.inbuf.drain(..used);
                if !valid {
                    continue;
                }
                let merged = match self.can_seq.take() {
                    Some((s, mut buf)) if s == seq => {
                        buf.extend_from_slice(&data);
                        buf
                    }
                    _ => data,
                };
                if idx & 0x80 != 0 {
                    self.answer_and_push(seq, &merged);
                } else {
                    self.can_seq = Some((seq, merged));
                }
            } else {
                let Some((payload, used)) = rtu_take(&self.inbuf) else {
                    break;
                };
                self.inbuf.drain(..used);
                if payload.len() >= 7 {
                    let seq = payload[1];
                    self.answer_and_push(seq, &payload);
                }
            }
        }
    }

    /// Device → host wire bytes.
    pub fn read(&mut self, out: &mut [u8]) -> usize {
        if self.out.is_empty() && self.mode == Mode::Direct {
            self.dev.tick();
            self.pump();
        }
        let n = out.len().min(self.out.len());
        for slot in &mut out[..n] {
            *slot = self.out.pop_front().unwrap();
        }
        n
    }

    pub fn available(&mut self) -> usize {
        if self.out.is_empty() {
            self.dev.tick();
            if self.mode == Mode::Direct {
                self.pump();
            }
        }
        self.out.len()
    }

    pub fn clear(&mut self) {
        self.out.clear();
        self.inbuf.clear();
        self.can_seq = None;
    }

    // ---------------------------------------------------------- packet level

    /// Answer one gateway packet (`[1, seq_lo, seq_hi, motor, op, len, 0, ...]`).
    /// Returns the response packet, or `None` when the request is malformed —
    /// the firmware answers nothing in that case, so the host sees a timeout.
    pub fn request(&mut self, packet: &[u8]) -> Option<Vec<u8>> {
        self.dev.tick();
        let q = packet;
        if q.len() < 7
            || q.len() > PACKET_MAX
            || q[0] != 1
            || q[6] != 0
            || q[5] as usize > PAYLOAD_MAX
            || q.len() != 7 + q[5] as usize
        {
            return None;
        }
        let head = &q[..5];
        let (motor, op) = (head[3], head[4]);
        let mut resp = head.to_vec();
        match self.dev.call(self.mode.source(), motor, op, &q[7..]) {
            Ok(d) => {
                resp.push(d.len() as u8);
                resp.push(MOTO_OK);
                resp.extend_from_slice(&d);
            }
            Err(code) => {
                resp.push(0);
                resp.push(code);
            }
        }
        Some(resp)
    }

    fn answer_and_push(&mut self, seq: u8, packet: &[u8]) {
        if let Some(resp) = self.request(packet) {
            self.push_frame(seq, &resp);
        }
    }

    /// Direct mode has no gateway in front of the TMC UART: pending UART bytes
    /// are the byte stream the host reads.
    fn pump(&mut self) {
        let m = &mut self.dev.motors[self.dev.focus];
        if !m.rx.is_empty() {
            self.out.extend(m.rx.drain(..));
        }
    }

    fn push_frame(&mut self, seq: u8, payload: &[u8]) {
        match self.mode {
            Mode::Can => {
                let chunks: Vec<&[u8]> = payload.chunks(6).collect();
                let total = chunks.len().max(1);
                for (i, part) in chunks.iter().enumerate() {
                    let mut w = vec![
                        0xaa,
                        0xc0 | (part.len() as u8 + 2),
                        0x80,
                        0x05,
                        seq,
                        i as u8 | if i + 1 == total { 128 } else { 0 },
                    ];
                    w.extend_from_slice(part);
                    w.push(0x55);
                    self.out.extend(w);
                }
            }
            _ => {
                let mut frame = vec![1u8, 0x41, payload.len() as u8];
                frame.extend_from_slice(payload);
                let c = crc16(&frame);
                frame.extend_from_slice(&c.to_le_bytes());
                self.out.extend(frame);
            }
        }
    }
}

/// Modbus-RTU request frame `1, 0x41, len, payload..., crc_lo, crc_hi`.
/// Returns the payload and how many bytes were consumed. A corrupt frame is
/// reported with an empty payload so the caller resynchronises.
fn rtu_take(buf: &[u8]) -> Option<(Vec<u8>, usize)> {
    let start = buf.iter().position(|b| *b == 1)?;
    if buf.len() < start + 5 {
        return None;
    }
    if buf[start + 1] != 0x41 {
        return Some((Vec::new(), start + 1));
    }
    let n = buf[start + 2] as usize;
    let total = start + 3 + n + 2;
    if buf.len() < total {
        return None;
    }
    if crc16(&buf[start..total]) != 0 {
        return Some((Vec::new(), start + 1));
    }
    Some((buf[start + 3..start + 3 + n].to_vec(), total))
}

/// USB-CAN-A frame towards the main controller: id 0x0600, `seq`, fragment
/// index with the `0x80` last flag. Returns `(valid, seq, idx, data, used)`.
fn can_take(buf: &[u8]) -> Option<(bool, u8, u8, Vec<u8>, usize)> {
    let start = buf.iter().position(|b| *b == 0xaa)?;
    if buf.len() < start + 6 {
        return None;
    }
    let dlc = (buf[start + 1] & 0x0F) as usize;
    let total = start + 5 + dlc;
    if buf.len() < total {
        return None;
    }
    let ok = buf[start + 2] == 0x00 && buf[start + 3] == 0x06 && buf[total - 1] == 0x55;
    if !ok {
        return Some((false, 0, 0, Vec::new(), start + 1));
    }
    Some((
        true,
        buf[start + 4],
        buf[start + 5],
        buf[start + 6..total - 1].to_vec(),
        total,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal host adapter: one request packet in, wire bytes out.
    fn call(sim: &mut Simulator, seq: u8, motor: u8, op: u8, data: &[u8]) -> Option<Vec<u8>> {
        let mut q = vec![1, seq, 0, motor, op, data.len() as u8, 0];
        q.extend_from_slice(data);
        sim.request(&q)
    }

    fn status(resp: &Option<Vec<u8>>) -> u8 {
        resp.as_ref().expect("no response")[6]
    }

    #[test]
    fn info_layout_matches_firmware() {
        let mut sim = Simulator::new("main485", 1);
        let ctl = call(&mut sim, 1, 0, OP_INFO, &[]).unwrap();
        assert_eq!(ctl[5], 4);
        assert_eq!(&ctl[7..], &[1, 16, 1, 0]);
        for m in 1..=16u8 {
            let info = call(&mut sim, 2, m, OP_INFO, &[]).unwrap();
            assert_eq!(info[5], 10, "M{m}");
            assert_eq!(info[7], ROUTES[m as usize - 1].0);
            assert_eq!(info[12], 1, "ready");
            assert_eq!(info[13], 0, "overflow");
            assert_eq!(info[16], 16, "mask");
        }
        assert_eq!(status(&call(&mut sim, 3, 17, OP_INFO, &[])), MOTO_BAD);
        assert_eq!(status(&call(&mut sim, 4, 0, 127, &[0; 4])), MOTO_BAD);
        assert_eq!(status(&call(&mut sim, 5, 1, OP_INFO, &[0])), MOTO_BAD);
        assert_eq!(status(&call(&mut sim, 6, 1, OP_BOARD, &[8, 8])), MOTO_BAD);
        assert!(call(&mut sim, 7, 1, OP_INFO, &[0, 0, 0, 0, 0, 0, 0, 0]).is_some());
        assert!(call(&mut sim, 8, 1, OP_INFO, &[0]).is_some());
    }

    #[test]
    fn malformed_packets_get_no_answer() {
        let mut sim = Simulator::new("main485", 1);
        assert!(sim.request(&[1, 2, 0, 1, OP_INFO, 0]).is_none(), "short packet");
        assert!(sim.request(&[2, 2, 0, 1, OP_INFO, 0, 0]).is_none(), "bad version");
        assert!(sim.request(&[1, 2, 0, 1, OP_INFO, 1, 0]).is_none(), "length mismatch");
        assert!(sim.request(&[1, 2, 0, 1, OP_INFO, 0, 1]).is_none(), "reserved byte");
    }

    #[test]
    fn board_snapshot_banner_and_hand_id() {
        let mut sim = Simulator::new("main485", 1);
        let fw = call(&mut sim, 1, 0, OP_BOARD, &[8, 8]).unwrap();
        assert_eq!(fw[5], 16);
        assert_eq!(&fw[7..], FW_TEXT);
        let page = call(&mut sim, 2, 0, OP_BOARD, &[0, 64]).unwrap();
        assert_eq!(page[5], 128);
        assert_eq!(call(&mut sim, 3, 0, OP_BOARD, &[73, 1]).unwrap()[7..], [0, 1]);
        call(&mut sim, 4, 0, OP_HAND_ID, &[0x12, 0x34]).unwrap();
        assert_eq!(call(&mut sim, 5, 0, OP_BOARD, &[73, 1]).unwrap()[7..], [0x12, 0x34]);
        assert_eq!(status(&call(&mut sim, 6, 0, OP_HAND_ID, &[0, 0])), MOTO_BAD);
        assert_eq!(status(&call(&mut sim, 7, 0, OP_BOARD, &[255, 2])), MOTO_BAD);
        assert_eq!(status(&call(&mut sim, 8, 0, OP_BOARD, &[0, 0])), MOTO_BAD);
    }

    #[test]
    fn power_mask_shows_up_in_info() {
        let mut sim = Simulator::new("main485", 1);
        call(&mut sim, 1, 3, OP_POWER, &[1]).unwrap();
        let info = call(&mut sim, 2, 3, OP_INFO, &[]).unwrap();
        let bit = 1u8 << (ROUTES[2].2 - 1);
        assert_eq!(info[7 + 8], 1, "diagnostics_live");
        assert_eq!(info[7 + 9], 16 | bit);
        call(&mut sim, 3, 3, OP_POWER, &[0]).unwrap();
        assert_eq!(call(&mut sim, 4, 3, OP_INFO, &[]).unwrap()[7 + 9], 16);
        assert_eq!(status(&call(&mut sim, 5, 3, OP_POWER, &[2])), MOTO_BAD);
        assert_eq!(status(&call(&mut sim, 6, 3, OP_POWER, &[])), MOTO_BAD);
        call(&mut sim, 7, 0, OP_ALL_OFF, &[]).unwrap();
        assert_eq!(call(&mut sim, 8, 3, OP_INFO, &[]).unwrap()[7 + 8], 0);
    }

    #[test]
    fn multiple_hosts_are_refused() {
        let mut sim = Simulator::new("main485", 1);
        call(&mut sim, 1, 1, OP_OPEN, &[]).unwrap();
        // Switch the simulated link to CAN: that is source 2 in the firmware.
        let mut can = Simulator::new("maincan", 1);
        call(&mut can, 1, 1, OP_OPEN, &[]).unwrap();
        let second = call(&mut can, 2, 1, OP_OPEN, &[]);
        assert_eq!(status(&second), MOTO_OK, "same source may re-open");
    }

    #[test]
    fn register_roundtrip_over_all_wire_modes() {
        let mut seq = 1u8;
        for mode in ["main485", "maincan", "direct"] {
            let mut sim = Simulator::new(mode, 1);
            if mode != "direct" {
                call(&mut sim, 1, 1, OP_OPEN, &[]).unwrap();
            }
            for (addr, value) in [
                (0x100u16, 0x0000_0483u32),
                (0x150, 12_345),
                (regs::UART_CONTROL, 0x0040_0000),
            ] {
                if mode == "direct" {
                    sim.clear();
                    sim.write(&write_request(addr, value));
                    sim.clear();
                    sim.write(&read_request(addr));
                    let mut b = [0u8; 6];
                    let mut n = 0;
                    for _ in 0..20 {
                        n += sim.read(&mut b[n..]);
                        if n == 6 {
                            break;
                        }
                    }
                    assert_eq!(n, 6, "{mode} {addr:#05X}");
                    assert_eq!(u32::from_be_bytes([b[2], b[3], b[4], b[5]]), value);
                } else {
                    seq = seq.wrapping_add(1);
                    call(&mut sim, seq, 1, OP_WRITE, &write_request(addr, value)).unwrap();
                    seq = seq.wrapping_add(1);
                    call(&mut sim, seq, 1, OP_CLEAR, &[]).unwrap();
                    seq = seq.wrapping_add(1);
                    call(&mut sim, seq, 1, OP_WRITE, &read_request(addr)).unwrap();
                    seq = seq.wrapping_add(1);
                    let resp = call(&mut sim, seq, 1, OP_READ, &[]).unwrap();
                    let payload = &resp[7..];
                    assert_eq!(payload.len(), 6, "{mode} {addr:#05X}");
                    assert_eq!(
                        u32::from_be_bytes([payload[2], payload[3], payload[4], payload[5]]),
                        value,
                        "{mode} {addr:#05X}"
                    );
                }
            }
        }
    }

    #[test]
    fn rx_overflow_latches_until_clear() {
        let mut sim = Simulator::new("main485", 1);
        call(&mut sim, 1, 1, OP_OPEN, &[]).unwrap();
        // 64 read requests per write, 6-byte answers each: the 2048-byte ring
        // overflows on the fifth burst, like the firmware RX ring.
        let mut burst = Vec::new();
        for _ in 0..64 {
            burst.extend_from_slice(&read_request(regs::CHIP_ID));
        }
        for _ in 0..6 {
            call(&mut sim, 2, 1, OP_WRITE, &burst).unwrap();
        }
        assert_eq!(status(&call(&mut sim, 3, 1, OP_READ, &[])), MOTO_OVERFLOW);
        call(&mut sim, 4, 1, OP_CLEAR, &[]).unwrap();
        assert_eq!(call(&mut sim, 5, 1, OP_READ, &[]).unwrap()[5], 0);
    }

    #[test]
    fn rtmi_streams_configured_channels() {
        let mut sim = Simulator::new("main485", 1);
        call(&mut sim, 1, 1, OP_OPEN, &[]).unwrap();
        let mut seq = 2u8;
        for (ch, addr) in [
            (0u16, regs::FOC_PID_POSITION_ACTUAL),
            (1, regs::FOC_PID_VELOCITY_ACTUAL),
        ] {
            call(
                &mut sim,
                seq,
                1,
                OP_WRITE,
                &write_request(regs::UART_RTMI_CH_BASE + ch, rtmi_channel(addr)),
            )
            .unwrap();
            seq += 1;
        }
        call(
            &mut sim,
            seq,
            1,
            OP_WRITE,
            &write_request(regs::UART_CONTROL, uart_control_rtmi(0, 0, false)),
        )
        .unwrap();

        let mut frames = Vec::new();
        let mut parser = RtmiParser::new(5);
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(10));
            seq += 1;
            let payload = call(&mut sim, seq, 1, OP_READ, &[]).unwrap();
            parser.push(&payload[7..], &mut frames);
            if frames.len() > 20 {
                break;
            }
        }
        assert!(frames.len() > 10, "only {} frames", frames.len());
        assert!(frames.iter().any(|(ch, _)| *ch == 0));
        assert!(frames.iter().any(|(ch, _)| *ch == 1));
    }

    /// Streaming frame aligner shared with the host app's parser semantics.
    struct RtmiParser {
        buf: Vec<u8>,
        frame_len: usize,
    }

    impl RtmiParser {
        fn new(frame_len: usize) -> Self {
            Self { buf: Vec::new(), frame_len }
        }

        fn push(&mut self, bytes: &[u8], out: &mut Vec<(u8, i32)>) {
            self.buf.extend_from_slice(bytes);
            let mut i = 0;
            while self.buf.len() - i >= self.frame_len {
                let head = self.buf[i];
                let ok = head & 0x01 != 0
                    && head & 0x80 == 0
                    && (self.frame_len != 6 || crc8(&self.buf[i..i + 5]) == self.buf[i + 5]);
                if ok {
                    let ch = (head >> 1) & 0x07;
                    let v = i32::from_be_bytes([
                        self.buf[i + 1],
                        self.buf[i + 2],
                        self.buf[i + 3],
                        self.buf[i + 4],
                    ]);
                    out.push((ch, v));
                    i += self.frame_len;
                } else {
                    i += 1;
                }
            }
            self.buf.drain(..i);
        }
    }
}
