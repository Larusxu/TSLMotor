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
fn execute_update(job:&Workbench,root:&Path,action:&str,port:&str,image:Option<&[u8]>)->Result<(),String>{

            // Validate the active target before building; never flash a stale
            // TeslaHand image after building a different selected business.
            run(job,root,&["-c","from pathlib import Path; import yaml; c=yaml.safe_load(Path('los_config.yaml').read_text(encoding='utf-8-sig')); assert c.get('platform',{}).get('target_mcu')=='hpm6e8y' and c.get('application',{}).get('active')=='TeslaHand', 'Select hpm6e8y / TeslaHand in los_config.yaml first'"])?;
            if action!="dfu"{run(job,root,&["tools/build.py"])?;}
            if action=="dfu"{
                let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
                let image_path=std::env::temp_dir().join(format!("tslviewer-dfu-{}-{stamp}.bin",std::process::id()));
                std::fs::write(&image_path,image.ok_or("Missing firmware image")?).map_err(|e|e.to_string())?;
                let result=run(job,root,&["tools/los_program.py","dfu","--mcu","hpm6e8y","--business","TeslaHand","--port",port,"--image",image_path.to_str().ok_or("Invalid image path")?]);
                let _=std::fs::remove_file(&image_path);
                result?;
            }
            if action=="build_dfu"{
                let image=root.join("build/platform/hpm6e8y/dfu/app.bin");
                if !image.is_file(){return Err("Build did not produce app.bin".into());}
                job.phase("dfu");
                // Entry baud, DFU baud, gap, device ID come from access.yaml.
                run(job,root,&["tools/los_program.py","dfu","--mcu","hpm6e8y","--business","TeslaHand","--port",port])?;
            }
            Ok::<(),String>(())

}
#[tauri::command]
pub fn firmware_status(job: State<'_,Workbench>)->Progress {job.0.lock().clone()}
#[tauri::command]
pub fn firmware_start(state: State<'_,AppState>,job: State<'_,Workbench>,root:String,action:String,port:String,image:Option<Vec<u8>>)->Result<(),String>{
    if !["build","build_dfu","dfu"].contains(&action.as_str()){return Err("Unsupported firmware action".into());}
    if action=="dfu" && !image.as_ref().is_some_and(|v|!v.is_empty()&&v.len()<=8*1024*1024){return Err("Select an app.bin image (up to 8 MB)".into());}
    let root=PathBuf::from(root).canonicalize().map_err(|e|e.to_string())?;
    if !root.join("tools/build.py").is_file()||!root.join("application/TeslaHand/access.yaml").is_file(){return Err("Select the TeslaHand LOS repository".into());}
    // The desktop must release the port through its existing disconnect flow.
    if action!="build"&&(state.link.is_connected()||port.trim().is_empty()){return Err("Disconnect the controller before DFU and select its port".into());}
    if state.control.active.load(Ordering::SeqCst){return Err("Stop the current task first".into());}
    if job.0.lock().running||state.busy.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err("A task is already running".into());}
    *job.0.lock()=Progress{running:true,phase:if action=="dfu"{"dfu"}else{"build"}.into(),action:action.clone(),result:None,lines:vec![]};
    let job=job.inner().clone();let busy=state.busy.clone();
    thread::spawn(move||{
        // Source upgrades build first; uploaded images use the same LOS DFU
        // validation/entry/transport and never invoke a separate sender.
        let result=execute_update(&job,&root,&action,&port,image.as_deref());
        if let Err(ref error)=result{job.line(error.clone());}
        let mut s=job.0.lock();s.running=false;s.result=Some(result.is_ok());s.phase=if result.is_ok(){"complete"}else{"failed"}.into();
        busy.store(false,Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project()->PathBuf{
        let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root=std::env::temp_dir().join(format!("tslviewer-firmware-test-{stamp}"));
        std::fs::create_dir_all(root.join("tools")).unwrap();
        std::fs::write(root.join("los_config.yaml"),"platform:\n  target_mcu: hpm6e8y\napplication:\n  active: TeslaHand\n").unwrap();
        root
    }
    #[test]
    fn failed_build_never_flashes_stale_image(){
        let root=project();
        std::fs::write(root.join("tools/build.py"),"raise SystemExit(7)\n").unwrap();
        std::fs::write(root.join("tools/los_program.py"),"raise Exception('must not flash')\n").unwrap();
        let job=Workbench::default();
        assert!(execute_update(&job,&root,"build_dfu","TEST",None).is_err());
        assert!(job.0.lock().lines.iter().all(|s|!s.contains("must not flash")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uploaded_bin_uses_common_dfu_and_removes_temporary_image(){
        let root=project();
        std::fs::write(root.join("tools/los_program.py"),"import sys\nfrom pathlib import Path\nassert sys.argv[1]=='dfu'\np=Path(sys.argv[sys.argv.index('--image')+1])\nassert p.read_bytes()==b'firmware-test'\nPath('called.txt').write_text(str(p),encoding='utf-8')\n").unwrap();
        let job=Workbench::default();
        execute_update(&job,&root,"dfu","TEST",Some(b"firmware-test")).unwrap();
        let path=std::fs::read_to_string(root.join("called.txt")).unwrap();
        assert!(!Path::new(&path).exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore="Explicit real controller DFU; requires TSL_FIRMWARE_HIL_ROOT/PORT"]
    fn hardware_dfu_uploaded_image(){
        let root=PathBuf::from(std::env::var("TSL_FIRMWARE_HIL_ROOT").unwrap());
        let port=std::env::var("TSL_FIRMWARE_HIL_PORT").unwrap();
        let image=std::fs::read(root.join("build/platform/hpm6e8y/dfu/app.bin")).unwrap();
        let job=Workbench::default();
        let result=execute_update(&job,&root,"dfu",&port,Some(&image));
        for line in &job.0.lock().lines{println!("{line}");}
        result.unwrap();
    }
}
