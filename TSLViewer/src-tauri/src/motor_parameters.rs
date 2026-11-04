//! Shared parameter ownership, masked write plans and closed-loop ramp codecs.
//! Datasheet Rev.0: pp.75-76, 92-97, 155-168, 173-177.
use crate::{link::Link, procs::PidSnapshot};
use serde::{Deserialize, Serialize};

pub const MA: f64 = 0.20131;
pub const VEL: f64 = 1099511627776.0 / 3600000000.0;
pub const CLOCK: f64 = 60_000_000.0;
// Match the MCU's measured-speed window; a stopped filter need not read zero.
pub const SWITCH_VELOCITY_RAW: i32 = 8192;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MotionMode {
    PositionDirect,
    #[default]
    PositionRamp,
    VelocityDirect,
    VelocityRamp,
}
impl MotionMode {
    pub fn velocity(self) -> bool {
        matches!(self, Self::VelocityDirect | Self::VelocityRamp)
    }
    pub fn ramp(self) -> bool {
        matches!(self, Self::PositionRamp | Self::VelocityRamp)
    }
    pub fn bits(self) -> u32 {
        (if self.velocity() { 3 } else { 4 }) << 9
            | if self.ramp() { 1 << 14 } else { 0 }
            | if self.velocity() { 1 << 13 } else { 0 }
    }
    // Retain unrelated bits, explicitly select closed-loop and disable unvalidated FF.
    pub fn word(self, old: u32) -> u32 {
        (old & !0x000f_fe00) | self.bits()
    }
}
pub fn velocity_raw(rpm: f64) -> Result<u32, String> {
    quantize(rpm * VEL, 0x07ff_ffff)
}
pub fn acceleration_raw(deg_s2: f64) -> Result<u32, String> {
    quantize(deg_s2 / 360.0 * VEL * 60.0 * 131072.0 / CLOCK, 0x007f_ffff)
}
fn quantize(value: f64, max: u32) -> Result<u32, String> {
    if !value.is_finite() || value <= 0.0 || value.round() < 1.0 || value.round() > max as f64 {
        return Err("参数超出芯片量化范围".into());
    }
    Ok(value.round() as u32)
}
pub fn merge(old: u32, value: u32, mask: u32) -> u32 {
    (old & !mask) | (value & mask)
}
#[derive(Clone, Debug, Serialize)]
pub struct RegisterWrite {
    pub reg: u16,
    pub value: u32,
    pub mask: u32,
}
pub trait RegisterAccess {
    fn get(&self, reg: u16) -> Result<u32, String>;
    fn put(&self, reg: u16, value: u32, mask: u32) -> Result<(), String>;
}
impl RegisterAccess for Link {
    fn get(&self, reg: u16) -> Result<u32, String> {
        self.read_reg_retry(reg, 2).map_err(|e| e.to_string())
    }
    fn put(&self, reg: u16, value: u32, mask: u32) -> Result<(), String> {
        if !self
            .write_verified(reg, value, mask)
            .map_err(|e| e.to_string())?
        {
            return Err(format!("0x{reg:03X}读回不一致；配置未完成"));
        }
        Ok(())
    }
}
pub fn execute(io: &impl RegisterAccess, plan: &[RegisterWrite]) -> Result<(), String> {
    for w in plan {
        let old = io.get(w.reg)?;
        let value = merge(old, w.value, w.mask);
        if old & w.mask != value & w.mask {
            io.put(w.reg, value, w.mask)?;
        }
        // Even unchanged values have been read and compared; no redundant write.
    }
    Ok(())
}
fn w(reg: u16, value: u32, mask: u32) -> RegisterWrite {
    RegisterWrite { reg, value, mask }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DriverProfile {
    pub registers: PidSnapshot,
    pub ma_per_count: f64,
    pub counts_per_rpm: f64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ParameterState {
    pub driver: Option<DriverProfile>,
    pub observed: Option<PidSnapshot>,
    pub effective_current_ma: Option<f64>,
    pub effective_velocity_rpm: Option<f64>,
    pub consistent: bool,
    pub message: String,
    pub requires_apply: bool,
}
#[derive(Default)]
pub struct ParameterBank {
    pub motors: [ParameterState; 16],
}
impl ParameterBank {
    pub fn invalidate(&mut self) {
        for m in &mut self.motors {
            *m = ParameterState {
                message: "连接或电源状态改变，请重新读取PID配置核对".into(),
                ..Default::default()
            };
        }
    }
}

pub fn observe(link: &Link, snap: PidSnapshot) -> Result<ParameterState, String> {
    let motor = link.focused_motor() as usize;
    if !(1..=16).contains(&motor) {
        return Err("电机号无效".into());
    }
    let mut bank = link.parameters.lock();
    let s = &mut bank.motors[motor - 1];
    if s.driver.is_none() {
        s.driver = Some(DriverProfile {
            registers: snap.clone(),
            ma_per_count: MA,
            counts_per_rpm: VEL,
        });
    }
    let d = s.driver.as_ref().unwrap();
    s.consistent = !s.requires_apply
        && same_gains(&snap, &d.registers)
        && ((snap.tf_limits >> 16) & 0x7fff) <= ((d.registers.tf_limits >> 16) & 0x7fff)
        && (snap.tf_limits & 0x7fff) == (d.registers.tf_limits & 0x7fff)
        && (snap.vel_limit & 0x7fff_ffff) <= (d.registers.vel_limit & 0x7fff_ffff);
    s.effective_current_ma = Some(((snap.tf_limits >> 16) & 0x7fff) as f64 * d.ma_per_count);
    s.effective_velocity_rpm = Some((snap.vel_limit & 0x7fff_ffff) as f64 / d.counts_per_rpm);
    s.observed = Some(snap);
    s.message = if s.consistent {
        "已读回核对；设备档案上限保持独立"
    } else {
        "设备与档案不一致；请停机后应用PID档案"
    }
    .into();
    Ok(s.clone())
}
fn same_gains(a: &PidSnapshot, b: &PidSnapshot) -> bool {
    (a.config & 0x7fffff) == (b.config & 0x7fffff)
        && a.flux_coeff == b.flux_coeff
        && a.torque_coeff == b.torque_coeff
        && a.vel_coeff == b.vel_coeff
        && a.pos_coeff == b.pos_coeff
        && (a.uq_ud_limit & 0xffff) == (b.uq_ud_limit & 0xffff)
}
pub fn commit_driver(link: &Link, snap: PidSnapshot, ma: f64, vel: f64) {
    let motor = link.focused_motor() as usize;
    if !(1..=16).contains(&motor) {
        return;
    }
    link.parameters.lock().motors[motor - 1] = ParameterState {
        driver: Some(DriverProfile {
            registers: snap.clone(),
            ma_per_count: ma,
            counts_per_rpm: vel,
        }),
        observed: Some(snap),
        consistent: true,
        message: "驱动器档案已逐项读回；仅本会话保存".into(),
        ..Default::default()
    };
}
pub fn mark_inconsistent(link: &Link, message: &str) {
    let m = link.focused_motor() as usize;
    if (1..=16).contains(&m) {
        let mut b = link.parameters.lock();
        let s = &mut b.motors[m - 1];
        s.consistent = false;
        s.requires_apply = true;
        s.message = message.into();
    }
}
pub fn ensure_stopped(io: &impl RegisterAccess) -> Result<(), String> {
    if io.get(0x100)? & 0x1e00 != 0 {
        return Err("请先断使能；禁止在带载保持或运动中应用参数".into());
    }
    if i64::from(io.get(0x154)? as i32).abs() > i64::from(SWITCH_VELOCITY_RAW) {
        return Err("电机尚未静止，参数未写入".into());
    }
    if io.get(0x009)? & 0x3fff != 0 {
        return Err("芯片故障未清除，参数未写入".into());
    }
    Ok(())
}
pub fn reset_integrators(io: &impl RegisterAccess) -> Result<(), String> {
    ensure_stopped(io)?;
    execute(
        io,
        &[
            w(0x15d, 0, u32::MAX),
            w(0x15e, 0, u32::MAX),
            w(0x15f, 0, u32::MAX),
            w(0x160, 0, u32::MAX),
        ],
    )
}
pub fn resolved(driver: &DriverProfile, ma: f64, rpm: f64) -> Result<(f64, f64), String> {
    let current =
        (((driver.registers.tf_limits >> 16) & 0x7fff) as f64 * driver.ma_per_count).min(ma);
    let velocity =
        ((driver.registers.vel_limit & 0x7fff_ffff) as f64 / driver.counts_per_rpm).min(rpm);
    if current <= 0.0 || velocity <= 0.0 {
        return Err("驱动器限幅为零；先读取或应用有效PID档案".into());
    }
    Ok((current, velocity))
}
pub fn ramp_plan(rpm: f64, accel: f64, decel: f64) -> Result<Vec<RegisterWrite>, String> {
    let v = velocity_raw(rpm)?;
    let a = acceleration_raw(accel)?;
    let d = acceleration_raw(decel)?;
    // p.94 allows V1=0, V2=V1: omit A1/A2,D1/D2 segments. All A/D set,
    // V_START=0, V_STOP=one internal LSB; no time dwell, no hidden reset defaults.
    Ok(vec![
        w(0x1c0, 0, u32::MAX),
        w(0x1c4, a, 0x7fffff),
        w(0x1c5, a, 0x7fffff),
        w(0x1c6, a, 0x7fffff),
        w(0x1c7, d, 0x7fffff),
        w(0x1c8, d, 0x7fffff),
        w(0x1c9, d, 0x7fffff),
        w(0x1ca, 0, 0x7fffff),
        w(0x1cb, 0, 0x7ffffff),
        w(0x1cc, 0, 0x7ffffff),
        w(0x1cd, 1, 0x7fffff),
        w(0x1ce, v, 0x7ffffff),
    ])
}
pub fn task_plan(
    driver: &DriverProfile,
    current: f64,
    rpm: f64,
    mode: MotionMode,
    a: f64,
    d: f64,
) -> Result<Vec<RegisterWrite>, String> {
    let (ma, v) = resolved(driver, current, rpm)?;
    let iq = (ma / driver.ma_per_count + 1e-8).floor() as u32;
    let velocity = (v * driver.counts_per_rpm + 1e-8).floor() as u32;
    let mut plan = vec![
        w(0x14a, iq << 16, 0x7fff0000),
        w(0x14b, velocity, 0x7fffffff),
    ];
    if mode.ramp() {
        plan.extend(ramp_plan(v, a, d)?);
    }
    Ok(plan)
}
/// Minimum rest-to-rest trapezoid time; does not model available load torque.
pub fn timed_velocity(
    distance: f64,
    seconds: f64,
    vmax: f64,
    a: f64,
    d: f64,
) -> Result<f64, String> {
    let x = distance.abs();
    if ![x, seconds, vmax, a, d].iter().all(|v| v.is_finite())
        || seconds <= 0.0
        || vmax <= 0.0
        || a <= 0.0
        || d <= 0.0
    {
        return Err("时间规划参数无效".into());
    }
    if x == 0.0 {
        return Ok(vmax);
    }
    let factor = 1.0 / a + 1.0 / d;
    let peak = (2.0 * x / factor).sqrt().min(vmax * 6.0);
    let minimum = x / peak + peak * factor / 2.0;
    if seconds + 1e-6 < minimum {
        return Err(format!(
            "期望时间不可行：运动学最短{minimum:.3}s；不会提高任何限幅"
        ));
    }
    let discriminant = seconds * seconds - 2.0 * factor * x;
    let speed = 2.0 * x / (seconds + discriminant.max(0.0).sqrt());
    Ok((speed / 6.0).min(vmax))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SafetyPhase {
    #[default]
    Normal,
    OverThreshold,
    FaultLatched,
    Recovery,
}
#[derive(Default)]
pub struct SafetyMonitor {
    pub phase: SafetyPhase,
    since: Option<u64>,
    pub reason: String,
}
impl SafetyMonitor {
    pub fn sample(&mut self, now: u64, current: f64, threshold: f64, duration: u32) -> bool {
        if self.phase == SafetyPhase::FaultLatched {
            return true;
        }
        if current.abs() > threshold {
            let since = *self.since.get_or_insert(now);
            self.phase = SafetyPhase::OverThreshold;
            if now.saturating_sub(since) >= duration as u64 {
                self.trip("q轴电流持续超过软件阈值");
                return true;
            }
        } else {
            self.since = None;
            self.phase = SafetyPhase::Normal;
        }
        false
    }
    pub fn trip(&mut self, reason: &str) {
        self.phase = SafetyPhase::FaultLatched;
        self.reason = reason.into();
    }
    pub fn recover(
        &mut self,
        stopped: bool,
        fault: u32,
        current: f64,
        threshold: f64,
    ) -> Result<(), String> {
        if !stopped || fault != 0 || !current.is_finite() || current.abs() > threshold {
            return Err("需断使能、芯片无故障且实测电流低于阈值，才能清除软件锁存".into());
        }
        self.phase = SafetyPhase::Recovery;
        self.since = None;
        self.reason.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Fake {
        r: RefCell<BTreeMap<u16, u32>>,
        writes: RefCell<Vec<u16>>,
        bad: Option<u16>,
    }
    impl RegisterAccess for Fake {
        fn get(&self, r: u16) -> Result<u32, String> {
            Ok(*self.r.borrow().get(&r).unwrap_or(&0))
        }
        fn put(&self, r: u16, v: u32, _: u32) -> Result<(), String> {
            self.writes.borrow_mut().push(r);
            if self.bad == Some(r) {
                return Err("injected readback error".into());
            }
            self.r.borrow_mut().insert(r, v);
            Ok(())
        }
    }
    #[test]
    fn modes_and_preserved_fields() {
        for (m, b) in [
            (MotionMode::PositionDirect, 0x800),
            (MotionMode::PositionRamp, 0x4800),
            (MotionMode::VelocityDirect, 0x2600),
            (MotionMode::VelocityRamp, 0x6600),
        ] {
            assert_eq!(m.bits(), b);
            assert_eq!(m.word(0x800f8181) & 0x800001ff, 0x80000181);
            assert_eq!(m.word(u32::MAX) & 0xf8000, 0);
        }
    }
    #[test]
    fn conversions_and_ramp() {
        assert_eq!(velocity_raw(2000.0).unwrap(), 610840);
        let a = acceleration_raw(6000.0).unwrap();
        assert_eq!(a, 667);
        assert!(acceleration_raw(0.01).is_err());
        let p = ramp_plan(2000.0, 6000.0, 3000.0).unwrap();
        assert_eq!(p.len(), 12);
        assert_eq!(p.iter().find(|w| w.reg == 0x1cb).unwrap().value, 0);
        assert!(p.iter().find(|w| w.reg == 0x1ce).unwrap().value > 1);
    }
    #[test]
    fn masked_and_abort() {
        let f = Fake {
            bad: Some(2),
            ..Default::default()
        };
        f.r.borrow_mut().insert(1, 0x8000abcd);
        let p = [w(1, 0x12340000, 0x7fff0000), w(2, 1, 1), w(3, 1, 1)];
        assert!(execute(&f, &p).is_err());
        assert_eq!(f.get(1).unwrap(), 0x9234abcd);
        assert_eq!(*f.writes.borrow(), vec![1, 2]);
    }
    #[test]
    fn time_constraints() {
        assert!(timed_velocity(1000.0, 0.1, 100.0, 100.0, 100.0).is_err());
        assert!(timed_velocity(1000.0, 20.0, 100.0, 100.0, 100.0).unwrap() < 100.0);
    }
    #[test]
    fn safety_duration_and_latch() {
        let mut s = SafetyMonitor::default();
        assert!(!s.sample(0, 700.0, 600.0, 180));
        assert!(!s.sample(179, 700.0, 600.0, 180));
        assert!(s.sample(180, 700.0, 600.0, 180));
        assert!(s.sample(200, 0.0, 600.0, 180));
        assert!(s.recover(false, 0, 0.0, 600.0).is_err());
        s.recover(true, 0, 0.0, 600.0).unwrap();
        assert!(!s.sample(210, 0.0, 600.0, 180));
    }
    #[test]
    fn driver_task_limits() {
        let d = DriverProfile {
            registers: PidSnapshot {
                tf_limits: (2000 << 16) | 321,
                vel_limit: 610840,
                ..Default::default()
            },
            ma_per_count: MA,
            counts_per_rpm: VEL,
        };
        let (i, v) = resolved(&d, 500.0, 3000.0).unwrap();
        assert!(i < 403.0 && v < 2000.01);
        assert_eq!(
            merge(d.registers.tf_limits, 1000 << 16, 0x7fff0000) & 0xffff,
            321
        );
    }
    #[test]
    fn task_never_writes_origin_mode_or_gains() {
        let d = DriverProfile {
            registers: PidSnapshot {
                tf_limits: (2000 << 16) | 321,
                vel_limit: 610840,
                ..Default::default()
            },
            ma_per_count: MA,
            counts_per_rpm: VEL,
        };
        let f = Fake::default();
        f.r.borrow_mut().insert(0x14a, 0x80000141);
        let plan = task_plan(&d, 500.0, 3000.0, MotionMode::PositionRamp, 6000.0, 3000.0).unwrap();
        execute(&f, &plan).unwrap();
        assert_eq!(f.get(0x14a).unwrap(), 0x87d00141);
        assert!(!f.writes.borrow().iter().any(|r| [
            0x100, 0x140, 0x142, 0x143, 0x145, 0x146, 0x14c, 0x14d, 0x150, 0x152, 0x155, 0x156
        ]
        .contains(r)));
    }
    #[test]
    fn stopped_feedback_uses_mcu_noise_window() {
        let f = Fake::default();
        for v in [-987,987,-SWITCH_VELOCITY_RAW,SWITCH_VELOCITY_RAW] {
            f.r.borrow_mut().insert(0x154,v as u32);
            assert!(ensure_stopped(&f).is_ok());
        }
        for v in [-SWITCH_VELOCITY_RAW-1,SWITCH_VELOCITY_RAW+1,i32::MIN,i32::MAX] {
            f.r.borrow_mut().insert(0x154,v as u32);
            assert!(ensure_stopped(&f).is_err());
        }
        assert!(f.writes.borrow().is_empty());
    }
    #[test]
    fn integrators_only_when_safely_stopped() {
        let f = Fake::default();
        for r in 0x15d..=0x160 {
            f.r.borrow_mut().insert(r, 123);
        }
        f.r.borrow_mut().insert(0x100, 0x800);
        assert!(reset_integrators(&f).is_err());
        assert!(f.writes.borrow().is_empty());
        f.r.borrow_mut().insert(0x100, 0);
        reset_integrators(&f).unwrap();
        assert_eq!(*f.writes.borrow(), vec![0x15d, 0x15e, 0x15f, 0x160]);
    }
    #[test]
    fn read_failure_prevents_plan_and_enable() {
        struct Offline;
        impl RegisterAccess for Offline {
            fn get(&self, _: u16) -> Result<u32, String> {
                Err("offline".into())
            }
            fn put(&self, _: u16, _: u32, _: u32) -> Result<(), String> {
                panic!("offline must not write")
            }
        }
        assert!(ensure_stopped(&Offline).is_err());
        assert!(execute(&Offline, &[w(0x14a, 1, 1)]).is_err());
    }
}
