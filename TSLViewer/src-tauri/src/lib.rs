//! TSL Viewer backend.
//!
//! The Rust side owns the serial port; the webview only sends intents and
//! renders the events it gets back. That keeps the timing critical paths
//! (datagram framing, RTMI parsing) away from the JS event loop.

mod gateway;
mod axis;
mod homing;
mod motor_control;
mod motor_parameters;
mod motor_profile;
mod semantic_control;
mod rebuild_hil;
mod split_storage;
mod io_rom;
mod commission;
mod link;
mod procs;
mod proto;
mod regs;
mod simport;
mod storage;

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
    pub control: Arc<motor_control::Control>,
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
    if state.busy.load(Ordering::SeqCst) {return Err("请先结束当前控制/标定任务".into());}
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
    if state.busy.load(Ordering::SeqCst) && ![4,6,10,13,14,16].contains(&op) {return Err("参数应用/运动期间拒绝并发写操作".into());}
    if state.control.active.load(Ordering::SeqCst) && ![4,6,10,13,14,16].contains(&op) {
        return Err("位置控制期间禁止其它写操作，请先断使能".into());
    }
    if ![4,5,6,10,11,12,13,14,15,16].contains(&op) || motor>16 {return Err("Invalid controller operation".into());}
    state.link.gateway_control(motor,op,&data).map_err(|e|e.to_string())
}

#[tauri::command(async)]
fn motor_storage(state: State<'_, AppState>, motor:u8, request:split_storage::Request)->Result<split_storage::Response,String> {
    if state.busy.load(Ordering::SeqCst)||state.control.active.load(Ordering::SeqCst) {
        return Err("Stop the current task before storage operations".into());
    }
    let payload=split_storage::encode(motor,&request)?;
    let reply=state.link.gateway_control(motor,33,&payload).map_err(|e|e.to_string())?;
    split_storage::decode(motor,&request,&reply)
}

#[tauri::command(async)]
fn motor_semantic(state: State<'_, AppState>, motor:u8, request:semantic_control::Request)->Result<semantic_control::Response,String> {
    let payload=semantic_control::encode(motor,&request)?;
    // One existing transport transaction; never retry a potentially moving
    // command or fall back to native register writes on timeout/rejection.
    let reply=state.link.gateway_control(motor,semantic_control::GATEWAY_OP,&payload).map_err(|e|e.to_string())?;
    semantic_control::decode(motor,&request,&reply)
}

#[tauri::command(async)]
fn focus_motor(state: State<'_, AppState>, motor: u8) -> Result<(), String> {
    if state.busy.load(Ordering::SeqCst) {return Err("请先停止当前控制/标定任务再切换电机".into());}
    state.link.focus_motor(motor).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn probe_tmc(state: State<'_, AppState>, motors: Vec<u8>, attempts: u32) -> Result<Vec<link::TmcProbe>, String> {
    if state.busy.load(Ordering::SeqCst) {return Err("任务运行中，禁止切换UART探测".into());}
    state.link.probe_tmc(&motors, attempts).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn disconnect(state: State<'_, AppState>) -> LinkStats {
    state.control.stop();
    state.cancel.store(true, Ordering::SeqCst);
    if state.link.is_connected() && !state.link.is_gateway() {
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
    if state.control.active.load(Ordering::SeqCst) {return Err("位置控制期间请读取专用反馈".into());}
    state.link.read_reg_retry(addr, 3).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_reg(state: State<'_, AppState>, addr: u16, value: u32, verify: bool) -> Result<bool, String> {
    if state.busy.load(Ordering::SeqCst) {return Err("参数应用/运动期间禁止透传写寄存器".into());}
    if [0x140,0x142,0x143,0x145,0x146,0x149,0x14a,0x14b,0x15d,0x15e,0x15f,0x160].contains(&addr) {
        motor_parameters::ensure_stopped(state.link.as_ref())?;
        motor_parameters::mark_inconsistent(&state.link,"高级寄存器已修改；需重新应用PID档案");
    }
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
struct SnapItem {    addr: u16,
    value: Option<u32>,
    error: Option<String>,
}

#[tauri::command(async)]
fn read_many(state: State<'_, AppState>, addrs: Vec<u16>) -> Vec<SnapItem> {
    if state.control.active.load(Ordering::SeqCst) {return addrs.into_iter().take(64).map(|addr|SnapItem{addr,value:None,error:Some("Use position-control telemetry while active".into())}).collect();}
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
    if state.control.active.load(Ordering::SeqCst) {return Err("请先停止位置控制再启动RTMI".into());}
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
    state.control.stop();
    let _ = state.cancel.store(true, Ordering::SeqCst);
    state.link.emergency_stop();
}

#[tauri::command(async)]
fn motor_control_start(state: State<'_, AppState>, cfg: motor_control::Config) -> Result<(),String> {
    state.control.start(Arc::clone(&state.link),Arc::clone(&state.busy),cfg)
}
#[tauri::command]
fn motor_control_command(state: State<'_, AppState>, command: motor_control::Command) -> Result<(),String> {
    state.control.command(command)
}
#[tauri::command]
fn motor_control_pulse(state: State<'_, AppState>) {state.control.pulse();}
#[tauri::command]
fn motor_control_stop(state: State<'_, AppState>) {state.control.stop();}
#[tauri::command]
fn motor_control_state(state: State<'_, AppState>) -> motor_control::Snapshot {state.control.state()}
#[tauri::command]
fn motor_parameter_state(state: State<'_, AppState>, motor:u8) -> Result<motor_parameters::ParameterState,String> {
    if !(1..=16).contains(&motor){return Err("电机号无效".into());}
    Ok(state.link.parameters.lock().motors[(motor-1)as usize].clone())
}
#[tauri::command(async)]
fn motor_safety_clear(state: State<'_, AppState>, motor:u8) -> Result<(),String> {
    if !(1..=16).contains(&motor){return Err("电机号无效".into());}
    if state.busy.swap(true,Ordering::SeqCst){return Err("请先结束任务".into());}
    let result=state.control.recover(&state.link,motor);state.busy.store(false,Ordering::SeqCst);result
}
#[tauri::command(async)]
fn motor_control_read(state: State<'_, AppState>, motor: u8) -> Result<motor_control::Snapshot,String> {
    if state.busy.swap(true,Ordering::SeqCst) {return Err("任务期间暂停空闲遥测".into());}
    let result=if !(1..=16).contains(&motor) {Err("电机号无效".into())}else{motor_control::snapshot(&state.link,motor).map(|mut s|{s.safety_phase=state.control.phase(motor);s})};
    state.busy.store(false,Ordering::SeqCst);result
}
#[tauri::command(async)]
fn motor_control_limits(state: State<'_, AppState>, cfg: motor_control::Config) -> Result<(),String> {
    cfg.validate()?;
    if state.busy.swap(true,Ordering::SeqCst) {return Err("请先断使能再更改限幅/行程".into());}
    let result=(|| {
        state.link.stop_rtmi()?;state.link.focus_motor(cfg.motor)?;
        motor_control::apply_limits(&state.link,&cfg)
    })();
    state.busy.store(false,Ordering::SeqCst);result
}

#[tauri::command(async)]
fn set_velocity(
    state: State<'_, AppState>,
    target_rpm: f64,
    poles: u32,
    counts_per_rpm: f64,
) -> Result<(), String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    procs::start_velocity(&state.link, target_rpm, poles, counts_per_rpm).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn stop_motion(state: State<'_, AppState>, poles: u32) -> Result<(), String> {
    if state.control.active.load(Ordering::SeqCst) {state.control.stop();return Ok(());}
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
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
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
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
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
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
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
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
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

#[tauri::command(async)]
fn read_pid(state: State<'_, AppState>) -> Result<procs::PidSnapshot, String> {
    if state.busy.swap(true,Ordering::SeqCst) {return Err("先停止当前任务，再读取PID档案".into());}
    let result=(||{state.link.stop_rtmi()?;procs::read_pid(&state.link).map_err(|e| e.to_string())})();
    state.busy.store(false,Ordering::SeqCst);result
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

// ------------------------------------------------------------- 机械找零
//
// 上位机只下发参数、只读状态；状态机与判据在主控固件里（TODO-01）。

#[tauri::command(async)]
fn homing_start(
    state: State<'_, AppState>,
    params: homing::HomingParams,
    motor: u8,
) -> Result<(), String> {
    if state.busy.load(Ordering::SeqCst) {return Err("请先结束当前控制/标定任务".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    if params.dual_limit && !motor_control::home(&state.link,motor)?.dual_supported {
        return Err("主控固件不支持双端找零，请先升级配套固件".into());
    }
    let bytes = homing::encode_start(&params)?;
    state.link.stop_rtmi().map_err(|e| e.to_string())?;
    let m = motor;
    let reply = state
        .link
        .gateway_control(m, homing::OP_HOMING_START, &bytes)
        .map_err(|e| e.to_string())?;
    if reply.is_empty() {
        return Err("主控固件尚未实现找零（见 doc/TODO/TODO-01-机械找零.md）".into());
    }
    if reply[0] == 0 {
        let raw = state.link.gateway_control(m, homing::OP_HOMING_STATE, &[])
            .map_err(|e| e.to_string())?;
        let detail = homing::decode_state(&raw)
            .map(|s| format!("{}（状态 {}，错误码 {}）", s.message, s.stage, s.error))
            .unwrap_or_else(|| "状态应答不完整".into());
        return Err(format!("M{m} 主控拒绝开始找零：{detail}；请确认该路已使能且编码器配置、对齐偏移已写回"));
    }
    Ok(())
}

#[tauri::command(async)]
fn homing_state(state: State<'_, AppState>, motor: u8) -> Result<homing::HomingState, String> {
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    let reply = state
        .link
        .gateway_control(motor, homing::OP_HOMING_STATE, &[])
        .map_err(|e| e.to_string())?;
    homing::decode_state(&reply)
        .ok_or_else(|| "主控固件尚未实现找零状态查询（见 doc/TODO/TODO-01-机械找零.md）".into())
}

#[tauri::command(async)]
fn homing_cancel(state: State<'_, AppState>, motor: u8) -> Result<(), String> {
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    state
        .link
        .gateway_control(motor, homing::OP_HOMING_CANCEL, &[])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 把找零工艺参数写进主控（op 15）。参数存在主控内存里，掉电不保存；
/// 主控只在空闲态接受，进行中会回 0。
#[tauri::command(async)]
fn homing_write_config(
    state: State<'_, AppState>,
    cfg: homing::HomingConfig,
    motor: u8,
) -> Result<(), String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    let bytes = cfg.encode()?;
    let reply = state
        .link
        .gateway_control(motor, homing::OP_PARAMS_WRITE, &bytes)
        .map_err(|e| e.to_string())?;
    match reply.first() {
        Some(1) => Ok(()),
        Some(0) => Err("主控拒绝写入找零参数：参数越界或找零进行中".into()),
        _ => Err(format!("主控 op15 应答不符：{reply:02x?}")),
    }
}

/// 回读主控当前生效的找零参数（op 16），用于「写入后校验」和「从主控读取」。
#[tauri::command(async)]
fn homing_read_config(
    state: State<'_, AppState>,
    motor: u8,
) -> Result<homing::HomingConfig, String> {
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    let reply = state
        .link
        .gateway_control(motor, homing::OP_PARAMS_READ, &[])
        .map_err(|e| e.to_string())?;
    homing::HomingConfig::decode(&reply)
        .ok_or_else(|| "主控未返回 16 字节找零参数（固件可能未实现 op 16）".into())
}

// ------------------------------------------------------------ EEPROM storage

#[tauri::command(async)]
fn eeprom_probe(state: State<'_, AppState>) -> Result<storage::Probe, String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    storage::probe(&state.link).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn eeprom_dump(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    storage::dump(&state.link).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn eeprom_save(
    state: State<'_, AppState>,
    params: storage::StoreParams,
) -> Result<storage::SaveInfo, String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    storage::save(&state.link, &params).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn eeprom_load(state: State<'_, AppState>) -> Result<storage::LoadInfo, String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    storage::load(&state.link).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn eeprom_erase(state: State<'_, AppState>) -> Result<usize, String> {
    if state.control.active.load(Ordering::SeqCst) {return Err("Stop position control before this operation".into());}
    if !state.link.is_connected() {
        return Err("串口未连接".into());
    }
    storage::erase(&state.link).map_err(|e| e.to_string())
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
                "commission" => serde_json::from_value::<commission::Config>(payload)
                    .map_err(|e|e.to_string()).and_then(|c|commission::run(&mut ctx,c)),
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
        control: Arc::new(motor_control::Control::default()),
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
            motor_semantic,
            motor_storage,
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
            homing_start,
            motor_control_start,
            motor_control_command,
            motor_control_pulse,
            motor_control_stop,
            motor_control_state,
            motor_control_read,
            motor_control_limits,
            motor_parameter_state,
            motor_safety_clear,
            homing_state,
            homing_cancel,
            homing_write_config,
            homing_read_config,
            get_logs,
            clear_logs,
            reports_path,
            open_reports_dir,
            suggest_pi,
            read_pid,
            job_busy,
            cancel_job,
            run_job,
            eeprom_probe,
            eeprom_dump,
            eeprom_save,
            eeprom_load,
            eeprom_erase
        ])
        .run(tauri::generate_context!())
        .expect("error while running TSL Viewer");
}

