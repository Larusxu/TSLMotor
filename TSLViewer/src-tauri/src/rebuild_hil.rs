//! Explicitly opted-in real hardware acceptance. Uses the viewer's actual
//! Transport + semantic/storage encoders. Never runs in `cargo test --lib`.
#[cfg(test)]
mod tests {
    use crate::{gateway::Transport,semantic_control::{self as sc,Command,Request,Response},split_storage as ss};
    use std::{time::{Duration,Instant},thread};
    struct Hil { t:Transport,q:Request,log:Vec<serde_json::Value>,path:String }
    impl Hil {
        fn call(&mut self,m:u8,c:Command)->Result<Response,String>{
            self.q.request_id+=1;self.q.command=c;
            let raw=self.t.call(m,32,&sc::encode(m,&self.q)?).map_err(|e|e.to_string())?;
            let r=sc::decode(m,&self.q,&raw)?;
            self.log.push(serde_json::json!({"motor":m,"request_id":self.q.request_id,"command":format!("{:?}",self.q.command),"response":r}));
            if !matches!(self.q.command,Command::RtmiState{..}) {std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;}
            if r.result!=0{return Err(format!("M{m} {}",r.result_name));}
            // Device Pulse has task_id=0; only this motor's acknowledged
            // snapshot may advance the task used by JogRenew.
            if m==9&&r.motor.is_some(){self.q.task_id=r.task_id;}
            Ok(r)
        }
        fn wait(&mut self,seconds:u64,mut accept:impl FnMut(&sc::MotorSnapshot)->bool)->Result<sc::MotorSnapshot,String>{
            self.wait_with_permit(seconds,true,&mut accept)
        }
        fn wait_idle(&mut self,seconds:u64,mut accept:impl FnMut(&sc::MotorSnapshot)->bool)->Result<sc::MotorSnapshot,String>{
            self.wait_with_permit(seconds,false,&mut accept)
        }
        fn wait_configuration(&mut self)->Result<sc::MotorSnapshot,String>{
            let end=Instant::now()+Duration::from_secs(30);
            loop {
                thread::sleep(Duration::from_millis(100));self.call(0,Command::Pulse)?;
                let r=self.call(9,Command::GetState)?;let s=r.motor.ok_or("No configuration state")?;
                if s.fault!=0||s.last_error!=0{return Err(format!("Configuration fault={} error={}",s.fault,s.last_error));}
                if !r.pending&&s.pending_action==0&&s.drive==0&&s.config_verified&&s.limits_valid{return Ok(s);}
                if Instant::now()>=end{return Err("Configuration completion timeout".into());}
            }
        }
        fn wait_with_permit(&mut self,seconds:u64,permit:bool,mut accept:impl FnMut(&sc::MotorSnapshot)->bool)->Result<sc::MotorSnapshot,String>{
            let end=Instant::now()+Duration::from_secs(seconds);
            loop {
                thread::sleep(Duration::from_millis(100));self.call(0,Command::Pulse)?;
                if permit{self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;}
                let r=self.call(9,Command::PositionState)?;let s=r.motor.ok_or("No motor snapshot")?;
                if s.fault!=0||(s.last_error!=0&&s.last_error!=15){return Err(format!("fault={} error={}",s.fault,s.last_error));}
                if accept(&s){return Ok(s);}if Instant::now()>=end{return Err("HIL wait deadline".into());}
            }
        }
        fn jogging(&mut self)->Result<(),String>{
            let s=self.call(9,Command::PositionState)?.motor.ok_or("No jog preflight")?;
            let position=s.logical_position.as_ref().ok_or("No logical position")?.parse::<i64>().map_err(|_|"Bad position")?;
            let span=s.logical_span.as_ref().ok_or("No current-boot span; rehome first")?.parse::<i64>().map_err(|_|"Bad span")?;
            if !s.coordinate_valid||!s.config_verified||!s.align_valid||!s.logic_power||!s.feedback_fresh||
               s.fault!=0||s.last_error!=0||s.drive!=0||s.motion_active||position<span/4||position>span*3/4 {
                return Err("Jog preflight requires healthy disabled motor near mid travel".into());
            }
            self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            let jog_velocity=std::env::var("MOTO_JOG_VELOCITY").ok().and_then(|x|x.parse::<i32>().ok()).unwrap_or(152709);
            if jog_velocity<305||jog_velocity>610839{return Err("Jog speed outside 1..2000rpm bench envelope".into());}
            let acceleration=std::env::var("MOTO_JOG_ACCEL").ok().and_then(|x|x.parse::<u32>().ok()).unwrap_or(667);
            if !(1..=111199).contains(&acceleration){return Err("Acceleration outside tested UI envelope".into());}
            self.call(9,Command::Limits{task_iq_raw:2483,task_velocity_raw:jog_velocity as u32,acceleration_raw:acceleration,
                deceleration_raw:acceleration,trip_iq_raw:2980,over_ms:180,sample_ms:60,
                feedback_timeout_ms:1000,stop_timeout_ms:5000,margin_counts:65536,fault_action:2})?;
            self.wait(15,|s|s.limits_valid&&s.pending_action==0)?;
            self.call(9,Command::Mode{mode:1})?;self.wait(15,|s|s.mode==1&&s.limits_valid&&s.pending_action==0)?;
            self.call(9,Command::DriveEnable)?;self.wait(15,|s|s.drive==2)?;
            // Hold time is measured at the transport, including START round-trip.
            // Short tests do not insert telemetry requests ahead of STOP.
            for hold_ms in [5000u64,500,200,100,50] {
              for direction in [1,-1] {
                self.call(0,Command::Pulse)?;self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                let before=self.call(9,Command::PositionState)?.motor.ok_or("No jog preflight")?;
                let origin=before.position.parse::<i64>().map_err(|_|"Bad jog origin")?;
                let q=before.logical_position.as_ref().ok_or("No coordinate")?.parse::<i64>().map_err(|_|"Bad coordinate")?;
                if before.mode!=1||before.drive!=2||before.motion_active||q<span/4||q>span*3/4{return Err("Jog must start held near mid travel".into());}
                let started=Instant::now();
                self.call(9,Command::JogStart{velocity_raw:direction*jog_velocity,lease_ms:700})?;
                let ack_ms=started.elapsed().as_millis();let task=self.q.task_id;
                let mut renew=Instant::now();let mut peak=0i64;
                while started.elapsed()<Duration::from_millis(hold_ms) {
                    thread::sleep(Duration::from_millis(5));
                    if renew.elapsed()>=Duration::from_millis(200) {
                        self.call(0,Command::Pulse)?;self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                        self.call(9,Command::JogRenew)?;
                        let r=self.call(9,Command::PositionState)?.motor.ok_or("No jog feedback")?;
                        if r.fault!=0||r.last_error!=0||!r.feedback_fresh{return Err(format!("Bad jog sample: {r:?}"));}
                        peak=peak.max(i64::from(r.velocity_raw).abs());renew=Instant::now();
                    }
                }
                let stop_sent_ms=started.elapsed().as_millis();
                self.call(9,Command::Stop{after:1})?;
                let stopped=self.wait(10,|s|!s.motion_active&&s.pending_action==0&&s.mode==1)?;
                // Read after a stationary dwell; retain MAX power and drive hold.
                let final_s=self.wait(2,|s|!s.motion_active&&s.mode==1)?;
                let delta=final_s.position.parse::<i64>().map_err(|_|"Bad jog end")?-origin;
                let moved=delta*i64::from(direction)>=4096;
                self.log.push(serde_json::json!({"position_jog":true,"jog_direction":direction,
                    "acceleration_raw":acceleration,"jog_velocity_raw":jog_velocity,"hold_requested_ms":hold_ms,"start_ack_ms":ack_ms,
                    "stop_sent_ms":stop_sent_ms,"settled_ms":started.elapsed().as_millis(),
                    "delta_raw":delta,"delta_degrees":delta as f64*360.0/65536.0,
                    "peak_velocity_raw":peak,"movement_confirmed":moved,"task_id":task,"stopped":stopped,"final":final_s}));
                std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
                if !final_s.logic_power||final_s.fault!=0{return Err("Jog stop power/fault regression".into());}
                if hold_ms==5000&&!moved{return Err("Long position jog did not move; do not increase acceleration blindly".into());}
              }
            }
            self.call(9,Command::Stop{after:2})?;self.wait(10,|s|s.drive==0&&!s.motion_active&&s.pending_action==0)?;
            let mut info=self.t.call(9,4,&[]).map_err(|e|e.to_string())?;
            for _ in 0..10 {
                if info.len()==10&&info[7]==1{break;}
                thread::sleep(Duration::from_millis(20));info=self.t.call(9,4,&[]).map_err(|e|e.to_string())?;
            }
            if info.len()!=10||info[7]!=1||info[2]<1||info[2]>4||info[9]&(1<<(info[2]-1))==0 {
                return Err(format!("Jog power retention not confirmed: {info:?}"));
            }
            self.log.push(serde_json::json!({"jog_power_retained":true,"route":info}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
            Ok(())
        }
        fn storage(&mut self,operation:u8,id:u32)->Result<ss::Response,String>{
            self.archive(9,operation,id,None)
        }
        fn archive(&mut self,motor:u8,operation:u8,_trace_id:u32,data:Option<&[u8]>)->Result<ss::Response,String>{
            // Match the UI's time-based request identity. Reusing fixed IDs
            // across HIL sessions in one boot is rejected by replay protection.
            let id=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|e|e.to_string())?.as_millis().wrapping_rem(0xffffffff) as u32;
            if let Some(image)=data {
                if operation!=3||image.len()!=128{return Err("Bad archive payload".into());}
                for offset in [0usize,106] {
                    let stage=ss::Request{id,operation:2,offset:offset as u8,data:image[offset..(offset+106).min(128)].to_vec()};
                    let r=ss::decode(motor,&stage,&self.t.call(motor,33,&ss::encode(motor,&stage)?).map_err(|e|e.to_string())?)?;
                    if r.phase!=1||r.result!=0{return Err("Archive staging rejected".into());}
                }
            }
            let mut q=ss::Request{id,operation,offset:0,data:vec![]};
            let raw=self.t.call(motor,33,&ss::encode(motor,&q)?).map_err(|e|e.to_string())?;
            let mut r=ss::decode(motor,&q,&raw)?;let end=Instant::now()+Duration::from_secs(45);
            while r.phase==2||r.phase==3 {
                if Instant::now()>=end{return Err("Storage deadline; not resubmitted".into());}
                thread::sleep(Duration::from_millis(80));self.call(0,Command::Pulse)?;
                q.operation=6;
                r=ss::decode(motor,&q,&self.t.call(motor,33,&ss::encode(motor,&q)?).map_err(|e|e.to_string())?)?;
            }
            if r.phase!=4||r.result!=0{return Err(format!("Storage op{operation} result={} flags={}",r.result,r.flags));}
            // A cached terminal START carries no head bytes. STATUS is the
            // only fragment interface; never compare a tail-only archive.
            q.operation=6;q.offset=0;
            r=ss::decode(motor,&q,&self.t.call(motor,33,&ss::encode(motor,&q)?).map_err(|e|e.to_string())?)?;
            if r.phase!=4||r.result!=0||r.data.len()!=106{return Err("Storage head missing".into());}
            q.operation=6;q.offset=106;
            let tail=ss::decode(motor,&q,&self.t.call(motor,33,&ss::encode(motor,&q)?).map_err(|e|e.to_string())?)?;
            if tail.result!=0||tail.generation!=r.generation||tail.phase!=4{return Err("Storage fragment changed".into());}
            r.data.extend(tail.data);
            if r.data.len()!=128{return Err("Incomplete archive".into());}
            self.log.push(serde_json::json!({"storage":r}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
            Ok(r)
        }
    }
    impl Hil {
        fn overshoot_trace(&mut self,label:&str,seconds:u64,jog:bool)->Result<(),String>{
            self.log.push(serde_json::json!({"trace_begin":label}));
            let end=Instant::now()+Duration::from_secs(seconds);let mut heartbeat=Instant::now();let mut cursor=0;
            while Instant::now()<end {
                if heartbeat.elapsed()>Duration::from_millis(150){
                    self.call(0,Command::Pulse)?;self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                    if jog {self.call(9,Command::JogRenew)?;}
                    let m=self.call(9,Command::PositionState)?.motor.ok_or("No trace state")?;
                    if m.fault!=0{return Err(format!("Trace fault {m:?}"));}
                    heartbeat=Instant::now();
                }
                let d=self.call(9,Command::RtmiState{cursor})?.rtmi.ok_or("No trace data")?;
                cursor=u32::from_le_bytes(d[0..4].try_into().unwrap());
                thread::sleep(Duration::from_millis(8));
            }
            self.log.push(serde_json::json!({"trace_end":label}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;Ok(())
        }
        fn jog_coast_suite(&mut self)->Result<(),String>{
            let base=self.archive(9,1,0,None)?.data;
            let policy=self.call(9,Command::HomingConfigRead)?.homing_config.ok_or("No home policy")?;
            if policy[5]!=0||policy[6]!=0{return Err("Removed retreat fields still active".into());}
            let word=|i|u32::from_le_bytes(base[i..i+4].try_into().unwrap());
            let old_mode=word(104) as u8;let old_speed=word(112);
            let initial=self.call(9,Command::PositionState)?.motor.ok_or("No M9")?;
            if initial.motion_active||initial.fault!=0{return Err("M9 must be idle and fault-free".into());}
            if !initial.config_verified {
                self.call(9,Command::Commission{action:1})?;
                self.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
            }
            self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            let ready=self.call(9,Command::PositionState)?.motor.ok_or("No calibrated M9")?;
            if !ready.align_valid{return Err("Stored encoder calibration must be valid".into());}
            let home=if ready.coordinate_valid{ready}else{
                self.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                self.wait(140,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh)?
            };
            let span=home.logical_span.as_ref().ok_or("No span")?.parse::<i64>().map_err(|_|"Bad span")?;
            self.log.push(serde_json::json!({"coast_archive":base,"span":span,"original_mode":old_mode,"original_speed":old_speed}));
            let result=(||->Result<(),String>{
                // First qualify a short release at 2000rpm, then reproduce the
                // previous 15000rpm complaint in direct and native Ramp modes.
                let tests=if std::env::var("MOTO_COAST_NEGATIVE").unwrap_or_default()=="1" {
                    vec![(0u8,15000u32,1i32);6]
                }else if std::env::var("MOTO_COAST_DIRECT").unwrap_or_default()=="1" {
                    vec![(0u8,15000u32,1i32),(0,15000,-1)]
                }else if std::env::var("MOTO_COAST_FULL").unwrap_or_default()=="1" {
                    vec![(0u8,2000u32,1i32),(0,15000,1),(0,15000,-1),(1,15000,1),(1,15000,-1),
                         (2,15000,1),(2,15000,-1),(3,15000,1),(3,15000,-1)]
                }else{vec![(old_mode,2000,1)]};
                for (index,(mode,rpm,direction)) in tests.into_iter().enumerate() {
                    let before=self.call(9,Command::PositionState)?.motor.ok_or("No test state")?;
                    if before.drive!=0 {
                        self.call(9,Command::Stop{after:2})?;
                        self.wait(15,|s|s.drive==0&&!s.motion_active&&s.pending_action==0)?;
                    }
                    self.wait(10,|s|s.feedback_fresh&&s.velocity_raw.unsigned_abs()<=8192)?;
                    let speed=((u64::from(rpm)*1_099_511_627_776+1_800_000_000)/3_600_000_000) as u32;
                    self.call(9,Command::TaskSpeed{velocity_raw:speed,mode})?;
                    self.wait(15,|s|s.drive==0&&s.pending_action==0&&s.mode==mode&&s.limits_valid)?;
                    self.call(9,Command::RtmiConfig{enabled:std::env::var("MOTO_COAST_NO_RTMI").unwrap_or_default()!="1",sampling:255,addresses:[0x152,0x155,0x154,0x153,65535,65535,65535],decimation:4})?;
                    self.wait(15,|s|s.pending_action==0&&s.drive==0)?;
                    self.call(9,Command::DriveEnable)?;self.wait(15,|s|s.drive==2)?;
                    self.call(9,Command::LogicalMove{position:(span/2).to_string()})?;
                    self.wait(30,|s|!s.motion_active&&s.pending_action==0)?;
                    let origin=self.call(9,Command::PositionState)?.motor.ok_or("No origin")?;
                    let q=origin.logical_position.as_ref().ok_or("No logical position")?.parse::<i64>().map_err(|_|"Bad coordinate")?;
                    if q<span*45/100||q>span*55/100{return Err("Jog requires middle of travel".into());}
                    self.call(9,Command::JogStart{velocity_raw:direction*speed as i32,lease_ms:1000})?;
                    let renewals=std::env::var("MOTO_COAST_RENEWALS").ok()
                        .and_then(|s|s.parse::<usize>().ok()).unwrap_or(3).clamp(1,20);
                    for _ in 0..renewals {
                        thread::sleep(Duration::from_millis(80));self.call(0,Command::Pulse)?;
                        self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;self.call(9,Command::JogRenew)?;
                    }
                    let release=self.call(9,Command::Stop{after:1})?;
                    self.log.push(serde_json::json!({"coast_trial":index,"mode":mode,"rpm":rpm,"direction":direction,
                        "stop_ack_ms":release.timestamp_ms,"origin":origin}));
                    self.overshoot_trace("jog_release",4,false)?;
                    let held=self.wait(12,|s|!s.motion_active&&s.pending_action==0)?;
                    if !held.logic_power||!held.align_valid||!held.coordinate_valid||held.drive!=2||held.mode!=mode||!held.permit {
                        return Err(format!("Coast lost power/calibration/mode/hold: {held:?}"));
                    }
                    self.log.push(serde_json::json!({"coast_trial_done":index,"held":held}));
                    // A second press uses the temporary hold -> selected-mode
                    // re-entry path without a disable/initialization in between.
                    self.call(9,Command::JogStart{velocity_raw:-direction*speed as i32,lease_ms:1000})?;
                    thread::sleep(Duration::from_millis(150));
                    self.call(9,Command::Stop{after:1})?;
                    self.overshoot_trace("jog_release_repeat",4,false)?;
                    self.wait(12,|s|!s.motion_active&&s.pending_action==0&&s.drive==2)?;
                }
                Ok(())
            })();
            let stop=self.call(9,Command::Stop{after:2});
            let disabled=if stop.is_ok(){self.wait_idle(15,|s|s.drive==0&&!s.motion_active&&s.pending_action==0)}else{Err("Stop rejected".into())};
            if disabled.is_ok(){
                self.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1})?;
                self.wait_idle(10,|s|s.drive==0&&s.pending_action==0)?;
                self.call(9,Command::TaskSpeed{velocity_raw:old_speed,mode:old_mode})?;
                self.wait_idle(15,|s|s.drive==0&&s.pending_action==0&&s.limits_valid)?;
                if self.archive(9,1,0,None)?.data!=base{return Err("W25 changed during coast test".into());}
            }
            self.log.push(serde_json::json!({"coast_result":result,"cleanup":disabled}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
            result?;disabled?;Ok(())
        }
        fn pi_overshoot_suite(&mut self)->Result<(),String>{
            let base=self.archive(9,1,0,None)?.data;
            let state=self.call(9,Command::PositionState)?.motor.ok_or("No state")?;
            if state.motion_active{return Err("M9 not idle".into());}
            if state.fault!=0 {
                if state.fault!=32||std::env::var("MOTO_PI_RECOVER").unwrap_or_default()!="1"{return Err("M9 fault requires explicit recovery".into());}
                let deadline=Instant::now()+Duration::from_secs(5);
                loop {let s=self.call(9,Command::PositionState)?.motor.ok_or("No recovery state")?;
                    if s.drive==0&&s.feedback_fresh&&s.velocity_raw==0{self.call(9,Command::ClearFault)?;break;}
                    if Instant::now()>deadline{return Err("Recovery requires standstill".into());}
                    self.call(0,Command::Pulse)?;thread::sleep(Duration::from_millis(100));}
            } else if state.last_error!=0 {self.call(9,Command::ClearFault)?;}
            if !state.config_verified {self.call(9,Command::Commission{action:1})?;self.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;}
            self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            let state=self.call(9,Command::PositionState)?.motor.ok_or("No ready state")?;
            if !state.align_valid{return Err("Existing calibration required".into());}
            let home=if state.coordinate_valid{state}else{
                self.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                self.wait(140,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh)?
            };
            let span=home.logical_span.as_ref().ok_or("No span")?.parse::<i64>().map_err(|_|"Bad span")?;
            let word=|i|u32::from_le_bytes(base[i..i+4].try_into().unwrap());
            let mode=word(104) as u8;let speed=word(112);
            self.call(9,Command::TaskSpeed{velocity_raw:speed,mode})?;
            self.wait(15,|s|s.pending_action==0&&s.limits_valid&&s.drive==0)?;
            let mut coeff=[word(32),word(36),word(40),word(44)];
            let kp=std::env::var("MOTO_PI_P").ok().and_then(|x|x.parse::<u32>().ok()).unwrap_or(coeff[2]>>16);
            let ki=std::env::var("MOTO_PI_I").ok().and_then(|x|x.parse::<u32>().ok()).unwrap_or(coeff[2]&65535);
            if kp>1000||ki>250{return Err("PI outside bounded tuning envelope".into());}
            coeff[2]=(kp<<16)|ki;
            let pp=std::env::var("MOTO_POS_P").ok().and_then(|x|x.parse::<u32>().ok()).unwrap_or(coeff[3]>>16);
            if pp==0||pp>500{return Err("Position P outside tuning envelope".into());}coeff[3]=(pp<<16)|(coeff[3]&65535);
            self.call(9,Command::PiTune{group:1,expected_config:word(28),coefficients:coeff})?;
            self.wait(15,|s|s.pending_action==0&&s.config_verified)?;
            self.call(9,Command::PiTune{group:2,expected_config:word(28),coefficients:coeff})?;
            self.wait(15,|s|s.pending_action==0&&s.config_verified)?;
            self.log.push(serde_json::json!({"bench_pi":coeff,"base_archive":base,"selected_mode":mode,"requested_speed_raw":speed,"span":span}));
            self.call(9,Command::RtmiConfig{enabled:true,sampling:255,addresses:[0x152,0x155,0x154,0x153,65535,65535,65535],decimation:4})?;
            self.wait(15,|s|s.pending_action==0&&s.drive==0)?;
            self.call(9,Command::DriveEnable)?;self.wait(15,|s|s.drive==2)?;
            let result=(||->Result<(),String>{
                for percent in [45i64,55,45] {
                    self.call(9,Command::LogicalMove{position:(span*percent/100).to_string()})?;
                    self.overshoot_trace(&format!("position_{percent}"),4,false)?;
                    self.wait(12,|s|!s.motion_active&&s.pending_action==0)?;
                }
                let direction=if self.call(9,Command::PositionState)?.motor.unwrap().position.parse::<i64>().unwrap()< -(span/2){1}else{-1};
                self.call(9,Command::JogStart{velocity_raw:direction*speed as i32,lease_ms:1000})?;
                // Test the configured task speed, never substitute the stall-detection threshold.
                for _ in 0..5 {
                    thread::sleep(Duration::from_millis(80));self.call(0,Command::Pulse)?;
                    self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;self.call(9,Command::JogRenew)?;
                }
                self.call(9,Command::Stop{after:1})?;
                self.overshoot_trace("jog_release",4,false)?;
                self.wait(12,|s|!s.motion_active&&s.pending_action==0)?;Ok(())
            })();
            let _=self.call(9,Command::Stop{after:2});
            let _=self.wait(12,|s|s.drive==0&&!s.motion_active&&s.pending_action==0);
            let _=self.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1});
            let _=self.wait_idle(10,|s|s.pending_action==0&&s.drive==0);
            let unchanged=self.archive(9,1,0,None)?.data==base;
            self.log.push(serde_json::json!({"pi_trace_result":result,"w25_unchanged":unchanged}));
            if result.is_ok()&&std::env::var("MOTO_PI_COMMIT").unwrap_or_default()=="1" {
                let current=self.archive(9,1,0,None)?.data;let mut edited=current.clone();
                edited[40..44].copy_from_slice(&coeff[2].to_le_bytes());edited[44..48].copy_from_slice(&coeff[3].to_le_bytes());
                let mut payload=current[120..124].to_vec();payload.extend_from_slice(&edited[28..64]);payload.extend_from_slice(&edited[68..120]);
                self.call(9,Command::ApplyConfiguration{payload})?;
                self.wait_idle(20,|s|s.pending_action==0&&s.config_verified&&s.drive==0)?;
                let saved=self.archive(9,1,0,None)?.data;
                if saved[28..64]!=edited[28..64]||saved[68..120]!=edited[68..120]{return Err("Tuned PI archive readback mismatch".into());}
                self.log.push(serde_json::json!({"pi_committed_after_tmc_readback":true,"saved_archive":saved}));
            }
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
            result
        }
        fn contact_online_suite(&mut self)->Result<(),String>{
            let base=self.archive(9,1,0,None)?.data;
            let state=self.call(9,Command::PositionState)?.motor.ok_or("No state")?;
            if state.motion_active||state.fault!=0{return Err("M9 is not idle".into());}
            if !state.config_verified {
                self.call(9,Command::Commission{action:1})?;
                self.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
            }
            self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            let state=self.call(9,Command::PositionState)?.motor.ok_or("No initialized state")?;
            if !state.align_valid{return Err("Existing calibration required".into());}
            let home=if state.coordinate_valid {state} else {
                self.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                self.wait(140,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh)?
            };
            let mode=u32::from_le_bytes(base[104..108].try_into().unwrap()) as u8;
            let task=u32::from_le_bytes(base[112..116].try_into().unwrap());
            self.call(9,Command::Stop{after:2})?;self.wait(10,|s|s.drive==0&&!s.motion_active&&s.pending_action==0)?;
            self.call(9,Command::TaskSpeed{velocity_raw:task,mode})?;
            self.wait(10,|s|s.mode==mode&&s.limits_valid&&s.pending_action==0)?;
            self.call(9,Command::DriveEnable)?;self.wait(15,|s|s.drive==2)?;
            let span=home.logical_span.as_ref().ok_or("No span")?.parse::<i64>().map_err(|_|"Bad span")?;
            let current=self.call(9,Command::PositionState)?.motor.ok_or("No current")?;
            let chip=current.position.parse::<i64>().map_err(|_|"Bad position")?;
            let negative=current.negative_contact.parse::<i64>().map_err(|_|"Bad endpoint")?;
            let sign=if chip-negative<span/2{1}else{-1};
            self.call(9,Command::JogStart{velocity_raw:sign*610839,lease_ms:1000})?;
            thread::sleep(Duration::from_millis(120));
            self.call(0,Command::Pulse)?;self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            self.call(9,Command::JogRenew)?;
            let during=self.archive(9,1,0,None)?.data;
            if during!=base{return Err("Moving W25 read differs".into());}
            self.call(9,Command::JogRenew)?;
            // Byte-identical raw archive write validates independent W25 access.
            self.archive(9,3,0,Some(&base))?;
            self.call(9,Command::JogRenew)?;
            let mut payload=base[120..124].to_vec();payload.extend_from_slice(&base[28..64]);payload.extend_from_slice(&base[68..120]);
            self.call(9,Command::ApplyConfiguration{payload})?;
            let end=Instant::now()+Duration::from_secs(15);
            loop {
                thread::sleep(Duration::from_millis(80));
                self.call(0,Command::Pulse)?;self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                self.call(9,Command::JogRenew)?;
                let r=self.call(9,Command::PositionState)?;let state=r.motor.ok_or("No online snapshot")?;
                if state.fault!=0||state.last_error!=0||state.drive!=2||!state.motion_active||!state.permit||!state.align_valid||!state.span_valid||!state.logic_power {
                    return Err(format!("Online update disturbed running motor: {state:?}"));
                }
                if !r.pending&&state.pending_action==0{break;}
                if Instant::now()>end{return Err("Online apply deadline".into());}
            }
            self.log.push(serde_json::json!({"running_w25_read_write":true,"running_apply_kept_pwm_task_permit_home":true}));
            self.call(9,Command::Stop{after:1})?;
            let stop_end=Instant::now()+Duration::from_secs(15);
            let mut last=None;let mut reverse=0i64;
            loop {
                thread::sleep(Duration::from_millis(40));
                self.call(0,Command::Pulse)?;self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                let r=self.call(9,Command::PositionState)?.motor.ok_or("No stop trace")?;
                let pos=r.position.parse::<i64>().map_err(|_|"Bad stop trace")?;
                if let Some(old)=last {reverse=reverse.max((old-pos)*i64::from(sign));}last=Some(pos);
                if r.fault!=0{return Err(format!("Stop fault: {r:?}"));}
                if !r.motion_active&&r.pending_action==0{break;}
                if Instant::now()>stop_end{return Err("Stop trace deadline".into());}
            }
            self.log.push(serde_json::json!({"stop_reverse_peak_counts":reverse,"stop_trace_tolerance_counts":2048}));
            if reverse>2048{return Err(format!("Reverse during stop exceeds noise envelope: {reverse}"));}
            let saved=self.archive(9,1,0,None)?.data;
            if saved!=base{return Err("Archive changed unexpectedly".into());}
            self.call(9,Command::Stop{after:2})?;self.wait(15,|s|s.drive==0&&!s.motion_active)?;
            self.call(9,Command::Permit{enabled:false,lease_ms:0})?;
            self.log.push(serde_json::json!({"contact_online_pass":true,"archive_unchanged":true}));
            self.call(0,Command::Close)?;Ok(())
        }
        fn four_task_suite(&mut self)->Result<(),String>{
            let base=self.archive(9,1,0,None)?.data;
            let common=self.archive(0,1,0,None)?.data;
            let initial=self.call(9,Command::PositionState)?.motor.ok_or("Missing M9")?;
            let cfg=self.call(9,Command::HomingConfigRead)?.homing_config;
            self.log.push(serde_json::json!({"four_task_backup":true,"archive":base,"common":common,"state":initial,"home_config":cfg}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
            if std::env::var("MOTO_FOUR_STAGE").unwrap_or_default()=="preflight"{return Ok(());}
            if initial.fault!=0||initial.motion_active{return Err("M9 not idle/healthy".into());}
            if !initial.config_verified {
                self.call(9,Command::Commission{action:1})?;
                self.wait_idle(25,|s|s.drive==0&&s.config_verified&&s.limits_valid&&s.feedback_fresh)?;
            }
            let state=self.call(9,Command::PositionState)?.motor.ok_or("Missing configured M9")?;
            if !state.align_valid{return Err("Calibration must already be valid".into());}
            self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            // Apply byte-identical saved settings: no invented PI/speed/current.
            // Observe every intermediate state BEFORE renewing the permission.
            let mut payload=base[120..124].to_vec();payload.extend_from_slice(&base[28..64]);payload.extend_from_slice(&base[68..120]);
            self.call(9,Command::ApplyConfiguration{payload})?;
            let until=Instant::now()+Duration::from_secs(30);
            loop {
                thread::sleep(Duration::from_millis(100));self.call(0,Command::Pulse)?;
                let r=self.call(9,Command::PositionState)?.motor.ok_or("Missing apply state")?;
                if r.fault!=0||r.last_error!=0||!r.permit{return Err(format!("Apply lost permission or failed: {r:?}"));}
                self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                if r.drive==0&&r.config_verified&&r.limits_valid&&r.pending_action==0{break;}
                if Instant::now()>until{return Err("Apply deadline".into());}
            }
            let applied_archive=self.archive(9,1,0,None)?.data;
            if applied_archive!=base{return Err("Applied archive differs from original".into());}
            let applied_state=self.call(9,Command::PositionState)?.motor.ok_or("No post-read state")?;
            if !applied_state.permit{return Err("Independent W25 read lost permission".into());}
            self.log.push(serde_json::json!({"apply_kept_permission":true,"independent_readback_kept_permission":true}));
            let state=self.call(9,Command::PositionState)?.motor.ok_or("Missing home preflight")?;
            let home=if state.coordinate_valid&&state.span_valid {state} else {
                self.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                self.wait(140,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh)?
            };
            let span=home.logical_span.as_ref().ok_or("No span")?.parse::<i64>().map_err(|_|"Bad span")?;
            let middle=span/2;
            let task=u32::from_le_bytes(base[112..116].try_into().unwrap());
            if task==0{return Err("RUN2 saved task speed required".into());}
            let set_mode=|h:&mut Hil,mode:u8|->Result<(),String>{
                h.call(9,Command::Stop{after:2})?;
                h.wait(10,|s|s.drive==0&&!s.motion_active&&s.pending_action==0&&s.feedback_fresh&&s.velocity_raw.abs()<=8192)?;
                h.call(9,Command::TaskSpeed{velocity_raw:task,mode})?;
                h.wait(10,|s|s.mode==mode&&s.limits_valid&&s.pending_action==0)?;
                h.call(9,Command::DriveEnable)?;h.wait(15,|s|s.drive==2)?;Ok(())
            };
            set_mode(self,1)?;self.call(9,Command::LogicalMove{position:middle.to_string()})?;
            self.wait(55,|s|s.arrival_phase==Some(4)&&!s.motion_active)?;
            let excursion=(span/100).clamp(65536,524288);
            let from=std::env::var("MOTO_FOUR_FROM").ok().and_then(|s|s.parse::<u8>().ok()).unwrap_or(0);
            for mode in [0u8,1,2,3].into_iter().filter(|m|*m>=from) {
                set_mode(self,mode)?;
                for goal in [middle-excursion,middle+excursion,middle] {
                    self.call(9,Command::LogicalMove{position:goal.to_string()})?;
                    let arrived=self.wait(30,|s|s.arrival_phase==Some(4)&&!s.motion_active)?;
                    if arrived.mode!=mode||!arrived.span_valid||!arrived.align_valid||!arrived.logic_power{return Err("Position task lost selected mode/home/power".into());}
                    self.log.push(serde_json::json!({"four_position_mode":mode,"goal":goal,"arrived":arrived}));
                }
                self.call(9,Command::LogicalWork{a:(middle-excursion).to_string(),b:(middle+excursion).to_string(),dwell_ms:0,cycles:1})?;
                let done=self.wait(40,|s|!s.motion_active&&s.pending_action==0)?;
                if done.mode!=mode||!done.span_valid||!done.logic_power{return Err("Work lost mode/home/power".into());}
                self.log.push(serde_json::json!({"four_work_mode":mode,"done":done}));
                for sign in [-1i32,1] {
                    let before=self.call(9,Command::PositionState)?.motor.ok_or("No jog preflight")?;
                    self.call(9,Command::JogStart{velocity_raw:sign*task as i32,lease_ms:700})?;
                    thread::sleep(Duration::from_millis(200));
                    self.call(9,Command::Stop{after:1})?;
                    let after=self.wait(12,|s|!s.motion_active&&s.pending_action==0)?;
                    let delta=after.position.parse::<i64>().map_err(|_|"Bad endpoint")?-before.position.parse::<i64>().map_err(|_|"Bad origin")?;
                    if delta*i64::from(sign)<=100||after.mode!=mode||!after.logic_power||!after.span_valid{return Err("Selected-mode jog failed direction/movement/mode/power".into());}
                    self.log.push(serde_json::json!({"four_jog_mode":mode,"sign":sign,"delta":delta,"after":after}));
                }
                self.call(9,Command::LogicalMove{position:middle.to_string()})?;
                self.wait(40,|s|s.arrival_phase==Some(4)&&!s.motion_active)?;
            }
            set_mode(self,u32::from_le_bytes(base[104..108].try_into().unwrap()) as u8)?;
            self.call(9,Command::Stop{after:2})?;self.wait(10,|s|s.drive==0&&!s.motion_active)?;
            let final_archive=self.archive(9,1,0,None)?.data;
            if final_archive!=base{return Err("Tests changed saved motor archive".into());}
            if self.call(9,Command::HomingConfigRead)?.homing_config!=cfg{return Err("Shared homing config changed".into());}
            self.log.push(serde_json::json!({"four_task_pass":true,"saved_archive_unchanged":true}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;Ok(())
        }
        fn mode_suite(&mut self)->Result<(),String>{
            let base=self.archive(9,1,0,None)?.data;
            let common=self.archive(0,1,0,None)?.data;
            let cfg=self.call(9,Command::HomingConfigRead)?.homing_config.ok_or("Missing shared home configuration")?;
            let initial=self.call(9,Command::PositionState)?.motor.ok_or("No M9 state")?;
            self.log.push(serde_json::json!({"mode_preflight":true,"shared_home":cfg,"state":initial,"archive":base,"common":common}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;
            if std::env::var("MOTO_MODE_STAGE").unwrap_or_default()=="preflight"{return Ok(());}
            if !initial.config_verified||!initial.align_valid||!initial.logic_power||initial.fault!=0||initial.motion_active||initial.drive!=0 {
                return Err("M9 must be calibrated, configured and disabled before mode suite".into());
            }
            let word=|p:&[u8],i:usize|u32::from_le_bytes(p[i..i+4].try_into().unwrap());
            let mut image=base.clone();
            let old_tag=word(&base,68);
            if old_tag!=0x324e5552&&(word(&base,60)!=0||word(&base,112)!=0){return Err("Cannot losslessly migrate this archive".into());}
            if word(&base,52)<152709{return Err("Position ceiling below 500rpm; no automatic increase".into());}
            let values:[(usize,u32);4]=[(60,0), // Filled from the verified common policy below.
                (68,0x324e5552),(104,1),(112,152709)];
            for (i,v) in values{image[i..i+4].copy_from_slice(&v.to_le_bytes());}
            // Same closed-loop scale as UI/MCU, floor so the policy is never exceeded.
            let velocity_limit=(u64::from(word(&common,36))*1099511627776/3600000000) as u32;
            image[60..64].copy_from_slice(&velocity_limit.to_le_bytes());
            let crc=crate::motor_profile::crc32(&image[..120]);image[120..124].copy_from_slice(&crc.to_le_bytes());
            let mut payload=base[120..124].to_vec();payload.extend_from_slice(&image[28..64]);payload.extend_from_slice(&image[68..120]);
            if base[12..120]!=image[12..120] {
                self.call(9,Command::ApplyConfiguration{payload})?;
                self.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid&&s.mode==1)?;
            }
            let saved=self.archive(9,1,0,None)?.data;
            if saved[12..120]!=image[12..120]{return Err("RUN2 archive apply readback differs".into());}
            // Do not overwrite shared homing policy as a side effect of mode tests.
            if u32::from(cfg[4])>word(&common,36){return Err("Saved homing rpm exceeds common safety limit; shared policy was not changed".into());}
            self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            let home=if initial.coordinate_valid&&initial.span_valid {
                self.call(9,Command::PositionState)?.motor.ok_or("No existing coordinate")?
            }else{
                self.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                self.wait(140,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh&&s.velocity_raw.abs()<=8192)?
            };
            let span=home.logical_span.as_ref().ok_or("No logical span")?.parse::<i64>().map_err(|_|"Bad span")?;
            let margin=i64::from(home.margin_counts.ok_or("No margin")?);
            if span<=4*margin{return Err("Travel too small for mode test".into());}
            let middle=span/2;
            let set_mode=|h:&mut Hil,mode:u8|->Result<(),String>{
                let before=h.call(9,Command::PositionState)?.motor.ok_or("No switch preflight")?;
                let started=Instant::now();
                h.call(9,Command::Stop{after:2})?;h.wait(10,|s|s.drive==0&&!s.motion_active&&s.feedback_fresh&&s.velocity_raw.abs()<=8192&&s.pending_action==0)?;
                h.call(9,Command::TaskSpeed{velocity_raw:152709,mode})?;
                h.wait(10,|s|s.mode==mode&&s.limits_valid&&s.pending_action==0)?;
                h.call(9,Command::DriveEnable)?;
                let after=h.wait(15,|s|s.drive==2)?;
                if !after.logic_power||!after.coordinate_valid||after.logical_span!=before.logical_span||after.fault!=0||after.motion_active {
                    return Err("Mode switch lost power/home or started unintended motion".into());
                }
                h.log.push(serde_json::json!({"mode_switch":true,"from":before.mode,"to":mode,
                    "elapsed_ms":started.elapsed().as_millis(),"before":before,"after":after}));
                Ok(())
            };
            set_mode(self,1)?;
            self.call(9,Command::LogicalMove{position:middle.to_string()})?;
            self.wait(50,|s|s.arrival_phase==Some(4)&&!s.motion_active)?;
            let excursion=((span-2*margin)/100).clamp(4096,65536);
            // Position tasks make small excursions around mid travel, no endpoint steps.
            for mode in [0u8,1] {
                set_mode(self,mode)?;
                for target in [middle-excursion,middle+excursion,middle] {
                    self.call(9,Command::LogicalMove{position:target.to_string()})?;
                    let arrived=self.wait(25,|s|s.arrival_phase==Some(4)&&!s.motion_active)?;
                    self.log.push(serde_json::json!({"mode_position":mode,"goal":target,"arrived":arrived}));
                }
            }
            for mode in [2u8,3] {
                set_mode(self,mode)?;
                for sign in [-1i32,1] {
                    let before=self.call(9,Command::PositionState)?.motor.ok_or("No velocity preflight")?;
                    let p=before.logical_position.as_ref().ok_or("No logical position")?.parse::<i64>().map_err(|_|"Bad position")?;
                    if p<span/4||p>3*span/4{return Err("Velocity tests require mid travel".into());}
                    self.call(9,Command::VelocityStart{velocity_raw:sign*152709,lease_ms:700})?;
                    let start=Instant::now();let mut peak=0i32;
                    while start.elapsed()<Duration::from_millis(500){
                        thread::sleep(Duration::from_millis(100));self.call(0,Command::Pulse)?;
                        self.call(9,Command::Permit{enabled:true,lease_ms:3000})?;self.call(9,Command::JogRenew)?;
                        let r=self.call(9,Command::PositionState)?.motor.ok_or("No velocity sample")?;
                        if r.fault!=0||r.last_error!=0{return Err("Velocity task fault".into());}
                        peak=peak.max(r.velocity_raw.abs());
                    }
                    self.call(9,Command::Stop{after:1})?;
                    let after=self.wait(10,|s|!s.motion_active&&s.pending_action==0&&s.velocity_raw.abs()<=8192)?;
                    let delta=after.position.parse::<i64>().map_err(|_|"Bad endpoint")?-before.position.parse::<i64>().map_err(|_|"Bad origin")?;
                    if delta*i64::from(sign)<=100{return Err("Velocity motion not confirmed in requested direction".into());}
                    if after.mode!=mode||!after.logic_power||!after.span_valid{return Err("Velocity stop lost mode/power/home".into());}
                    self.log.push(serde_json::json!({"mode_velocity":mode,"sign":sign,"delta":delta,"peak_raw":peak,"after":after}));
                }
            }
            set_mode(self,0)?;
            for sign in [-1i32,1] {
                let before=self.call(9,Command::PositionState)?.motor.ok_or("No jog preflight")?;
                self.call(9,Command::JogStart{velocity_raw:sign*152709,lease_ms:700})?;
                thread::sleep(Duration::from_millis(200));self.call(9,Command::Stop{after:1})?;
                let after=self.wait(10,|s|!s.motion_active&&s.pending_action==0)?;
                self.log.push(serde_json::json!({"fixed_direct_jog":true,"sign":sign,"before":before,"after":after}));
            }
            // Exercise all twelve distinct ordered mode pairs without issuing
            // another movement target. Each switch must keep this boot's home.
            for mode in [1u8,2,0,3,1,0,2,3,0,1,3,2,1,0] {set_mode(self,mode)?;}
            self.call(9,Command::Stop{after:2})?;
            self.wait_idle(10,|s|s.drive==0&&!s.motion_active&&s.pending_action==0)?;
            self.call(9,Command::Permit{enabled:false,lease_ms:0})?;
            let after=self.archive(9,1,0,None)?.data;
            if after!=saved{return Err("RAM mode/target tasks modified W25 archive".into());}
            let current_cfg=self.call(9,Command::HomingConfigRead)?.homing_config;
            if current_cfg!=Some(cfg){return Err("Mode test changed independent shared homing config".into());}
            self.log.push(serde_json::json!({"mode_suite_pass":true,"archive_unchanged_during_tasks":true,"shared_home_unchanged":true}));
            std::fs::write(&self.path,serde_json::to_vec_pretty(&self.log).unwrap()).map_err(|e|e.to_string())?;Ok(())
        }
    }
    #[test]
    #[ignore="Real M9 motion/storage; requires MOTO_REBUILD_HIL=storage|motion and explicit ports"]
    fn hardware_m9_acceptance(){
        let scenario=std::env::var("MOTO_REBUILD_HIL").expect("Explicit scenario required");
        assert!(["dualcore_rtmi","dualcore","storage","motion","safety","partition","travel","jog","jog_home","configuration","homing_policy","initialization","pi_calibration","rtmi","rtmi_preflight","rtmi_dump","enable_entry","uart_isolation","passive_state","passive_watch","config_probe","mode_apply","apply_idle","board_policy","modes","four_tasks","contact_online","pi_overshoot","jog_coast","recovery_idle"].contains(&scenario.as_str()));
        let port=std::env::var("MOTO_STORAGE_RS485").unwrap_or("COM10".into());
        let mode=std::env::var("MOTO_HIL_MODE").unwrap_or("main485".into());
        let baud=if mode=="maincan"{2000000}else{1500000};
        let serial=serialport::new(port,baud).timeout(Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
        let path=std::env::var("MOTO_COMMISSION_REPORT").expect("Evidence path required");
        let mut h=Hil{t:Transport::new(serial,&mode,9),q:Request{request_id:0,boot_id:"0".into(),session_id:0,task_id:0,command:Command::GetState},log:vec![],path};
        if scenario=="passive_state" {
            h.call(0,Command::GetState).unwrap();h.q.boot_id="0".into();
            h.call(9,Command::GetState).unwrap();return;
        }
        if scenario=="passive_watch" {
            // Zero-session discovery may coexist with the other transport's
            // controller. Never OPEN/PULSE/PERMIT, write a register, or STOP it.
            for _ in 0..40 {
                h.q.boot_id="0".into();h.q.session_id=0;h.q.task_id=0;
                h.call(0,Command::GetState).unwrap();
                h.q.task_id=0;h.call(9,Command::PositionState).unwrap();
                let bits=h.t.call(0,10,&[74,2]).unwrap();assert_eq!(bits.len(),4);
                h.log.push(serde_json::json!({"validity_bitmap":bits,"read_only":true}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).unwrap();
                thread::sleep(Duration::from_millis(250));
            }
            return;
        }
        let d=h.call(0,Command::GetState).unwrap();h.q.boot_id=d.boot_id;
        h.q.request_id=d.device.unwrap().request_floor;h.q.session_id=0x52454232;
        h.call(0,Command::Open).unwrap();
        let result=(||->Result<(),String>{
            if scenario=="dualcore_rtmi" {
                let initial=h.call(9,Command::GetState)?.motor.ok_or("No M9")?;
                if initial.drive!=0||initial.motion_active||initial.fault!=0{return Err("RTMI requires disabled M9".into());}
                let saved=h.storage(1,0x7a0001)?;
                let capture=(||->Result<(),String>{
                    for sampling in [11u8,9,7] {
                        h.call(9,Command::RtmiConfig{enabled:true,sampling,addresses:[0x154,0x153,0x155,0x251,65535,65535,65535],decimation:1})?;
                        {
                            let deadline=Instant::now()+Duration::from_secs(10);
                            loop { thread::sleep(Duration::from_millis(50));h.call(0,Command::Pulse)?;
                                let r=h.call(9,Command::GetState)?;
                                if !r.pending {break;}if Instant::now()>deadline{return Err("RTMI configuration deadline".into());}
                            }
                        }
                        let start=h.call(9,Command::RtmiState{cursor:u32::MAX})?.rtmi.ok_or("No RTMI start")?;
                        if start[16]!=1||start[17]!=sampling{return Err("RTMI start configuration not active".into());}
                        let seq=u32::from_le_bytes(start[0..4].try_into().unwrap());let at=Instant::now();
                        for _ in 0..10 {thread::sleep(Duration::from_millis(500));h.call(0,Command::Pulse)?;}
                        let end=h.call(9,Command::RtmiState{cursor:u32::MAX})?.rtmi.ok_or("No RTMI end")?;
                        if start[12..16]!=end[12..16]||end[16]!=1||end[17]!=sampling{return Err("RTMI generation/configuration changed during measurement".into());}
                        let elapsed=at.elapsed().as_secs_f64();let total=u32::from_le_bytes(end[0..4].try_into().unwrap()).wrapping_sub(seq);
                        let errors=u32::from_le_bytes(end[8..12].try_into().unwrap());let hz=total as f64/4.0/elapsed;
                        h.log.push(serde_json::json!({"dualcore_rtmi_sampling":sampling,"channel_hz":hz,"samples":total,"seconds":elapsed,"crc_errors":errors,"motion_sent":false,"download_ring_intentionally_not_drained":true}));
                        if errors!=0||hz<1800.0{return Err(format!("RTMI rate/error failure: {hz} Hz, {errors} errors"));}
                        h.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1})?;
                        {
                            let deadline=Instant::now()+Duration::from_secs(10);
                            loop { thread::sleep(Duration::from_millis(50));h.call(0,Command::Pulse)?;
                                let r=h.call(9,Command::GetState)?;
                                if !r.pending {break;}if Instant::now()>deadline{return Err("RTMI configuration deadline".into());}
                            }
                        }
                    }
                    Ok(())
                })();
                let stopped=h.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1});
                if stopped.is_ok(){{
                            let deadline=Instant::now()+Duration::from_secs(10);
                            loop { thread::sleep(Duration::from_millis(50));h.call(0,Command::Pulse)?;
                                let r=h.call(9,Command::GetState)?;
                                if !r.pending {break;}if Instant::now()>deadline{return Err("RTMI configuration deadline".into());}
                            }
                        }}
                capture?;stopped?;
                let after=h.storage(1,0x7a0002)?;
                if after.data!=saved.data||after.generation!=saved.generation{return Err("RTMI changed W25".into());}
                return Ok(());
            }
            if scenario=="dualcore" {
                let initial=h.call(9,Command::PositionState)?.motor.ok_or("No M9")?;
                if initial.fault!=0||initial.motion_active {return Err("M9 not idle".into());}
                let policy=h.call(9,Command::HomingConfigRead)?.homing_config.ok_or("No home policy")?;
                h.log.push(serde_json::json!({"unchanged_homing_policy":policy}));
                if !initial.span_valid {
                    h.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
                    h.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                    h.wait(160,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh)?;
                }
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                h.wait_idle(15,|s|s.drive==0&&!s.motion_active)?;
                return Ok(());
            }
            if scenario=="jog_coast" {return h.jog_coast_suite();}
            if scenario=="pi_overshoot" {return h.pi_overshoot_suite();}
            if scenario=="contact_online" {
            return h.contact_online_suite();
        }
        if scenario=="four_tasks" {return h.four_task_suite();}
            if scenario=="config_probe" {
                  let old=h.call(9,Command::GetState)?.motor.ok_or("No M9")?;
                  if old.motion_active {return Err("Motor moving".into());}
                  if old.fault!=0 {h.call(9,Command::ClearFault)?;}
                  h.call(9,Command::Commission{action:1})?;
                  h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                  for i in 0..8 {let _=h.storage(1,0x799000+i)?;h.call(0,Command::Pulse)?;}
                  h.wait_idle(5,|s|s.feedback_fresh&&s.config_verified)?;
                  for mode in [0u8,1,0,1] {
                      h.call(0,Command::Pulse)?;
                      h.call(9,Command::TaskSpeed{velocity_raw:610839,mode})?;
                      h.wait_idle(15,|s|s.drive==0&&s.mode==mode&&s.limits_valid)?;
                  }
                  let _original=h.storage(1,0x799100)?;
                  let snapshot=h.call(9,Command::GetState)?.motor.ok_or("No before apply")?;
                  let public=h.archive(0,1,0,None)?;
                  let maximum=u32::from_le_bytes(public.data[36..40].try_into().unwrap());
                  let ceiling=(28730u64*1099511627776/3600000000) as u32;
                  // Explicit test configuration: persist the user's long-term
                  // 28730rpm setting, then exercise task edits without motion.
                  for (i,(mode,rpm)) in [(0u32,2000u64),(1,15000),(2,500),(3,15000),(0,15000),(1,15000)].into_iter().enumerate() {
                      let before=h.storage(1,0x799110+i as u32*2)?;
                      let mut expected=before.data.clone();
                      let speed=(rpm*1099511627776/3600000000) as u32;
                      expected[60..64].copy_from_slice(&ceiling.to_le_bytes());
                      expected[52..56].copy_from_slice(&(if mode==0{speed}else{ceiling}).to_le_bytes());
                      expected[112..116].copy_from_slice(&speed.to_le_bytes());
                      expected[104..108].copy_from_slice(&mode.to_le_bytes());
                      let mut payload=before.data[120..124].to_vec();
                      payload.extend_from_slice(&expected[28..64]);payload.extend_from_slice(&expected[68..120]);
                      h.call(9,Command::ApplyConfiguration{payload})?;
                      let v=h.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                      if !v.logic_power||v.align_valid!=snapshot.align_valid||v.span_valid!=snapshot.span_valid||v.fault!=0 {
                          return Err(format!("Apply changed power/qualification: {v:?}"));
                      }
                      let after=h.storage(1,0x799111+i as u32*2)?;
                      if after.data[12..120]!=expected[12..120] {return Err("Independent W25 mismatch".into());}
                      h.log.push(serde_json::json!({"verified_mode":mode,"verified_task_rpm":rpm,"public_maximum_rpm":maximum,"long_term_rpm":28730,"motion_sent":false}));
                  }
                  for mode in [0u8,1,2,3] {
                      h.call(0,Command::Pulse)?;
                      h.call(9,Command::TaskSpeed{velocity_raw:4581298,mode})?;
                      h.wait_idle(15,|s|s.drive==0&&s.mode==mode&&s.limits_valid)?;
                  }
                  h.call(9,Command::TaskSpeed{velocity_raw:4581298,mode:1})?;
                  h.wait_idle(15,|s|s.drive==0&&s.mode==1&&s.limits_valid)?;
                  h.log.push(serde_json::json!({"config_probe":true,"motion_sent":false,"saved_task_rpm":15000,"saved_long_term_rpm":28730,"saved_mode":1,"original_profile_logged":true}));
                  std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                  return Ok(());
              }
              if scenario=="modes" { return h.mode_suite(); }
            if scenario=="board_policy" {
                let mut archives=Vec::new();
                for m in 1..=16 {
                    match h.archive(m,1,0,None) {
                        Ok(r)=>archives.push(Some(r.data)),
                        Err(e) if e.contains("result=-4")=>archives.push(None),
                        Err(e)=>return Err(e),
                    }
                }
                h.call(9,Command::Commission{action:1})?;
                let before=h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                let old=h.archive(0,1,0,None)?;let mut next=old.data.clone();
                next[36..40].copy_from_slice(&28730u32.to_le_bytes());
                let crc=crate::motor_profile::crc32(&next[..120]);
                next[120..124].copy_from_slice(&crc.to_le_bytes());
                h.archive(0,3,0,Some(&next))?;
                let actual=h.archive(0,1,0,None)?;
                if actual.data[8..64]!=next[8..64]{return Err("Public config readback differs".into());}
                for m in 1..=16 {
                    match (&archives[m-1],h.archive(m as u8,1,0,None)) {
                        (Some(saved),Ok(r)) if *saved==r.data=>{},
                        (None,Err(e)) if e.contains("result=-4")=>{},
                        _=>return Err(format!("Public speed edit changed motor M{m} archive")),
                    }
                }
                let after=h.call(9,Command::GetState)?.motor.ok_or("No post-policy state")?;
                if !after.logic_power||!after.config_verified||after.align_valid!=before.align_valid||
                    after.span_valid!=before.span_valid{return Err("Policy edit invalidated motor state".into());}
                h.call(0,Command::Close)?;
                // No semantic pulse / permit / motion for more than the lease.
                thread::sleep(Duration::from_secs(4));
                let closed=h.call(9,Command::GetState)?.motor.ok_or("No closed state")?;
                if !closed.logic_power||!closed.config_verified||closed.drive!=0||closed.motion_active||closed.permit||closed.fault!=0 {
                    return Err(format!("Disconnect failed to preserve TMC power: {closed:?}"));
                }
                h.log.push(serde_json::json!({"board_policy":true,"maximum_rpm":28730,"motor_archives_unchanged":16,
                    "disconnect_power_retained":true,"motion_sent":false,"closed":closed}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }
            if scenario=="uart_isolation" {
                h.call(9,Command::Commission{action:1})?;
                h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                h.call(1,Command::Commission{action:1})?;
                let end=Instant::now()+Duration::from_secs(10);
                let failed=loop {
                    h.call(0,Command::Pulse)?;
                    let v=h.call(1,Command::GetState)?.motor.ok_or("No M1 state")?;
                    if v.drive!=1&&v.pending_action==0 {break v;}
                    if Instant::now()>end{return Err("M1 timeout did not complete".into());}
                    std::thread::sleep(Duration::from_millis(100));
                };
                if failed.last_error!=13||failed.logic_power||failed.drive!=0{return Err(format!("Unexpected absent M1 result: {failed:?}"));}
                let end=Instant::now()+Duration::from_secs(8);let mut checks=0;
                while Instant::now()<end {
                    h.call(0,Command::Pulse)?;
                    let v=h.call(9,Command::GetState)?.motor.ok_or("No M9 state")?;
                    if v.fault!=0||v.last_error!=0||!v.logic_power||!v.config_verified||v.drive!=0||v.motion_active{return Err(format!("M1 affected M9: {v:?}"));}
                    if v.feedback_fresh {checks+=1;}
                    std::thread::sleep(Duration::from_millis(200));
                }
                if checks<10{return Err("M9 feedback did not remain fresh".into());}
                // Reinitialization cleanup must also ignore other UART quarantine bits.
                h.call(9,Command::Commission{action:1})?;
                let ready=h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                if !ready.logic_power||ready.fault!=0{return Err("M9 warm init affected by absent M1".into());}
                h.log.push(serde_json::json!({"uart_isolation_verified":true,"absent_motor":1,"healthy_motor":9,"fresh_checks":checks,"motion_sent":false}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }
            if scenario=="recovery_idle" {
                let before=h.call(9,Command::GetState)?.motor.ok_or("No M9")?;
                if before.drive!=0||before.motion_active{return Err("Recovery test requires disabled M9".into());}
                if before.fault==0 {h.call(9,Command::EStop)?;thread::sleep(Duration::from_millis(500));}
                let latched=h.call(9,Command::GetState)?.motor.ok_or("No fault snapshot")?;
                if latched.fault==0{return Err("No latch to clear".into());}
                h.call(9,Command::ClearFault)?;
                let end=Instant::now()+Duration::from_secs(25);
                loop {
                    h.call(0,Command::Pulse)?;let r=h.call(9,Command::GetState)?;
                    let s=r.motor.ok_or("No recovery snapshot")?;
                    if !r.pending&&s.drive!=1&&s.pending_action==0 {
                        if s.fault!=0||s.last_error!=0||s.permit||s.drive!=0||!s.logic_power||!s.config_verified||!s.align_valid {
                            return Err(format!("Recovery not verified: {s:?}"));}
                        if s.align_valid!=before.align_valid||s.span_valid!=before.span_valid||
                           s.home_neg_valid!=before.home_neg_valid||s.home_pos_valid!=before.home_pos_valid||
                           s.negative_contact!=before.negative_contact||s.positive_contact!=before.positive_contact {
                            return Err(format!("Recovery destroyed boot-local calibration: before={before:?} after={s:?}"));
                        }
                        h.log.push(serde_json::json!({"recovery_verified":true,"motion_sent":false,"state":s}));break;
                    }
                    if Instant::now()>end{return Err("Recovery timeout".into());}thread::sleep(Duration::from_millis(100));
                }
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;return Ok(());
            }
            if scenario=="mode_apply" {
                // Configuration only: gate stays OFF; never authorize or move.
                let state=h.call(9,Command::GetState)?.motor.ok_or("No M9")?;
                if state.motion_active||state.drive!=0||state.fault!=0{return Err("M9 must be stopped and disabled".into());}
                if !state.config_verified {
                    h.call(9,Command::Commission{action:1})?;
                    h.wait_configuration()?;
                }
                let original=h.storage(1,0)?;
                let snapshot=h.call(9,Command::GetState)?.motor.ok_or("No initial state")?;
                for mode in [0u32,1,2,3,0,1] {
                    let before=h.storage(1,0)?;
                    let mut expected=before.data.clone();
                    expected[104..108].copy_from_slice(&mode.to_le_bytes());
                    let task=u32::from_le_bytes(expected[112..116].try_into().unwrap());
                    let ceiling=u32::from_le_bytes(expected[60..64].try_into().unwrap());
                    expected[52..56].copy_from_slice(&(if mode==0{task}else{ceiling}).to_le_bytes());
                    let mut payload=before.data[120..124].to_vec();
                    payload.extend_from_slice(&expected[28..64]);payload.extend_from_slice(&expected[68..120]);
                    h.call(9,Command::ApplyConfiguration{payload})?;
                    let v=h.wait_configuration()?;
                    if v.mode!=mode as u8||!v.logic_power||v.align_valid!=snapshot.align_valid||v.span_valid!=snapshot.span_valid {
                        return Err(format!("Mode apply changed validity: {v:?}"));
                    }
                    let after=h.storage(1,0)?;
                    if after.data[12..120]!=expected[12..120]{return Err("W25 readback differs".into());}
                }
                let before=h.storage(1,0)?;let mut payload=before.data[120..124].to_vec();
                payload.extend_from_slice(&original.data[28..64]);payload.extend_from_slice(&original.data[68..120]);
                h.call(9,Command::ApplyConfiguration{payload})?;
                h.wait_configuration()?;
                if h.storage(1,0)?.data!=original.data{return Err("Original profile not restored".into());}
                h.log.push(serde_json::json!({"mode_apply":true,"motion_sent":false,"restored":true}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }
            if scenario=="apply_idle" {
                h.call(9,Command::Commission{action:1})?;
                h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                let original=h.storage(1,0x791001)?;
                let snapshot=h.call(9,Command::GetState)?.motor.ok_or("No original state")?;
                let mut rejected=original.data[120..124].to_vec();
                let public=h.archive(0,1,0,None)?;
                let ceiling=u32::from_le_bytes(public.data[36..40].try_into().unwrap());
                let excessive=((u64::from(ceiling)*1099511627776/3600000000)+1) as u32;
                let mut high=original.data.clone();high[52..56].copy_from_slice(&excessive.to_le_bytes());
                rejected.extend_from_slice(&high[28..60]);rejected.extend_from_slice(&high[68..120]);
                h.call(9,Command::ApplyConfiguration{payload:rejected})?;
                let end=Instant::now()+Duration::from_secs(10);
                loop {
                    h.call(0,Command::Pulse)?;let v=h.call(9,Command::GetState)?.motor.ok_or("No rejected state")?;
                    if v.drive!=1&&v.pending_action==0 {
                        if v.last_error!=6||!v.config_verified||!v.logic_power||v.align_valid!=snapshot.align_valid||v.span_valid!=snapshot.span_valid {
                            return Err(format!("Rejection destroyed evidence: {v:?}"));}
                        break;
                    }
                    if Instant::now()>end{return Err("Reject wait timeout".into());}thread::sleep(Duration::from_millis(100));
                }
                for (i,mode) in [0u32,1u32].into_iter().enumerate() {
                    let before=h.storage(1,0x791010+i as u32)?;
                    let mut expected=before.data.clone();
                    expected[52..56].copy_from_slice(&458129u32.to_le_bytes());
                    expected[104..108].copy_from_slice(&mode.to_le_bytes());
                    let mut payload=before.data[120..124].to_vec();payload.extend_from_slice(&expected[28..60]);payload.extend_from_slice(&expected[68..120]);
                    h.call(9,Command::ApplyConfiguration{payload})?;
                    let v=h.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                    if !v.logic_power||v.mode!=mode as u8||v.align_valid!=snapshot.align_valid||v.span_valid!=snapshot.span_valid||
                       v.negative_contact!=snapshot.negative_contact||v.positive_contact!=snapshot.positive_contact {
                        return Err(format!("Apply failed or changed frame: {v:?}"));}
                }
                let current=h.storage(1,0x791020)?;
                let mut payload=current.data[120..124].to_vec();payload.extend_from_slice(&original.data[28..60]);payload.extend_from_slice(&original.data[68..120]);
                h.call(9,Command::ApplyConfiguration{payload})?;h.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                let restored=h.storage(1,0x791021)?;
                if restored.data!=original.data{return Err("Profile restore differs".into());}
                h.log.push(serde_json::json!({"apply_idle":true,"motion_sent":false,"restored":true}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;return Ok(());
            }
            // Exact main-mode top-right entry: no storage transaction or motion.
            if scenario=="enable_entry" {
                h.call(9,Command::GetState)?;
                h.call(9,Command::Commission{action:1})?;
                let v=h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                if !v.logic_power||v.motion_active||v.permit{return Err(format!("Unexpected enable-entry state: {v:?}"));}
                h.log.push(serde_json::json!({"enable_entry_verified":true,"motion_sent":false,"state":v}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }
            if scenario=="rtmi_dump" {h.call(9,Command::GetState)?;h.call(9,Command::RtmiState{cursor:0})?;return Ok(());}
            if scenario=="rtmi_preflight" {
                let v=h.call(9,Command::GetState)?.motor.ok_or("No M9 state")?;
                if v.drive!=0||v.motion_active||v.permit||v.velocity_raw.abs()>1000||v.fault!=0{return Err(format!("Not safely idle: {v:?}"));}
                return Ok(());
            }
            if scenario=="rtmi" {
                let v=h.call(9,Command::GetState)?.motor.ok_or("No M9 state")?;
                if v.drive!=0||v.motion_active||v.permit||v.fault!=0{return Err("RTMI requires disabled M9".into());}
                let archive=h.storage(1,0x770001)?;
                h.call(9,Command::Commission{action:1})?;
                h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                let mut channels=[65535;7];channels[..4].copy_from_slice(&[0x154,0x153,0x155,0x251]);
                h.call(9,Command::RtmiConfig{enabled:true,sampling:255,addresses:channels,decimation:if mode=="maincan"{12}else{2}})?;
                h.wait_idle(10,|s|s.drive==0&&s.config_verified)?;
                let result=(||->Result<(),String>{
                    let end=Instant::now()+Duration::from_secs(if mode=="maincan"{30}else{12});let mut cursor=0;let mut counts=[0u32;7];
                    let mut pulse=Instant::now();let mut tuned=false;let mut errors=0;let mut lost=0;
                    while Instant::now()<end {
                        if pulse.elapsed()>Duration::from_millis(200){
                            h.call(0,Command::Pulse)?;
                            let v=h.call(9,Command::GetState)?.motor.ok_or("No live state")?;
                            if v.fault!=0||v.drive!=0||v.motion_active{return Err(format!("RTMI disturbed motor: {v:?}"));}
                            pulse=Instant::now();
                        }
                        let data=h.call(9,Command::RtmiState{cursor})?.rtmi.ok_or("No native RTMI")?;
                        cursor=u32::from_le_bytes(data[0..4].try_into().unwrap());
                        lost+=u32::from_le_bytes(data[4..8].try_into().unwrap());
                        errors=u32::from_le_bytes(data[8..12].try_into().unwrap());
                        if data[16]!=1||data[17]!=255||data[18]!=15{return Err("RTMI configuration not verified".into());}
                        for i in 0..data[19] as usize{counts[data[24+i*9] as usize]+=1;}
                        if !tuned&&counts[0]>50 {
                            let word=|i|u32::from_le_bytes(archive.data[i..i+4].try_into().unwrap());
                            h.call(9,Command::PiTune{group:1,expected_config:word(28),coefficients:[word(32),word(36),word(40),word(44)]})?;
                            h.wait_idle(10,|s|s.pending_action==0&&s.config_verified)?;tuned=true;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    h.log.push(serde_json::json!({"native_rtmi":true,"samples":counts,"lost":lost,"crc_sync_errors":errors,"live_pi_same_value_verified":tuned,"motion_sent":false}));
                    if counts[..4].iter().any(|n|*n<100)||errors!=0||lost!=0||!tuned{return Err(format!("RTMI quality failure {counts:?}, errors={errors}"));}
                    Ok(())
                })();
                let stop=h.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1});
                if stop.is_ok(){h.wait_idle(10,|s|s.drive==0)?;}
                result?;stop?;
                let stopped=h.call(9,Command::RtmiState{cursor:0})?.rtmi.ok_or("No stop status")?;
                if stopped[16]!=0{return Err("RTMI still enabled".into());}
                let after=h.storage(1,0x770002)?;
                if after.data!=archive.data||after.generation!=archive.generation{return Err("RTMI modified W25 archive".into());}
                return Ok(());
            }
            if scenario=="jog"{return h.jogging();}
            if scenario=="homing_policy" {
                let original=h.call(9,Command::HomingConfigRead)?.homing_config.ok_or("No policy")?;
                let mut edit=original;edit[6]=if edit[6]==2001{2002}else{2001};
                let result=(||->Result<(),String>{
                    let written=h.call(9,Command::HomingConfigWrite{config:edit})?;
                    if written.homing_config!=Some(edit){return Err("Policy commit differs".into());}
                    for m in [1,9,16] {if h.call(m,Command::HomingConfigRead)?.homing_config!=Some(edit){return Err("Policy not shared".into());}}
                    if h.call(16,Command::HomingConfigWrite{config:[0;8]}).is_ok(){return Err("Invalid policy accepted".into());}
                    if h.call(9,Command::HomingConfigRead)?.homing_config!=Some(edit){return Err("Invalid write changed policy".into());}
                    Ok(())
                })();
                thread::sleep(Duration::from_millis(1100)); // board Flash write throttle
                let restore:[u16;8]=std::env::var("MOTO_HOME_RESTORE").ok()
                    .map(|x|serde_json::from_str(&x).expect("Explicit restore array")).unwrap_or(original);
                let restored=h.call(9,Command::HomingConfigWrite{config:restore})?;
                if restored.homing_config!=Some(restore)||h.call(16,Command::HomingConfigRead)?.homing_config!=Some(restore){return Err("Policy restore failed".into());}
                result?;
                h.log.push(serde_json::json!({"shared_homing_policy":true,"original":original,"tested":edit,"restored":true,"restored_config":restore,"motion_sent":false}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }

            if scenario=="initialization" {
                let before=h.storage(1,0x750001)?;
                h.call(9,Command::Commission{action:1})?;
                let applied=h.wait(20,|s|s.drive==0&&s.config_verified&&s.limits_valid&&s.pending_action==0)?;
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                let after=h.storage(1,0x750002)?;
                if before.data!=after.data||before.generation!=after.generation {return Err("Initialization changed tuned archive".into());}
                let iq=u32::from_le_bytes(before.data[48..52].try_into().unwrap())>>16;
                let velocity=u32::from_le_bytes(before.data[52..56].try_into().unwrap());
                if applied.effective_iq_raw!=iq||applied.effective_velocity_raw!=velocity {return Err("Archive limits not installed".into());}
                h.log.push(serde_json::json!({"archive_priority":true,"before":before,"after":after,"applied":applied,"motion_sent":false}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }
            if scenario=="pi_calibration" {
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                let before=h.storage(1,0x760001)?;
                h.call(9,Command::Commission{action:1})?;
                let initial=h.wait_idle(30,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                let enc=h.call(9,Command::EncoderState)?.encoder.ok_or("Missing encoder cache")?;
                if enc[1]!=1||enc[4]&65535!=u32::from_le_bytes(before.data[20..24].try_into().unwrap()){return Err("Offset cache differs".into());}
                let masks=h.t.call(0,10,&[74,2]).map_err(|e|e.to_string())?;
                if masks.len()!=4{return Err("Status mask size".into());}
                let encoder=u16::from_be_bytes([masks[0],masks[1]])&(1<<8)!=0;
                let homed=u16::from_be_bytes([masks[2],masks[3]])&(1<<8)!=0;
                if encoder!=initial.align_valid||homed!=initial.span_valid{return Err("Register/semantic validity mismatch".into());}
                let config=u32::from_le_bytes(before.data[28..32].try_into().unwrap());
                let mut coefficients=[0;4];for i in 0..4 {coefficients[i]=u32::from_le_bytes(before.data[32+4*i..36+4*i].try_into().unwrap());}
                let saved_coefficients=coefficients;coefficients[1]^=1;
                h.wait_idle(5,|s|s.feedback_fresh&&s.drive==0)?;
                h.call(9,Command::PiTune{group:0,expected_config:config,coefficients})?;
                h.wait_idle(5,|s|s.drive==0&&s.config_verified&&s.pending_action==0)?;
                let live_archive=h.storage(1,0x760002)?;
                if live_archive.data!=before.data||live_archive.generation!=before.generation{return Err("Live PI modified W25".into());}
                h.wait_idle(5,|s|s.feedback_fresh&&s.drive==0)?;
                h.call(9,Command::PiTune{group:0,expected_config:config,coefficients:saved_coefficients})?;
                h.wait_idle(5,|s|s.drive==0&&s.config_verified&&s.pending_action==0)?;
                let mut edited=before.data.clone();edited[36]^=1;
                let mut payload=before.data[120..124].to_vec();payload.extend(&edited[28..60]);payload.extend(&edited[68..120]);
                h.call(9,Command::ApplyConfiguration{payload})?;
                h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                let after=h.storage(1,0x760003)?;
                if after.data[28..60]!=edited[28..60]||after.generation==before.generation{return Err("Apply/save readback mismatch".into());}
                thread::sleep(Duration::from_millis(1100));
                let mut payload=after.data[120..124].to_vec();payload.extend(&before.data[28..60]);payload.extend(&before.data[68..120]);
                h.call(9,Command::ApplyConfiguration{payload})?;
                let final_state=h.wait_idle(20,|s|s.drive==0&&s.config_verified&&s.limits_valid)?;
                let restored=h.storage(1,0x760004)?;
                if restored.data[12..120]!=before.data[12..120]{return Err("Original PI restore mismatch".into());}
                h.log.push(serde_json::json!({"pi_and_calibration":true,"initial":initial,"register_masks":masks,"encoder_cache":enc,"before":before,"live_archive":live_archive,"after":after,"restored":restored,"final_state":final_state,"motion_sent":false}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;return Ok(());
            }
            h.call(9,Command::Commission{action:1})?;
            h.wait(15,|s|s.drive==0&&s.config_verified)?;
            if scenario=="configuration" {
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                let before=h.storage(1,0x740001)?;
                let mut profile=crate::motor_profile::Profile::decode(&before.data,9,9,
                    u32::from_le_bytes(before.data[64..68].try_into().unwrap())).map_err(|e|format!("{e:?}"))?;
                profile.words[7]=(2483u32<<16)|(profile.words[7]&65535);
                profile.words[8]=610839;
                profile.run=[0x314e5552,667,667,2980,180,60,1000,5000,65536,1,2,0,1];
                let expected=profile.encode().map_err(|e|format!("{e:?}"))?;
                h.archive(9,3,0x740002,Some(&expected))?;
                let after=h.storage(1,0x740003)?;
                if after.data[12..120]!=expected[12..120]{return Err("W25 RUN1 readback mismatch".into());}
                h.call(9,Command::Commission{action:1})?;
                let applied=h.wait(20,|s|s.config_verified&&s.limits_valid&&s.drive==0&&s.pending_action==0)?;
                if applied.effective_iq_raw!=2483||applied.effective_velocity_raw!=610839||applied.mode!=1||!applied.logic_power {
                    return Err(format!("Saved configuration not installed: {applied:?}"));
                }
                h.log.push(serde_json::json!({"unified_configuration":true,"before":before,"after":after,"applied":applied}));
                std::fs::write(&h.path,serde_json::to_vec_pretty(&h.log).unwrap()).map_err(|e|e.to_string())?;
                return Ok(());
            }
            if scenario=="partition" {
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                let common=h.archive(0,1,0x720001,None)?;
                let motor=h.storage(1,0x720002)?;
                let migrated=h.archive(0,3,0x720003,Some(&common.data))?;
                let check=h.archive(0,1,0x720004,None)?;
                let unchanged=h.storage(1,0x720005)?;
                if migrated.data!=check.data||&check.data[..4]!=b"ENC2"||
                   check.data[8..64]!=common.data[8..64]||motor.data!=unchanged.data||motor.generation!=unchanged.generation {
                    return Err("Common migration altered policy/motor data or independent readback differs".into());
                }
                if common.data==migrated.data&&common.generation!=migrated.generation {
                    return Err("Identical common save advanced journal generation".into());
                }
                if u16::from_le_bytes(check.data[64..66].try_into().unwrap())!=check.hand_id||
                   &check.data[112..120]!=b"HPM6E8Y\0"||&check.data[88..95]!=b"hpm6e8y"||
                   crate::motor_profile::crc32(&check.data[..120])!=u32::from_le_bytes(check.data[120..124].try_into().unwrap()) {
                    return Err("ENC2 metadata/CRC mismatch".into());
                }
                // Canonical policy hash must still initialize the saved M9 PI/offset.
                h.call(9,Command::Commission{action:1})?;
                h.wait(15,|s|s.drive==0&&s.config_verified&&s.align_valid)?;
                return Ok(());
            }
            if scenario=="storage" {
                h.call(9,Command::Permit{enabled:false,lease_ms:0})?;
                let saved=h.storage(1,0x710001)?;
                let backup=h.storage(5,0x710002)?;
                let read=h.storage(4,0x710003)?;
                if saved.data.len()!=128||backup.data[..16]!=read.data[..16]||read.flags&6!=6{return Err("Backup readback or SSI restoration mismatch".into());}
                let offset=u16::from_le_bytes([saved.data[20],saved.data[21]]);
                let decoded_offset=u16::from_le_bytes([read.data[6],read.data[7]]);
                if offset!=decoded_offset{return Err("W25/M24 offset differs".into());}
                return Ok(());
            }
            h.call(9,Command::Permit{enabled:true,lease_ms:3000})?;
            // Explicit RAM configuration commit/readback, then independent start.
            let cfg=[400,1050,50,500,2000,360,2000,60];
            let written=h.call(9,Command::HomingConfigWrite{config:cfg})?;
            let read=h.call(9,Command::HomingConfigRead)?;
            if written.homing_config!=Some(cfg)||read.homing_config!=Some(cfg){return Err("Homing RAM readback mismatch".into());}
            h.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
            let home=h.wait(140,|s|s.drive==0&&s.span_valid&&s.config_verified&&s.feedback_fresh&&s.velocity_raw==0)?;
            let neg:i64=home.negative_contact.parse().map_err(|_|"Bad negative")?;
            let pos:i64=home.positive_contact.parse().map_err(|_|"Bad positive")?;
            let target=home.position.parse::<i64>().map_err(|_|"Bad position")?+4096;
            if !home.coordinate_valid||home.logical_span.as_deref()!=Some((pos-neg).to_string().as_str())||
               home.logical_position.as_deref()!=Some((pos-home.position.parse::<i64>().map_err(|_|"Bad position")?).to_string().as_str()) {
                return Err("MCU coordinate snapshot differs from actual chip endpoints".into());
            }
            let logical=pos-target;
            if scenario=="travel"||scenario=="jog_home" {
                h.call(9,Command::Limits{task_iq_raw:2483,task_velocity_raw:610839,acceleration_raw:667,
                    deceleration_raw:667,trip_iq_raw:2980,over_ms:180,sample_ms:60,
                    feedback_timeout_ms:1000,stop_timeout_ms:5000,margin_counts:65536,fault_action:2})?;
                let applied=h.wait(15,|s|s.limits_valid&&s.pending_action==0)?;
                if applied.effective_velocity_raw!=610839||applied.effective_iq_raw!=2483 {
                    return Err("2000rpm/500mA edit did not take effect".into());
                }
                h.call(9,Command::Mode{mode:1})?;h.wait(15,|s|s.mode==1&&s.limits_valid&&s.pending_action==0)?;
                h.call(9,Command::DriveEnable)?;h.wait(15,|s|s.drive==2)?;
                let span=pos-neg;
                let points=if scenario=="jog_home"{vec![50i64]}else{vec![0i64,50,100,50]};
                for percent in points {
                    let goal=65536+(span-131072)*percent/100;
                    h.call(9,Command::LogicalMove{position:goal.to_string()})?;
                    // Arrival is certified by the MCU trajectory/error/dwell
                    // state, never by a second host-side settling heuristic.
                    let mut peak_velocity=0i64;
                    let arrived=h.wait(55,|s|{
                        peak_velocity=peak_velocity.max(i64::from(s.velocity_raw).abs());
                        s.arrival_phase==Some(4)&&!s.motion_active&&s.pending_action==0&&s.feedback_fresh&&
                            s.logical_position.as_ref().and_then(|x|x.parse::<i64>().ok()).map(|x|(x-goal).abs()<=i64::from(s.arrival_tolerance.unwrap_or(0))).unwrap_or(false)
                    })?;
                    if !arrived.logic_power{return Err("Normal position completion cut logic power".into());}
                    h.log.push(serde_json::json!({"travel_percent":percent,"goal":goal,"peak_velocity_raw":peak_velocity,"arrived":arrived}));

                }
                h.call(9,Command::Stop{after:2})?;h.wait(10,|s|s.drive==0&&s.pending_action==0&&!s.motion_active&&s.velocity_raw==0)?;
                return h.jogging();
            }
            if target<=neg+182||target>=pos-182{return Err("Near-end test target outside margin".into());}
            // Conservative 100rpm/500mA motion, independent overcurrent.
            h.call(9,Command::Limits{task_iq_raw:2483,task_velocity_raw:30541,acceleration_raw:667,
                deceleration_raw:667,trip_iq_raw:2980,over_ms:180,sample_ms:60,
                feedback_timeout_ms:1000,stop_timeout_ms:3000,margin_counts:182,fault_action:2})?;
            h.wait(15,|s|s.limits_valid&&s.pending_action==0)?;
            h.call(9,Command::Mode{mode:1})?;h.wait(15,|s|s.mode==1&&s.limits_valid&&s.pending_action==0)?;
            h.call(9,Command::DriveEnable)?;h.wait(15,|s|s.drive==2)?;
            if !matches!(h.call(9,Command::LogicalMove{position:"0".into()}),Err(e) if e.contains("OUT_OF_RANGE")) {
                return Err("Hard-contact logical target was not rejected".into());
            }
            h.call(9,Command::LogicalMove{position:logical.to_string()})?;
            h.wait(15,|s|s.position.parse::<i64>().map(|p|(p-target).abs()<182).unwrap_or(false)&&
                s.logical_position.as_ref().and_then(|x|x.parse::<i64>().ok()).map(|x|(x-logical).abs()<182).unwrap_or(false))?;
            h.call(9,Command::Stop{after:2})?;h.wait(10,|s|s.drive==0&&s.pending_action==0&&!s.motion_active)?;
            if scenario=="safety" {
                h.wait(10,|s|s.drive==0&&s.velocity_raw==0)?;
                h.call(9,Command::DriveEnable)?;h.wait(15,|s|s.drive==2)?;
                h.call(9,Command::LogicalWork{a:(pos-target-2048).to_string(),b:(pos-target-4096).to_string(),dwell_ms:0,cycles:10})?;
                h.wait(5,|s|s.motion_active&&s.motion_owner==5)?;
                h.call(9,Command::Stop{after:2})?;
                h.wait(10,|s|s.drive==0&&!s.motion_active&&s.pending_action==0&&s.velocity_raw==0)?;
                h.call(9,Command::Mode{mode:1})?;
                h.wait(15,|s|s.mode==1&&s.limits_valid&&s.pending_action==0)?;
                h.call(9,Command::DriveEnable)?;h.wait(15,|s|s.drive==2)?;
                // Renew session/permit only: the distinct jog lease must expire.
                h.call(9,Command::JogStart{velocity_raw:6108,lease_ms:500})?;
                h.wait(10,|s|!s.motion_active&&s.pending_action==0&&s.mode==0)?;
                h.call(9,Command::Stop{after:2})?;
                h.wait(10,|s|s.drive==0&&!s.motion_active&&s.velocity_raw==0)?;
                h.call(9,Command::Mode{mode:1})?;
                h.wait(15,|s|s.mode==1&&s.limits_valid&&s.pending_action==0)?;
                h.call(9,Command::DriveEnable)?;h.wait(15,|s|s.drive==2)?;
                h.call(9,Command::JogStart{velocity_raw:6108,lease_ms:1000})?;
                // No host packets at all: MCU must expire the session itself.
                thread::sleep(Duration::from_secs(4));
                let s=h.call(9,Command::GetState)?.motor.ok_or("No post-disconnect snapshot")?;
                if s.drive!=0||s.motion_active||s.permit||s.fault!=0 {
                    return Err(format!("Disconnect did not safely disable: {s:?}"));
                }
            }
            Ok(())
        })();
        let _=h.call(9,Command::Permit{enabled:false,lease_ms:0});let _=h.call(0,Command::Close);
        // Close/permit revoke stop through the MCU. An assertion deadline alone
        // is not an electrical emergency; do not cut MAX20087 logic power here.
        // MCU fault handling still owns the emergency power-off fallback.
        assert!(result.is_ok(),"{result:?}");
    }
}
