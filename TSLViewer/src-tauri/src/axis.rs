//! Mechanical travel guard.
//!
//! Once a lead screw (丝杆) is bolted to the motor there are hard end stops the
//! motor can slam into. The guard watches the position feedback at RTMI rate and
//! cuts the torque the moment the axis leaves the configured window. It also
//! hosts the small trapezoidal profile used by "move to" so a user can never
//! ask for a move that is half as long as the travel left.
//!
//! Everything here is unit-agnostic: positions are raw encoder counts, speeds
//! are RPM, acceleration is counts/s². The UI converts mm <-> counts.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// Soft limits, in encoder counts, on the RTMI channel chosen by the user.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Limits {
    pub enabled: bool,
    pub ch: u8,
    pub min: i32,
    pub max: i32,
    /// "loose" = drop the velocity target and let the loop hold the shaft,
    /// "brake" = PWM off + gate drive off (shaft free, may drift).
    pub action: String,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            enabled: false,
            ch: 0,
            min: 0,
            max: 65535,
            action: "loose".into(),
        }
    }
}

impl Limits {
    fn contains(&self, pos: i32) -> bool {
        pos >= self.min && pos <= self.max
    }
    pub fn span(&self) -> i32 {
        (self.max - self.min).max(1)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveCfg {
    pub target: i32,
    pub tol: i32,
    pub max_rpm: f64,
    pub accel: f64,
    /// counts per mechanical revolution (CPR x 4)
    pub cpr: f64,
    pub poles: u32,
}

#[derive(Clone, Debug)]
enum Goal {
    Idle,
    Jog,
    Move(MoveCfg),
}

/// What the RTMI thread should do with the serial port this tick.
#[derive(Clone, Copy, Debug)]
pub enum Cmd {
    /// Write this raw value to `FOC.PID_VELOCITY_TARGET` (encoder counts/s).
    Vel(i32),
    /// Drop the target and hold position.
    Stop,
    /// PWM off + gate drive off.
    Brake,
}

#[derive(Default)]
struct Tick {
    at: Option<Instant>,
    rpm: f64,
}

pub struct Axis {
    limits: Mutex<Limits>,
    goal: Mutex<Goal>,
    pos: AtomicI32,
    /// last raw 16-bit sample, used to unwrap the counter across revolutions
    prev_raw: AtomicI32,
    primed: AtomicBool,
    tripped: AtomicBool,
    done: AtomicBool,
    tick: Mutex<Tick>,
}

#[derive(Serialize)]
pub struct AxisState {
    pub limits: Limits,
    pub pos: i32,
    pub tripped: bool,
    pub done: bool,
    pub moving: bool,
    pub cmd_rpm: f64,
}

impl Default for Axis {
    fn default() -> Self {
        Self::new()
    }
}

impl Axis {
    pub fn new() -> Self {
        Self {
            limits: Mutex::new(Limits::default()),
            goal: Mutex::new(Goal::Idle),
            pos: AtomicI32::new(0),
            prev_raw: AtomicI32::new(0),
            primed: AtomicBool::new(false),
            tripped: AtomicBool::new(false),
            done: AtomicBool::new(false),
            tick: Mutex::new(Tick::default()),
        }
    }

    pub fn limits(&self) -> Limits {
        self.limits.lock().map(|l| l.clone()).unwrap_or_default()
    }

    /// Install new limits. Refuses a window that does not contain the axis, so a
    /// typo cannot park the motor outside its own guard.
    pub fn set_limits(&self, next: Limits) -> Result<Limits, String> {
        if next.max <= next.min {
            return Err("上限必须大于下限".into());
        }
        if next.enabled {
            let pos = self.pos.load(Ordering::Relaxed);
            if !next.contains(pos) {
                return Err(format!(
                    "当前位置 {pos} 已在软限位 [{}, {}] 之外，请先移动或重新设原点",
                    next.min, next.max
                ));
            }
        }
        *self.limits.lock().unwrap() = next.clone();
        if !next.enabled {
            self.tripped.store(false, Ordering::SeqCst);
        }
        Ok(next)
    }

    pub fn pos(&self) -> i32 {
        self.pos.load(Ordering::Relaxed)
    }

    pub fn state(&self) -> AxisState {
        let limits = self.limits();
        let moving = !matches!(*self.goal.lock().unwrap(), Goal::Idle);
        AxisState {
            limits,
            pos: self.pos(),
            tripped: self.tripped.load(Ordering::SeqCst),
            done: self.done.load(Ordering::SeqCst),
            moving,
            cmd_rpm: self.tick.lock().map(|t| t.rpm).unwrap_or(0.0),
        }
    }

    /// A new command always clears a stale "done" flag so the UI stop showing
    /// the previous move's result.
    pub fn start_jog(&self) -> Result<(), String> {
        let lim = self.limits();
        if lim.enabled && self.tripped.load(Ordering::SeqCst) {
            return Err("软限位已触发，请先复位".into());
        }
        if lim.enabled && !lim.contains(self.pos()) {
            return Err("当前位置在软限位之外，请先复位".into());
        }
        self.done.store(false, Ordering::SeqCst);
        *self.goal.lock().unwrap() = Goal::Jog;
        Ok(())
    }

    pub fn start_move(&self, cfg: MoveCfg) -> Result<(), String> {
        let lim = self.limits();
        if cfg.max_rpm <= 0.0 {
            return Err("速度上限必须大于 0".into());
        }
        if cfg.cpr < 1.0 {
            return Err("每圈计数无效".into());
        }
        if lim.enabled {
            if self.tripped.load(Ordering::SeqCst) {
                return Err("软限位已触发，请先复位".into());
            }
            if !lim.contains(self.pos()) {
                return Err("当前位置在软限位之外，请先复位".into());
            }
            if !lim.contains(cfg.target) {
                return Err(format!(
                    "目标 {} 超出软限位 [{}, {}]",
                    cfg.target, lim.min, lim.max
                ));
            }
        }
        self.done.store(false, Ordering::SeqCst);
        *self.goal.lock().unwrap() = Goal::Move(cfg);
        Ok(())
    }

    pub fn hold(&self) {
        *self.goal.lock().unwrap() = Goal::Idle;
        if let Ok(mut t) = self.tick.lock() {
            t.rpm = 0.0;
        }
    }

    pub fn clear_trip(&self) {
        self.tripped.store(false, Ordering::SeqCst);
        self.done.store(false, Ordering::SeqCst);
        self.hold();
    }

    /// Called when the RTMI stream restarts: the next sample becomes the new
    /// absolute reference instead of being diffed against a stale one.
    pub fn reset_tracking(&self) {
        self.primed.store(false, Ordering::SeqCst);
    }

    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }

    /// Feed one RTMI sample. Returns `true` the moment the guard trips so the
    /// caller can stop the motor exactly once.
    ///
    /// The chip reports a 16-bit position that wraps every revolution, which is
    /// useless on a lead screw that travels several turns. Consecutive samples
    /// differ by far less than half a revolution, so the counter is unwrapped
    /// into a continuous 32-bit value here.
    pub fn observe(&self, ch: u8, v: i32, lim: &Limits) -> bool {
        if ch != lim.ch {
            return false;
        }
        let raw = v & 0xFFFF;
        let prev = self.prev_raw.swap(raw, Ordering::Relaxed);
        let pos = if !self.primed.swap(true, Ordering::Relaxed) {
            raw
        } else {
            let mut d = raw - prev;
            if d > 32_768 {
                d -= 65_536;
            } else if d < -32_768 {
                d += 65_536;
            }
            self.pos.load(Ordering::Relaxed) + d
        };
        self.pos.store(pos, Ordering::Relaxed);
        if lim.enabled && !lim.contains(pos) && !self.tripped.swap(true, Ordering::SeqCst) {
            *self.goal.lock().unwrap() = Goal::Idle;
            return true;
        }
        false
    }

    /// Position controller tick, called from the RTMI thread. Returns the
    /// command to push to the chip, or `None` when nothing changes.
    pub fn tick(&self) -> Option<Cmd> {
        if self.tripped() {
            return None;
        }
        let mut goal = self.goal.lock().ok()?;
        let attrs = match &*goal {
            Goal::Idle | Goal::Jog => return None,
            Goal::Move(c) => c.clone(),
        };

        let mut t = self.tick.lock().ok()?;
        if let Some(at) = t.at {
            if at.elapsed().as_millis() < 30 {
                return None;
            }
        }
        t.at = Some(Instant::now());

        let pos = self.pos();
        let (rpm, reached) = plan(&attrs, pos);
        if reached {
            *goal = Goal::Idle;
            t.rpm = 0.0;
            self.done.store(true, Ordering::SeqCst);
            return Some(Cmd::Stop);
        }
        t.rpm = rpm;
        Some(Cmd::Vel((rpm * attrs.cpr / 60.0).round() as i32))
    }
}

/// Trapezoidal setpoint: (rpm, reached). Kept free of side effects so the
/// profile can be unit tested without waiting on the 30 ms tick timer.
fn plan(c: &MoveCfg, pos: i32) -> (f64, bool) {
    let err = c.target - pos;
    if err.abs() <= c.tol.max(1) {
        return (0.0, true);
    }
    let cpr_per_s = c.cpr / 60.0;
    let v_cap = c.max_rpm * cpr_per_s;
    // never faster than what can still be braked within the distance left
    let v_brake = (2.0 * c.accel.max(1.0) * err.abs() as f64).sqrt();
    let v = v_cap.min(v_brake);
    ((v / cpr_per_s) * err.signum() as f64, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(min: i32, max: i32) -> Limits {
        Limits {
            enabled: true,
            ch: 0,
            min,
            max,
            action: "loose".into(),
        }
    }

    fn open() -> Limits {
        Limits {
            enabled: false,
            ch: 0,
            ..Limits::default()
        }
    }

    #[test]
    fn unwraps_the_16_bit_counter() {
        let a = Axis::new();
        let lim = open();
        a.observe(0, 65_000, &lim);
        assert_eq!(a.pos(), 65_000);
        // 65000 -> 200 is +736 counts across the wrap
        a.observe(0, 200, &lim);
        assert_eq!(a.pos(), 65_736);
        a.observe(0, 1_000, &lim);
        assert_eq!(a.pos(), 66_536);
        // and backwards again
        a.observe(0, 65_000, &lim);
        assert_eq!(a.pos(), 66_536 - 1_536);
    }

    #[test]
    fn trips_outside_the_window() {
        let a = Axis::new();
        let lim = window(0, 1_000);
        assert!(!a.observe(0, 500, &lim));
        assert!(a.observe(0, 1_200, &lim));
        assert!(a.state().tripped);
        // a second out-of-range sample does not re-trigger the event
        assert!(!a.observe(0, 1_300, &lim));
    }

    #[test]
    fn refuses_targets_outside_the_window() {
        let a = Axis::new();
        a.observe(0, 500, &window(0, 10_000));
        a.set_limits(window(0, 10_000)).unwrap();
        let cfg = |target| MoveCfg {
            target,
            tol: 50,
            max_rpm: 100.0,
            accel: 200_000.0,
            cpr: 65_536.0,
            poles: 1,
        };
        assert!(a.start_move(cfg(5_000)).is_ok());
        a.hold();
        assert!(a.start_move(cfg(20_000)).is_err());
    }

    #[test]
    fn profile_decelerates_before_the_target() {
        let cfg = MoveCfg {
            target: 65_536,
            tol: 100,
            max_rpm: 300.0,
            accel: 5_000_000.0,
            cpr: 65_536.0,
            poles: 1,
        };
        // far away: speed capped by max_rpm
        let (v0, hit0) = plan(&cfg, 0);
        assert!(!hit0);
        assert!((v0 - 300.0).abs() < 1.0);
        // close to the target: braking curve dominates
        let (v1, _) = plan(&cfg, cfg.target - 400);
        assert!(v1 < 100.0, "expected a slow approach, got {v1}");
        // inside the tolerance: stop
        let (_, hit2) = plan(&cfg, cfg.target - 10);
        assert!(hit2);
    }
}
