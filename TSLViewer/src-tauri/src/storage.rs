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
//! | `I2C_READ`    | `0xDyyy0000` | `RESPONSE_1[15:0]`; byte mapping UNVERIFIED      |
//! | `I2C_EEPROM`  | `0xAA030000` | whole EEPROM copied into the I/O controller RAM  |
//! | `RAM_READ`    | `0xCyyy0000` | `RESPONSE_1[15:0]`                              |
//!
//! Motor archives use the MCU RUN2 storage API only.

use std::thread::sleep;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::link::{Link, LinkError, Result};
use crate::regs;
use crate::io_rom::{self, LinkPort};

/// Two supplied datasheets do not define the ROM-to-M24C02 byte contract.
/// Do not run byte operations
/// or take SSI ownership based on that unverified assumption. No UI override.
pub fn require_byte_contract() -> Result<()> {
    Err(LinkError::ValueError(
        "M24C02 字节访问后端尚未验证：TMC ROM 定义为12位地址/16位数据，器件寻址、字节序和SSI恢复仍待核实；本次未访问或修改EEPROM".into(),
    ))
}

pub const EEPROM_LEN: usize = 256;
pub const SCRATCH: usize = 0xFE;

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

// ---------------------------------------------------------------------------
// I/O controller I²C access
// ---------------------------------------------------------------------------

/// `I2C_INIT_OD` with the closest reachable clock: `fI2C = 60 MHz / 4 / (yyyy+1)`.
pub fn init_i2c(link: &Link, hz: u32) -> Result<u32> {
    require_byte_contract()?;
    let hz = hz.clamp(10_000, 100_000);
    let yyyy = (60_000_000u32 / 4 / hz).saturating_sub(1).min(0xFFFF);
    let cmd = 0xAA02_0000 | yyyy;
    io_rom::execute(&mut LinkPort::new(link), cmd, false, 50)?;
    Ok(60_000_000 / 4 / (yyyy + 1))
}

/// Point `HALL_U`/`HALL_V` at the I/O controller as SDA/SCL. Costs the Hall
/// inputs — the only pins the TMC6460 can drive I²C on.
pub fn enable_i2c_pins(link: &Link) -> Result<(u32, u32)> {
    require_byte_contract()?;
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
    require_byte_contract()?;
    let cmd = io_rom::i2c_command(addr, Some(u16::from(data)))?;
    io_rom::execute(&mut LinkPort::new(link), cmd, false, 50)?;
    sleep(Duration::from_millis(WRITE_DELAY_MS));
    Ok(())
}

fn read_byte(link: &Link, addr: usize) -> Result<u8> {
    require_byte_contract()?;
    let cmd = io_rom::i2c_command(addr, None)?;
    let v = io_rom::execute(&mut LinkPort::new(link), cmd, true, 50)?.ok_or(LinkError::Corrupt)?;
    u8::try_from(v).map_err(|_| LinkError::ValueError("ROM 返回值不是单字节；禁止静默截断".into()))
}

pub fn write_bytes(link: &Link, addr: usize, data: &[u8]) -> Result<()> {
    require_byte_contract()?;
    if addr > EEPROM_LEN || data.len() > EEPROM_LEN-addr { return Err(LinkError::Corrupt); }
    for (i, b) in data.iter().enumerate() {
        write_byte(link, addr + i, *b)?;
    }
    Ok(())
}

pub fn read_bytes(link: &Link, addr: usize, len: usize) -> Result<Vec<u8>> {
    require_byte_contract()?;
    if addr > EEPROM_LEN || len > EEPROM_LEN-addr { return Err(LinkError::Corrupt); }
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
    reject_new_layout(link)?;
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

fn retired_archive() -> LinkError {
    LinkError::ValueError("旧电机档案接口已移除，请使用主控 RUN2 档案接口".into())
}
pub fn save(_link: &Link, _params: &StoreParams) -> Result<SaveInfo> {Err(retired_archive())}

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

pub fn load(_link: &Link) -> Result<LoadInfo> {Err(retired_archive())}
pub fn erase(_link: &Link) -> Result<usize> {Err(retired_archive())}

/// The old B block and scratch overlap MTR1 slot B. Refuse legacy mutations
/// even when the new record has an invalid commit marker (interrupted save).
fn reject_new_layout(link: &Link) -> Result<()> {
    for base in [0usize, 128usize] {
        let magic = read_bytes(link, base, 4)?;
        if magic == b"MTR1" {
            return Err(LinkError::ValueError(
                "检测到主控 MTR1 双槽档案；旧版保存、清除和0xFE写测试已禁止，请使用主控档案接口".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retired_archives_reject_without_device_io() {
        let link=Link::new();
        for e in [save(&link,&StoreParams::default()).err(),load(&link).err(),erase(&link).err()] {
            assert!(matches!(e,Some(LinkError::ValueError(ref text)) if text.contains("RUN2")));
        }
    }
    #[test]
    fn unverified_byte_backend_still_rejects() {assert!(require_byte_contract().is_err());}
}
