// Runtime for the existing motor-control service. No hardware calls in tests by default.
use crate::{
    homing,
    link::Link,
    motor_parameters::{
        self as mp, MotionMode, RegisterAccess, RegisterWrite, SafetyMonitor, SafetyPhase,
    },
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
pub const COUNTS: f64 = 65536.0;
pub const SIGN: f64 = -1.0;
const MA: f64 = mp::MA;
const VEL: f64 = mp::VEL;
pub fn raw(deg: f64) -> i32 {
    (deg * COUNTS / 360.0 * SIGN).round() as i32
}
pub fn degrees(count: i32) -> f64 {
    count as f64 * 360.0 / COUNTS * SIGN
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub motor: u8,
    pub poles: u32,
    // Compatibility only: service replaces these with measured homing span.
    pub min_deg: f64,
    pub max_deg: f64,
    pub max_rpm: f64,
    pub limit_ma: f64,
    pub trip_ma: f64,
    pub trajectory: bool,
    pub duration_ms: u32,
    pub accel_deg_s2: f64,
    pub decel_deg_s2: f64,
    pub mode: MotionMode,
    pub planning: String,
    pub over_ms: u32,
    pub sample_ms: u32,
    pub comm_timeout_ms: u32,
    pub fault_action: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            motor: 1,
            poles: 1,
            min_deg: 0.0,
            max_deg: 54600.0,
            max_rpm: 2000.0,
            limit_ma: 500.0,
            trip_ma: 600.0,
            trajectory: true,
            duration_ms: 2000,
            accel_deg_s2: 6000.0,
            decel_deg_s2: 6000.0,
            mode: MotionMode::PositionRamp,
            planning: "limits".into(),
            over_ms: 180,
            sample_ms: 60,
            comm_timeout_ms: 1000,
            fault_action: "disable".into(),
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=16).contains(&self.motor)
            || !(1..=127).contains(&self.poles)
            || ![
                self.min_deg,
                self.max_deg,
                self.max_rpm,
                self.limit_ma,
                self.trip_ma,
                self.accel_deg_s2,
                self.decel_deg_s2,
            ]
            .iter()
            .all(|v| v.is_finite())
            || !(1.0..=6000.0).contains(&self.max_rpm)
            || !(50.0..=1050.0).contains(&self.limit_ma)
            || !(50.0..=1200.0).contains(&self.trip_ma)
            || !(1.0..=1_000_000.0).contains(&self.accel_deg_s2)
            || !(1.0..=1_000_000.0).contains(&self.decel_deg_s2)
            || !(1..=600000).contains(&self.duration_ms)
            || !(10..=10000).contains(&self.over_ms)
            || !(20..=1000).contains(&self.sample_ms)
            || !(100..=5000).contains(&self.comm_timeout_ms)
            || self.comm_timeout_ms < self.sample_ms * 2
            || !["disable", "controlled_stop"].contains(&self.fault_action.as_str())
            || !["limits", "time"].contains(&self.planning.as_str())
        {
            return Err("任务参数越界或保护采样/超时不匹配".into());
        }
        if self.planning == "time" && self.mode != MotionMode::PositionRamp {
            return Err("指定时间只适用于位置插补".into());
        }
        if self.mode == MotionMode::VelocityRamp
            && (self.accel_deg_s2 - self.decel_deg_s2).abs() > 0.001
        {
            return Err("手册p.96：速度Ramp使用同一A参数加减速；最大加速度与减速度必须相等".into());
        }
        if self.mode.ramp() {
            mp::ramp_plan(self.max_rpm, self.accel_deg_s2, self.decel_deg_s2)?;
        }
        Ok(())
    }
    fn contains(&self, x: f64) -> bool {
        x >= self.min_deg && x <= self.max_deg
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Command {
    pub kind: String,
    pub target: f64,
    pub b: f64,
    pub amplitude: f64,
    pub period_s: f64,
    pub cycles: u32,
    pub rpm: f64,
}
impl Command {
    fn validate(&self, c: &Config) -> Result<(), String> {
        if ![self.target, self.b, self.amplitude, self.period_s, self.rpm]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err("目标不是有限数值".into());
        }
        let valid = match self.kind.as_str() {
            "hold" | "stop_profile" | "decel_stop" => true,
            "velocity" => c.mode.velocity() && self.rpm.abs() <= c.max_rpm,
            "jog" => self.rpm != 0.0 && self.rpm.abs() <= c.max_rpm,
            "goto" => !c.mode.velocity() && c.contains(self.target),
            "recip" => {
                !c.mode.velocity()
                    && c.contains(self.target)
                    && c.contains(self.b)
                    && self.period_s >= 0.2
                    && self.period_s <= 3600.0
            }
            "sine" => {
                c.mode == MotionMode::PositionDirect
                    && self.amplitude >= 0.0
                    && c.contains(self.target - self.amplitude)
                    && c.contains(self.target + self.amplitude)
                    && self.period_s >= 0.2
                    && self.period_s <= 3600.0
            }
            _ => false,
        };
        if !valid {
            return Err("目标越界或与运动模式不匹配；正弦连续目标仅在位置直通可用".into());
        }
        if self.kind == "recip" {
            mp::timed_velocity(
                self.b - self.target,
                self.period_s / 2.0,
                c.max_rpm,
                c.accel_deg_s2,
                c.decel_deg_s2,
            )?;
        }
        if self.kind == "sine"
            && self.amplitude * std::f64::consts::TAU / self.period_s > c.max_rpm * 6.0
        {
            return Err("正弦工况峰值速度超过生效限幅".into());
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    pub motor: u8,
    pub active: bool,
    pub enabled: bool,
    pub power: bool,
    pub zero_valid: bool,
    pub position: Option<f64>,
    pub target: Option<f64>,
    pub rpm: Option<f64>,
    pub iq_ma: Option<f64>,
    pub fault: Option<u32>,
    pub travel_deg: Option<f64>,
    pub offset: Option<u32>,
    pub kind: String,
    pub cycles: u32,
    pub message: String,
    pub effective_current_ma: Option<f64>,
    pub effective_velocity_rpm: Option<f64>,
    pub safety_phase: SafetyPhase,
}
pub struct Control {
    pub active: AtomicBool,
    abort: AtomicBool,
    pulse: Mutex<Instant>,
    pending: Mutex<Option<Command>>,
    config: Mutex<Option<Config>>,
    state: Mutex<Snapshot>,
    safety: Mutex<[SafetyMonitor; 16]>,
    thresholds: Mutex<[f64; 16]>,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            abort: AtomicBool::new(false),
            pulse: Mutex::new(Instant::now()),
            pending: Mutex::new(None),
            config: Mutex::new(None),
            state: Mutex::new(Snapshot::default()),
            safety: Mutex::new(std::array::from_fn(|_| SafetyMonitor::default())),
            thresholds: Mutex::new([600.0; 16]),
        }
    }
}
pub fn home(link: &Link, motor: u8) -> Result<homing::HomingState, String> {
    homing::decode_state(&link.gateway_control(motor, 13, &[])?).ok_or("找零状态长度错误".into())
}
fn read(link: &Link, r: u16) -> Result<u32, String> {
    link.get(r)
}
fn write(link: &Link, r: u16, v: u32) -> Result<(), String> {
    link.put(r, v, u32::MAX)
}
fn masked(link: &Link, r: u16, v: u32, m: u32) -> Result<(), String> {
    mp::execute(
        link,
        &[RegisterWrite {
            reg: r,
            value: v,
            mask: m,
        }],
    )
}
pub fn snapshot(link: &Link, motor: u8) -> Result<Snapshot, String> {
    let info = link.gateway_control(motor, 4, &[])?;
    if info.len() != 10 || info[7] == 0 {
        return Err("电源状态不可读".into());
    }
    let power = info[9] & (1 << (info[2] - 1)) != 0;
    let h = home(link, motor)?;
    let ps = link.parameters.lock().motors[(motor - 1) as usize].clone();
    let mut s = Snapshot {
        motor,
        power,
        zero_valid: h.zero_valid && h.dual_supported && h.negative_valid && h.positive_valid,
        travel_deg: if h.zero_valid && h.travel_counts > 0 {
            Some(h.travel_counts as f64 * 360.0 / COUNTS)
        } else {
            None
        },
        effective_current_ma: ps.effective_current_ma,
        effective_velocity_rpm: ps.effective_velocity_rpm,
        kind: "idle".into(),
        ..Default::default()
    };
    if !power {
        link.parameters.lock().motors[(motor - 1) as usize].consistent = false;
        s.message = "逻辑电源未开启".into();
        return Ok(s);
    }
    if h.stage == 1 {
        s.kind = "homing".into();
        s.message = "主控正在找零".into();
        return Ok(s);
    }
    link.focus_motor(motor)?;
    s.position = Some(degrees(read(link, 0x155)? as i32));
    s.rpm = Some(read(link, 0x154)? as i32 as f64 / VEL * SIGN);
    s.iq_ma = Some((read(link, 0x153)? >> 16) as u16 as i16 as f64 * MA);
    s.fault = Some(read(link, 0x009)? & 0x3fff);
    s.enabled = read(link, 0x100)? & 0x1e00 != 0;
    s.offset = Some(read(link, 0x242)? & 0xffff);
    Ok(s)
}
pub fn apply_limits(link: &Link, c: &Config) -> Result<(), String> {
    c.validate()?;
    mp::ensure_stopped(link)?;
    let before = crate::procs::read_pid_raw(link).map_err(|e| e.to_string())?;
    let existing = link.parameters.lock().motors[(c.motor - 1) as usize].clone();
    if existing.driver.is_none() {
        return Err("先在PID页从芯片读取或应用驱动器档案".into());
    }
    let state = mp::observe(link, before)?;
    if !state.consistent {
        return Err(state.message);
    }
    let driver = state.driver.unwrap();
    let plan = mp::task_plan(
        &driver,
        c.limit_ma,
        c.max_rpm,
        c.mode,
        c.accel_deg_s2,
        c.decel_deg_s2,
    )?;
    let result: Result<(), String> = (|| {
        // Only Iq field belongs to task limit. Id and reserved bits survive.
        mp::execute(link, &plan)?;
        let rb = crate::procs::read_pid_raw(link).map_err(|e| e.to_string())?;
        mp::observe(link, rb)?;
        Ok(())
    })();
    if let Err(ref e) = result {
        mp::mark_inconsistent(link, e);
    }
    result
}
// Kept for historical offline tests/legacy quintic callers; main moves use native ramp.
pub fn ramp_duration(distance: f64, c: &Config) -> f64 {
    (c.duration_ms as f64 / 1000.0)
        .max(1.875 * distance.abs() / (6.0 * c.max_rpm))
        .max((5.773503 * distance.abs() / c.accel_deg_s2).sqrt())
}
fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (10.0 + t * (-15.0 + 6.0 * t))
}
fn request_decel(link: &Link, c: &Config) -> Result<(), String> {
    if !c.mode.ramp() {
        return Err("直通模式没有减速轨迹；请使用保持目标或断使能".into());
    }
    if c.mode.velocity() {
        write(link, 0x150, 0)
    } else {
        // p.173 FORCE_HARD_STOP triggers stall event; SOFT_STOP_EN selects D profile.
        masked(
            link,
            0x1c1,
            (1 << 16) | (1 << 15) | (1 << 14),
            (1 << 16) | (1 << 15) | (1 << 14),
        )
    }
}
impl Control {
    pub fn state(&self) -> Snapshot {
        self.state.lock().clone()
    }
    pub fn pulse(&self) {
        *self.pulse.lock() = Instant::now();
    }
    pub fn stop(&self) {
        self.abort.store(true, Ordering::SeqCst);
    }
    pub fn phase(&self, m: u8) -> SafetyPhase {
        self.safety.lock()[(m - 1) as usize].phase.clone()
    }
    pub fn recover(&self, link: &Link, m: u8) -> Result<(), String> {
        if self.active.load(Ordering::SeqCst) {
            return Err("先断使能再清除锁存".into());
        }
        link.focus_motor(m)?;
        let s = snapshot(link, m)?;
        let threshold = self.thresholds.lock()[(m - 1) as usize];
        self.safety.lock()[(m - 1) as usize].recover(
            !s.enabled,
            s.fault.unwrap_or(u32::MAX),
            s.iq_ma.unwrap_or(f64::NAN),
            threshold,
        )
    }
    fn check(&self, c: &Config) -> Result<(), String> {
        if self.abort.load(Ordering::SeqCst) {
            return Err("已请求断使能".into());
        }
        if self.pulse.lock().elapsed() > Duration::from_millis(c.comm_timeout_ms as u64) {
            return Err("页面通信超时，停止输出；保护依赖桌面通信".into());
        }
        Ok(())
    }
    pub fn command(&self, cmd: Command) -> Result<(), String> {
        if !self.active.load(Ordering::SeqCst) {
            return Err("请先使能输出".into());
        }
        let cfg = self.config.lock().clone().ok_or("任务未就绪")?;
        cmd.validate(&cfg)?;
        self.check(&cfg)?;
        if self.phase(cfg.motor) == SafetyPhase::FaultLatched {
            return Err("软件保护已锁存".into());
        }
        if cmd.kind == "decel_stop" && !cfg.mode.ramp() {
            return Err("正常减速停止需要选择原生Ramp模式".into());
        }
        *self.pending.lock() = Some(cmd);
        Ok(())
    }
    pub fn start(
        self: &Arc<Self>,
        link: Arc<Link>,
        busy: Arc<AtomicBool>,
        mut cfg: Config,
    ) -> Result<(), String> {
        cfg.validate()?;
        if self.phase(cfg.motor) == SafetyPhase::FaultLatched {
            return Err("软件故障已锁存，请先读取故障并清除".into());
        }
        if busy.swap(true, Ordering::SeqCst) {
            return Err("请先结束当前任务".into());
        }
        if self.active.swap(true, Ordering::SeqCst) {
            busy.store(false, Ordering::SeqCst);
            return Err("输出已使能".into());
        }
        // No motor motion during checks/application. Enabling pins the current target.
        self.abort.store(false, Ordering::SeqCst);
        self.thresholds.lock()[(cfg.motor - 1) as usize] = cfg.trip_ma;
        self.pulse();
        *self.pending.lock() = None;
        *self.state.lock() = Snapshot {
            motor: cfg.motor,
            active: true,
            message: "检查档案、闭环和双端行程".into(),
            ..Default::default()
        };
        let me = Arc::clone(self);
        let release = Arc::clone(&busy);
        if let Err(e) = thread::Builder::new()
            .name("tsl-motion".into())
            .spawn(move || {
                let result = me.run(&link, &mut cfg);
                let stopped = masked(&link, 0x100, 0, 0xfe00);
                if stopped.is_err() {
                    let _ = link.gateway_control(cfg.motor, 5, &[0]);
                }
                if let Err(ref e) = result {
                    if !me.abort.load(Ordering::SeqCst) {
                        me.safety.lock()[(cfg.motor - 1) as usize].trip(e);
                    }
                }
                let mut s = me.state.lock();
                s.active = false;
                s.enabled = false;
                s.kind = "idle".into();
                s.safety_phase = me.phase(cfg.motor);
                s.message = result.err().unwrap_or_else(|| "已正常停止并断使能".into());
                if stopped.is_err() {
                    s.message.push_str("；PWM回读失败，已请求逻辑断电");
                }
                link.log("info", "motor-control", s.message.clone());
                drop(s);
                me.active.store(false, Ordering::SeqCst);
                release.store(false, Ordering::SeqCst);
            })
        {
            self.active.store(false, Ordering::SeqCst);
            busy.store(false, Ordering::SeqCst);
            return Err(e.to_string());
        }
        Ok(())
    }
    fn run(&self, link: &Link, c: &mut Config) -> Result<(), String> {
        link.stop_rtmi()?;
        link.focus_motor(c.motor)?;
        self.check(c)?;
        let initial = snapshot(link, c.motor)?;
        if !initial.power
            || !initial.zero_valid
            || initial.kind == "homing"
            || initial.fault != Some(0)
        {
            return Err("须逻辑上电、完整双端找零有效且芯片无故障".into());
        }
        c.min_deg = 0.0;
        c.max_deg = initial.travel_deg.ok_or("双端行程不可读")?;
        let pos = initial.position.ok_or("位置不可读")?;
        if !c.contains(pos) {
            return Err("当前位置不在实测行程内".into());
        }
        mp::ensure_stopped(link)?;
        let old = read(link, 0x100)?;
        if old & 0x1ff != 0 && old & 0x1ff != (3 << 7) | c.poles {
            return Err("电机类型或极对数与档案不一致；禁止自动改写后运动".into());
        }
        if (read(link, 0x240)? >> 24) & 15 != 7
            || read(link, 0x240)? & 0xffffff == 0
            || read(link, 0x250)? & 0x00f30000 != 1 << 22
            || read(link, 0x250)? & 0xff != c.poles
        {
            return Err("反馈来源不符合当前SSI闭环档案".into());
        }
        for r in [0x142, 0x143, 0x145, 0x146] {
            if read(link, r)? & 0x7fff7fff == 0 {
                return Err(format!("闭环系数0x{r:03X}未知"));
            }
        }
        if (read(link, 0x101)? >> 4) & 3 != 3 {
            return Err("电流换算要求LS_RES_ON=11，请先核对硬件".into());
        }
        apply_limits(link, c)?;
        let p = link.parameters.lock().motors[(c.motor - 1) as usize].clone();
        c.max_rpm = p.effective_velocity_rpm.ok_or("生效速度不可读")?;
        c.limit_ma = p.effective_current_ma.ok_or("生效电流不可读")?;
        *self.config.lock() = Some(c.clone());
        // Explicit enable is stopped/verified; reset stale integrators here only.
        mp::reset_integrators(link)?;
        write(link, 0x150, 0)?;
        write(link, 0x152, raw(pos) as u32)?;
        if c.mode.ramp() {
            write(link, 0x1d1, raw(pos) as u32)?;
            if read(link, 0x1d0)? as i32 != 0 {
                return Err("Ramp未静止，拒绝切换；请先复位/检查Ramp状态".into());
            }
        }
        let switch_old = read(link, 0x1c1)?;
        if switch_old & (1 << 16) != 0 {
            return Err("Ramp强制停止仍有效，先检查故障".into());
        }
        self.check(c)?;
        write(link, 0x101, read(link, 0x101)? | (1 << 16))?;
        // MCU homing cleanup writes literal PWM_OFF=0; feedback above verifies
        // pole pairs before restoring the known BLDC descriptor in that case.
        let descriptor = (old & !0x1ff) | (3 << 7) | c.poles;
        write(link, 0x100, c.mode.word(descriptor))?;
        let mut target = pos;
        let mut goal: Option<Command> = None;
        let mut began = Instant::now();
        let clock = Instant::now();
        let mut last_sample = Instant::now();
        let mut last = Instant::now();
        let mut cycles = 0;
        let mut previous: Option<u32> = None;
        let mut stopping: Option<(Instant, bool)> = None;
        loop {
            self.check(c)?;
            let tick = Instant::now();
            let h = home(link, c.motor)?;
            if !h.zero_valid || h.stage == 1 {
                return Err("零点失效或找零占用驱动".into());
            }
            let pos = degrees(read(link, 0x155)? as i32);
            let rpm = read(link, 0x154)? as i32 as f64 / VEL * SIGN;
            let iq = (read(link, 0x153)? >> 16) as u16 as i16 as f64 * MA;
            let fault = read(link, 0x009)? & 0x3fff;
            if fault != 0 {
                return Err(format!("芯片电气故障0x{fault:04X}，安全禁能"));
            }
            if !c.contains(pos) {
                return Err("实测位置超出双端行程，安全禁能".into());
            }
            if last_sample.elapsed() > Duration::from_millis(c.comm_timeout_ms as u64) {
                return Err("设备读取超时，保护采样不连续".into());
            }
            last_sample = Instant::now();
            let over = self.safety.lock()[(c.motor - 1) as usize].sample(
                clock.elapsed().as_millis() as u64,
                iq,
                c.trip_ma,
                c.over_ms,
            );
            if over && stopping.is_none() {
                if c.fault_action == "controlled_stop" && c.mode.ramp() {
                    request_decel(link, c)?;
                    stopping = Some((Instant::now(), true));
                    goal = None;
                } else {
                    return Err("持续q轴过流，故障锁存并安全禁能".into());
                }
            }
            let dt = last.elapsed().as_secs_f64().min(0.1);
            last = Instant::now();
            if let Some((at, is_fault)) = stopping {
                if rpm.abs() < 1.0 {
                    if !c.mode.velocity() {
                        // Pin a safe target and disable before releasing the
                        // stall request; releasing first could resume old travel.
                        write(link, 0x152, raw(pos) as u32)?;
                        masked(link, 0x100, 0, 0xfe00)?;
                        masked(link, 0x1c1, switch_old, (1 << 16) | (1 << 15) | (1 << 14))?;
                    }
                    if is_fault {
                        return Err("过流受控停止完成；软件故障已锁存".into());
                    }
                    return Ok(());
                }
                if at.elapsed() > Duration::from_millis(c.comm_timeout_ms as u64) {
                    return Err("受控停止超时，安全禁能".into());
                }
            } else if let Some(next) = self.pending.lock().take() {
                began = Instant::now();
                cycles = 0;
                previous = None;
                if next.kind == "decel_stop" {
                    request_decel(link, c)?;
                    stopping = Some((Instant::now(), false));
                    goal = None;
                } else if next.kind == "hold" || next.kind == "stop_profile" {
                    target = pos;
                    goal = None;
                    if c.mode.velocity() {
                        write(link, 0x150, 0)?;
                    } else {
                        write(link, 0x152, raw(pos) as u32)?;
                    }
                } else {
                    if c.planning == "time" && next.kind == "goto" {
                        if rpm.abs() > 1.0 {
                            return Err("指定时间规划仅接受静止起点".into());
                        }
                        let v = mp::timed_velocity(
                            next.target - pos,
                            c.duration_ms as f64 / 1000.0,
                            c.max_rpm,
                            c.accel_deg_s2,
                            c.decel_deg_s2,
                        )?;
                        masked(link, 0x1ce, mp::velocity_raw(v)?, 0x7ffffff)?;
                    } else if c.mode.ramp() {
                        masked(link, 0x1ce, mp::velocity_raw(c.max_rpm)?, 0x7ffffff)?;
                    }
                    goal = Some(next);
                }
            }
            let mut kind = goal
                .as_ref()
                .map(|g| g.kind.clone())
                .unwrap_or("hold".into());
            if stopping.is_some() {
                kind = "stopping".into();
            } else if let Some(g) = &goal {
                let elapsed = began.elapsed().as_secs_f64();
                if c.mode.velocity() {
                    let value = (g.rpm * VEL * SIGN).round() as i32 as u32;
                    if previous != Some(value) {
                        write(link, 0x150, value)?;
                        previous = Some(value);
                    }
                } else {
                    target = match g.kind.as_str() {
                        "jog" => {
                            let lead =
                                (g.rpm.abs() * 6.0 * c.sample_ms as f64 / 1000.0 * 5.0).max(3.0);
                            (target + g.rpm * 6.0 * dt).clamp(pos - lead, pos + lead)
                        }
                        "goto" => g.target,
                        "recip" => {
                            cycles = (elapsed / g.period_s).floor() as u32;
                            let leg = (elapsed / (g.period_s / 2.0)).floor() as u64;
                            if g.cycles > 0 && cycles >= g.cycles {
                                g.target
                            } else if leg % 2 == 0 {
                                g.b
                            } else {
                                g.target
                            }
                        }
                        "sine" => {
                            cycles = (elapsed / g.period_s).floor() as u32;
                            if g.cycles > 0 && cycles >= g.cycles {
                                g.target
                            } else {
                                (g.target
                                    + g.amplitude
                                        * (std::f64::consts::TAU * elapsed / g.period_s).sin())
                                .clamp(target - 6.0 * c.max_rpm * dt, target + 6.0 * c.max_rpm * dt)
                            }
                        }
                        _ => target,
                    }
                    .clamp(c.min_deg, c.max_deg);
                    let value = raw(target) as u32;
                    if previous != Some(value) {
                        write(link, 0x152, value)?;
                        previous = Some(value);
                    }
                }
                if (g.kind == "recip" || g.kind == "sine") && g.cycles > 0 && cycles >= g.cycles {
                    goal = None;
                    kind = "hold".into();
                }
            }
            *self.state.lock() = Snapshot {
                motor: c.motor,
                active: true,
                enabled: true,
                power: true,
                zero_valid: true,
                position: Some(pos),
                target: Some(target),
                rpm: Some(rpm),
                iq_ma: Some(iq),
                fault: Some(fault),
                travel_deg: initial.travel_deg,
                offset: initial.offset,
                kind,
                cycles,
                effective_current_ma: Some(c.limit_ma),
                effective_velocity_rpm: Some(c.max_rpm),
                safety_phase: self.phase(c.motor),
                message: "软件保护运行于桌面后端；依赖串口与页面心跳，不能替代芯片OCP".into(),
            };
            if let Some(delay) =
                Duration::from_millis(c.sample_ms as u64).checked_sub(tick.elapsed())
            {
                thread::sleep(delay);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direction_roundtrip() {
        assert_eq!(raw(360.0), -65536);
        assert_eq!(degrees(-65536), 360.0);
    }
    #[test]
    fn trajectory_bounds() {
        let c = Config {
            motor: 9,
            poles: 1,
            min_deg: 0.0,
            max_deg: 54600.0,
            max_rpm: 2000.0,
            limit_ma: 500.0,
            trip_ma: 600.0,
            trajectory: true,
            duration_ms: 2000,
            accel_deg_s2: 6000.0,
            ..Config::default()
        };
        assert!(c.validate().is_ok());
        assert!(ramp_duration(54600.0, &c) >= 1.875 * 54600.0 / 12000.0);
        assert_eq!(smooth(0.0), 0.0);
        assert_eq!(smooth(1.0), 1.0);
        let mut bad = c.clone();
        bad.max_deg = f64::NAN;
        assert!(bad.validate().is_err());
    }
    #[test]
    fn incompatible_modes_and_constraints_rejected() {
        let mut c = Config::default();
        c.mode = MotionMode::VelocityRamp;
        c.decel_deg_s2 = 3000.0;
        assert!(c.validate().is_err());
        c.decel_deg_s2 = c.accel_deg_s2;
        assert!(c.validate().is_ok());
        c.planning = "time".into();
        assert!(c.validate().is_err());
        c.mode = MotionMode::PositionRamp;
        c.planning = "limits".into();
        let cmd = Command {
            kind: "velocity".into(),
            target: 0.0,
            b: 360.0,
            amplitude: 10.0,
            period_s: 1.0,
            cycles: 1,
            rpm: 10.0,
        };
        assert!(cmd.validate(&c).is_err());
        let mut sine = cmd.clone();
        sine.kind = "sine".into();
        assert!(sine.validate(&c).is_err());
    }
    #[test]
    #[ignore = "real M9 motion; requires MOTO_M9_PORT and MOTO_M9_REPORT; powers off on exit"]
    fn hardware_m9_control() {
        let port = std::env::var("MOTO_M9_PORT").expect("explicit real board port required");
        let report = std::env::var("MOTO_M9_REPORT").expect("evidence path required");
        let link = Arc::new(Link::new());
        let control = Arc::new(Control::default());
        let busy = Arc::new(AtomicBool::new(false));
        link.open(&port, 460800, "main485", 9).unwrap();
        struct Cleanup(Arc<Link>, Arc<Control>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.1.stop();
                for _ in 0..50 {
                    if !self.1.active.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                let _ = self.0.gateway_control(9, 14, &[]);
                let _ = self.0.gateway_control(0, 6, &[]);
                self.0.close();
            }
        }
        let _cleanup = Cleanup(link.clone(), control.clone());
        let mut evidence: Vec<serde_json::Value> = Vec::new();
        let record = |list: &mut Vec<serde_json::Value>, phase: &str, s: Snapshot| {
            list.push(serde_json::json!({"phase":phase,"state":s}));
            std::fs::write(&report, serde_json::to_vec_pretty(list).unwrap()).unwrap();
        };
        link.gateway_control(9, 5, &[1]).unwrap();
        thread::sleep(Duration::from_millis(250));
        write(&link, 0x100, 0x181).unwrap();
        write(&link, 0x381, 0).unwrap();
        let matrix = read(&link, 0x006).unwrap();
        write(&link, 0x006, (matrix & !(0x3f | (7 << 12))) | 0x303f).unwrap();
        for (r, v) in [
            (0x240, 0x07000400),
            (0x250, 0x00400001),
            (0x242, 18282),
            (0x103, 0xffff12c0),
            (0x384, 0x3fff),
            (0x383, 0),
            (0x140, 0x855c),
            (0x142, 0x00400030),
            (0x143, 0x00400030),
            (0x145, 0x01f400fa),
            (0x146, 0x01f40000),
            (0x149, 0x5a81),
            (0x14a, ((500.0 / MA).round() as u32) << 16),
            (0x14b, (2000.0 * VEL).round() as u32),
            (0x244, 0x02bb12),
            (0x14c, 0x80000001),
            (0x14d, 0x7fffffff),
        ] {
            write(&link, r, v).unwrap();
        }
        assert!(link.write_verified(0x0c3, 3, 3).unwrap());
        link.write_reg(0x381, 0xf6108d0e).unwrap();
        thread::sleep(Duration::from_millis(200));
        write(
            &link,
            0x101,
            read(&link, 0x101).unwrap() | (1 << 31) | (1 << 16),
        )
        .unwrap();
        let hc = homing::HomingConfig {
            k_x1000: 400,
            rated_ma: 1050,
            confirm_ms: 50,
            limit_ma: 500,
            max_rpm: 2000,
            retreat_deg: 360,
            settle_ms: 2000,
            timeout_s: 60,
        };
        assert_eq!(
            link.gateway_control(9, 15, &hc.encode().unwrap()).unwrap(),
            [1]
        );
        assert_eq!(link.gateway_control(9, 12, &[1, 100, 0, 2]).unwrap(), [1]);
        let began = Instant::now();
        loop {
            let h = home(&link, 9).unwrap();
            if h.stage == 2 && h.zero_valid {
                break;
            }
            assert_ne!(h.stage, 3, "{}", h.message);
            assert!(h.iq_ma.abs() < 650.0);
            assert!(began.elapsed().as_secs() < 125);
            thread::sleep(Duration::from_millis(120));
        }
        thread::sleep(Duration::from_millis(400));
        record(&mut evidence, "home_complete", snapshot(&link, 9).unwrap());
        crate::procs::read_pid(&link).unwrap();
        let cfg = Config {
            motor: 9,
            poles: 1,
            min_deg: 0.0,
            max_deg: 1440.0,
            max_rpm: 120.0,
            limit_ma: 500.0,
            trip_ma: 650.0,
            trajectory: true,
            duration_ms: 700,
            accel_deg_s2: 6000.0,
            ..Config::default()
        };
        let wait = |ms: u64| {
            let end = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < end {
                control.pulse();
                thread::sleep(Duration::from_millis(80));
            }
            let s = control.state();
            assert!(s.active, "{}", s.message);
            s
        };
        let cmd = |kind: &str, target: f64, rpm: f64| Command {
            kind: kind.into(),
            target,
            b: 650.0,
            amplitude: 60.0,
            period_s: 3.0,
            cycles: 1,
            rpm,
        };
        control
            .start(link.clone(), busy.clone(), cfg.clone())
            .unwrap();
        record(&mut evidence, "enabled", wait(1000));
        control.command(cmd("goto", 540.0, 0.0)).unwrap();
        let s = wait(2500);
        record(&mut evidence, "goto_540", s.clone());
        assert!((s.position.unwrap() - 540.0).abs() < 8.0);
        let before = s.position.unwrap();
        control.command(cmd("jog", 0.0, 60.0)).unwrap();
        wait(450);
        control.command(cmd("hold", 0.0, 0.0)).unwrap();
        let s = wait(600);
        record(&mut evidence, "jog_positive_release", s.clone());
        assert!(s.position.unwrap() > before + 5.0);
        let before = s.position.unwrap();
        control.command(cmd("jog", 0.0, -60.0)).unwrap();
        wait(450);
        control.command(cmd("hold", 0.0, 0.0)).unwrap();
        let s = wait(600);
        record(&mut evidence, "jog_negative_release", s.clone());
        assert!(s.position.unwrap() < before - 5.0);
        control.command(cmd("recip", 400.0, 0.0)).unwrap();
        let s = wait(4500);
        record(&mut evidence, "recip_complete", s.clone());
        assert_eq!(s.kind, "hold");
        assert!(control.command(cmd("sine", 520.0, 0.0)).is_err());
        control.command(cmd("jog", 0.0, 30.0)).unwrap();
        wait(250);
        control.command(cmd("hold", 0.0, 0.0)).unwrap();
        record(&mut evidence, "hold", wait(500));
        thread::sleep(Duration::from_millis(1800));
        let s = control.state();
        record(&mut evidence, "ui_timeout", s.clone());
        assert!(!s.active && !s.enabled);
        assert_eq!(read(&link, 0x100).unwrap() & 0x1e00, 0);
        assert!(home(&link, 9).unwrap().zero_valid);
        let mut direct = cfg;
        direct.trajectory = false;
        direct.mode = MotionMode::PositionDirect;
        control.recover(&link, 9).unwrap();
        control.start(link.clone(), busy.clone(), direct).unwrap();
        wait(1000);
        control.command(cmd("goto", 500.0, 0.0)).unwrap();
        let s = wait(2000);
        record(&mut evidence, "direct_500", s.clone());
        assert!((s.position.unwrap() - 500.0).abs() < 8.0);
        let mut ongoing = cmd("sine", 520.0, 0.0);
        ongoing.cycles = 0;
        control.command(ongoing).unwrap();
        wait(500);
        control.command(cmd("stop_profile", 0.0, 0.0)).unwrap();
        let s = wait(500);
        record(&mut evidence, "stop_profile_holds", s.clone());
        assert!(s.enabled && s.kind == "hold");
        control.stop();
        thread::sleep(Duration::from_millis(600));
        assert!(!control.active.load(Ordering::SeqCst));
        record(
            &mut evidence,
            "disabled_zero_preserved",
            snapshot(&link, 9).unwrap(),
        );
        link.gateway_control(0, 6, &[]).unwrap();
        record(
            &mut evidence,
            "logic_off_zero_invalid",
            snapshot(&link, 9).unwrap(),
        );
        assert!(!home(&link, 9).unwrap().zero_valid);
        eprintln!("REAL M9 CONTROL PASS: {}", report);
    }
}
