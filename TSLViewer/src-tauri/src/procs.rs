//! High level test procedures: encoder bring-up, phi_e alignment, PID apply,
//! step response, closed-loop runs and automated test sequences.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::link::{Link, LinkError, Result};
use crate::regs;

// --------------------------------------------------------------------------
// job plumbing
// --------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct JobProgress {
    pub job: String,
    pub idx: usize,
    pub total: usize,
    pub label: String,
    pub status: &'static str,
    pub detail: String,
}

#[derive(Clone, Serialize)]
pub struct JobDone {
    pub job: String,
    pub ok: bool,
    pub message: String,
    pub data: serde_json::Value,
}

pub struct Ctx<'a> {
    pub link: Arc<Link>,
    pub app: &'a AppHandle,
    pub job: &'a str,
    pub cancel: &'a AtomicBool,
    pub total: usize,
    pub idx: usize,
}

impl<'a> Ctx<'a> {
    pub fn new(link: Arc<Link>, app: &'a AppHandle, job: &'a str, cancel: &'a AtomicBool) -> Self {
        Self {
            link,
            app,
            job,
            cancel,
            total: 12,
            idx: 0,
        }
    }

    fn emit(&self, label: &str, status: &'static str, detail: impl Into<String>) {
        let _ = self.app.emit(
            "tsl:job:progress",
            JobProgress {
                job: self.job.to_string(),
                idx: self.idx,
                total: self.total,
                label: label.to_string(),
                status,
                detail: detail.into(),
            },
        );
    }

    pub fn begin(&mut self, label: &str) -> usize {
        self.idx += 1;
        self.emit(label, "run", "");
        self.idx
    }

    pub fn ok(&self, label: &str, detail: impl Into<String>) {
        self.emit(label, "ok", detail);
    }

    pub fn fail(&self, label: &str, detail: impl Into<String>) {
        self.emit(label, "fail", detail);
    }

    pub fn info(&self, label: &str, detail: impl Into<String>) {
        self.emit(label, "info", detail);
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

fn ms(n: u64) {
    thread::sleep(Duration::from_millis(n));
}

// --------------------------------------------------------------------------
// encoder configuration
// --------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct EncoderCfg {
    pub preset: String,
    /// Datagram length in bits sent per SPI frame (MT6701: 14 verified, 24 full frame).
    pub frame_bits: u32,
    /// CPOL/CPHA index 0..3.
    pub spi_mode: u32,
    pub spi_hz: u32,
    pub idle_cycles: u32,
    pub data_mask: u32,
    pub send_data: u32,
    /// `u[7] = 1` routes CSN to ENC_N, 0 routes it to HALL_W.
    pub csn_via_enc_n: bool,
    pub cpr: u32,
    pub poles: u32,
    pub phi_e_offset: u32,
    /// Write `0x242` as part of this job. Only when replaying a known-good
    /// board (legacy table); a new motor must get its offset from alignment.
    #[serde(default)]
    pub write_phi_e_offset: bool,
    pub pwm_max_count: u32,
    pub csa_gain: u32,
    /// Optional velocity-meter configuration (0 = leave untouched / same as legacy).
    pub vel_frq_conf: u32,
    pub vel_per_conf: u32,
    pub write_velocity_cfg: bool,
}

impl Default for EncoderCfg {
    fn default() -> Self {
        Self {
            preset: "MT6701 · 14-bit SSI".into(),
            frame_bits: 14,
            spi_mode: 1,
            spi_hz: 2_000_000,
            idle_cycles: 16,
            data_mask: 0x0000_3FFF,
            send_data: 0,
            csn_via_enc_n: true,
            cpr: 16_384,
            poles: 1,
            phi_e_offset: 48_000,
            write_phi_e_offset: false,
            pwm_max_count: 4800,
            csa_gain: 3,
            vel_frq_conf: 0,
            vel_per_conf: 0,
            write_velocity_cfg: false,
        }
    }
}

/// `IO_CONTROLLER.COMMAND` for the SPI_ENC ROM feature (p.114).
pub fn build_spi_command(frame_bits: u32, spi_mode: u32, spi_hz: u32, idle: u32, csn_enc_n: bool) -> u32 {
    let half = ((60_000_000f64 / (2.0 * spi_hz as f64)).round() as i64 - 1).clamp(0, 255) as u32;
    let mut u = (frame_bits.saturating_sub(1)) & 0x1F;
    if csn_enc_n {
        u |= 0x80;
    }
    let mut cmd = 0xF000_0000u32;
    cmd |= (spi_mode & 0x03) << 26;
    cmd |= 2 << 24; // repeated request, processed into FEEDBACK.PHI_EXT_A
    cmd |= (idle & 0xFF) << 16;
    cmd |= (u & 0xFF) << 8;
    cmd |= half & 0xFF;
    cmd
}

pub fn cpr_inv_for(cpr: u32) -> u32 {
    if cpr == 0 {
        return 0;
    }
    (1u32 << 24) / cpr
}

pub fn setup_encoder(ctx: &mut Ctx, cfg: &EncoderCfg) -> Result<String> {
    ctx.total = 12;
    let base_mm = regs::motor_motion(regs::MODE_PWM_OFF, cfg.poles, false, false);

    // 1. hold the bridge in PWM_OFF while reconfiguring
    let label = "桥臂安全态 (PWM_OFF)";
    ctx.begin(label);
    ctx.link.write_reg(regs::MCC_MOTOR_MOTION, base_mm)?;
    ctx.link.write_reg(regs::FOC_PID_VELOCITY_TARGET, 0)?;
    ctx.link.write_reg(regs::FOC_PID_TORQUE_FLUX_TARGET, 0)?;
    ctx.ok(label, format!("MOTOR_MOTION=0x{base_mm:08X}"));

    // 2. stop the IO controller
    let label = "停止 IO Controller";
    ctx.begin(label);
    ctx.link.write_reg(regs::IO_COMMAND, 0)?;
    ctx.link.write_reg(regs::IO_RESPONSE_0, 0)?;
    ms(40);
    ctx.ok(label, "COMMAND=0, RESPONSE_0=0");

    // 3. pin mux
    let label = "配置 IO_MATRIX (SCK/SDI/CSN)";
    ctx.begin(label);
    let cur = ctx.link.read_reg_retry(regs::CHIP_IO_MATRIX, 3)?;
    let mask = 0x3Fu32 | (7 << 12);
    let mut new = (cur & !mask) | 0x3F | (3 << 12);
    if cfg.csn_via_enc_n {
        new &= !(3 << 4);
        new |= 3 << 4;
    }
    if !ctx.link.write_verified(regs::CHIP_IO_MATRIX, new, 0xFFFF)? {
        ctx.fail(label, "写入失败");
        return Err(LinkError::ValueError("IO_MATRIX 写入失败".into()));
    }
    ctx.ok(
        label,
        format!("0x{cur:08X} → 0x{new:08X} (CSN via {})", if cfg.csn_via_enc_n { "ENC_N" } else { "HALL_W" }),
    );

    // 4. probe the IO controller firmware
    let label = "探测 IO Controller 固件";
    ctx.begin(label);
    ctx.link.write_reg(regs::IO_COMMAND, 0)?;
    ms(20);
    ctx.link.write_reg(regs::IO_COMMAND, 0xAA00_0000)?;
    ms(50);
    let fw = ctx.link.read_reg_retry(regs::IO_RESPONSE_1, 3)?;
    let fw_type = fw >> 8;
    if !(fw_type == 0x646000 || fw_type == 0x52414D || fw != 0) {
        ctx.fail(label, format!("RESPONSE_1=0x{fw:08X}"));
        return Err(LinkError::ValueError(format!(
            "IO Controller 无响应 (0x{fw:08X})"
        )));
    }
    ctx.ok(label, format!("RESPONSE_1=0x{fw:08X} (fw=0x{fw_type:X})"));

    // 5. feedback channel A
    let label = "反馈通道 A (0x240)";
    ctx.begin(label);
    let cpr_inv = cpr_inv_for(cfg.cpr);
    let conf = (7u32 << 24) | (cpr_inv & 0x00FF_FFFF); // SRC_SEL = PHI_EXT_A
    if !ctx.link.write_verified(regs::FEEDBACK_CONF_CH_A, conf, 0x0FFF_FFFF)? {
        ctx.fail(label, "写入失败");
        return Err(LinkError::ValueError("0x240 写入失败".into()));
    }
    ctx.ok(
        label,
        format!("PHI_EXT_A, CPR_INV={cpr_inv} (CPR={})", cfg.cpr),
    );

    // 6. velocity meter (optional)
    let label = "速度测量配置 (0x244/0x245)";
    ctx.begin(label);
    if cfg.write_velocity_cfg {
        let ok1 = ctx.link.write_verified(regs::FEEDBACK_VELOCITY_FRQ_CONF, cfg.vel_frq_conf, 0x00FF_FFFF)?;
        let ok2 = if cfg.vel_per_conf != 0 {
            ctx.link.write_verified(regs::FEEDBACK_VELOCITY_PER_CONF, cfg.vel_per_conf, 0xFFFF_FFFF)?
        } else {
            true
        };
        if !(ok1 && ok2) {
            ctx.fail(label, "写入失败");
            return Err(LinkError::ValueError("速度测量配置写入失败".into()));
        }
        ctx.ok(
            label,
            format!("0x244=0x{:08X} 0x245=0x{:08X}", cfg.vel_frq_conf, cfg.vel_per_conf),
        );
    } else {
        ctx.ok(label, "保留当前值");
    }

    // 7. feedback output
    let label = "反馈输出 (0x250)";
    ctx.begin(label);
    let out_conf = (1u32 << 22) | (cfg.poles & 0xFF); // period meter + phi_e multiplier
    if !ctx.link.write_verified(regs::FEEDBACK_OUTPUT_CONF, out_conf, 0x00FF_FFFF)? {
        ctx.fail(label, "写入失败");
        return Err(LinkError::ValueError("0x250 写入失败".into()));
    }
    ctx.ok(
        label,
        format!("PHI_E_MUL_FACTOR={} (极对数), 周期测速", cfg.poles),
    );

    // 8. electrical angle offset — a new motor must not inherit a stale value
    let label = "电角度偏移 (0x242)";
    ctx.begin(label);
    if cfg.write_phi_e_offset {
        if !ctx
            .link
            .write_verified(regs::FEEDBACK_PHI_E_OFFSET, cfg.phi_e_offset & 0xFFFF, 0xFFFF)?
        {
            ctx.fail(label, "写入失败");
            return Err(LinkError::ValueError("0x242 写入失败".into()));
        }
        ctx.ok(label, format!("0x{:04X}（按遗留表复现）", cfg.phi_e_offset & 0xFFFF));
    } else {
        ctx.ok(label, "跳过：偏移由「对齐与闭环 → 电角度对齐」测得后写回");
    }

    // 9. PWM period + CSA gain
    let label = "PWM 周期 / 电流采样增益";
    ctx.begin(label);
    let period = regs::mcc_pwm_period(cfg.pwm_max_count);
    ctx.link.write_verified(regs::MCC_PWM_PERIOD, period, 0x0000_FFFF)?;
    ctx.link.write_verified(regs::MCC_ADC_CSA_GAIN, cfg.csa_gain & 0x03, 0x03)?;
    let f_pwm = 120_000_000.0 / cfg.pwm_max_count.max(1) as f64;
    ctx.ok(
        label,
        format!("MAX_COUNT={} → {:.2} kHz, CSA_GAIN={}", cfg.pwm_max_count, f_pwm / 1000.0, cfg.csa_gain),
    );

    // 10. SPI mask + payload
    let label = "SPI 数据掩码 / 发送数据";
    ctx.begin(label);
    ctx.link.write_verified(regs::IO_RESPONSE_2, cfg.data_mask, 0xFFFF_FFFF)?;
    ctx.link.write_verified(regs::IO_RESPONSE_1, cfg.send_data, 0xFFFF_FFFF)?;
    ctx.ok(
        label,
        format!("mask=0x{:08X} send=0x{:08X}", cfg.data_mask, cfg.send_data),
    );

    // 11. start polling
    let label = "启动 SPI 轮询";
    ctx.begin(label);
    let cmd = build_spi_command(
        cfg.frame_bits,
        cfg.spi_mode,
        cfg.spi_hz,
        cfg.idle_cycles,
        cfg.csn_via_enc_n,
    );
    ctx.link.write_reg(regs::IO_COMMAND, cmd)?;
    ms(80);
    ctx.ok(
        label,
        format!("COMMAND=0x{cmd:08X} (mode {} · {:.2} MHz · {} bit)", cfg.spi_mode, cfg.spi_hz as f64 / 1e6, cfg.frame_bits),
    );

    // 12. verify
    let label = "校验 IO Controller 执行";
    ctx.begin(label);
    let resp0 = ctx.link.read_reg_retry(regs::IO_RESPONSE_0, 3)?;
    if resp0 == 0 {
        ctx.fail(label, "RESPONSE_0 = 0");
        return Err(LinkError::ValueError(
            "IO Controller 未执行命令 (RESPONSE_0=0)".into(),
        ));
    }
    let raw = ctx.link.read_reg_retry(regs::FEEDBACK_PHI_EXT_A, 3).unwrap_or(0);
    let angle = raw & if cfg.frame_bits > 14 { 0x00FF_FFFF } else { 0x3FFF };
    ctx.ok(
        label,
        format!("RESPONSE_0=0x{resp0:08X} · PHI_EXT_A=0x{raw:08X} (raw {angle})"),
    );

    Ok(format!("编码器配置完成，PHI_EXT_A=0x{raw:08X}"))
}

// --------------------------------------------------------------------------
// PID / limits
// --------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PidCfg {
    pub flux_p: u16,
    pub flux_i: u16,
    pub torque_p: u16,
    pub torque_i: u16,
    pub vel_p: u16,
    pub vel_i: u16,
    pub pos_p: u16,
    pub pos_i: u16,
    pub cur_norm_p: u8,
    pub cur_norm_i: u8,
    pub vel_norm_p: u8,
    pub vel_norm_i: u8,
    pub pos_norm_p: u8,
    pub pos_norm_i: u8,
    pub vel_shift: u8,
    pub pos_sampling: u8,
    pub overwrite_target: bool,
    pub keep_pos_target: bool,
    pub torque_limit_ma: f64,
    pub flux_limit_ma: f64,
    pub vel_limit_rpm: f64,
    pub uq_ud_limit: u32,
    pub ma_per_count: f64,
    pub counts_per_rpm: f64,
}

pub fn compose_pid_config(c: &PidCfg) -> u32 {
    ((c.pos_sampling as u32 & 0x7F) << 16)
        | ((c.vel_shift as u32 & 0x0F) << 12)
        | ((c.pos_norm_i as u32 & 0x03) << 10)
        | ((c.pos_norm_p as u32 & 0x03) << 8)
        | ((c.vel_norm_i as u32 & 0x03) << 6)
        | ((c.vel_norm_p as u32 & 0x03) << 4)
        | ((c.cur_norm_i as u32 & 0x01) << 3)
        | ((c.cur_norm_p as u32 & 0x01) << 2)
        | if c.overwrite_target { 1 << 1 } else { 0 }
        | if c.keep_pos_target { 1 } else { 0 }
}

pub fn counts_from_ma(ma: f64, ma_per_count: f64) -> i32 {
    if ma_per_count <= 0.0 {
        return 0;
    }
    (ma / ma_per_count).round() as i32
}

/// Write the whole PID + limits block and verify each register.
pub fn apply_pid(ctx: &mut Ctx, c: &PidCfg) -> Result<serde_json::Value> {
    ctx.total = 8;
    let mut results: Vec<serde_json::Value> = Vec::new();

    let label = "PID_CONFIG (0x140)";
    ctx.begin(label);
    let cfg = compose_pid_config(c);
    let ok = ctx.link.write_verified(regs::FOC_PID_CONFIG, cfg, 0x007F_FFFF)?;
    ctx.ok(label, format!("0x{cfg:08X}"));
    results.push(serde_json::json!({ "addr": "0x140", "ok": ok, "value": format!("0x{cfg:08X}") }));

    let label = "电流环系数 (0x142/0x143)";
    ctx.begin(label);
    let flux = ((c.flux_p as u32) << 16) | c.flux_i as u32;
    let torque = ((c.torque_p as u32) << 16) | c.torque_i as u32;
    let a = ctx.link.write_verified(regs::FOC_PID_FLUX_COEFF, flux, 0xFFFF_FFFF)?;
    let b = ctx.link.write_verified(regs::FOC_PID_TORQUE_COEFF, torque, 0xFFFF_FFFF)?;
    ctx.ok(label, format!("P={}/{} I={}/{}", c.flux_p, c.torque_p, c.flux_i, c.torque_i));
    results.push(serde_json::json!({ "addr": "0x142/0x143", "ok": a && b }));

    let label = "速度环 / 位置环系数";
    ctx.begin(label);
    let vel = ((c.vel_p as u32) << 16) | c.vel_i as u32;
    let pos = ((c.pos_p as u32) << 16) | c.pos_i as u32;
    let a = ctx.link.write_verified(regs::FOC_PID_VELOCITY_COEFF, vel, 0xFFFF_FFFF)?;
    let b = ctx.link.write_verified(regs::FOC_PID_POSITION_COEFF, pos, 0xFFFF_FFFF)?;
    ctx.ok(label, format!("速度 P={} I={} · 位置 P={} I={}", c.vel_p, c.vel_i, c.pos_p, c.pos_i));
    results.push(serde_json::json!({ "addr": "0x145/0x146", "ok": a && b }));

    let label = "力矩/磁链限幅 (0x14A)";
    ctx.begin(label);
    let t_raw = counts_from_ma(c.torque_limit_ma, c.ma_per_count).clamp(0, 0x7FFF) as u32;
    let f_raw = counts_from_ma(c.flux_limit_ma, c.ma_per_count).clamp(0, 0x7FFF) as u32;
    let lim = (t_raw << 16) | f_raw;
    let ok = ctx.link.write_verified(regs::FOC_PID_TORQUE_FLUX_LIMITS, lim, 0x7FFF_7FFF)?;
    ctx.ok(
        label,
        format!(
            "力矩 {:.0} mA → {} counts · 磁链 {:.0} mA → {}",
            c.torque_limit_ma, t_raw, c.flux_limit_ma, f_raw
        ),
    );
    results.push(serde_json::json!({ "addr": "0x14A", "ok": ok, "value": format!("0x{lim:08X}") }));

    let label = "速度限幅 (0x14B)";
    ctx.begin(label);
    let v = (c.vel_limit_rpm * c.counts_per_rpm).round().clamp(0.0, 0x7FFF_FFFF as f64) as u32;
    let ok = ctx.link.write_verified(regs::FOC_PID_VELOCITY_LIMIT, v, 0x7FFF_FFFF)?;
    ctx.ok(label, format!("{:.0} RPM → {}", c.vel_limit_rpm, v));
    results.push(serde_json::json!({ "addr": "0x14B", "ok": ok, "value": format!("0x{v:08X}") }));

    let label = "电压矢量限幅 (0x149)";
    ctx.begin(label);
    let ok = ctx.link.write_verified(regs::FOC_PID_UQ_UD_LIMITS, c.uq_ud_limit & 0xFFFF, 0xFFFF)?;
    let eff = (c.uq_ud_limit & 0xFFFF).min(18_900);
    ctx.ok(label, format!("{} counts ≈ {:.1}% 调制", c.uq_ud_limit & 0xFFFF, eff as f64 / 189.0));
    results.push(serde_json::json!({ "addr": "0x149", "ok": ok }));

    let label = "清零积分器";
    ctx.begin(label);
    let _ = ctx.link.write_reg(regs::FOC_PID_TORQUE_INTEGRATOR, 0);
    let _ = ctx.link.write_reg(regs::FOC_PID_FLUX_INTEGRATOR, 0);
    let _ = ctx.link.write_reg(regs::FOC_PID_VELOCITY_INTEGRATOR, 0);
    let _ = ctx.link.write_reg(regs::FOC_PID_POSITION_INTEGRATOR, 0);
    ctx.ok(label, "0x15D..0x160 = 0");

    let label = "回读校验";
    ctx.begin(label);
    let rb = ctx.link.read_reg_retry(regs::FOC_PID_CONFIG, 3)?;
    let torque_rb = ctx.link.read_reg_retry(regs::FOC_PID_TORQUE_COEFF, 3)?;
    ctx.ok(
        label,
        format!("0x140=0x{rb:08X} 0x143=0x{torque_rb:08X}"),
    );

    Ok(serde_json::json!({ "checks": results }))
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PidSnapshot {
    pub config: u32,
    pub flux_coeff: u32,
    pub torque_coeff: u32,
    pub vel_coeff: u32,
    pub pos_coeff: u32,
    pub tf_limits: u32,
    pub vel_limit: u32,
    pub uq_ud_limit: u32,
}

pub fn read_pid(link: &Link) -> Result<PidSnapshot> {
    Ok(PidSnapshot {
        config: link.read_reg_retry(regs::FOC_PID_CONFIG, 3)?,
        flux_coeff: link.read_reg_retry(regs::FOC_PID_FLUX_COEFF, 3)?,
        torque_coeff: link.read_reg_retry(regs::FOC_PID_TORQUE_COEFF, 3)?,
        vel_coeff: link.read_reg_retry(regs::FOC_PID_VELOCITY_COEFF, 3)?,
        pos_coeff: link.read_reg_retry(regs::FOC_PID_POSITION_COEFF, 3)?,
        tf_limits: link.read_reg_retry(regs::FOC_PID_TORQUE_FLUX_LIMITS, 3)?,
        vel_limit: link.read_reg_retry(regs::FOC_PID_VELOCITY_LIMIT, 3)?,
        uq_ud_limit: link.read_reg_retry(regs::FOC_PID_UQ_UD_LIMITS, 3)?,
    })
}

// --------------------------------------------------------------------------
// phi_e alignment
// --------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct CalibCfg {
    pub flux_ma: f64,
    pub poles: u32,
    pub settle_ms: u64,
    pub step_deg: i32,
    pub end_deg: i32,
    pub ma_per_count: f64,
    pub write_back: bool,
    pub dry_run: bool,
    /// Encoder CPR — 决定 16 位换算比例 `CPR_INV >> 8 = 65536 / CPR`（14 bit → ×4）。
    #[serde(default = "default_cpr")]
    pub cpr: u32,
}

fn default_cpr() -> u32 {
    16_384
}

impl Default for CalibCfg {
    fn default() -> Self {
        Self {
            flux_ma: 300.0,
            poles: 1,
            settle_ms: 700,
            step_deg: 90,
            end_deg: 720,
            ma_per_count: 0.20131,
            write_back: true,
            dry_run: false,
            cpr: 16_384,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct CalibPoint {
    pub deg: i32,
    pub enc: i32,
}

#[derive(Clone, Serialize)]
pub struct CalibResult {
    pub offset: u32,
    pub offset_hex: String,
    pub intercept: f64,
    pub slope: f64,
    pub r2: f64,
    pub points: Vec<CalibPoint>,
    pub groups: Vec<CalibGroup>,
    pub written: bool,
}

#[derive(Clone, Serialize)]
pub struct CalibGroup {
    pub deg: i32,
    pub n: usize,
    pub avg: f64,
    pub unwrapped: f64,
    pub residual: f64,
}

fn read_encoder_raw(link: &Link, frame_bits: u32) -> Result<i32> {
    let v = link.read_reg_retry(regs::FEEDBACK_PHI_EXT_A, 3)?;
    let mask = if frame_bits > 14 { 0x00FF_FFFF } else { 0x3FFF };
    Ok((v & mask) as i32)
}

pub fn calibrate_phi_e(ctx: &mut Ctx, cfg: &CalibCfg, frame_bits: u32) -> Result<CalibResult> {
    let angles: Vec<i32> = {
        let mut v = Vec::new();
        let mut a = 0;
        while a <= cfg.end_deg {
            v.push(a);
            a += cfg.step_deg.max(10);
        }
        v
    };
    let scans = 2usize;
    ctx.total = 5 + angles.len() * scans;

    // 1. base config
    let label = "基础配置（电流环/限幅）";
    ctx.begin(label);
    let cnt = counts_from_ma(cfg.flux_ma, cfg.ma_per_count).clamp(1, 8192) as u32;
    ctx.link.write_verified(regs::MCC_ADC_CSA_GAIN, 3, 0x03)?;
    ctx.link.write_verified(regs::FOC_PID_FLUX_COEFF, (64 << 16) | 48, 0xFFFF_FFFF)?;
    ctx.link.write_verified(regs::FOC_PID_TORQUE_COEFF, (64 << 16) | 48, 0xFFFF_FFFF)?;
    // limit = max flux so the lock current is reachable, but never above 4x full scale
    let lim = (8192u32 << 16) | 8192u32;
    ctx.link.write_verified(regs::FOC_PID_TORQUE_FLUX_LIMITS, lim, 0x7FFF_7FFF)?;
    ctx.ok(label, format!("{} counts ≈ {:.0} mA", cnt, cfg.flux_ma));

    // 2. enable the gate driver
    let label = "使能驱动";
    ctx.begin(label);
    let gdrv = ctx.link.read_reg_retry(regs::MCC_GDRV, 3)?;
    ctx.link.write_verified(regs::MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x8001_0000)?;
    ctx.ok(label, "DRV_EN + 电荷泵");

    // 3. open-loop torque with position ramp
    let label = "进入开环力矩 + 位置 ramp";
    ctx.begin(label);
    let mm = regs::motor_motion_openloop(regs::MODE_TORQUE, cfg.poles, false);
    ctx.link.write_verified(regs::MCC_MOTOR_MOTION, mm, 0x0000_FFFF)?;
    ctx.link.write_verified(regs::RAMPER_V_MAX, 0x0001_0000, 0x07FF_FFFF)?;
    ctx.link.write_verified(regs::RAMPER_V_START, 0, 0x07FF_FFFF)?;
    ctx.link.write_verified(regs::RAMPER_A1, 0x0002_0000, 0x007F_FFFF)?;
    ctx.link.write_verified(regs::RAMPER_A_MAX, 0x0004_0000, 0x007F_FFFF)?;
    ctx.ok(label, format!("MOTOR_MOTION=0x{mm:08X}"));

    // 4. apply the d-axis current that locks the rotor
    let label = "施加对齐电流";
    ctx.begin(label);
    ctx.link.write_reg(regs::FOC_PID_TORQUE_FLUX_TARGET, cnt & 0xFFFF)?;
    ms(300);
    let actual = ctx.link.read_reg_retry(regs::FOC_PID_TORQUE_FLUX_ACTUAL, 3).unwrap_or(0);
    ctx.ok(label, format!("iD={} counts (actual 0x{actual:08X})", cnt));

    if cfg.dry_run {
        ctx.info("干跑模式", "不扫描、不写回");
        return Ok(CalibResult {
            offset: 0,
            offset_hex: "0x0000".into(),
            intercept: 0.0,
            slope: 0.0,
            r2: 0.0,
            points: Vec::new(),
            groups: Vec::new(),
            written: false,
        });
    }

    // 5. sweep
    let mut points: Vec<CalibPoint> = Vec::new();
    let mut sequence: Vec<i32> = angles.clone();
    let mut reverse: Vec<i32> = angles.clone();
    reverse.reverse();
    sequence.extend(reverse);

    for (i, deg) in sequence.iter().enumerate() {
        if ctx.cancelled() {
            return Err(LinkError::ValueError("已取消".into()));
        }
        let label = format!("扫描 {}°", deg);
        ctx.begin(&label);
        let tgt = ((deg.rem_euclid(360) as f64 / 360.0) * 65536.0) as u32 & 0xFFFF;
        ctx.link.write_reg(regs::FOC_PID_POSITION_TARGET, tgt)?;

        // wait for the ramp to arrive
        let deadline = Instant::now() + Duration::from_millis(2500);
        let mut arrived = false;
        while Instant::now() < deadline {
            if let Ok(pe) = ctx.link.read_reg(regs::RAMPER_PHI_E) {
                let cur = (pe & 0xFFFF) as i64;
                let d = (cur - tgt as i64).abs();
                let d = d.min(65536 - d);
                if d < 0x800 {
                    arrived = true;
                    break;
                }
            }
            ms(30);
        }
        if !arrived {
            ctx.fail(&label, "位置未到达（超时）");
            continue;
        }
        ms(cfg.settle_ms);
        match read_encoder_raw(&ctx.link, frame_bits) {
            Ok(enc) => {
                points.push(CalibPoint { deg: *deg, enc });
                ctx.ok(&label, format!("enc={enc}"));
            }
            Err(e) => ctx.fail(&label, e.to_string()),
        }
        let _ = i;
    }

    // 6. fit
    let label = "拟合电角度偏移";
    ctx.begin(label);
    // 16 位换算比例：converted = raw × (CPR_INV >> 8) = raw × 65536 / CPR（14 bit + CPR=16384 → ×4）
    let scale = 65_536.0 / cfg.cpr.max(1) as f64;
    let fit = fit_offset(&points, scale, cfg.poles.max(1));
    let result = match fit {
        Some(r) => {
            ctx.ok(
                label,
                format!(
                    "R²={:.5} · 0° 时 enc={:.1} → offset 0x{:04X}（raw×{:.0}×{})",
                    r.r2,
                    r.intercept.rem_euclid(cfg.cpr.max(1) as f64),
                    r.offset,
                    scale,
                    cfg.poles.max(1)
                ),
            );
            r
        }
        None => {
            ctx.fail(label, "有效点不足，无法拟合");
            return Err(LinkError::ValueError("有效点不足（至少需要 3 个角度）".into()));
        }
    };

    // 7. write back
    let label = "写回 PHI_E_OFFSET (0x242)";
    ctx.begin(label);
    let mut written = false;
    if cfg.write_back && result.r2 > 0.9 {
        written = ctx
            .link
            .write_verified(regs::FEEDBACK_PHI_E_OFFSET, result.offset, 0xFFFF)
            .unwrap_or(false);
        if written {
            ctx.ok(label, format!("0x{:04X}", result.offset));
        } else {
            ctx.fail(label, "写入校验失败");
        }
    } else {
        ctx.info(label, "未写回（干跑或拟合质量不足）");
    }

    // 8. release
    let _ = ctx.link.write_reg(regs::FOC_PID_TORQUE_FLUX_TARGET, 0);
    let _ = ctx.link.write_reg(regs::MCC_MOTOR_MOTION, regs::motor_motion(regs::MODE_PWM_OFF, cfg.poles, false, false));

    Ok(CalibResult {
        offset: result.offset,
        offset_hex: format!("0x{:04X}", result.offset),
        intercept: result.intercept,
        slope: result.slope,
        r2: result.r2,
        points,
        groups: result.groups,
        written,
    })
}

struct FitResult {
    offset: u32,
    intercept: f64,
    slope: f64,
    r2: f64,
    groups: Vec<CalibGroup>,
}

/// 拟合电角度偏移。
///
/// `scale` = 16 位换算比例（`CPR_INV >> 8` = 65536/CPR），`poles` = 极对数。
/// 手册的 phi_e 链路是 `PHI_E = 换算后的 16 位机械角 × PHI_E_MUL_FACTOR + PHI_E_OFFSET`，
/// 所以让 `PHI_E` 等于开环目标角的偏移应是
/// `OFFSET = target16 − converted × poles`（对全扫描点取圆周平均，即手册说的"平均差值"）。
fn fit_offset(points: &[CalibPoint], scale: f64, poles: u32) -> Option<FitResult> {
    // group by deg % 360
    let mut bins: Vec<(i32, Vec<f64>)> = Vec::new();
    let mut keys: Vec<i32> = points
        .iter()
        .map(|p| p.deg.rem_euclid(360))
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    for k in keys {
        let vals: Vec<f64> = points
            .iter()
            .filter(|p| p.deg.rem_euclid(360) == k)
            .map(|p| p.enc as f64)
            .collect();
        bins.push((k, vals));
    }
    if bins.len() < 3 {
        return None;
    }

    let avg: Vec<(f64, f64)> = bins
        .iter()
        .map(|(d, v)| {
            let m = v.iter().sum::<f64>() / v.len() as f64;
            (*d as f64, m)
        })
        .collect();

    // unwrap across the 16384 wrap boundary
    let mut uw: Vec<f64> = vec![avg[0].1];
    for i in 1..avg.len() {
        let mut delta = avg[i].1 - avg[i - 1].1;
        if delta < -8192.0 {
            delta += 16384.0;
        } else if delta > 8192.0 {
            delta -= 16384.0;
        }
        uw.push(uw[i - 1] + delta);
    }

    // least squares enc = k*deg + b
    let n = avg.len() as f64;
    let sx: f64 = avg.iter().map(|(d, _)| *d).sum();
    let sy: f64 = uw.iter().sum();
    let sxy: f64 = avg.iter().zip(uw.iter()).map(|((d, _), e)| d * e).sum();
    let sx2: f64 = avg.iter().map(|(d, _)| d * d).sum();
    let denom = n * sx2 - sx * sx;
    if denom.abs() < 1e-9 {
        return None;
    }
    let slope = (n * sxy - sx * sy) / denom;
    let intercept = (sy - slope * sx) / n;

    let ss_res: f64 = avg
        .iter()
        .zip(uw.iter())
        .map(|((d, _), e)| (e - (slope * d + intercept)).powi(2))
        .sum();
    let mean = sy / n;
    let ss_tot: f64 = uw.iter().map(|e| (e - mean).powi(2)).sum();
    let r2 = if ss_tot > 0.0 { 1.0 - ss_res / ss_tot } else { 0.0 };

    let b14 = intercept.rem_euclid(16384.0);
    let offset = phi_e_offset_from(points, scale, poles);

    let groups = bins
        .iter()
        .enumerate()
        .map(|(i, (d, v))| {
            let m = v.iter().sum::<f64>() / v.len() as f64;
            let pred = slope * (*d as f64) + intercept;
            let mut res = m - pred.rem_euclid(16384.0);
            if res > 8192.0 {
                res -= 16384.0;
            } else if res < -8192.0 {
                res += 16384.0;
            }
            CalibGroup {
                deg: *d,
                n: v.len(),
                avg: m,
                unwrapped: uw[i],
                residual: res,
            }
        })
        .collect();

    let _ = b14;
    Some(FitResult {
        offset,
        intercept,
        slope,
        r2,
        groups,
    })
}

/// `OFFSET = target16 − converted × poles`，对全部扫描点做圆周平均（手册 p.70 的"平均差值"法）。
fn phi_e_offset_from(points: &[CalibPoint], scale: f64, poles: u32) -> u32 {
    let mut sum_sin = 0.0;
    let mut sum_cos = 0.0;
    let mut n = 0.0;
    for p in points {
        let target16 = (p.deg.rem_euclid(360) as f64 / 360.0 * 65_536.0).round();
        let converted = scale * p.enc as f64 * poles as f64;
        let diff = (target16 - converted).rem_euclid(65_536.0); // 0 … 65536
        let rad = diff / 65_536.0 * std::f64::consts::TAU;
        sum_sin += rad.sin();
        sum_cos += rad.cos();
        n += 1.0;
    }
    if n == 0.0 {
        return 0;
    }
    let mean_rad = sum_sin.atan2(sum_cos);
    let mean = mean_rad.rem_euclid(std::f64::consts::TAU) / std::f64::consts::TAU * 65_536.0;
    (mean.round() as i64).rem_euclid(65_536) as u32
}

// --------------------------------------------------------------------------
// step response
// --------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct StepCfg {
    /// "current" | "velocity"
    pub kind: String,
    pub amplitude: f64,
    pub duration_ms: u64,
    pub poles: u32,
    pub ma_per_count: f64,
    pub counts_per_rpm: f64,
    pub r_ohm: f64,
    pub l_uh: f64,
    pub bandwidth_hz: f64,
    pub sampling: u8,
    pub current_p: u16,
    pub current_i: u16,
    pub velocity_p: u16,
    pub velocity_i: u16,
}

#[derive(Clone, Serialize)]
pub struct StepMetrics {
    pub rise_ms: f64,
    pub settle_ms: f64,
    pub overshoot_pct: f64,
    pub steady_error: f64,
    pub peak: f64,
    pub ripple: f64,
    pub samples: usize,
}

#[derive(Clone, Serialize)]
pub struct StepResult {
    pub kind: String,
    pub amplitude: f64,
    pub unit: String,
    pub time: Vec<f64>,
    pub target: Vec<f64>,
    pub actual: Vec<f64>,
    pub metrics: StepMetrics,
    pub p_reg: u16,
    pub i_reg: u16,
}

/// Continuous-domain PI that matches the legacy bench-verified tuning:
/// `Kp = 2*pi*f*L`, `Ki = 2*pi*f*R`, register = coefficient * 256 (Q8.8).
pub fn suggest_pi(r_ohm: f64, l_uh: f64, bandwidth_hz: f64, f_pwm: f64) -> (u16, u16, f64, f64) {
    let l = l_uh * 1e-6;
    let kp = 2.0 * std::f64::consts::PI * bandwidth_hz * l;
    let ki = 2.0 * std::f64::consts::PI * bandwidth_hz * r_ohm;
    let p = (kp * 256.0).round().clamp(1.0, 32767.0) as u16;
    let i = (ki / f_pwm.max(1.0) * 256.0).round().clamp(0.0, 32767.0) as u16;
    (p, i, kp, ki)
}

pub fn step_response(ctx: &mut Ctx, cfg: &StepCfg, frame_bits: u32) -> Result<StepResult> {
    ctx.total = 8;
    let is_current = cfg.kind == "current";

    let label = "基础配置与驱动使能";
    ctx.begin(label);
    ctx.link.write_verified(regs::MCC_ADC_CSA_GAIN, 3, 0x03)?;
    let gdrv = ctx.link.read_reg_retry(regs::MCC_GDRV, 3)?;
    ctx.link.write_verified(regs::MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x8001_0000)?;
    let lim = (8192u32 << 16) | 8192u32;
    ctx.link.write_verified(regs::FOC_PID_TORQUE_FLUX_LIMITS, lim, 0x7FFF_7FFF)?;
    ctx.ok(label, "CSA=4x, DRV on, limits=8192");

    let label = "写入电流环系数";
    ctx.begin(label);
    let cur = ((cfg.current_p as u32) << 16) | cfg.current_i as u32;
    ctx.link.write_verified(regs::FOC_PID_FLUX_COEFF, cur, 0xFFFF_FFFF)?;
    ctx.link.write_verified(regs::FOC_PID_TORQUE_COEFF, cur, 0xFFFF_FFFF)?;
    ctx.ok(label, format!("P={} I={}", cfg.current_p, cfg.current_i));

    let (target_reg, actual_reg, unit, scale, amplitude_raw) = if is_current {
        (
            regs::FOC_PID_TORQUE_FLUX_TARGET,
            regs::FOC_PID_TORQUE_FLUX_ACTUAL,
            "mA".to_string(),
            cfg.ma_per_count,
            counts_from_ma(cfg.amplitude, cfg.ma_per_count).clamp(1, 8192),
        )
    } else {
        (
            regs::FOC_PID_VELOCITY_TARGET,
            regs::FOC_PID_VELOCITY_ACTUAL,
            "RPM".to_string(),
            1.0 / cfg.counts_per_rpm,
            (cfg.amplitude * cfg.counts_per_rpm).round() as i32,
        )
    };

    let label = if is_current { "进入力矩模式" } else { "进入速度模式" };
    ctx.begin(label);
    if !is_current {
        let vel = ((cfg.velocity_p as u32) << 16) | cfg.velocity_i as u32;
        ctx.link.write_verified(regs::FOC_PID_VELOCITY_COEFF, vel, 0xFFFF_FFFF)?;
    }
    let mode = if is_current { regs::MODE_TORQUE } else { regs::MODE_VELOCITY };
    ctx.link.write_verified(
        regs::MCC_MOTOR_MOTION,
        regs::motor_motion(mode, cfg.poles, false, false),
        0x0000_FFFF,
    )?;
    ctx.link.write_reg(target_reg, 0)?;
    let _ = ctx.link.write_reg(regs::FOC_PID_TORQUE_INTEGRATOR, 0);
    let _ = ctx.link.write_reg(regs::FOC_PID_FLUX_INTEGRATOR, 0);
    let _ = ctx.link.write_reg(regs::FOC_PID_VELOCITY_INTEGRATOR, 0);
    ms(150);
    ctx.ok(label, format!("mode={mode}"));

    let label = "启动 RTMI 采集";
    ctx.begin(label);
    let sampling = cfg.sampling;
    ctx.link
        .start_rtmi(&[(0, target_reg), (1, actual_reg)], sampling, false)?;
    ms(200);
    ctx.ok(label, format!("ch0=0x{target_reg:03X} ch1=0x{actual_reg:03X}"));

    // flush the pre-step window
    ctx.link.start_recording();
    ms(180);

    let label = if is_current { "注入 iD 阶跃" } else { "注入转速阶跃" };
    ctx.begin(label);
    let payload = if is_current {
        (amplitude_raw as u32) & 0xFFFF
    } else {
        (amplitude_raw as u32) & 0x7FFF_FFFF
    };
    ctx.link.write_reg(target_reg, payload)?;
    ctx.ok(label, format!("{} {}", cfg.amplitude, unit));

    let label = "采集响应";
    ctx.begin(label);
    let deadline = Instant::now() + Duration::from_millis(cfg.duration_ms);
    while Instant::now() < deadline {
        if ctx.cancelled() {
            break;
        }
        ms(50);
    }
    let data = ctx.link.stop_recording();
    let _ = ctx.link.stop_rtmi();
    ctx.ok(label, format!("{} 帧", data.len()));

    let label = "停止输出";
    ctx.begin(label);
    let _ = ctx.link.write_reg(target_reg, 0);
    ms(120);
    let _ = ctx.link.write_reg(
        regs::MCC_MOTOR_MOTION,
        regs::motor_motion(regs::MODE_PWM_OFF, cfg.poles, false, false),
    );
    ctx.ok(label, "PWM_OFF");

    let label = "计算指标";
    ctx.begin(label);
    let (time, target, actual) = build_series(&data, scale, is_current);
    let metrics = analyse(&time, &target, &actual, if is_current { cfg.amplitude } else { cfg.amplitude });
    ctx.ok(
        label,
        format!(
            "上升 {:.2} ms · 超调 {:.1}% · 稳态误差 {:.2} {}",
            metrics.rise_ms, metrics.overshoot_pct, metrics.steady_error, unit
        ),
    );
    let _ = frame_bits;

    Ok(StepResult {
        kind: cfg.kind.clone(),
        amplitude: cfg.amplitude,
        unit,
        time,
        target,
        actual,
        metrics,
        p_reg: cfg.current_p,
        i_reg: cfg.current_i,
    })
}

fn build_series(data: &[(f64, u8, i32)], scale: f64, signed16: bool) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut tgt: Vec<(f64, f64)> = Vec::new();
    let mut act: Vec<(f64, f64)> = Vec::new();
    for (t, ch, raw) in data {
        let v = if signed16 {
            let lo = (*raw & 0xFFFF) as u16 as i16 as f64;
            lo * scale
        } else {
            (*raw as f64) * scale
        };
        match ch {
            0 => tgt.push((*t, v)),
            _ => act.push((*t, v)),
        }
    }
    let t0 = tgt
        .iter()
        .map(|(t, _)| *t)
        .chain(act.iter().map(|(t, _)| *t))
        .fold(f64::INFINITY, f64::min);
    if !t0.is_finite() {
        return (vec![], vec![], vec![]);
    }
    // resample onto a uniform grid so both series can share one x axis
    let span = tgt
        .iter()
        .map(|(t, _)| *t - t0)
        .chain(act.iter().map(|(t, _)| *t - t0))
        .fold(0.0, f64::max);
    let n = 900usize;
    let dt = if span > 0.0 { span / (n as f64 - 1.0) } else { 1.0 };
    let mut time = Vec::with_capacity(n);
    let mut t_out = Vec::with_capacity(n);
    let mut a_out = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f64 * dt;
        time.push(t);
        t_out.push(interp(&tgt, t));
        a_out.push(interp(&act, t));
    }
    (time, t_out, a_out)
}

fn interp(pts: &[(f64, f64)], t: f64) -> f64 {
    if pts.is_empty() {
        return 0.0;
    }
    // pts are already time ordered by arrival
    let mut lo = 0usize;
    let mut hi = pts.len() - 1;
    if t <= pts[0].0 {
        return pts[0].1;
    }
    if t >= pts[hi].0 {
        return pts[hi].1;
    }
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if pts[mid].0 <= t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (t0, v0) = pts[lo];
    let (t1, v1) = pts[hi];
    if (t1 - t0).abs() < 1e-9 {
        v0
    } else {
        v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    }
}

fn analyse(time: &[f64], target: &[f64], actual: &[f64], amplitude: f64) -> StepMetrics {
    if time.is_empty() || actual.is_empty() {
        return StepMetrics {
            rise_ms: 0.0,
            settle_ms: 0.0,
            overshoot_pct: 0.0,
            steady_error: 0.0,
            peak: 0.0,
            ripple: 0.0,
            samples: 0,
        };
    }
    let sign = if amplitude >= 0.0 { 1.0 } else { -1.0 };
    let final_target = target.last().copied().unwrap_or(amplitude) * sign;
    let amp = final_target.abs().max(1e-9);

    // step detection: first index where the target leaves zero
    let start = target
        .iter()
        .position(|v| v.abs() > amp * 0.05)
        .unwrap_or(0);
    let t_start = time[start];

    let mut rise = 0.0;
    for i in start..actual.len() {
        if actual[i] * sign >= 0.9 * amp {
            rise = time[i] - t_start;
            break;
        }
    }

    let mut peak = 0.0f64;
    for i in start..actual.len() {
        peak = peak.max(actual[i] * sign);
    }
    let overshoot = ((peak - amp) / amp * 100.0).max(0.0);

    // settle: last time outside +-5 %
    let tol = amp * 0.05;
    let mut settle = 0.0;
    for i in (start..actual.len()).rev() {
        if (actual[i] * sign - amp).abs() > tol {
            settle = time[i] - t_start;
            break;
        }
    }

    let tail_from = (actual.len() as f64 * 0.8) as usize;
    let tail = &actual[tail_from.min(actual.len() - 1)..];
    let mean = tail.iter().sum::<f64>() / tail.len() as f64;
    let steady = (mean * sign - amp) / amp * 100.0;
    let ripple = tail.iter().fold(f64::MIN, |a, b| a.max(*b)) - tail.iter().fold(f64::MAX, |a, b| a.min(*b));

    StepMetrics {
        rise_ms: rise,
        settle_ms: settle,
        overshoot_pct: overshoot,
        steady_error: steady,
        peak: peak * sign,
        ripple,
        samples: actual.len(),
    }
}

// --------------------------------------------------------------------------
// closed loop run
// --------------------------------------------------------------------------

pub fn start_velocity(link: &Link, target_rpm: f64, poles: u32, counts_per_rpm: f64) -> Result<()> {
    link.write_verified(
        regs::MCC_MOTOR_MOTION,
        regs::motor_motion(regs::MODE_VELOCITY, poles, false, false),
        0x0000_FFFF,
    )?;
    let gdrv = link.read_reg_retry(regs::MCC_GDRV, 3)?;
    link.write_verified(regs::MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x8001_0000)?;
    let raw = (target_rpm * counts_per_rpm).round() as i64 as i32;
    link.write_reg(regs::FOC_PID_VELOCITY_TARGET, raw as u32)?;
    Ok(())
}

pub fn stop_motion(link: &Link, poles: u32) -> Result<()> {
    let _ = link.write_reg(regs::FOC_PID_VELOCITY_TARGET, 0);
    let _ = link.write_reg(regs::FOC_PID_TORQUE_FLUX_TARGET, 0);
    thread::sleep(Duration::from_millis(200));
    let _ = link.write_reg(
        regs::MCC_MOTOR_MOTION,
        regs::motor_motion(regs::MODE_PWM_OFF, poles, false, false),
    );
    let _ = link.write_reg(regs::FOC_PID_VELOCITY_INTEGRATOR, 0);
    Ok(())
}

// --------------------------------------------------------------------------
// automated sequence
// --------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct SeqStep {
    pub rpm: f64,
    pub hold_s: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SeqCfg {
    pub serial: String,
    pub operator: String,
    pub note: String,
    pub steps: Vec<SeqStep>,
    pub poles: u32,
    pub counts_per_rpm: f64,
    pub ma_per_count: f64,
    pub tolerance_pct: f64,
    pub settle_s: f64,
    pub mode: String, // "closed" | "open"
    pub open_ud: u32,
}

#[derive(Clone, Serialize)]
pub struct SeqRow {
    pub t_ms: f64,
    pub target_rpm: f64,
    pub actual_rpm: f64,
    pub current_ma: f64,
    pub temp_c: f64,
}

#[derive(Clone, Serialize)]
pub struct SeqSummary {
    pub window: String,
    pub n: usize,
    pub mean_rpm: f64,
    pub std_rpm: f64,
    pub ripple_pct: f64,
    pub mean_current_ma: f64,
    pub max_current_ma: f64,
    pub max_temp_c: f64,
    pub verdict: String,
}

#[derive(Clone, Serialize)]
pub struct SeqResult {
    pub rows: Vec<SeqRow>,
    pub summary: Vec<SeqSummary>,
    pub csv_path: String,
}

pub fn run_sequence(
    ctx: &mut Ctx,
    cfg: &SeqCfg,
    frame_bits: u32,
    csv_dir: &std::path::Path,
) -> Result<SeqResult> {
    ctx.total = 5 + cfg.steps.len() * 2;

    let label = "准备采集通道";
    ctx.begin(label);
    ctx.link.start_rtmi(
        &[
            (0, regs::FOC_PID_VELOCITY_TARGET),
            (1, regs::FOC_PID_VELOCITY_ACTUAL),
            (2, regs::FOC_PID_TORQUE_FLUX_ACTUAL),
            (3, regs::ADC_TEMP_RAW),
        ],
        24,
        false,
    )?;
    ms(200);
    ctx.ok(label, "4 通道 · 1 kHz");

    let label = "使能与模式";
    ctx.begin(label);
    let gdrv = ctx.link.read_reg_retry(regs::MCC_GDRV, 3)?;
    ctx.link.write_verified(regs::MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x8001_0000)?;
    if cfg.mode == "open" {
        ctx.link.write_verified(
            regs::MCC_MOTOR_MOTION,
            regs::motor_motion_openloop(regs::MODE_VOLTAGE_EXT, cfg.poles, true),
            0x0000_FFFF,
        )?;
        ctx.link.write_verified(regs::EXT_CTRL_VOLTAGE, 0, 0xFFFF)?;
    } else {
        ctx.link.write_verified(
            regs::MCC_MOTOR_MOTION,
            regs::motor_motion(regs::MODE_VELOCITY, cfg.poles, false, false),
            0x0000_FFFF,
        )?;
    }
    ctx.ok(label, format!("mode={}", cfg.mode));

    ctx.link.start_recording();
    let mut windows: Vec<(f64, f64, f64, f64)> = Vec::new(); // t_start, t_end, target, _
    let t0 = Instant::now();

    for (i, step) in cfg.steps.iter().enumerate() {
        if ctx.cancelled() {
            break;
        }
        let label = format!("档位 {} · {:.0} RPM", i + 1, step.rpm);
        ctx.begin(&label);
        if cfg.mode == "closed" {
            let raw = (step.rpm * cfg.counts_per_rpm).round() as i64 as i32;
            ctx.link.write_reg(regs::FOC_PID_VELOCITY_TARGET, raw as u32)?;
        } else {
            // open loop: the ramp generator integrates the voltage vector, so we
            // scale UD with the requested speed and let the encoder measure it.
            let max_rpm = cfg
                .steps
                .iter()
                .map(|s| s.rpm.abs())
                .fold(1.0f64, f64::max);
            let ud = (cfg.open_ud as f64 * step.rpm.abs() / max_rpm).round() as u32;
            ctx.link
                .write_reg(regs::EXT_CTRL_VOLTAGE, (ud & 0xFFFF) | 0xFFFF_0000)?;
        }
        let start = t0.elapsed().as_secs_f64();
        let deadline = Instant::now() + Duration::from_millis((step.hold_s * 1000.0) as u64);
        while Instant::now() < deadline {
            if ctx.cancelled() {
                break;
            }
            ms(50);
        }
        let end = t0.elapsed().as_secs_f64();
        windows.push((start, end, step.rpm, step.hold_s));
        ctx.ok(&label, format!("保持 {:.1}s", step.hold_s));

        let label = format!("档位 {} · 停稳", i + 1);
        ctx.begin(&label);
        if cfg.mode == "closed" {
            ctx.link.write_reg(regs::FOC_PID_VELOCITY_TARGET, 0)?;
        } else {
            ctx.link
                .write_reg(regs::EXT_CTRL_VOLTAGE, 0xFFFF_0000)?;
        }
        ms((cfg.settle_s * 1000.0) as u64);
        ctx.ok(&label, "ok");
    }

    let data = ctx.link.stop_recording();
    let _ = ctx.link.stop_rtmi();

    let label = "停机";
    ctx.begin(label);
    let _ = stop_motion(&ctx.link, cfg.poles);
    ctx.ok(label, "PWM_OFF");

    let label = "汇总与导出";
    ctx.begin(label);
    let rows: Vec<SeqRow> = data
        .iter()
        .map(|(t, ch, raw)| {
            let v = *raw;
            match ch {
                0 => SeqRow {
                    t_ms: *t,
                    target_rpm: v as f64 / cfg.counts_per_rpm,
                    actual_rpm: f64::NAN,
                    current_ma: 0.0,
                    temp_c: 0.0,
                },
                1 => SeqRow {
                    t_ms: *t,
                    target_rpm: f64::NAN,
                    actual_rpm: v as f64 / cfg.counts_per_rpm,
                    current_ma: 0.0,
                    temp_c: 0.0,
                },
                2 => SeqRow {
                    t_ms: *t,
                    target_rpm: f64::NAN,
                    actual_rpm: f64::NAN,
                    current_ma: (v & 0xFFFF) as u16 as i16 as f64 * cfg.ma_per_count,
                    temp_c: 0.0,
                },
                _ => SeqRow {
                    t_ms: *t,
                    target_rpm: f64::NAN,
                    actual_rpm: f64::NAN,
                    current_ma: 0.0,
                    temp_c: v as f64 * 0.125,
                },
            }
        })
        .collect();

    // per-window statistics on the last 60 % of each hold
    let mut summary = Vec::new();
    for (start, end, target, _hold) in &windows {
        let lo = start + (end - start) * 0.4;
        let vals: Vec<f64> = rows
            .iter()
            .filter(|r| r.t_ms / 1000.0 >= lo && r.t_ms / 1000.0 <= *end && r.actual_rpm.is_finite())
            .map(|r| r.actual_rpm)
            .collect();
        if vals.is_empty() {
            continue;
        }
        let n = vals.len();
        let mean = vals.iter().sum::<f64>() / n as f64;
        let var = vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
        let std = var.sqrt();
        let cur: Vec<f64> = rows
            .iter()
            .filter(|r| r.t_ms / 1000.0 >= lo && r.t_ms / 1000.0 <= *end && r.current_ma.abs() > 0.0)
            .map(|r| r.current_ma)
            .collect();
        let temp: Vec<f64> = rows
            .iter()
            .filter(|r| r.t_ms / 1000.0 >= lo && r.t_ms / 1000.0 <= *end && r.temp_c > 0.0)
            .map(|r| r.temp_c)
            .collect();
        let ripple = if target.abs() > 1.0 {
            (mean - target).abs() / target.abs() * 100.0
        } else {
            0.0
        };
        let verdict = if target.abs() < 1.0 {
            "idle".to_string()
        } else if ripple <= cfg.tolerance_pct {
            "pass".to_string()
        } else {
            "check".to_string()
        };
        summary.push(SeqSummary {
            window: format!("{:.0} RPM", target),
            n,
            mean_rpm: mean,
            std_rpm: std,
            ripple_pct: ripple,
            mean_current_ma: if cur.is_empty() {
                0.0
            } else {
                cur.iter().sum::<f64>() / cur.len() as f64
            },
            max_current_ma: cur.iter().fold(0.0f64, |a, b| a.max(b.abs())),
            max_temp_c: temp.iter().fold(0.0f64, |a, b| a.max(*b)),
            verdict,
        });
    }

    // CSV
    let stamp = chrono_like_stamp();
    let safe_serial: String = cfg
        .serial
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let name = if safe_serial.is_empty() {
        format!("report_{stamp}.csv")
    } else {
        format!("{safe_serial}_{stamp}.csv")
    };
    let _ = std::fs::create_dir_all(csv_dir);
    let path = csv_dir.join(&name);
    let mut out = String::new();
    out.push_str("t_ms,target_rpm,actual_rpm,current_mA,temp_C\n");
    for r in &rows {
        out.push_str(&format!(
            "{:.2},{:.1},{:.1},{:.3},{:.2}\n",
            r.t_ms, r.target_rpm, r.actual_rpm, r.current_ma, r.temp_c
        ));
    }
    out.push_str("\nwindow,n,mean_rpm,std_rpm,ripple_pct,mean_mA,max_mA,max_temp_C,verdict\n");
    for s in &summary {
        out.push_str(&format!(
            "{},{},{:.1},{:.2},{:.2},{:.1},{:.1},{:.1},{}\n",
            s.window, s.n, s.mean_rpm, s.std_rpm, s.ripple_pct, s.mean_current_ma, s.max_current_ma, s.max_temp_c, s.verdict
        ));
    }
    std::fs::write(&path, out).map_err(|e| LinkError::Io(e.to_string()))?;
    ctx.ok(label, path.display().to_string());
    let _ = frame_bits;

    Ok(SeqResult {
        rows,
        summary,
        csv_path: path.display().to_string(),
    })
}

/// `YYYYMMDD-HHMMSS` in local time, computed without extra dependencies.
fn chrono_like_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    // Windows exposes local time through the TZ offset in minutes.
    let offset_min = local_offset_minutes();
    let local = secs + offset_min as i64 * 60;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(windows)]
fn local_offset_minutes() -> i32 {
    #[repr(C)]
    struct SystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    #[repr(C)]
    struct TimeZoneInformation {
        bias: i32,
        standard_name: [u16; 32],
        standard_date: SystemTime,
        standard_bias: i32,
        daylight_name: [u16; 32],
        daylight_date: SystemTime,
        daylight_bias: i32,
    }
    extern "system" {
        fn GetTimeZoneInformation(tzi: *mut TimeZoneInformation) -> u32;
    }
    unsafe {
        let mut tzi: TimeZoneInformation = std::mem::zeroed();
        let r = GetTimeZoneInformation(&mut tzi);
        // 2 == TIME_ZONE_ID_DAYLIGHT
        let extra = if r == 2 { tzi.daylight_bias } else { tzi.standard_bias };
        -(tzi.bias + extra)
    }
}

#[cfg(not(windows))]
fn local_offset_minutes() -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc_for(deg_e: i32, poles: u32, cpr: u32, b: i64) -> i32 {
        // 机械角 = 电角度 / 极对数；编码器 = 机械角占一圈的比例 × CPR
        let mech = deg_e as f64 / poles.max(1) as f64;
        let raw = (mech / 360.0 * cpr as f64).round() as i64;
        (raw + b).rem_euclid(cpr as i64) as i32
    }

    fn make_points(poles: u32, cpr: u32, b: i64) -> Vec<CalibPoint> {
        (0..=720)
            .step_by(90)
            .map(|d| CalibPoint { deg: d, enc: enc_for(d, poles, cpr, b) })
            .collect()
    }

    #[test]
    fn offset_uses_16bit_scaling_not_raw_counts() {
        // 14 bit / CPR 16384 → 换算比例 4；0° 时编码器读到 1000
        // PHI_E = raw×4×poles + OFFSET ⇒ OFFSET = −4000 = 0xF060
        let pts = make_points(1, 16_384, 1000);
        let off = phi_e_offset_from(&pts, 65536.0 / 16_384.0, 1);
        assert_eq!(off, (-4_000i64).rem_euclid(65_536) as u32);
    }

    #[test]
    fn offset_zero_when_already_aligned() {
        let pts = make_points(1, 16_384, 0);
        assert_eq!(phi_e_offset_from(&pts, 4.0, 1), 0);
    }

    #[test]
    fn offset_respects_pole_pairs() {
        // 极对数 2、0° 时编码器读到 500：OFFSET = −(4×500×2) = 0xF060
        let pts = make_points(2, 16_384, 500);
        let off = phi_e_offset_from(&pts, 4.0, 2);
        assert_eq!(off, (-4_000i64).rem_euclid(65_536) as u32);
    }
}
