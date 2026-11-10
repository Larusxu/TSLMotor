//! LOS tool orchestration; never builds command strings or owns motion logic.
use crate::AppState;
use serde::Serialize;
use std::{io::{BufRead, BufReader}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc, atomic::Ordering}, thread};
use parking_lot::Mutex;
use tauri::State;

#[derive(Clone, Default, Serialize)]
pub struct Progress { pub running: bool, pub phase: String, pub action: String, pub result: Option<bool>, pub lines: Vec<String> }
#[derive(Clone, Default)]
pub struct Workbench(pub Arc<Mutex<Progress>>);
impl Workbench {
    fn line(&self, line: String) { let mut s=self.0.lock(); if s.lines.len()>=600 {s.lines.remove(0);} s.lines.push(line); }
    fn phase(&self, phase: &str) {self.0.lock().phase=phase.into();}
}
fn run(job: &Workbench, root: &Path, args: &[&str]) -> Result<(),String> {
    let mut cmd=Command::new("python");
    cmd.current_dir(root).env("PYTHONIOENCODING","utf-8").env("PYTHONUNBUFFERED","1")
        .args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
    let mut child=cmd.spawn().map_err(|e|format!("Cannot start Python: {e}"))?;
    let stdout=child.stdout.take().ok_or("Missing stdout")?;
    let stderr=child.stderr.take().ok_or("Missing stderr")?;
    let a=job.clone();let b=job.clone();
    let out=thread::spawn(move||{for line in BufReader::new(stdout).lines(){if let Ok(line)=line{a.line(line);}}});
    let err=thread::spawn(move||{for line in BufReader::new(stderr).lines(){if let Ok(line)=line{b.line(line);}}});
    let status=child.wait().map_err(|e|e.to_string())?;let _=out.join();let _=err.join();
    if status.success(){Ok(())}else{Err(format!("LOS tool exited with {status}"))}
}
#[tauri::command]
pub fn firmware_status(job: State<'_,Workbench>)->Progress {job.0.lock().clone()}
#[tauri::command]
pub fn firmware_start(state: State<'_,AppState>,job: State<'_,Workbench>,root:String,action:String,port:String)->Result<(),String>{
    if !["build","build_dfu"].contains(&action.as_str()){return Err("Unsupported firmware action".into());}
    let root=PathBuf::from(root).canonicalize().map_err(|e|e.to_string())?;
    if !root.join("tools/build.py").is_file()||!root.join("application/TeslaHand/access.yaml").is_file(){return Err("Select the TeslaHand LOS repository".into());}
    // The desktop must release the port through its existing disconnect flow.
    if action=="build_dfu"&&(state.link.is_connected()||port.trim().is_empty()){return Err("Disconnect the controller before DFU and select its port".into());}
    if state.control.active.load(Ordering::SeqCst){return Err("Stop the current task first".into());}
    if job.0.lock().running||state.busy.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err("A task is already running".into());}
    *job.0.lock()=Progress{running:true,phase:"build".into(),action:action.clone(),result:None,lines:vec![]};
    let job=job.inner().clone();let busy=state.busy.clone();
    thread::spawn(move||{
        // Every flash builds first. A failed build never reaches an old image.
        let result=(||{
            // Validate the active target before building; never flash a stale
            // TeslaHand image after building a different selected business.
            run(&job,&root,&["-c","from pathlib import Path; import yaml; c=yaml.safe_load(Path('los_config.yaml').read_text(encoding='utf-8-sig')); assert c.get('platform',{}).get('target_mcu')=='hpm6e8y' and c.get('application',{}).get('active')=='TeslaHand', 'Select hpm6e8y / TeslaHand in los_config.yaml first'"])?;
            run(&job,&root,&["tools/build.py"])?;
            if action=="build_dfu"{
                let image=root.join("build/platform/hpm6e8y/dfu/app.bin");
                if !image.is_file(){return Err("Build did not produce app.bin".into());}
                job.phase("dfu");
                // Entry baud, DFU baud, gap, device ID come from access.yaml.
                run(&job,&root,&["tools/los_program.py","dfu","--mcu","hpm6e8y","--business","TeslaHand","--port",&port])?;
            }
            Ok::<(),String>(())
        })();
        if let Err(ref error)=result{job.line(error.clone());}
        let mut s=job.0.lock();s.running=false;s.result=Some(result.is_ok());s.phase=if result.is_ok(){"complete"}else{"failed"}.into();
        busy.store(false,Ordering::SeqCst);
    });
    Ok(())
}
