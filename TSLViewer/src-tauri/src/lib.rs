//! TSL Viewer backend.
//!
//! The Rust side owns the serial port; the webview only sends intents and
//! renders the events it gets back. That keeps the timing critical paths
//! (datagram framing, RTMI parsing) away from the JS event loop.

mod gateway;
mod axis;
mod link;
mod procs;
mod proto;
mod regs;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use link::{Link, LinkStats, LogLine, PortInfo};
use procs::{Ctx, JobDone};

pub struct AppState {
    pub link: Arc<Link>,
    pub cancel: Arc<AtomicBool>,
    pub busy: Arc<AtomicBool>,
}

fn reports_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Documents").join("TSLViewer").join("reports")
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    link::list_ports()
}

#[tauri::command(async)]
fn connect(state: State<'_, AppState>, port: String, baud: u32, mode: Option<String>, motor: Option<u8>) -> Result<LinkStats, String> {
    state.link.open(&port, baud, mode.as_deref().unwrap_or("direct"),motor.unwrap_or(1)).map_err(|e| e.to_string())?;
    // Gateway open already verifies the controller. An unpowered/absent
    // motor must not trigger native transactions merely by connecting.
    if mode.as_deref().unwrap_or("direct") == "direct" {
    match state.link.read_reg_retry(regs::CHIP_ID, 2) {
        Ok(id) => {
            state
                .link
                .log("info", "link", format!("CHIP.ID = 0x{id:08X}"));
        }
        Err(e) => {
            state
                .link
                .log("warn", "link", format!("已打开串口，但读取 CHIP.ID 失败: {e}"));
        }
    }
    }
    Ok(state.link.stats())
}

#[tauri::command(async)]
fn main_control(state: State<'_, AppState>, motor:u8, op:u8, data:Vec<u8>)->Result<Vec<u8>,String> {
    if ![4,5,6,10,11].contains(&op) || motor>16 {return Err("Invalid controller operation".into());}
    state.link.gateway_control(motor,op,&data).map_err(|e|e.to_string())
}

#[tauri::command(async)]
fn focus_motor(state: State<'_, AppState>, motor: u8) -> Result<(), String> {
    state.link.focus_motor(motor).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn probe_tmc(state: State<'_, AppState>, motors: Vec<u8>, attempts: u32) -> Result<Vec<link::TmcProbe>, String> {
    state.link.probe_tmc(&motors, attempts).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn disconnect(state: State<'_, AppState>) -> LinkStats {
    if state.link.is_connected() {
        state.link.emergency_stop();
    }
    state.link.close();
    state.link.stats()
}

#[tauri::command(async)]
fn link_stats(state: State<'_, AppState>) -> LinkStats {
    state.link.stats()
}

#[tauri::command(async)]
fn read_reg(state: State<'_, AppState>, addr: u16) -> Result<u32, String> {
    state.link.read_reg_retry(addr, 3).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_reg(state: State<'_, AppState>, addr: u16, value: u32, verify: bool) -> Result<bool, String> {
    if verify {
        state
            .link
            .write_verified(addr, value, 0xFFFF_FFFF)
            .map_err(|e| e.to_string())
    } else {
        state
            .link
            .write_reg(addr, value)
            .map_err(|e| e.to_string())
            .map(|_| true)
    }
}

#[derive(Serialize)]
struct SnapItem {
    addr: u16,
    value: Option<u32>,
    error: Option<String>,
}

#[tauri::command(async)]
fn read_many(state: State<'_, AppState>, addrs: Vec<u16>) -> Vec<SnapItem> {
    let mut failed = false;
    addrs
        .into_iter()
        .take(64)
        .map(|addr| {
            if failed {return SnapItem {addr,value:None,error:Some("已停止本轮读取：电机无响应".into())};}
            match state.link.read_reg_retry(addr, 2) {
            Ok(v) => SnapItem {
                addr,
                value: Some(v),
                error: None,
            },
            Err(e) => {failed=true; SnapItem {
                addr,
                value: None,
                error: Some(e.to_string()),
            }},
        }})
        .collect()
}

#[tauri::command(async)]
fn start_rtmi(
    state: State<'_, AppState>,
    channels: Vec<(u8, u16)>,
    sampling: u8,
    crc: bool,
) -> Result<(), String> {
    state
        .link
        .start_rtmi(&channels, sampling, crc)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn stop_rtmi(state: State<'_, AppState>) -> Result<(), String> {
    state.link.stop_rtmi().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn emergency_stop(state: State<'_, AppState>) {
    let _ = state.cancel.store(true, Ordering::SeqCst);
    state.link.emergency_stop();
}

#[tauri::command(async)]
fn set_velocity(
    state: State<'_, AppState>,
    target_rpm: f64,
    poles: u32,
    counts_per_rpm: f64,
) -> Result<(), String> {
    procs::start_velocity(&state.link, target_rpm, poles, counts_per_rpm).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn stop_motion(state: State<'_, AppState>, poles: u32) -> Result<(), String> {
    procs::stop_motion(&state.link, poles).map_err(|e| e.to_string())
}

// --------------------------------------------------------------- axis guard

#[tauri::command]
fn axis_state(state: State<'_, AppState>) -> axis::AxisState {
    state.link.axis().state()
}

#[tauri::command]
fn axis_set_limits(
    state: State<'_, AppState>,
    limits: axis::Limits,
) -> Result<axis::AxisState, String> {
    if limits.enabled && !state.link.guard_feedback_live(&limits) {
        return Err(format!(
            "软限位要读到位置才能生效：请先把 CH{} 设为「实际位置 0x155」并启动数据流",
            limits.ch
        ));
    }
    state.link.axis().set_limits(limits)?;
    let st = state.link.axis().state();
    state.link.log(
        "info",
        "axis",
        format!(
            "软限位 {} [{}, {}] action={}",
            if st.limits.enabled { "开启" } else { "关闭" },
            st.limits.min,
            st.limits.max,
            st.limits.action
        ),
    );
    Ok(st)
}

#[tauri::command(async)]
fn axis_jog(
    state: State<'_, AppState>,
    rpm: f64,
    poles: u32,
    counts_per_rpm: f64,
) -> Result<axis::AxisState, String> {
    if rpm == 0.0 {
        return Ok(state.link.axis().state());
    }
    let lim = state.link.axis().limits();
    if lim.enabled && !state.link.guard_feedback_live(&lim) {
        return Err("软限位已开启但位置反馈中断，已拒绝运动".into());
    }
    state.link.axis().start_jog()?;
    if let Err(e) = procs::start_velocity(&state.link, rpm, poles, counts_per_rpm) {
        state.link.axis().hold();
        return Err(e.to_string());
    }
    Ok(state.link.axis().state())
}

#[tauri::command(async)]
fn axis_move(state: State<'_, AppState>, cfg: axis::MoveCfg) -> Result<axis::AxisState, String> {
    let poles = cfg.poles;
    let counts_per_rpm = cfg.cpr / 60.0;
    let lim = state.link.axis().limits();
    if lim.enabled && !state.link.guard_feedback_live(&lim) {
        return Err("软限位已开启但位置反馈中断，已拒绝定位".into());
    }
    state.link.axis().start_move(cfg)?;
    // enter velocity mode once; the RTMI thread then streams the setpoint
    if let Err(e) = procs::start_velocity(&state.link, 0.0, poles, counts_per_rpm) {
        state.link.axis().hold();
        return Err(e.to_string());
    }
    Ok(state.link.axis().state())
}

#[tauri::command(async)]
fn axis_hold(state: State<'_, AppState>, poles: u32) -> Result<axis::AxisState, String> {
    state.link.axis().hold();
    procs::stop_motion(&state.link, poles).map_err(|e| e.to_string())?;
    Ok(state.link.axis().state())
}

#[tauri::command]
fn axis_clear(state: State<'_, AppState>) -> axis::AxisState {
    state.link.axis().clear_trip();
    state.link.log("info", "axis", "软限位已复位");
    state.link.axis().state()
}

#[tauri::command]
fn get_logs(state: State<'_, AppState>) -> Vec<LogLine> {
    state.link.log_snapshot()
}

#[tauri::command]
fn clear_logs(state: State<'_, AppState>) {
    state.link.clear_log();
}

#[tauri::command]
fn reports_path() -> String {
    let p = reports_dir();
    let _ = std::fs::create_dir_all(&p);
    p.display().to_string()
}

#[tauri::command]
fn open_reports_dir() -> Result<(), String> {
    let p = reports_dir();
    let _ = std::fs::create_dir_all(&p);
    std::process::Command::new("explorer")
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn suggest_pi(r_ohm: f64, l_uh: f64, bandwidth_hz: f64, f_pwm: f64) -> (u16, u16, f64, f64) {
    procs::suggest_pi(r_ohm, l_uh, bandwidth_hz, f_pwm)
}

#[tauri::command]
fn read_pid(state: State<'_, AppState>) -> Result<procs::PidSnapshot, String> {
    procs::read_pid(&state.link).map_err(|e| e.to_string())
}

#[tauri::command]
fn job_busy(state: State<'_, AppState>) -> bool {
    state.busy.load(Ordering::SeqCst)
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
    state.link.log("warn", "job", "已请求取消当前任务");
}

/// Run one of the blocking procedures on a worker thread.
#[tauri::command]
fn run_job(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("已有任务在运行".into());
    }
    state.cancel.store(false, Ordering::SeqCst);

    let link = Arc::clone(&state.link);
    let cancel = Arc::clone(&state.cancel);
    let busy = Arc::clone(&state.busy);
    let job = format!("{kind}:{}", link::now_ms() as i64);

    thread::Builder::new()
        .name(format!("tsl-job-{kind}"))
        .spawn(move || {
            let mut ctx = Ctx::new(Arc::clone(&link), &app, &job, &cancel);
            let result: Result<serde_json::Value, String> = (|| match kind.as_str() {
                "encoder" => serde_json::from_value::<procs::EncoderCfg>(payload)
                    .map_err(|e| e.to_string())
                    .and_then(|cfg| {
                        procs::setup_encoder(&mut ctx, &cfg)
                            .map(|m| serde_json::json!({ "message": m }))
                            .map_err(|e| e.to_string())
                    }),
                "pid" => serde_json::from_value::<procs::PidCfg>(payload)
                    .map_err(|e| e.to_string())
                    .and_then(|cfg| {
                        procs::apply_pid(&mut ctx, &cfg).map_err(|e| e.to_string())
                    }),
                "calibrate" => {
                    let cfg: procs::CalibCfg = serde_json::from_value(
                        payload.get("cfg").cloned().unwrap_or_default(),
                    )
                    .map_err(|e| e.to_string())?;
                    let frame_bits = payload
                        .get("frameBits")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(14) as u32;
                    procs::calibrate_phi_e(&mut ctx, &cfg, frame_bits)
                        .map(|r| serde_json::to_value(r).unwrap_or_default())
                        .map_err(|e| e.to_string())
                }
                "step" => {
                    let cfg: procs::StepCfg = serde_json::from_value(
                        payload.get("cfg").cloned().unwrap_or_default(),
                    )
                    .map_err(|e| e.to_string())?;
                    let frame_bits = payload
                        .get("frameBits")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(14) as u32;
                    procs::step_response(&mut ctx, &cfg, frame_bits)
                        .map(|r| serde_json::to_value(r).unwrap_or_default())
                        .map_err(|e| e.to_string())
                }
                "sequence" => {
                    let cfg: procs::SeqCfg = serde_json::from_value(payload)
                        .map_err(|e| e.to_string())?;
                    let dir = reports_dir();
                    procs::run_sequence(&mut ctx, &cfg, 14, &dir)
                        .map(|r| serde_json::to_value(r).unwrap_or_default())
                        .map_err(|e| e.to_string())
                }
                other => Err(format!("未知任务类型 {other}")),
            })();

            let done = match result {
                Ok(data) => JobDone {
                    job: job.clone(),
                    ok: true,
                    message: "完成".into(),
                    data,
                },
                Err(e) => JobDone {
                    job: job.clone(),
                    ok: false,
                    message: e.clone(),
                    data: serde_json::Value::Null,
                },
            };
            if !done.ok {
                link.log("error", "job", format!("{kind} 失败: {}", done.message));
            } else {
                link.log("info", "job", format!("{kind} 完成"));
            }
            let _ = app.emit("tsl:job:done", done);
            busy.store(false, Ordering::SeqCst);
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ------------------------------------------------------------------- setup

/// Keep the default window inside the current monitor. Tauri sizes windows in
/// logical pixels, so on a 125% display 1440x900 would be 1800x1125 physical and
/// overflow a 1080p screen. Work in physical pixels and clamp to the monitor.
fn fit_window(win: &tauri::WebviewWindow) -> String {
    let cur = win.inner_size().unwrap_or_default();
    let (mut w, mut h) = (cur.width, cur.height);
    let mut mon_desc = "unknown".to_string();
    if let Ok(Some(mon)) = win.current_monitor() {
        let s = mon.size();
        let cap_w = (s.width as f64 * 0.94) as u32;
        let cap_h = (s.height as f64 * 0.90) as u32;
        w = w.min(cap_w);
        h = h.min(cap_h);
        mon_desc = format!(
            "{}x{} @{:.2}x",
            s.width,
            s.height,
            mon.scale_factor()
        );
    }
    let _ = win.set_size(tauri::PhysicalSize::new(w.max(1120), h.max(700)));
    let _ = win.center();
    format!("window={w}x{h} monitor={mon_desc}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let link = Arc::new(Link::new());
    let state = AppState {
        link: Arc::clone(&link),
        cancel: Arc::new(AtomicBool::new(false)),
        busy: Arc::new(AtomicBool::new(false)),
    };

    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            link.attach(app.handle().clone());
            // Lease renewal is independent of UI statistics and never queues
            // behind an in-flight serial transaction.
            let weak = Arc::downgrade(&link);
            thread::spawn(move || loop {
                thread::sleep(std::time::Duration::from_millis(1000));
                let Some(link) = weak.upgrade() else { break };
                link.keepalive();
            });
            let _ = std::fs::create_dir_all(reports_dir());
            if let Some(win) = app.get_webview_window("main") {
                let d = fit_window(&win);
                link.log("info", "app", d);
            }
            link.log("info", "app", "TSL Viewer 已启动");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            main_control,
            focus_motor,
            probe_tmc,
            list_ports,
            connect,
            disconnect,
            link_stats,
            read_reg,
            write_reg,
            read_many,
            start_rtmi,
            stop_rtmi,
            emergency_stop,
            set_velocity,
            stop_motion,
            axis_state,
            axis_set_limits,
            axis_jog,
            axis_move,
            axis_hold,
            axis_clear,
            get_logs,
            clear_logs,
            reports_path,
            open_reports_dir,
            suggest_pi,
            read_pid,
            job_busy,
            cancel_job,
            run_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running TSL Viewer");
}

