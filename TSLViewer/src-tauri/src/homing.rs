//! 机械找零（撞限位回零）——**上位机只做上位机的事**。
//!
//! 分工（见 `doc/TODO/TODO-01-机械找零.md`）：
//!
//! | 角色 | 做什么 |
//! |---|---|
//! | 上位机（本文件） | 下发「方向 + 每拍步进」、发出开始/取消请求、轮询并显示状态 |
//! | 主控固件 | 门控、位置直通推进、电流判据 + 连续确认、超时保护、写零点、退开、置有效标志 |
//!
//! 所以这里没有任何判定逻辑：不采样电流、不推断「到了」、不写零点。
//! 只做两件事——把参数编码成主控能懂的字节，把主控回的状态字解码成界面能显示的结构。

use serde::{Deserialize, Serialize};

/// 主控协议里「找零请求」的操作码。
pub const OP_HOMING_START: u8 = 12;
/// 「找零状态查询」。
pub const OP_HOMING_STATE: u8 = 13;
/// 「找零取消」。
pub const OP_HOMING_CANCEL: u8 = 14;

/// 步进量的合法区间（0.01° 单位）。太小推不动，太大冲击大。
pub const STEP_MIN: u16 = 100; // 1°
pub const STEP_MAX: u16 = 6000; // 60°

/// 上位机唯一下发的工艺参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomingParams {
    /// 找零方向：-1 / +1
    pub dir: i8,
    /// 每拍推进量，单位 0.01°（电机端）；1500 = 15°
    pub step_unit: u16,
}

/// 主控上报的找零状态（只读）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HomingState {
    /// 0 空闲 / 1 进行中 / 2 成功 / 3 失败
    pub stage: u8,
    /// 行程零点有效；上电必清
    pub zero_valid: bool,
    /// q 轴实测电流，mA
    pub iq_ma: f64,
    /// 本次找零已用时，ms
    pub elapsed_ms: u32,
    /// 0 无 / 1 超时 / 2 控制器故障 / 3 取消 / 4 断使能 / 5 编码器无效 / 6 未授权
    pub error: u8,
    /// 主控给的说明
    pub message: String,
}

impl HomingState {
    pub fn error_text(&self) -> &'static str {
        match self.error {
            1 => "找零超时（未检测到接触）",
            2 => "控制器故障（过流/过温锁存）",
            3 => "已取消",
            4 => "已断开使能",
            5 => "编码器无效，请先做电角度标定",
            6 => "未授予运动授权",
            _ => "",
        }
    }
}

/// 把工艺参数编码成 `OP_HOMING_START` 的载荷。
///
/// 布局（4 字节，与固件一一对应）：
/// `[0]` 方向（0x00 = 负 / 0x01 = 正）、`[1..3)` 步进量 u16 小端（0.01°）。
pub fn encode_start(p: &HomingParams) -> Result<[u8; 4], String> {
    if p.dir != 1 && p.dir != -1 {
        return Err("找零方向只能是 +1 或 -1".into());
    }
    if !(STEP_MIN..=STEP_MAX).contains(&p.step_unit) {
        return Err(format!(
            "每拍步进需在 {:.0}°…{:.0}° 之间",
            STEP_MIN as f64 / 100.0,
            STEP_MAX as f64 / 100.0
        ));
    }
    let dir = if p.dir > 0 { 1u8 } else { 0u8 };
    let [lo, hi] = p.step_unit.to_le_bytes();
    Ok([dir, lo, hi, 0])
}

/// 解码 `OP_HOMING_STATE` 的应答。
///
/// 布局（10 字节）：`[0]` 子状态、`[1]` 零点有效、`[2]` 错误码、
/// `[3..7)` 用时 ms u32 小端、`[7..9)` i_q 有符号 mA i16 小端、`[9]` 保留。
/// 不足 10 字节说明固件没实现该操作码，返回 `None` 让上层报「固件未实现」。
pub fn decode_state(raw: &[u8]) -> Option<HomingState> {
    if raw.len() < 10 {
        return None;
    }
    let elapsed_ms = u32::from_le_bytes([raw[3], raw[4], raw[5], raw[6]]);
    let iq_ma = i16::from_le_bytes([raw[7], raw[8]]) as f64;
    let mut s = HomingState {
        stage: raw[0],
        zero_valid: raw[1] != 0,
        error: raw[2],
        elapsed_ms,
        iq_ma,
        message: String::new(),
    };
    // 固件可以只在状态字里给码值；这里补一句人能读的说明，界面直接显示。
    s.message = if s.error != 0 {
        s.error_text().to_string()
    } else if s.stage == 2 {
        "找零完成".to_string()
    } else if s.stage == 1 {
        "进行中".to_string()
    } else {
        String::new()
    };
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_default_negative_15_degrees() {
        let b = encode_start(&HomingParams { dir: -1, step_unit: 1500 }).unwrap();
        assert_eq!(b, [0x00, 0xdc, 0x05, 0x00]); // 1500 = 0x05DC
    }

    #[test]
    fn encodes_positive_direction() {
        let b = encode_start(&HomingParams { dir: 1, step_unit: 100 }).unwrap();
        assert_eq!(b[0], 0x01);
        assert_eq!(u16::from_le_bytes([b[1], b[2]]), 100);
    }

    #[test]
    fn rejects_out_of_range_step() {
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 0 }).is_err());
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 99 }).is_err());
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 6001 }).is_err());
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 6000 }).is_ok());
    }

    #[test]
    fn rejects_illegal_direction() {
        assert!(encode_start(&HomingParams { dir: 0, step_unit: 1500 }).is_err());
        assert!(encode_start(&HomingParams { dir: 2, step_unit: 1500 }).is_err());
    }

    #[test]
    fn decodes_status_frame() {
        let raw = [2u8, 1, 0, 0xe8, 0x03, 0, 0, 0x58, 0x02, 0];
        let s = decode_state(&raw).expect("10-byte frame");
        assert_eq!(s.stage, 2);
        assert!(s.zero_valid);
        assert_eq!(s.elapsed_ms, 1000);
        assert_eq!(s.iq_ma, 600.0);
        assert_eq!(s.message, "找零完成");
    }

    #[test]
    fn decodes_negative_current() {
        let raw = [1u8, 0, 0, 0, 0, 0, 0, 0x74, 0xff, 0]; // -140 mA
        assert_eq!(decode_state(&raw).unwrap().iq_ma, -140.0);
    }

    #[test]
    fn short_frame_means_unimplemented() {
        assert!(decode_state(&[]).is_none());
        assert!(decode_state(&[2, 1, 0, 0, 0, 0, 0, 0, 0]).is_none());
    }

    #[test]
    fn error_text_covers_documented_codes() {
        let mut s = HomingState::default();
        for code in 1..=6u8 {
            s.error = code;
            assert!(!s.error_text().is_empty(), "code {code} needs a message");
        }
        s.error = 0;
        assert_eq!(s.error_text(), "");
    }
}