//! Explicit real-board test through the viewer's production codec/transport.
#[cfg(test)] mod tests {
    use crate::{gateway::Transport,semantic_control::{self as sc,Command,Request,Response}};
    use std::{thread,time::{Duration,Instant}};
    struct Client { wire:Transport,q:Request,records:Vec<serde_json::Value>,path:String }
    impl Client {
        fn live_pi(&mut self)->Result<(u32,[u32;4]),String>{
            self.call(9,Command::RtmiConfig{enabled:true,sampling:255,addresses:[0x140,0x142,0x143,0x145,0x146,65535,65535],decimation:4})?;
            self.wait()?;
            let result=(||->Result<(u32,[u32;4]),String>{
                let end=Instant::now()+Duration::from_secs(3);let mut cursor=0;let mut values=[None;5];
                while values.iter().any(Option::is_none){
                    let b=self.call(9,Command::RtmiState{cursor})?.rtmi.ok_or("No PI RTMI")?;
                    cursor=u32::from_le_bytes(b[..4].try_into().unwrap());
                    if b[4..12].iter().any(|v|*v!=0){return Err("PI RTMI error/loss".into());}
                    for offset in (20..b.len()).step_by(9){let ch=b[offset+4] as usize;if ch<5{values[ch]=Some(u32::from_le_bytes(b[offset+5..offset+9].try_into().unwrap()));}}
                    if Instant::now()>end{return Err("PI snapshot timeout".into());}thread::sleep(Duration::from_millis(10));
                }
                let v=values.map(Option::unwrap);self.records.push(serde_json::json!({"live_pi_rtmi":v}));Ok((v[0],v[1..].try_into().unwrap()))
            })();
            self.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1})?;self.wait()?;
            result
        }
        fn profile(&mut self)->Result<Vec<u8>,String>{
            use crate::split_storage as ss;
            let id=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u32;
            let mut q=ss::Request{id,operation:1,offset:0,data:vec![]};
            let end=Instant::now()+Duration::from_secs(15);
            loop{let b=self.wire.call(9,33,&ss::encode(9,&q)?).map_err(|e|e.to_string())?;let r=ss::decode(9,&q,&b)?;
                if r.phase==4 {if r.result!=0{return Err("Profile read failed".into());}break;}
                if Instant::now()>end{return Err("Profile timeout".into());}
                self.call(0,Command::Pulse)?;thread::sleep(Duration::from_millis(50));q.operation=6;
            }
            let mut data=vec![];
            for offset in [0,106]{q.operation=6;q.offset=offset;let b=self.wire.call(9,33,&ss::encode(9,&q)?).map_err(|e|e.to_string())?;let r=ss::decode(9,&q,&b)?;if r.phase!=4||r.result!=0{return Err("Profile fragment error".into());}data.extend(r.data);}
            if data.len()!=128{return Err("Profile length".into());}Ok(data)
        }
        fn limits_from(&mut self,p:&[u8],acceleration:Option<u32>)->Result<(),String>{
            let w=|i|u32::from_le_bytes(p[i..i+4].try_into().unwrap());
            self.call(9,Command::Limits{task_iq_raw:w(48)>>16,task_velocity_raw:w(52),acceleration_raw:acceleration.unwrap_or(w(72)),deceleration_raw:acceleration.unwrap_or(w(76)),trip_iq_raw:w(80),over_ms:w(84),sample_ms:w(88),feedback_timeout_ms:w(92),stop_timeout_ms:w(96),margin_counts:w(100),fault_action:w(108) as u8})?;
            self.motion_wait(15,|s|s.drive==0&&s.limits_valid)?;Ok(())
        }
        fn call(&mut self,m:u8,c:Command)->Result<Response,String>{
            self.q.request_id+=1;self.q.command=c;
            let bytes=sc::encode(m,&self.q)?;
            let raw=self.wire.call(m,32,&bytes).map_err(|e|e.to_string())?;
            let r=sc::decode(m,&self.q,&raw)?;
            self.records.push(serde_json::json!({"command":format!("{:?}",self.q.command),"response":r}));
            // Append bounded work per reply. Re-serializing the entire growing
            // log here delays RTMI draining and biases measured speed peaks.
            {use std::io::Write;let mut log=std::fs::OpenOptions::new().create(true).append(true).open(format!("{}.jsonl",self.path)).map_err(|e|e.to_string())?;
             writeln!(log,"{}",self.records.last().unwrap()).map_err(|e|e.to_string())?;}
            if r.result!=0{return Err(format!("{} {:?}",r.result_name,r.motor));}
            if m==9&&r.motor.is_some(){self.q.task_id=r.task_id;}
            Ok(r)
        }
        fn motion_wait(&mut self,seconds:u64,accept:impl Fn(&sc::MotorSnapshot)->bool)->Result<sc::MotorSnapshot,String>{
            let end=Instant::now()+Duration::from_secs(seconds);
            loop{thread::sleep(Duration::from_millis(100));self.call(0,Command::Pulse)?;

                let r=self.call(9,Command::PositionState)?;let s=r.motor.ok_or("Missing motor state")?;
                if s.fault!=0||s.last_error!=0{return Err(format!("Motion fault/error {s:?}"));}
                if !r.pending&&s.pending_action==0&&accept(&s){return Ok(s);}
                if Instant::now()>end{return Err("Motion timeout".into());}
            }
        }
        fn center(&mut self)->Result<(),String>{

            let mut s=self.call(9,Command::PositionState)?.motor.ok_or("Missing position")?;
            if !s.coordinate_valid{
                self.call(9,Command::HomingConfigRead)?;
                self.call(9,Command::HomingStart{direction:1,step_unit:100,dual:true})?;
                s=self.motion_wait(150,|s|s.drive==0&&s.span_valid&&s.coordinate_valid&&s.feedback_fresh)?;
            }
            let span=s.logical_span.ok_or("No homed span")?.parse::<i64>().map_err(|_|"Bad span")?;
            self.call(9,Command::TaskSpeed{velocity_raw:152709,mode:1})?;
            self.motion_wait(15,|s|s.drive==0&&s.limits_valid)?;
            self.call(9,Command::DriveEnable)?;self.motion_wait(15,|s|s.drive==2)?;
            self.call(9,Command::LogicalMove{position:(span/2).to_string()})?;
            let s=self.motion_wait(100,|s|!s.motion_active&&s.arrival_phase==Some(4))?;
            let p=s.logical_position.ok_or("No final position")?.parse::<i64>().map_err(|_|"Bad final position")?;
            if (p-span/2).abs()>span/100{return Err("Midpoint not reached".into());}
            self.call(9,Command::Stop{after:2})?;self.motion_wait(15,|s|s.drive==0&&!s.motion_active)?;
            Ok(())
        }
        fn speed_bench(&mut self)->Result<(),String>{
            let profile=self.profile()?;
            let s=self.call(9,Command::PositionState)?.motor.ok_or("No state")?;
            if !s.coordinate_valid||!s.align_valid||s.motion_active{return Err("Bench requires homed idle motor".into());}
            let span=s.logical_span.ok_or("No span")?.parse::<i64>().map_err(|_|"Bad span")?;
            let old_mode=s.mode;
            let acceleration=std::env::var("PI_AUTO_ACCEL").ok().and_then(|v|v.parse::<u32>().ok());
            if let Some(a)=acceleration{if a==0||a>111199{return Err("Acceleration out of envelope".into());}self.limits_from(&profile,Some(a))?;}
            let result=(||->Result<(),String>{
                for rpm in [500u32,2000,8000,15000]{
                    self.call(9,Command::TaskSpeed{velocity_raw:((rpm as u64*1099511627776)/3600000000) as u32,mode:1})?;
                    self.motion_wait(15,|s|s.drive==0&&s.limits_valid)?;
                    self.call(9,Command::RtmiConfig{enabled:true,sampling:255,addresses:[0x154,0x153,0x155,0x152,65535,65535,65535],decimation:4})?;
                    self.motion_wait(15,|s|s.drive==0)?;
                    self.call(9,Command::DriveEnable)?;self.motion_wait(15,|s|s.drive==2)?;
                    let mut cursor=0;
                    for percent in [20,80,50]{
                        self.records.push(serde_json::json!({"bench_start":true,"rpm":rpm,"percent":percent}));
                        let accepted=self.call(9,Command::LogicalMove{position:(span*percent/100).to_string()})?;
                        self.records.push(serde_json::json!({"bench_accepted":true,"timestamp_ms":accepted.timestamp_ms}));
                        let deadline=Instant::now()+Duration::from_secs(80);let mut tick=Instant::now();
                        loop{
                            let b=self.call(9,Command::RtmiState{cursor})?.rtmi.ok_or("No RTMI")?;
                            cursor=u32::from_le_bytes(b[..4].try_into().unwrap());
                            if b[4..12].iter().any(|v|*v!=0){return Err("RTMI lost/error during bench".into());}
                            if tick.elapsed()>=Duration::from_millis(100){
                                self.call(0,Command::Pulse)?;
                                let s=self.call(9,Command::PositionState)?.motor.ok_or("No feedback")?;
                                if s.fault!=0||s.last_error!=0||!s.coordinate_valid{return Err(format!("Bench fault {s:?}"));}
                                let pos=s.logical_position.as_ref().ok_or("Missing coordinate")?.parse::<i64>().map_err(|_|"Bad coordinate")?;
                                if pos<span/10||pos>span*9/10{return Err("Bench outside middle travel".into());}
                                if !s.motion_active&&s.arrival_phase==Some(4){
                                    // Drain telemetry through the completion time before
                                    // opening the next segment or disabling RTMI.
                                    let completed=self.records.last().unwrap()["response"]["timestamp_ms"].as_u64().unwrap() as u32;
                                    let end=Instant::now()+Duration::from_secs(5);let mut latest=0;
                                    while latest<completed{
                                        let b=self.call(9,Command::RtmiState{cursor})?.rtmi.ok_or("No final RTMI")?;
                                        cursor=u32::from_le_bytes(b[..4].try_into().unwrap());
                                        if b[4..12].iter().any(|v|*v!=0){return Err("Final RTMI loss/error".into());}
                                        for offset in (20..b.len()).step_by(9){latest=u32::from_le_bytes(b[offset..offset+4].try_into().unwrap());}
                                        if Instant::now()>end{return Err("Final RTMI backlog timeout".into());}thread::sleep(Duration::from_millis(5));
                                    }
                                    break;
                                }tick=Instant::now();
                            }
                            if Instant::now()>deadline{return Err("Bench arrival timeout".into());}
                            thread::sleep(Duration::from_millis(5));
                        }
                        self.records.push(serde_json::json!({"bench_done":true,"rpm":rpm,"percent":percent}));
                    }
                    self.call(9,Command::Stop{after:2})?;self.motion_wait(15,|s|s.drive==0)?;
                    self.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1})?;self.motion_wait(15,|s|s.drive==0)?;
                }Ok(())
            })();
            self.call(9,Command::Stop{after:2})?;self.motion_wait(15,|s|s.drive==0)?;
            self.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1})?;self.motion_wait(15,|s|s.drive==0)?;
            let saved_speed=u32::from_le_bytes(profile[112..116].try_into().unwrap());
            self.call(9,Command::TaskSpeed{velocity_raw:saved_speed,mode:old_mode})?;self.motion_wait(15,|s|s.drive==0)?;
            if acceleration.is_some(){self.limits_from(&profile,None)?;}
            if self.profile()?!=profile{return Err("W25 changed during bench".into());}
            result
        }
        fn wait(&mut self)->Result<sc::MotorSnapshot,String>{
            let end=Instant::now()+Duration::from_secs(25);
            loop{thread::sleep(Duration::from_millis(120));self.call(0,Command::Pulse)?;
                let r=self.call(9,Command::GetState)?;
                let s=r.motor.ok_or("Missing state")?;
                if s.fault!=0||s.last_error!=0{return Err(format!("Motor fault/error {s:?}"));}
                if !r.pending&&s.drive==0&&s.pending_action==0{return Ok(s);}
                if Instant::now()>end{return Err("Motor completion timeout".into());}
            }
        }
    }
    #[test]
    #[ignore="Real M9 PRBS excitation; set PI_AUTO_PORT and PI_AUTO_REPORT"]
    fn m9_identification(){
        let name=std::env::var("PI_AUTO_PORT").expect("PI_AUTO_PORT required");
        let path=std::env::var("PI_AUTO_REPORT").expect("PI_AUTO_REPORT required");
        let serial=serialport::new(name,std::env::var("PI_AUTO_BAUD").ok().and_then(|v|v.parse().ok()).unwrap_or(1500000)).timeout(Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
        let mut c=Client{wire:Transport::new(serial,"main485",9),q:Request{request_id:1,boot_id:"0".into(),session_id:0,task_id:0,command:Command::GetState},records:vec![],path};
        let d=c.call(0,Command::GetState).unwrap();c.q.boot_id=d.boot_id;c.q.request_id=d.device.unwrap().request_floor+1;
        c.q.session_id=0x50490001;c.call(0,Command::Open).unwrap();
        let mut restore_pi:Option<(u32,[u32;4])>=None;
        let action=std::env::var("PI_AUTO_ACTION").unwrap_or("capture".into());
        let result=(||->Result<(),String>{
            let r=c.call(9,Command::GetState)?;
            if action=="probe"{c.call(9,Command::IdentState{cursor:0})?;return Ok(());}
            let mut s=r.motor.ok_or("Missing motor")?;
            if !s.config_verified{c.call(9,Command::Commission{action:1})?;s=c.wait()?;}
            if s.drive!=0{c.call(9,Command::Stop{after:2})?;s=c.wait()?;}
            if !s.align_valid||!s.logic_power{return Err("M9 requires valid existing encoder calibration and logic power".into());}
            if action=="readiness" {
                let profile=c.profile()?;let old_speed=u32::from_le_bytes(profile[112..116].try_into().unwrap());let old_mode=s.mode;
                let run=(||->Result<(),String>{
                    for mode in 0..4 {

                        c.call(9,Command::TaskSpeed{velocity_raw:305419,mode})?;
                        c.motion_wait(15,|s|s.drive==0&&s.limits_valid)?;
                        c.call(9,Command::DriveEnable)?;c.motion_wait(15,|s|s.drive==2)?;
                        let repeat=c.call(9,Command::DriveEnable)?;
                        if repeat.pending||repeat.motor.as_ref().map(|s|s.drive)!=Some(2){return Err("Repeated enable was not idempotent".into());}

                        // A rejected task must not turn into a device fault or revoke authorization.
                        if c.call(9,Command::LogicalMove{position:"-1".into()}).is_ok(){return Err("Invalid target was accepted".into());}
                        let state=c.call(9,Command::GetState)?.motor.ok_or("Missing enabled state")?;
                        if state.fault!=0||!state.logic_power||!state.align_valid{return Err(format!("Rejected task blocked the device: {state:?}"));}
                        c.call(9,Command::Stop{after:2})?;c.motion_wait(15,|s|s.drive==0)?;
                        c.records.push(serde_json::json!({"readiness_mode":mode,"passed":true}));
                    }Ok(())
                })();
                c.call(9,Command::Stop{after:2})?;c.wait()?;
                c.call(9,Command::TaskSpeed{velocity_raw:old_speed,mode:old_mode})?;c.wait()?;
                if c.profile()?!=profile{return Err("W25 changed during readiness regression".into());}
                return run;
            }
            if action=="range_retry"{
                if s.position.parse::<i64>().map_err(|_|"Bad position")?.abs()+5461<=9102{return Err("Test requires position outside PRBS envelope; no excitation sent".into());}

                c.call(9,Command::IdentStart{loop_id:3,amplitude:5461,duration_ms:5000,travel_counts:9102,sampling:None,excitation_sampling:None})?;
                let end=Instant::now()+Duration::from_secs(5);
                loop {
                    c.call(0,Command::Pulse)?;
                    let b=c.call(9,Command::IdentState{cursor:0})?.identification.ok_or("No rejection record")?;
                    if b[1]==3{
                        let err=u32::from_le_bytes(b[12..16].try_into().unwrap());
                        let count=u32::from_le_bytes(b[8..12].try_into().unwrap());
                        if err!=6||count!=0{return Err(format!("Unexpected rejection {err}, samples {count}"));}
                        break;
                    }
                    if Instant::now()>end{return Err("Range rejection timeout".into());}thread::sleep(Duration::from_millis(50));
                }
                let after=c.call(9,Command::GetState)?.motor.ok_or("No state")?;
                if after.last_error!=0||after.fault!=0{return Err(format!("Range rejection polluted motor status: {after:?}"));}
            }
            if action=="rtmi_limits"||action=="range_retry"{
                let result=(||->Result<(),String>{
                    for addresses in [[0x14a,0x14b,65535,65535,65535,65535,65535],
                                      [0x154,0x153,0x155,65535,65535,65535,65535]]{
                        c.call(9,Command::RtmiConfig{enabled:true,sampling:255,addresses,decimation:4})?;c.wait()?;
                        let mut values=[None;7];let mut cursor=0;let end=Instant::now()+Duration::from_secs(3);
                        while addresses.iter().enumerate().any(|(i,a)|*a!=65535&&values[i].is_none()){
                            c.call(0,Command::Pulse)?;
                            let b=c.call(9,Command::RtmiState{cursor})?.rtmi.ok_or("Missing RTMI")?;
                            if b.len()<20||b[16]!=1||b[4..12].iter().any(|v|*v!=0){return Err("RTMI disabled/error/loss".into());}
                            cursor=u32::from_le_bytes(b[..4].try_into().unwrap());
                            for i in (20..b.len()).step_by(9){let ch=b[i+4] as usize;if ch<7{values[ch]=Some(u32::from_le_bytes(b[i+5..i+9].try_into().unwrap()));}}
                            if Instant::now()>end{return Err("RTMI snapshot timeout".into());}thread::sleep(Duration::from_millis(10));
                        }
                        c.records.push(serde_json::json!({"rtmi_addresses":addresses,"rtmi_values":values}));
                        c.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1})?;c.wait()?;
                    }
                    Ok(())
                })();
                if result.is_err(){let _=c.call(9,Command::RtmiConfig{enabled:false,sampling:255,addresses:[65535;7],decimation:1});let _=c.wait();}
                result?;let after=c.call(9,Command::GetState)?.motor.ok_or("Missing final state")?;
                if after.fault!=0||after.drive!=0||!after.logic_power||after.align_valid!=s.align_valid||after.span_valid!=s.span_valid{return Err(format!("RTMI changed motor state: {after:?}"));}
                return Ok(());
            }
            if action=="center"{return c.center();}
            let verify=std::env::var("PI_AUTO_VERIFY_PI").is_ok();
            let original_pi=if verify{Some(c.live_pi()?)}else{None};
            let original_profile=if verify{Some(c.profile()?)}else{None};
            let loop_id=std::env::var("PI_AUTO_LOOP").ok().and_then(|v|v.parse().ok()).unwrap_or(0);
            let amplitude=std::env::var("PI_AUTO_AMPLITUDE").ok().and_then(|v|v.parse().ok()).unwrap_or(if loop_id<2{248}else{30542});

            let before=c.call(9,Command::IdentState{cursor:0})?.identification.ok_or("No identification capability")?;
            let word=|b:&[u8],i:usize|u32::from_le_bytes(b[i..i+4].try_into().unwrap());
            let generation=word(&before,4);
            if let Ok(p)=std::env::var("PI_AUTO_VEL_P"){
                // Capture metadata is historical, never a live PI backup. Use
                // the explicitly selected, original same-boot baseline record.
                let path=std::env::var("PI_AUTO_BASELINE").map_err(|_|"Original baseline file required")?;
                let history:Vec<serde_json::Value>=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                if !history.iter().any(|v|v["response"]["boot_id"].as_str()==Some(c.q.boot_id.as_str())){return Err("Baseline boot changed".into());}
                let before:Vec<u8>=history.iter().find_map(|v|v.get("identification").and_then(|b|serde_json::from_value(b.clone()).ok())).ok_or("Missing baseline")?;
                if before[2]!=9||before[3]!=2||word(&before,24)==0{return Err("Read baseline velocity identification first".into());}
                let mut original=[0u32;4];let mut j=0;
                for i in 0..4{original[i]=if i==2{word(&before,32)}else{let v=word(&before,52+4*j);j+=1;v};}
                let actual=c.live_pi()?;
                if actual!=(word(&before,20),original){return Err(format!("Live PI differs from explicit baseline: {actual:?}"));}
                let vp:u32=p.parse().map_err(|_|"Bad P")?;
                let vi:u32=std::env::var("PI_AUTO_VEL_I").ok().and_then(|v|v.parse().ok()).unwrap_or(original[2]&65535);
                if vp==0||vp>(original[2]>>16)*5/4||vp<(original[2]>>16)/4||vi!=original[2]&65535{return Err("Trial P outside 0.25..1.25x baseline or changed I".into());}
                restore_pi=Some((word(&before,20),original));let mut trial=original;trial[2]=vp<<16|vi;
                c.call(9,Command::PiTune{group:1,expected_config:word(&before,20),coefficients:trial})?;c.wait()?;
                if action=="restore"{return Ok(());}
            }
            if action=="bench"{return c.speed_bench();}
            let travel_counts=std::env::var("PI_AUTO_TRAVEL").ok().and_then(|v|v.parse().ok()).unwrap_or(32768);
            let duration_ms=std::env::var("PI_AUTO_DURATION").ok().and_then(|v|v.parse().ok()).unwrap_or(3000);
            let position_before=if loop_id==3 {
                Some(c.call(9,Command::PositionState)?.motor.ok_or("No start position")?.position.parse::<i64>().map_err(|_|"Bad start position")?)
            }else{None};
            c.call(9,Command::IdentStart{loop_id,amplitude,duration_ms,travel_counts,sampling:std::env::var("PI_AUTO_SAMPLING").ok().and_then(|v|v.parse().ok()),excitation_sampling:None})?;
            let end=Instant::now()+Duration::from_secs(20);let mut aborted=false;
            let capture=loop{
                thread::sleep(Duration::from_millis(120));c.call(0,Command::Pulse)?;
                if action!="disconnect"{}
                let r=c.call(9,Command::IdentState{cursor:0})?;let b=r.identification.ok_or("Missing identification snapshot")?;
                if !aborted&&(action=="abort"||(action=="abort_live"&&b[1]==1&&word(&b,8)>=20)){
                    c.call(9,Command::IdentAbort)?;aborted=true;
                }
                if word(&b,4)!=generation&&(b[1]==2||b[1]==3){break b;}
                if Instant::now()>end{return Err("Identification timeout".into());}
            };
            let mut cursor=0;let total=word(&capture,8);let mut samples=vec![];
            while cursor<total{
                c.call(0,Command::Pulse)?;
                let data=c.call(9,Command::IdentState{cursor})?.identification.ok_or("Missing capture chunk")?;
                let next=word(&data,48);if next<=cursor{return Err("Capture download stalled".into());}
                for i in (64..data.len()).step_by(16){samples.push(serde_json::json!({"at":word(&data,i),"reference":word(&data,i+4) as i32,"actual":word(&data,i+8) as i32,"effort":word(&data,i+12) as i32}));}
                cursor=next;
            }
            c.records.push(serde_json::json!({"identification":capture,"samples":samples}));
            if let Some(position)=position_before {
                let after=c.call(9,Command::PositionState)?.motor.ok_or("No restored position")?.position.parse::<i64>().map_err(|_|"Bad restored position")?;
                if (after-position).abs()>travel_counts as i64{return Err(format!("Position origin was not restored: {position} -> {after}"));}
                // The first RTMI frame can coincide with mode activation and
                // contain the previous zero target; subsequent targets must be +/- amplitude.
                if samples.iter().enumerate().any(|(i,v)|{
                    let reference=v["reference"].as_i64().unwrap();
                    (reference.abs()!=amplitude as i64&&(i!=0||reference!=0))||v["actual"].as_i64().unwrap().abs()>travel_counts as i64
                }){return Err("PRBS samples are not centered on the temporary origin".into());}
                c.records.push(serde_json::json!({"position_origin_before":position,"position_origin_after":after,"relative_travel_limit":travel_counts}));
            }
            let state=c.call(9,Command::GetState)?.motor.ok_or("Missing final state")?;
            if state.drive!=0||!state.logic_power||state.span_valid!=s.span_valid||state.align_valid!=s.align_valid{return Err(format!("End state mismatch: {state:?}"));}
            if let Some(pi)=original_pi {if c.live_pi()?!=pi{return Err("PI changed during rate test".into());}}
            if let Some(p)=original_profile {if c.profile()?!=p{return Err("W25 changed during rate test".into());}}
            if verify{c.records.push(serde_json::json!({"sample_rate_pi_w25_unchanged":true}));}
            if action=="abort"||action=="abort_live"||action=="disconnect" {if capture[1]!=3||word(&capture,12)!=2{return Err("Abort was not confirmed".into());}}
            else if capture[1]!=2{return Err(format!("Identification failed error={}",word(&capture,12)));}
            std::fs::write(&c.path,serde_json::to_vec_pretty(&c.records).unwrap()).map_err(|e|e.to_string())?;
            Ok(())
        })();
        if result.is_err(){let _=c.call(9,Command::IdentAbort);let _=c.call(9,Command::Stop{after:2});let _=c.wait();}
        let restored=if let Some((config,coefficients))=restore_pi {
            c.call(9,Command::PiTune{group:1,expected_config:config,coefficients}).and_then(|_|c.wait()).and_then(|_|{if c.live_pi()?==(config,coefficients){Ok(())}else{Err("Independent PI restore verification failed".into())}})
        }else{Ok(())};
        let _=c.call(9,Command::DriveDisable);let _=c.call(0,Command::Close);
        std::fs::write(&c.path,serde_json::to_vec_pretty(&c.records).unwrap()).unwrap();
        assert!(restored.is_ok(),"Restore failed: {restored:?}");
        assert!(result.is_ok(),"{result:?}");
    }
}

/// Line-oriented CLI bridge to the production gateway/semantic codec. No GUI.
#[cfg(test)] mod bridge {
    use crate::{gateway::Transport,semantic_control as sc};
    use std::io::{self,BufRead,Write};
    #[test] #[ignore="Explicit real hardware command bridge"]
    fn m9_commands() {
        let port=std::env::var("PI_AUTO_PORT").expect("PI_AUTO_PORT");
        let serial=serialport::new(port,1500000).timeout(std::time::Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
        let mut wire=Transport::new(serial,"main485",9);
        println!("PI_BRIDGE_READY");io::stdout().flush().unwrap();
        for line in io::stdin().lock().lines() {
            let line=line.unwrap();if line=="quit"{break;}
            let result=(||->Result<serde_json::Value,String>{
                let v:serde_json::Value=serde_json::from_str(&line).map_err(|e|e.to_string())?;
                let m=v["motor"].as_u64().ok_or("motor")? as u8;
                if let Some(q)=v.get("control") {
                    let op=q["op"].as_u64().ok_or("op")? as u8;
                    let data:Vec<u8>=serde_json::from_value(q["data"].clone()).map_err(|e|e.to_string())?;
                    if ![4,5,13,16].contains(&op)&&!(op==34&&data==[0,1]){return Err("Only per-motor power/status, homing reads and cylinder snapshots permitted".into());}
                    return serde_json::to_value(wire.call(m,op,&data).map_err(|e|e.to_string())?).map_err(|e|e.to_string());
                }
                if let Some(q)=v.get("storage") {
                    let q:crate::split_storage::Request=serde_json::from_value(q.clone()).map_err(|e|e.to_string())?;
                    let b=wire.call(m,33,&crate::split_storage::encode(m,&q)?).map_err(|e|e.to_string())?;
                    return serde_json::to_value(crate::split_storage::decode(m,&q,&b)?).map_err(|e|e.to_string());
                }
                let q:sc::Request=serde_json::from_value(v["request"].clone()).map_err(|e|e.to_string())?;
                let raw=wire.call(m,32,&sc::encode(m,&q)?).map_err(|e|e.to_string())?;
                serde_json::to_value(sc::decode(m,&q,&raw)?).map_err(|e|e.to_string())
            })();
            println!("PI_BRIDGE {}",match result {Ok(v)=>serde_json::json!({"reply":v}),Err(e)=>serde_json::json!({"error":e})});io::stdout().flush().unwrap();
        }
    }
}
