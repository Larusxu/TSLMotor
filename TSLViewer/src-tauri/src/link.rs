//! Serial link: datagram transactions, RTMI streaming and capture buffers.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::axis::{self, Axis, Cmd, Limits};
use crate::proto::{self, RtmiParser};
use crate::regs;

#[derive(Debug)]
pub enum LinkError {
    NotConnected,
    Io(String),
    Timeout,
    Corrupt,
    ValueError(String),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::NotConnected => write!(f, "串口未连接"),
            LinkError::Io(e) => write!(f, "串口错误: {e}"),
            LinkError::Timeout => write!(f, "等待芯片响应超时"),
            LinkError::Corrupt => write!(f, "响应数据损坏（同步/回显不匹配）"),
            LinkError::ValueError(e) => write!(f, "{e}"),
        }
    }
}

impl From<LinkError> for String {
    fn from(e: LinkError) -> Self {
        e.to_string()
    }
}

pub type Result<T> = std::result::Result<T, LinkError>;

#[derive(Default)]
pub struct Counters {
    pub tx_bytes: AtomicU64,
    pub rx_bytes: AtomicU64,
    pub rtmi_frames: AtomicU64,
    pub rtmi_dropped: AtomicU64,
    pub rtmi_interrupts: AtomicU64,
}

#[derive(Clone, Serialize)]
pub struct LogLine {
    pub ts: f64,
    pub level: &'static str,
    pub source: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct LinkStats {
    pub connected: bool,
    pub port: String,
    pub baud: u32,
    pub rtmi_running: bool,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub rtmi_frames: u64,
    pub rtmi_dropped: u64,
    pub frame_rate: f64,
    pub channels: Vec<u8>,
    pub sampling: u8,
    pub trigger_hz: f64,
}

#[derive(Clone, Serialize)]
pub struct RtmiBatch {
    pub t: f64,
    pub pts: Vec<[i64; 2]>,
}

struct Port {
    sp: Box<dyn serialport::SerialPort>,
    name: String,
    baud: u32,
}

pub struct Link {
    port: Mutex<Option<Port>>,
    paused: AtomicBool,
    running: AtomicBool,
    axis: axis::Axis,
    app: Mutex<Option<AppHandle>>,
    pub counters: Counters,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    rtmi_state: Mutex<RtmiState>,
    rec: Mutex<Vec<(f64, u8, i32)>>,
    rec_origin: Mutex<Option<Instant>>,
    recording: AtomicBool,
    log_lines: Mutex<Vec<LogLine>>,
    rate_mark: Mutex<(Instant, u64)>,
}

#[derive(Default)]
struct RtmiState {
    channels: Vec<u8>,
    sampling: u8,
    crc: bool,
    frame_len: usize,
    trigger_hz: f64,
    last_rate: f64,
}

impl Link {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
            paused: AtomicBool::new(false),
            running: AtomicBool::new(false),
            axis: axis::Axis::new(),
            app: Mutex::new(None),
            counters: Counters::default(),
            thread: Mutex::new(None),
            rtmi_state: Mutex::new(RtmiState {
                frame_len: 5,
                ..Default::default()
            }),
            rec: Mutex::new(Vec::new()),
            rec_origin: Mutex::new(None),
            recording: AtomicBool::new(false),
            log_lines: Mutex::new(Vec::new()),
            rate_mark: Mutex::new((Instant::now(), 0)),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        let app = self.app.lock().clone();
        if let Some(app) = app {
            let _ = app.emit(event, payload);
        }
    }

    /// Record a line for the in-app console and mirror it to stdout.
    pub fn log(&self, level: &'static str, source: impl Into<String>, message: impl Into<String>) {
        let line = LogLine {
            ts: now_ms(),
            level,
            source: source.into(),
            message: message.into(),
        };
        println!(
            "[{}] {} {}",
            line.level.to_uppercase(),
            line.source,
            line.message
        );
        {
            let mut buf = self.log_lines.lock();
            buf.push(line.clone());
            if buf.len() > 5000 {
                let drop = buf.len() - 4000;
                buf.drain(..drop);
            }
        }
        self.emit("tsl:log", line);
    }

    // ---------------------------------------------------------------- ports

    pub fn is_connected(&self) -> bool {
        self.port.lock().is_some()
    }

    pub fn rtmi_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// True when the guard's channel is actually streaming position data.
    pub fn guard_feedback_live(&self, limits: &Limits) -> bool {
        if !self.rtmi_running() {
            return false;
        }
        self.rtmi_state
            .lock()
            .channels
            .iter()
            .any(|c| *c == limits.ch)
    }

    pub fn log_snapshot(&self) -> Vec<LogLine> {
        self.log_lines.lock().clone()
    }

    pub fn clear_log(&self) {
        self.log_lines.lock().clear();
    }

    pub fn open(&self, name: &str, baud: u32) -> Result<()> {
        self.close();
        let sp = serialport::new(name, baud)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(Duration::from_millis(8))
            .open()
            .map_err(|e| LinkError::Io(e.to_string()))?;
        *self.port.lock() = Some(Port {
            sp,
            name: name.to_string(),
            baud,
        });
        self.log("info", "link", format!("已打开 {name} @ {baud} 8N1"));
        Ok(())
    }

    pub fn close(&self) {
        let _ = self.stop_rtmi();
        let mut guard = self.port.lock();
        if let Some(p) = guard.take() {
            self.log("info", "link", format!("关闭 {}", p.name));
        }
    }

    pub fn stats(&self) -> LinkStats {
        let frames = self.counters.rtmi_frames.load(Ordering::Relaxed);
        let rate = {
            let mut mark = self.rate_mark.lock();
            let dt = mark.0.elapsed().as_secs_f64();
            if dt >= 0.5 {
                let r = (frames.saturating_sub(mark.1)) as f64 / dt;
                *mark = (Instant::now(), frames);
                self.rtmi_state.lock().last_rate = r;
                r
            } else {
                self.rtmi_state.lock().last_rate
            }
        };
        let (name, baud, connected) = {
            let guard = self.port.lock();
            match guard.as_ref() {
                Some(p) => (p.name.clone(), p.baud, true),
                None => (String::new(), 0, false),
            }
        };
        let st = self.rtmi_state.lock();
        LinkStats {
            connected,
            port: name,
            baud,
            rtmi_running: self.running.load(Ordering::Relaxed),
            tx_bytes: self.counters.tx_bytes.load(Ordering::Relaxed),
            rx_bytes: self.counters.rx_bytes.load(Ordering::Relaxed),
            rtmi_frames: frames,
            rtmi_dropped: self.counters.rtmi_dropped.load(Ordering::Relaxed),
            frame_rate: rate,
            channels: st.channels.clone(),
            sampling: st.sampling,
            trigger_hz: st.trigger_hz,
        }
    }

    // ---------------------------------------------------------- transactions

    fn gate(&self) -> PauseGuard<'_> {
        PauseGuard::new(&self.paused)
    }

    fn with_port<T>(&self, f: impl FnOnce(&mut Port) -> Result<T>) -> Result<T> {
        let mut guard = self.port.lock();
        let p = guard.as_mut().ok_or(LinkError::NotConnected)?;
        f(p)
    }

    /// Send a datagram and collect `want` response bytes.
    fn transact(&self, req: &[u8], want: usize, timeout_ms: u64) -> Result<Vec<u8>> {
        let _gate = self.gate();
        thread::sleep(Duration::from_millis(3));
        self.with_port(|p| {
            let _ = p.sp.clear(serialport::ClearBuffer::Input);
            p.sp
                .write_all(req)
                .map_err(|e| LinkError::Io(e.to_string()))?;
            let _ = p.sp.flush();
            self.counters
                .tx_bytes
                .fetch_add(req.len() as u64, Ordering::Relaxed);

            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            let mut buf = vec![0u8; want];
            let mut n = 0usize;
            while n < want {
                match p.sp.read(&mut buf[n..]) {
                    Ok(0) => {}
                    Ok(k) => n += k,
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(e) => return Err(LinkError::Io(e.to_string())),
                }
                if n >= want {
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
            }
            self.counters.rx_bytes.fetch_add(n as u64, Ordering::Relaxed);
            if n == 0 {
                return Err(LinkError::Timeout);
            }
            buf.truncate(n);
            Ok(buf)
        })
    }

    pub fn read_reg(&self, addr: u16) -> Result<u32> {
        let req = proto::read_request(addr);
        let resp = self.transact(&req, 6, 60)?;
        if resp.len() < 6 {
            return Err(LinkError::Timeout);
        }
        if resp[0] != req[0] || resp[1] != req[1] {
            return Err(LinkError::Corrupt);
        }
        proto::parse_read_response(&resp).ok_or(LinkError::Corrupt)
    }

    pub fn read_reg_retry(&self, addr: u16, tries: u32) -> Result<u32> {
        let mut last = LinkError::Timeout;
        for _ in 0..tries.max(1) {
            match self.read_reg(addr) {
                Ok(v) => return Ok(v),
                Err(e) => last = e,
            }
            thread::sleep(Duration::from_millis(2));
        }
        Err(last)
    }

    /// Fire-and-forget write. The chip only acknowledges writes when
    /// `UART.RTMI_CH_7.CH_7_EN` is set, so callers normally verify by read-back.
    pub fn write_reg(&self, addr: u16, value: u32) -> Result<()> {
        let req = proto::write_request(addr, value);
        let _gate = self.gate();
        thread::sleep(Duration::from_millis(2));
        self.with_port(|p| {
            let _ = p.sp.clear(serialport::ClearBuffer::Input);
            p.sp
                .write_all(&req)
                .map_err(|e| LinkError::Io(e.to_string()))?;
            let _ = p.sp.flush();
            self.counters.tx_bytes.fetch_add(6, Ordering::Relaxed);
            Ok(())
        })
    }

    /// Fire-and-forget write with no inter-transaction delay, for callers that
    /// already run inside the RTMI thread (position controller ticks). Never
    /// reads, so it cannot steal RTMI frames.
    pub fn write_reg_quiet(&self, addr: u16, value: u32) -> Result<()> {
        let req = proto::write_request(addr, value);
        self.with_port(|p| {
            p.sp
                .write_all(&req)
                .map_err(|e| LinkError::Io(e.to_string()))?;
            let _ = p.sp.flush();
            self.counters.tx_bytes.fetch_add(6, Ordering::Relaxed);
            Ok(())
        })
    }

    pub fn write_verified(&self, addr: u16, value: u32, mask: u32) -> Result<bool> {
        let mut last = LinkError::Timeout;
        for _ in 0..3 {
            self.write_reg(addr, value)?;
            thread::sleep(Duration::from_millis(2));
            match self.read_reg_retry(addr, 2) {
                Ok(rb) => {
                    if (rb & mask) == (value & mask) {
                        return Ok(true);
                    }
                }
                Err(e) => last = e,
            }
        }
        self.log(
            "error",
            "link",
            format!("写 0x{addr:03X} = 0x{value:08X} 校验失败 ({last})"),
        );
        Ok(false)
    }

    // ---------------------------------------------------------------- RTMI

    pub fn start_rtmi(self: &Arc<Self>, channels: &[(u8, u16)], sampling: u8, crc: bool) -> Result<()> {
        let _ = self.stop_rtmi();
        if channels.is_empty() {
            return Err(LinkError::ValueError("至少选择一个 RTMI 通道".into()));
        }
        let base = self.read_reg_retry(regs::UART_CONTROL, 3)?;

        // channels first, then the global enable
        for (ch, addr) in channels {
            if *ch > 6 {
                return Err(LinkError::ValueError("RTMI 通道 0..6 可用".into()));
            }
            let reg = regs::UART_RTMI_CH_BASE + *ch as u16;
            let val = regs::rtmi_channel(*addr);
            if !self.write_verified(reg, val, 0x0001_03FF)? {
                return Err(LinkError::ValueError(format!(
                    "RTMI 通道 {ch} 配置失败"
                )));
            }
        }
        let ctrl = regs::uart_control_rtmi(base, sampling, crc);
        if !self.write_verified(regs::UART_CONTROL, ctrl, 0xFFE0_0000)? {
            return Err(LinkError::ValueError("UART.CONTROL 写入失败".into()));
        }

        let frame_len = if crc { 6 } else { 5 };
        let pwm_hz = self.pwm_frequency_hz().unwrap_or(25_000.0);
        let trigger = pwm_hz / (sampling as f64 + 1.0);
        {
            let mut st = self.rtmi_state.lock();
            st.channels = channels.iter().map(|(c, _)| *c).collect();
            st.sampling = sampling;
            st.crc = crc;
            st.frame_len = frame_len;
            st.trigger_hz = trigger;
        }
        self.running.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.axis.reset_tracking();
        self.counters.rtmi_frames.store(0, Ordering::Relaxed);
        *self.rate_mark.lock() = (Instant::now(), 0);

        let me = Arc::clone(self);
        let handle = thread::Builder::new()
            .name("tsl-rtmi".into())
            .spawn(move || me.rtmi_loop(frame_len))
            .map_err(|e| LinkError::Io(e.to_string()))?;
        *self.thread.lock() = Some(handle);
        self.log(
            "info",
            "rtmi",
            format!(
                "RTMI 已启动: {} 通道, sampling={} → {:.0} Hz 触发",
                channels.len(),
                sampling,
                trigger
            ),
        );
        Ok(())
    }

    pub fn stop_rtmi(&self) -> Result<()> {
        let was_running = self.running.swap(false, Ordering::SeqCst);
        self.axis.reset_tracking();
        if let Some(h) = self.thread.lock().take() {
            let _ = h.join();
        }
        if was_running && self.is_connected() {
            if let Ok(base) = self.read_reg_retry(regs::UART_CONTROL, 3) {
                let off = regs::uart_control_rtmi_off(base);
                let _ = self.write_reg(regs::UART_CONTROL, off);
            }
            self.log("info", "rtmi", "RTMI 已停止");
        }
        self.paused.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn rtmi_loop(self: Arc<Link>, frame_len: usize) {
        let mut parser = RtmiParser::new(frame_len);
        let mut batch: Vec<[i64; 2]> = Vec::with_capacity(256);
        let mut last_emit = Instant::now();
        let mut chunk = vec![0u8; 4096];

        while self.running.load(Ordering::Relaxed) {
            if self.paused.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            let n = {
                let mut guard = self.port.lock();
                match guard.as_mut() {
                    Some(p) => match p.sp.bytes_to_read() {
                        Ok(n) => {
                            let n = n as usize;
                            if n == 0 {
                                0
                            } else {
                                let want = n.min(chunk.len());
                                match p.sp.read(&mut chunk[..want]) {
                                    Ok(k) => k,
                                    Err(_) => 0,
                                }
                            }
                        }
                        Err(_) => 0,
                    },
                    None => 0,
                }
            };

            if n > 0 {
                self.counters
                    .rx_bytes
                    .fetch_add(n as u64, Ordering::Relaxed);
                let mut frames = Vec::with_capacity(64);
                parser.push(&chunk[..n], &mut frames);
                if !frames.is_empty() {
                    self.counters
                        .rtmi_frames
                        .fetch_add(frames.len() as u64, Ordering::Relaxed);
                    // travel guard runs per frame, before anything else
                    let lim = self.axis.limits();
                    let mut hit = None;
                    for (ch, v) in &frames {
                        if self.axis.observe(*ch, *v as i32, &lim) {
                            hit = Some(*v as i32);
                        }
                    }
                    if let Some(pos) = hit {
                        let cmd = self.on_travel_limit(&lim, pos);
                        self.dispatch(&self, cmd);
                    }
                    let rec = self.recording.load(Ordering::Relaxed);
                    if rec {
                        let t0 = { *self.rec_origin.lock() };
                        if let Some(t0) = t0 {
                            let mut buf = self.rec.lock();
                            for (ch, v) in &frames {
                                buf.push((t0.elapsed().as_secs_f64() * 1000.0, *ch, *v));
                            }
                        }
                    }
                    for (ch, v) in frames {
                        batch.push([ch as i64, v as i64]);
                    }
                }
                let dropped = parser.dropped;
                self.counters
                    .rtmi_dropped
                    .store(dropped, Ordering::Relaxed);
            } else {
                thread::sleep(Duration::from_micros(800));
            }

            // position controller tick (no-op unless a move is active)
            if let Some(cmd) = self.axis.tick() {
                self.dispatch(&self, cmd);
            }

            if last_emit.elapsed() >= Duration::from_millis(33) {
                if !batch.is_empty() {
                    self.emit(
                        "tsl:rtmi",
                        RtmiBatch {
                            t: now_ms(),
                            pts: std::mem::take(&mut batch),
                        },
                    );
                    batch = Vec::with_capacity(256);
                }
                last_emit = Instant::now();
            }
        }
    }

    // ------------------------------------------------------------ recording

    pub fn start_recording(&self) {
        self.rec.lock().clear();
        *self.rec_origin.lock() = Some(Instant::now());
        self.recording.store(true, Ordering::SeqCst);
    }

    pub fn stop_recording(&self) -> Vec<(f64, u8, i32)> {
        self.recording.store(false, Ordering::SeqCst);
        *self.rec_origin.lock() = None;
        std::mem::take(&mut *self.rec.lock())
    }

    // ------------------------------------------------------------- helpers

    pub fn pwm_frequency_hz(&self) -> Option<f64> {
        let period = self.read_reg(regs::MCC_PWM_PERIOD).ok()?;
        let max_count = (period & 0xFFFF) as f64;
        if max_count == 0.0 {
            return None;
        }
        Some(120_000_000.0 / max_count)
    }

    /// Immediate, best-effort safe state: stop PWM, drop targets, disable gate drive.
    pub fn emergency_stop(&self) {
        self.log("warn", "safety", "急停：关闭 PWM 与驱动使能");
        let _ = self.write_reg(regs::FOC_PID_VELOCITY_TARGET, 0);
        let _ = self.write_reg(regs::FOC_PID_TORQUE_FLUX_TARGET, 0);
        if let Ok(mm) = self.read_reg(regs::MCC_MOTOR_MOTION) {
            let poles = mm & 0x7F;
            let off = (regs::MOTOR_TYPE_BLDC << 7) | poles;
            let _ = self.write_reg(regs::MCC_MOTOR_MOTION, off);
        }
        if let Ok(gdrv) = self.read_reg(regs::MCC_GDRV) {
            let _ = self.write_reg(regs::MCC_GDRV, gdrv & !(1 << 16));
        }
        let _ = self.write_reg(regs::FOC_PID_VELOCITY_INTEGRATOR, 0);
        let _ = self.write_reg(regs::FOC_PID_TORQUE_INTEGRATOR, 0);
        let _ = self.write_reg(regs::FOC_PID_FLUX_INTEGRATOR, 0);
    }

    // ------------------------------------------------------- travel guard

    pub fn axis(&self) -> &Axis {
        &self.axis
    }

    /// Called from the RTMI thread when a sample leaves the soft-limit window.
    /// Returns the action to dispatch (the caller owns the `Arc<Link>`).
    fn on_travel_limit(&self, lim: &Limits, pos: i32) -> Cmd {
        self.log(
            "error",
            "safety",
            format!(
                "软限位触发：位置 {pos} 越界 [{}, {}]，执行 {}",
                lim.min,
                lim.max,
                if lim.action == "brake" { "刹车" } else { "松力矩" }
            ),
        );
        let _ = self.emit(
            "tsl:limit",
            serde_json::json!({
                "pos": pos,
                "min": lim.min,
                "max": lim.max,
                "action": lim.action,
                "at": now_ms(),
            }),
        );
        if lim.action == "brake" {
            Cmd::Brake
        } else {
            Cmd::Stop
        }
    }

    /// Push a controller action to the chip. `Brake` reads registers, so it is
    /// moved to its own thread to keep the RTMI loop responsive.
    fn dispatch(&self, me: &Arc<Link>, cmd: Cmd) {
        if let Cmd::Brake = cmd {
            let link = Arc::clone(me);
            thread::spawn(move || link.emergency_stop());
        } else {
            self.apply_axis_cmd(cmd);
        }
    }

    fn apply_axis_cmd(&self, cmd: Cmd) {
        match cmd {
            Cmd::Vel(raw) => {
                let _ = self.write_reg_quiet(regs::FOC_PID_VELOCITY_TARGET, raw as u32);
            }
            Cmd::Stop => {
                let _ = self.write_reg_quiet(regs::FOC_PID_VELOCITY_TARGET, 0);
                let _ = self.write_reg_quiet(regs::FOC_PID_VELOCITY_INTEGRATOR, 0);
            }
            Cmd::Brake => {}
        }
    }
}

struct PauseGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> PauseGuard<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self { flag }
    }
}

impl Drop for PauseGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

pub fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Clone, Serialize)]
pub struct PortInfo {
    pub name: String,
    pub kind: String,
    pub detail: String,
}

pub fn list_ports() -> Vec<PortInfo> {
    let mut out = Vec::new();
    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            let (kind, detail) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    "USB".to_string(),
                    format!(
                        "{} {} · {}",
                        info.manufacturer.clone().unwrap_or_default(),
                        info.product.clone().unwrap_or_default(),
                        info.serial_number.clone().unwrap_or_default()
                    )
                    .trim()
                    .to_string(),
                ),
                serialport::SerialPortType::PciPort => ("PCI".to_string(), String::new()),
                serialport::SerialPortType::BluetoothPort => ("BT".to_string(), String::new()),
                serialport::SerialPortType::Unknown => ("UART".to_string(), String::new()),
            };
            out.push(PortInfo {
                name: p.port_name,
                kind,
                detail,
            });
        }
    }
    out.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    out
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let na: u32 = a.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
    let nb: u32 = b.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
    na.cmp(&nb).then_with(|| a.cmp(b))
}
