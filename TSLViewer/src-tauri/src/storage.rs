//! On-board parameter storage: M24C02 (2 Kbit I²C EEPROM) behind the TMC6460
//! I/O controller.
//!
//! The chip is wired to `HALL_U` (SDA) and `HALL_V` (SCL) — the only pins the
//! TMC6460 can act as an I²C master on — so using it costs the Hall inputs.
//! All access goes through the I/O controller ROM features (datasheet p.105-106):
//!
//! | feature       | command      | reply                                          |
//! |---------------|--------------|------------------------------------------------|
//! | `I2C_INIT_OD` | `0xAA02yyyy` | `RESPONSE_0` echoes, `fI2C=fSYS/4/(yyyy+1)`     |
//! | `I2C_WRITE`   | `0xEyyyzzzz` | `RESPONSE_0` echoes                             |
//! | `I2C_READ`    | `0xDyyy0000` | `RESPONSE_1[7:0]` = byte                        |
//! | `I2C_EEPROM`  | `0xAA030000` | whole EEPROM copied into the I/O controller RAM  |
//! | `RAM_READ`    | `0xCyyy0000` | `RESPONSE_1[15:0]`                              |
//!
//! Parameter block layout (two copies, A/B, so a torn write never loses both):
//!
//! ```text
//! 0x00 .. 0x6F  block A (112 B)
//! 0x70 .. 0xDF  block B (112 B)
//! 0xE0 .. 0xFD  reserved
//! 0xFE          scratch byte used by the write/read self test
//!
//! block:
//!   [0..4)    "TSL1"
//!   [4]       version (1)
//!   [5]       payload length in bytes (92)
//!   [6..8)    sequence, u16 little endian (higher = newer)
//!   [8..100)  payload: 23 × u32 little endian, see `StoreParams`
//!   [100]     CRC-8 (poly 0x07) over [0..100)
//!   [101..112) 0xFF
//! ```

use std::thread::sleep;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::link::{Link, Result};
use crate::regs;

pub const EEPROM_LEN: usize = 256;
pub const BLOCK_LEN: usize = 112;
pub const BLOCK_A: usize = 0x00;
pub const BLOCK_B: usize = 0x70;
pub const SCRATCH: usize = 0xFE;

const MAGIC: [u8; 4] = *b"TSL1";
const VERSION: u8 = 1;
const PAYLOAD_WORDS: usize = 23;
const PAYLOAD_LEN: usize = PAYLOAD_WORDS * 4;
const HEADER_LEN: usize = 8;
const CRC_OFFSET: usize = HEADER_LEN + PAYLOAD_LEN;
/// M24C02 needs ≤5 ms per byte write; leave headroom.
const WRITE_DELAY_MS: u64 = 6;

// ---------------------------------------------------------------------------
// parameter block
// ---------------------------------------------------------------------------

/// Everything worth keeping across a power cycle. Field order defines the
/// payload word order — do not reorder without bumping `VERSION`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StoreParams {
    pub cpr: u32,
    pub poles: u32,
    pub csa_gain: u32,
    pub pwm_max_count: u32,
    pub phi_e_offset: u32,
    pub torque_limit_ma: u32,
    pub flux_limit_ma: u32,
    pub vel_limit_rpm: u32,
    pub uq_ud_limit: u32,
    pub cur_p: u32,
    pub cur_i: u32,
    pub vel_p: u32,
    pub vel_i: u32,
    pub pos_p: u32,
    pub pos_i: u32,
    /// bit0 = 电角度已标定
    pub flags: u32,
    pub motor_id: u32,
    pub axis_origin: i32,
    pub axis_min: i32,
    pub axis_max: i32,
    pub lead_um: u32,
    /// 305.4 counts/RPM → 3054
    pub counts_per_rpm_x10: u32,
    /// 0.20131 mA/LSB → 201 µA
    pub ma_per_count_ua: u32,
}

impl Default for StoreParams {
    fn default() -> Self {
        Self {
            cpr: 16_384,
            poles: 1,
            csa_gain: 3,
            pwm_max_count: 4800,
            phi_e_offset: 0,
            torque_limit_ma: 800,
            flux_limit_ma: 0,
            vel_limit_rpm: 25_000,
            uq_ud_limit: 0x5A81,
            cur_p: 64,
            cur_i: 48,
            vel_p: 500,
            vel_i: 250,
            pos_p: 500,
            pos_i: 0,
            flags: 0,
            motor_id: 1,
            axis_origin: 0,
            axis_min: 0,
            axis_max: 0,
            lead_um: 2000,
            counts_per_rpm_x10: 3054,
            ma_per_count_ua: 201,
        }
    }
}

impl StoreParams {
    fn words(&self) -> [u32; PAYLOAD_WORDS] {
        [
            self.cpr,
            self.poles,
            self.csa_gain,
            self.pwm_max_count,
            self.phi_e_offset,
            self.torque_limit_ma,
            self.flux_limit_ma,
            self.vel_limit_rpm,
            self.uq_ud_limit,
            self.cur_p,
            self.cur_i,
            self.vel_p,
            self.vel_i,
            self.pos_p,
            self.pos_i,
            self.flags,
            self.motor_id,
            self.axis_origin as u32,
            self.axis_min as u32,
            self.axis_max as u32,
            self.lead_um,
            self.counts_per_rpm_x10,
            self.ma_per_count_ua,
        ]
    }
}

fn encode(params: &StoreParams, seq: u16) -> [u8; BLOCK_LEN] {
    let mut b = [0xFFu8; BLOCK_LEN];
    b[0..4].copy_from_slice(&MAGIC);
    b[4] = VERSION;
    b[5] = PAYLOAD_LEN as u8;
    b[6..8].copy_from_slice(&seq.to_le_bytes());
    for (i, w) in params.words().iter().enumerate() {
        let o = HEADER_LEN + i * 4;
        b[o..o + 4].copy_from_slice(&w.to_le_bytes());
    }
    b[CRC_OFFSET] = crc8(&b[..CRC_OFFSET]);
    b
}

fn decode(b: &[u8]) -> Option<(StoreParams, u16)> {
    if b.len() < BLOCK_LEN || b[0..4] != MAGIC {
        return None;
    }
    if b[4] != VERSION || b[5] as usize != PAYLOAD_LEN {
        return None;
    }
    if crc8(&b[..CRC_OFFSET]) != b[CRC_OFFSET] {
        return None;
    }
    let mut w = [0u32; PAYLOAD_WORDS];
    for (i, slot) in w.iter_mut().enumerate() {
        let o = HEADER_LEN + i * 4;
        *slot = u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    }
    Some((
        StoreParams {
            cpr: w[0],
            poles: w[1],
            csa_gain: w[2],
            pwm_max_count: w[3],
            phi_e_offset: w[4],
            torque_limit_ma: w[5],
            flux_limit_ma: w[6],
            vel_limit_rpm: w[7],
            uq_ud_limit: w[8],
            cur_p: w[9],
            cur_i: w[10],
            vel_p: w[11],
            vel_i: w[12],
            pos_p: w[13],
            pos_i: w[14],
            flags: w[15],
            motor_id: w[16],
            axis_origin: w[17] as i32,
            axis_min: w[18] as i32,
            axis_max: w[19] as i32,
            lead_um: w[20],
            counts_per_rpm_x10: w[21],
            ma_per_count_ua: w[22],
        },
        u16::from_le_bytes([b[6], b[7]]),
    ))
}

fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for byte in data {
        crc ^= *byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 { (crc << 1) ^ 0x07 } else { crc << 1 };
        }
    }
    crc
}

// ---------------------------------------------------------------------------
// I/O controller I²C access
// ---------------------------------------------------------------------------

/// `I2C_INIT_OD` with the closest reachable clock: `fI2C = 60 MHz / 4 / (yyyy+1)`.
pub fn init_i2c(link: &Link, hz: u32) -> Result<u32> {
    let hz = hz.clamp(10_000, 100_000);
    let yyyy = (60_000_000u32 / 4 / hz).saturating_sub(1).min(0xFFFF);
    let cmd = 0xAA02_0000 | yyyy;
    link.write_reg(regs::IO_COMMAND, cmd)?;
    sleep(Duration::from_millis(5));
    let echo = link.read_reg_retry(regs::IO_RESPONSE_0, 3)?;
    if echo != cmd {
        link.log(
            "warn",
            "storage",
            format!("I2C_INIT_OD 回显 0x{echo:08X}，期望 0x{cmd:08X}"),
        );
    }
    Ok(60_000_000 / 4 / (yyyy + 1))
}

/// Point `HALL_U`/`HALL_V` at the I/O controller as SDA/SCL. Costs the Hall
/// inputs — the only pins the TMC6460 can drive I²C on.
pub fn enable_i2c_pins(link: &Link) -> Result<(u32, u32)> {
    let cur = link.read_reg_retry(regs::CHIP_IO_MATRIX, 3)?;
    // PIN_HALL_U[8:6] = 3 (SDA), PIN_HALL_V[11:9] = 3 (SCL)
    let mut next = cur & !(0b111 << 6) & !(0b111 << 9);
    next |= 3 << 6;
    next |= 3 << 9;
    if next != cur {
        link.write_verified(regs::CHIP_IO_MATRIX, next, 0x0FFF)?;
        link.log(
            "info",
            "storage",
            format!("IO_MATRIX 0x{cur:08X} → 0x{next:08X}（HALL_U=SDA, HALL_V=SCL）"),
        );
    }
    Ok((cur, next))
}

fn write_byte(link: &Link, addr: usize, data: u8) -> Result<()> {
    let cmd = 0xE000_0000 | ((addr as u32 & 0x0FFF) << 16) | data as u32;
    link.write_reg(regs::IO_COMMAND, cmd)?;
    sleep(Duration::from_millis(WRITE_DELAY_MS));
    let echo = link.read_reg_retry(regs::IO_RESPONSE_0, 3)?;
    if echo != cmd {
        link.log(
            "warn",
            "storage",
            format!("I2C_WRITE 回显 0x{echo:08X}，期望 0x{cmd:08X}"),
        );
    }
    Ok(())
}

fn read_byte(link: &Link, addr: usize) -> Result<u8> {
    let cmd = 0xD000_0000 | ((addr as u32 & 0x0FFF) << 16);
    link.write_reg(regs::IO_COMMAND, cmd)?;
    let v = link.read_reg_retry(regs::IO_RESPONSE_1, 3)?;
    Ok((v & 0xFF) as u8)
}

pub fn write_bytes(link: &Link, addr: usize, data: &[u8]) -> Result<()> {
    for (i, b) in data.iter().enumerate() {
        write_byte(link, addr + i, *b)?;
    }
    Ok(())
}

pub fn read_bytes(link: &Link, addr: usize, len: usize) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        out.push(read_byte(link, addr + i)?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// high level operations
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Probe {
    pub ok: bool,
    pub i2c_hz: u32,
    pub matrix_before: u32,
    pub matrix_after: u32,
    pub addr: usize,
    pub saved: u8,
    pub written: [u8; 2],
    pub read_back: [u8; 2],
    pub message: String,
}

/// Non-destructive write/read test on the scratch byte (`0xFE`).
pub fn probe(link: &Link) -> Result<Probe> {
    let (before, after) = enable_i2c_pins(link)?;
    let hz = init_i2c(link, 100_000)?;
    let saved = read_byte(link, SCRATCH)?;
    let pattern = [0xA5u8, 0x5A];
    let mut read_back = [0u8; 2];
    for (i, p) in pattern.iter().enumerate() {
        write_byte(link, SCRATCH, *p)?;
        read_back[i] = read_byte(link, SCRATCH)?;
    }
    let ok = read_back == pattern;
    write_byte(link, SCRATCH, saved)?;
    let message = if ok {
        "EEPROM 可读可写".to_string()
    } else {
        format!(
            "回读不符（写 0x{:02X}/0x{:02X}，读 0x{:02X}/0x{:02X}）：检查 I²C 上拉与 IO_MATRIX",
            pattern[0], pattern[1], read_back[0], read_back[1]
        )
    };
    link.log(
        if ok { "info" } else { "error" },
        "storage",
        format!("EEPROM 自检 @0x{SCRATCH:02X}: {message}"),
    );
    Ok(Probe {
        ok,
        i2c_hz: hz,
        matrix_before: before,
        matrix_after: after,
        addr: SCRATCH,
        saved,
        written: pattern,
        read_back,
        message,
    })
}

pub fn dump(link: &Link) -> Result<Vec<u8>> {
    enable_i2c_pins(link)?;
    init_i2c(link, 100_000)?;
    read_bytes(link, 0, EEPROM_LEN)
}

#[derive(Serialize)]
pub struct SaveInfo {
    pub seq: u16,
    pub block: String,
    pub bytes_written: usize,
    pub verified: bool,
    pub elapsed_ms: u128,
}

pub fn save(link: &Link, params: &StoreParams) -> Result<SaveInfo> {
    let started = std::time::Instant::now();
    enable_i2c_pins(link)?;
    init_i2c(link, 100_000)?;
    // The pins are remapped now; never leave the bridge driving.
    link.write_reg(
        regs::MCC_MOTOR_MOTION,
        regs::motor_motion(regs::MODE_PWM_OFF, params.poles, false, false),
    )?;

    let seq = next_seq(link)?.max(1);
    let block = encode(params, seq);
    write_bytes(link, BLOCK_A, &block)?;
    let verified = read_bytes(link, BLOCK_A, BLOCK_LEN)? == block;
    if !verified {
        link.log("error", "storage", "参数块 A 回读不一致，未写 B");
        return Ok(SaveInfo {
            seq,
            block: "A".into(),
            bytes_written: BLOCK_LEN,
            verified: false,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    write_bytes(link, BLOCK_B, &block)?;
    let ok_b = read_bytes(link, BLOCK_B, BLOCK_LEN)? == block;
    link.log(
        if ok_b { "info" } else { "warn" },
        "storage",
        format!(
            "参数块写入 EEPROM：seq={seq}，A/B 校验{}",
            if ok_b { "通过" } else { "B 不一致" }
        ),
    );
    Ok(SaveInfo {
        seq,
        block: "A+B".into(),
        bytes_written: BLOCK_LEN * 2,
        verified: ok_b,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn next_seq(link: &Link) -> Result<u16> {
    let a = read_bytes(link, BLOCK_A, BLOCK_LEN)
        .ok()
        .and_then(|b| decode(&b).map(|(_, s)| s));
    let b = read_bytes(link, BLOCK_B, BLOCK_LEN)
        .ok()
        .and_then(|b| decode(&b).map(|(_, s)| s));
    Ok(a.unwrap_or(0).max(b.unwrap_or(0)).wrapping_add(1))
}

#[derive(Serialize)]
pub struct LoadInfo {
    pub found: bool,
    pub block: String,
    pub seq: u16,
    pub crc_a: bool,
    pub crc_b: bool,
    pub params: Option<StoreParams>,
    pub message: String,
}

pub fn load(link: &Link) -> Result<LoadInfo> {
    enable_i2c_pins(link)?;
    init_i2c(link, 100_000)?;
    let raw_a = read_bytes(link, BLOCK_A, BLOCK_LEN)?;
    let raw_b = read_bytes(link, BLOCK_B, BLOCK_LEN)?;
    let a = decode(&raw_a);
    let b = decode(&raw_b);
    let (params, seq, block) = match (a.clone(), b.clone()) {
        (Some((pa, sa)), Some((pb, sb))) => {
            if sb > sa {
                (Some(pb), sb, "B")
            } else {
                (Some(pa), sa, "A")
            }
        }
        (Some((pa, sa)), None) => (Some(pa), sa, "A"),
        (None, Some((pb, sb))) => (Some(pb), sb, "B"),
        (None, None) => (None, 0, "—"),
    };
    let message = match &params {
        Some(_) => format!("有效参数块（{block}，seq={seq}）"),
        None => "未找到有效参数块（magic/CRC 不符）".to_string(),
    };
    Ok(LoadInfo {
        found: params.is_some(),
        block: block.to_string(),
        seq,
        crc_a: a.is_some(),
        crc_b: b.is_some(),
        params,
        message,
    })
}

/// Invalidate both blocks by wiping the magic (8 byte writes instead of 224).
pub fn erase(link: &Link) -> Result<usize> {
    enable_i2c_pins(link)?;
    init_i2c(link, 100_000)?;
    let mut n = 0;
    for base in [BLOCK_A, BLOCK_B] {
        for i in 0..4 {
            write_byte(link, base + i, 0xFF)?;
            n += 1;
        }
    }
    link.log("warn", "storage", "EEPROM 参数块已作废（magic 清空）");
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_round_trips() {
        let p = StoreParams::default();
        let b = encode(&p, 7);
        let (back, seq) = decode(&b).expect("decode");
        assert_eq!(seq, 7);
        assert_eq!(back, p);
    }

    #[test]
    fn crc_rejects_corruption() {
        let mut b = encode(&StoreParams::default(), 1);
        b[HEADER_LEN + 3] ^= 0xFF;
        assert!(decode(&b).is_none());
    }

    #[test]
    fn erased_eeprom_is_not_valid() {
        assert!(decode(&[0xFFu8; BLOCK_LEN]).is_none());
    }

    #[test]
    fn blocks_fit_the_chip() {
        assert!(BLOCK_B + BLOCK_LEN <= SCRATCH);
        assert!(SCRATCH < EEPROM_LEN);
    }
}
