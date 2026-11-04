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
/// 「写找零参数」（工艺参数存主控，掉电不保存）。
pub const OP_PARAMS_WRITE: u8 = 15;
/// 「读找零参数」。
pub const OP_PARAMS_READ: u8 = 16;

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
    /// true: elapsed-time trajectory up to max_rpm; false: legacy fixed step.
    #[serde(default)]
    pub timed_seek: bool,
    #[serde(default)]
    pub dual_limit: bool,
}

/// 主控上报的找零状态（只读）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HomingState {    /// 0 空闲 / 1 进行中 / 2 成功 / 3 失败
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
    pub dual_supported: bool,
    pub limit_phase: u8,
    pub negative_valid: bool,
    pub positive_valid: bool,
    pub negative_contact: i32,
    pub positive_contact: i32,
    pub travel_counts: i32,
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
            8 => "双端行程无效：未离开首端、行程过短或位置溢出",
            7 => "闭环参数无效：请配置电流环、速度环、位置环及反馈来源/位置限位",
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
    Ok([if p.dual_limit {1} else {dir}, lo, hi, if p.dual_limit {2} else {u8::from(p.timed_seek)}])
}

/// 解码 `OP_HOMING_STATE` 的应答。///
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
        ..Default::default()
    };
    if raw[9] == 2 {
        if raw.len() < 24 {return None;}
        s.dual_supported = true;
        s.limit_phase = raw[10];
        s.negative_valid = raw[11] & 1 != 0;
        s.positive_valid = raw[11] & 2 != 0;
        let word = |i| i32::from_le_bytes(raw[i..i+4].try_into().unwrap());
        s.negative_contact = word(12);
        s.positive_contact = word(16);
        s.travel_counts = word(20);
        s.zero_valid &= s.negative_valid && s.positive_valid && s.travel_counts > 0;
    }
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
    if s.dual_supported && s.error == 0 {
        s.message = match (s.stage, s.limit_phase, s.zero_valid) {
            (1, 1, _) => "负端检测／退开确认中",
            (1, 2, _) => "负端有效，正端检测／退开确认中",
            (2, _, true) => "双端找零完成",
            (2, _, false) => "单端已记录，双端行程尚未有效",
            _ => "等待找零",
        }.into();
    }
    Some(s)
}

// ------------------------------------------------------------- params (op 15/16)

/// 找零工艺参数。**存在主控里**（内存，掉电不保存），上位机只在界面上改、
/// 点「写入配置」时用 `op 15` 下发，再用 `op 16` 回读校验。
///
/// 布局见 `doc/TODO/TODO-01-机械找零.md` 4.1b：8 个字段全部 u16 小端，共 16 字节。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HomingConfig {
    /// 判定系数 k ×1000（0.4 → 400）；阈值 = k × 额定电流
    pub k_x1000: u16,
    /// 额定电流刻度，mA（判据基准）
    pub rated_ma: u16,
    /// 连续超阈确认时间，ms（抗瞬态）
    pub confirm_ms: u16,
    /// 找零期间电流上限，mA；必须大于阈值
    pub limit_ma: u16,
    /// 推进速度上限，RPM
    pub max_rpm: u16,
    /// 到位后反向退开量，电机端角度
    pub retreat_deg: u16,
    /// 退开后稳定等待，ms
    pub settle_ms: u16,
    /// 找零超时，s
    pub timeout_s: u16,
}

impl Default for HomingConfig {
    /// 与固件参考实现、`doc/TODO/TODO-01-机械找零.md` 第 5 章的建议值一致。
    fn default() -> Self {
        Self {
            k_x1000: 400,
            rated_ma: 800,
            confirm_ms: 50,
            limit_ma: 600,
            max_rpm: 2000,
            retreat_deg: 360,
            settle_ms: 2000,
            timeout_s: 60,
        }
    }
}

impl HomingConfig {
    /// 接触电流阈值，mA（整数除法，与界面显示保持一致）。
    pub fn threshold_ma(&self) -> u32 {
        self.k_x1000 as u32 * self.rated_ma as u32 / 1000
    }

    /// 上位机侧先挡一遍越界值，避免把注定失败的参数写进主控。
    pub fn validate(&self) -> Result<(), String> {
        let fields: [(&str, u16, u16, u16); 8] = [
            ("判定系数 k（×1000）", self.k_x1000, 100, 2000),
            ("额定电流（mA）", self.rated_ma, 100, 3000),
            ("连续确认（ms）", self.confirm_ms, 10, 1000),
            ("找零电流上限（mA）", self.limit_ma, 100, 2000),
            ("推进速度上限（RPM）", self.max_rpm, 100, 6000),
            ("退开量（°）", self.retreat_deg, 0, 1080),
            ("退开稳定等待（ms）", self.settle_ms, 0, 10000),
            ("找零超时（s）", self.timeout_s, 5, 300),
        ];
        for (name, v, lo, hi) in fields {
            if v < lo || v > hi {
                return Err(format!("{name} 超出 {lo}…{hi}（当前 {v}）"));
            }
        }
        let threshold = self.threshold_ma();
        if self.limit_ma as u32 <= threshold {
            return Err(format!(
                "找零电流上限 {} mA 必须大于判定阈值 {} mA，否则判据永远无法满足",
                self.limit_ma, threshold
            ));
        }
        Ok(())
    }

    /// 编码成 `op 15` 的 16 字节载荷。
    pub fn encode(&self) -> Result<[u8; 16], String> {
        self.validate()?;
        let mut out = [0u8; 16];
        for (i, v) in [
            self.k_x1000,
            self.rated_ma,
            self.confirm_ms,
            self.limit_ma,
            self.max_rpm,
            self.retreat_deg,
            self.settle_ms,
            self.timeout_s,
        ]
        .iter()
        .enumerate()
        {
            let [lo, hi] = v.to_le_bytes();
            out[i * 2] = lo;
            out[i * 2 + 1] = hi;
        }
        Ok(out)
    }

    /// 解码 `op 16` 的应答。不足 16 字节说明固件没实现该操作码。
    pub fn decode(raw: &[u8]) -> Option<Self> {
        if raw.len() < 16 {
            return None;
        }
        let word = |i: usize| u16::from_le_bytes([raw[i * 2], raw[i * 2 + 1]]);
        Some(Self {
            k_x1000: word(0),
            rated_ma: word(1),
            confirm_ms: word(2),
            limit_ma: word(3),
            max_rpm: word(4),
            retreat_deg: word(5),
            settle_ms: word(6),
            timeout_s: word(7),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_default_negative_15_degrees() {
        let b = encode_start(&HomingParams { dir: -1, step_unit: 1500, timed_seek: false, dual_limit: false }).unwrap();
        assert_eq!(b, [0x00, 0xdc, 0x05, 0x00]); // 1500 = 0x05DC
    }

    #[test]
    fn encodes_positive_direction() {
        let b = encode_start(&HomingParams { dir: 1, step_unit: 100, timed_seek: false, dual_limit: false }).unwrap();
        assert_eq!(b[0], 0x01);
        assert_eq!(u16::from_le_bytes([b[1], b[2]]), 100);
    }

    #[test]
    fn encodes_timed_seek_without_changing_legacy_payload() {
        let p = HomingParams { dir: 1, step_unit: 100, timed_seek: true, dual_limit: false };
        assert_eq!(encode_start(&p).unwrap(), [1,100,0,1]);
        let legacy: HomingParams = serde_json::from_str(r#"{"dir":-1,"step_unit":1500}"#).unwrap();
        assert!(!legacy.timed_seek);
    }

    #[test]
    fn rejects_out_of_range_step() {
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 0, timed_seek: false, dual_limit: false }).is_err());
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 99, timed_seek: false, dual_limit: false }).is_err());
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 6001, timed_seek: false, dual_limit: false }).is_err());
        assert!(encode_start(&HomingParams { dir: -1, step_unit: 6000, timed_seek: false, dual_limit: false }).is_ok());
    }

    #[test]
    fn rejects_illegal_direction() {
        assert!(encode_start(&HomingParams { dir: 0, step_unit: 1500, timed_seek: false, dual_limit: false }).is_err());
        assert!(encode_start(&HomingParams { dir: 2, step_unit: 1500, timed_seek: false, dual_limit: false }).is_err());
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
    fn dual_requires_both_limits_and_positive_span() {
        let p=HomingParams{dir:-1,step_unit:1500,timed_seek:true,dual_limit:true};
        assert_eq!(encode_start(&p).unwrap(),[1,0xdc,5,2]);
        let mut b=[0u8;24];b[0]=2;b[1]=1;b[9]=2;b[10]=3;b[11]=3;
        b[12..16].copy_from_slice(&196608i32.to_le_bytes());
        b[16..20].copy_from_slice(&(-196608i32).to_le_bytes());
        b[20..24].copy_from_slice(&393216i32.to_le_bytes());
        let s=decode_state(&b).unwrap();
        assert!(s.zero_valid && s.dual_supported && s.negative_valid && s.positive_valid);
        assert_eq!(s.travel_counts,393216);
        b[11]=1;assert!(!decode_state(&b).unwrap().zero_valid);
        b[11]=3;b[20..24].fill(0);assert!(!decode_state(&b).unwrap().zero_valid);
        assert!(decode_state(&b[..23]).is_none());
    }

    #[test]
    fn short_frame_means_unimplemented() {
        assert!(decode_state(&[]).is_none());
        assert!(decode_state(&[2, 1, 0, 0, 0, 0, 0, 0, 0]).is_none());
    }

    #[test]
    fn error_text_covers_documented_codes() {
        let mut s = HomingState::default();
        for code in 1..=7u8 {
            s.error = code;
            assert!(!s.error_text().is_empty(), "code {code} needs a message");
        }
        s.error = 0;
        assert_eq!(s.error_text(), "");
    }

    #[test]
    fn default_config_matches_reference_implementation() {
        let c = HomingConfig::default();
        assert_eq!(c.threshold_ma(), 320);
        assert!(c.validate().is_ok());
        // 16 字节，全部小端
        assert_eq!(
            c.encode().unwrap(),
            [0x90, 0x01, 0x20, 0x03, 0x32, 0x00, 0x58, 0x02, 0xd0, 0x07, 0x68, 0x01, 0xd0, 0x07, 0x3c, 0x00]
        );
    }

    #[test]
    fn config_roundtrip() {
        let mut c = HomingConfig::default();
        c.k_x1000 = 750;
        c.confirm_ms = 500;
        c.timeout_s = 180;
        c.limit_ma = 900; // 阈值 750×800/1000 = 600，上限必须更大
        let back = HomingConfig::decode(&c.encode().unwrap()).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn config_rejects_limit_below_threshold() {
        let mut c = HomingConfig::default();
        c.limit_ma = 320; // == 阈值，判据永远无法满足
        assert!(c.encode().is_err());
        c.limit_ma = 321;
        assert!(c.encode().is_ok());
    }

    #[test]
    fn config_rejects_out_of_range_fields() {
        for (mut c, why) in [
            (
                {
                    let mut c = HomingConfig::default();
                    c.k_x1000 = 99;
                    c
                },
                "k too small",
            ),
            (
                {
                    let mut c = HomingConfig::default();
                    c.timeout_s = 4;
                    c
                },
                "timeout too small",
            ),
            (
                {
                    let mut c = HomingConfig::default();
                    c.max_rpm = 6001;
                    c
                },
                "rpm too large",
            ),
            (
                {
                    let mut c = HomingConfig::default();
                    c.retreat_deg = 1081;
                    c
                },
                "retreat too large",
            ),
        ] {
            c.rated_ma = c.rated_ma.max(100);
            assert!(c.encode().is_err(), "{why}");
        }
    }

    #[test]
    fn config_decode_short_frame_means_unimplemented() {
        assert!(HomingConfig::decode(&[]).is_none());
        assert!(HomingConfig::decode(&[0u8; 15]).is_none());
        assert!(HomingConfig::decode(&[0u8; 16]).is_some());
    }
}
