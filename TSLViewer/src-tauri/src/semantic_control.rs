//! Stage C wire contract. The MCU owns execution and readiness. No PC motion
//! timer, implicit retries, optimistic enable, or fallback to raw TMC writes.
use serde::{Deserialize, Serialize};

pub const GATEWAY_OP: u8 = 32;
#[derive(Debug, Deserialize)]
pub struct Request {
    pub request_id: u32,
    /// Decimal string: JavaScript numbers cannot represent all u64 boot IDs.
    pub boot_id: String,
    pub session_id: u32,
    #[serde(default)]
    pub task_id: u32,
    pub command: Command,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    IdentState { cursor:u32 }, IdentStart { loop_id:u8, amplitude:u32, duration_ms:u32, travel_counts:u32, #[serde(default)] sampling:Option<u8>, #[serde(default)] excitation_sampling:Option<u8> }, IdentAbort,
    GetState, PositionState, TelemetryState, EncoderState, RtmiState { cursor:u32 }, RtmiConfig { enabled:bool, sampling:u8, addresses:[u16;7], #[serde(default="rtmi_decimation_default")] decimation:u8 }, Open, Pulse, Close,
    DriveDisable, DriveEnable,
    Commission { action: u8 },
    EncoderConfig { config: [u32;11] },
    EncoderTemporary { config: [u32;11] },
    Alignment { scan_degrees:u16, step_degrees:u16, settle_ms:u16, current_ma:u16 },
    HomingConfigRead,
    HomingConfigWrite { config:[u16;8] },
    PiTune { group:u8, expected_config:u32, coefficients:[u32;4] },
    ApplyConfiguration { payload:Vec<u8> },
    HomingStart { direction:u8, step_unit:u16, dual:bool },
    HomingLinked { direction:u8, step_unit:u16, dual:bool, motor_mask:u16, #[serde(default)] complex:bool },
    HomingAdaptive { #[serde(default)] velocity_rpm:Option<u16>, #[serde(default)] return_positive:Option<bool> },
    Homing { direction:u8, step_unit:u16, dual:bool, config:[u16;8], #[serde(default)] debug_pi:bool },
    Limits { task_iq_raw: u32, task_velocity_raw: u32, acceleration_raw: u32,
        deceleration_raw: u32, trip_iq_raw: u32, over_ms: u32, sample_ms: u32,
        feedback_timeout_ms: u32, stop_timeout_ms: u32, margin_counts: u32, fault_action: u8 },
    Mode { mode: u8 },
    TaskSpeed { velocity_raw:u32, mode:u8 },
    VelocityStart { velocity_raw:i32, lease_ms:u32 },
    OpenLoopStart { velocity_raw:i32, lease_ms:u32 },
    JogStart { velocity_raw: i32, lease_ms: u32 },
    JogRenew,
    Move { position: String },
    LogicalMove { position: String },
    LogicalWork { a: String, b: String, #[serde(default)] dwell_ms: u32, cycles: u32 },
    Work { a: String, b: String, #[serde(default)] dwell_ms: u32, cycles: u32 },
    Stop { after: u8 }, EStop, ClearFault, Status,
}
fn rtmi_decimation_default()->u8{1}
impl Command {
    fn code(&self) -> u8 {
        match self {
            Self::IdentState{..}|Self::GetState|Self::PositionState|Self::TelemetryState|Self::EncoderState|Self::RtmiState{..}=>1,
            Self::IdentStart{..}=>28, Self::IdentAbort=>29, Self::Open=>2, Self::Pulse=>3, Self::Close=>4,
            Self::DriveDisable=>6, Self::DriveEnable=>7,
            Self::Limits{..}=>8, Self::Mode{..}=>9, Self::JogStart{..}=>10,
            Self::TaskSpeed{..}=>26,
            Self::VelocityStart{..}=>27,
            Self::OpenLoopStart{..}=>30,
            Self::JogRenew=>11, Self::Move{..}=>12, Self::Work{..}=>13,
            Self::Stop{..}=>14, Self::EStop=>15, Self::ClearFault=>16, Self::Status=>17,
            Self::Commission{..}|Self::EncoderConfig{..}|Self::EncoderTemporary{..}=>18,
            Self::LogicalMove{..}=>19, Self::LogicalWork{..}=>20,
            Self::Alignment{..}=>18,
            Self::Homing{..}|Self::HomingStart{..}|Self::HomingLinked{..}|Self::HomingAdaptive{..}=>18,
            Self::HomingConfigRead=>21, Self::HomingConfigWrite{..}=>22,
            Self::RtmiConfig{..}=>25, Self::PiTune{..}=>23, Self::ApplyConfiguration{..}=>24,
        }
    }
}
fn add32(p: &mut Vec<u8>, v:u32){p.extend(v.to_le_bytes());}
fn count(v:&str)->Result<i64,String>{v.parse().map_err(|_|"Count 必须是有符号64位十进制字符串".into())}
pub fn encode(motor:u8,q:&Request)->Result<Vec<u8>,String>{
    let op=q.command.code();
    if motor>16 || q.request_id==0 {return Err("电机号或 request_id 无效".into());}
    if ([2,3,4].contains(&op)&&motor!=0) || (![1,2,3,4,15,17].contains(&op)&&motor==0){return Err("命令与电机号不匹配".into());}
    let boot:u64=q.boot_id.parse().map_err(|_|"boot_id 必须是无符号64位十进制字符串")?;
    let mut p=vec![2,op];add32(&mut p,q.request_id);p.extend(boot.to_le_bytes());
    add32(&mut p,q.session_id);add32(&mut p,q.task_id);
    match &q.command {
        Command::IdentState{cursor}=>{if motor==0{return Err("Identification requires a motor".into());}p.push(4);add32(&mut p,*cursor);},
        Command::IdentStart{loop_id,amplitude,duration_ms,travel_counts,sampling,excitation_sampling}=>{
            if *loop_id>3||*amplitude==0||*amplitude>i32::MAX as u32||!(1000..=7000).contains(duration_ms)||*travel_counts==0||*travel_counts>i32::MAX as u32{return Err("Invalid identification parameters".into());}
            p.push(*loop_id);for v in [amplitude,duration_ms,travel_counts]{add32(&mut p,*v);}if let Some(e)=excitation_sampling{p.push(sampling.unwrap_or(7));p.push(*e);}else if let Some(v)=sampling{p.push(*v);}
        },
        Command::PositionState=>{if motor==0{return Err("位置状态需要电机编号".into());}p.push(1);},
        Command::TelemetryState=>{if motor==0{return Err("遥测状态需要电机编号".into());}p.push(5);},
        Command::EncoderState=>{if motor==0{return Err("编码器状态需要电机编号".into());}p.push(2);},
        Command::RtmiState{cursor}=>{if motor==0{return Err("RTMI requires a motor".into());}p.push(3);add32(&mut p,*cursor);},
        Command::RtmiConfig{enabled,sampling,addresses,decimation}=>{if !(1..=16).contains(decimation){return Err("RTMI decimation invalid".into());}p.push(*enabled as u8);p.push(*sampling);for addr in addresses{if *addr>0x3ff&&*addr!=65535{return Err("RTMI address invalid".into());}p.extend(addr.to_le_bytes());}p.push(*decimation);},
        Command::Limits{task_iq_raw,task_velocity_raw,acceleration_raw,deceleration_raw,trip_iq_raw,over_ms,sample_ms,feedback_timeout_ms,stop_timeout_ms,margin_counts,fault_action}=>{
            for v in [task_iq_raw,task_velocity_raw,acceleration_raw,deceleration_raw,trip_iq_raw,over_ms,sample_ms,feedback_timeout_ms,stop_timeout_ms,margin_counts]{add32(&mut p,*v);}
            p.push(*fault_action);
        }
        Command::Mode{mode}=>p.push(*mode),
        Command::TaskSpeed{velocity_raw,mode}=>{
            if *velocity_raw==0||*velocity_raw>0x7ffffff||*mode>3{return Err("任务转速或模式无效".into());}
            add32(&mut p,*velocity_raw);p.push(*mode);
        }
        Command::PiTune{group,expected_config,coefficients}=>{
            if *group>2||coefficients.iter().any(|v|v&0x80008000!=0){return Err("PI 系数无效".into());}
            p.push(*group);add32(&mut p,*expected_config);for v in coefficients{add32(&mut p,*v);}
        }
        Command::ApplyConfiguration{payload}=>{
            if payload.len()!=88&&payload.len()!=92&&!((payload.len()==93||payload.len()==105)&&(1..=6).contains(&payload[92])){return Err("配置负载长度错误".into());}p.extend(payload);
        }
        Command::EncoderConfig{config}|Command::EncoderTemporary{config}=>{
            if motor==0{return Err("编码器配置需要电机编号".into());}
            p.push(11);for v in config{add32(&mut p,*v);}
            if matches!(&q.command,Command::EncoderTemporary{..}){p.push(1);}
        }
        Command::Commission{action}=>{
            if !(1..=5).contains(action){return Err("初始化/校准操作无效".into());}
            p.push(*action);
        }
        Command::Alignment{scan_degrees,step_degrees,settle_ms,current_ma}=>{
            if !(360..=1080).contains(scan_degrees)||!(15..=180).contains(step_degrees)||
                scan_degrees%step_degrees!=0||!(100..=1000).contains(settle_ms)||!(50..=500).contains(current_ma){
                return Err("标定范围/步长/稳定时间/电流无效".into());
            }
            p.push(2);
            for v in [scan_degrees,step_degrees,settle_ms,current_ma]{p.extend(v.to_le_bytes());}
        }
        Command::JogStart{velocity_raw,lease_ms}|Command::VelocityStart{velocity_raw,lease_ms}|Command::OpenLoopStart{velocity_raw,lease_ms}=>{p.extend(velocity_raw.to_le_bytes());add32(&mut p,*lease_ms);}
        Command::HomingConfigWrite{config}=>{ for v in config {p.extend(v.to_le_bytes());} }
        Command::HomingStart{direction,step_unit,dual}=>{
            if (*direction>2||(*direction==2&&!*dual))||!(100..=6000).contains(step_unit){return Err("找零方向或步长无效".into());}
            p.extend([3,if *direction==2 {0}else{*direction}]);p.extend(step_unit.to_le_bytes());p.push((if *dual{2}else{0}) | if *direction==2{32}else{0});
        }
        Command::HomingLinked{direction,step_unit,dual,motor_mask,complex}=>{
            if (*direction>2||(*direction==2&&!*dual))||!(100..=6000).contains(step_unit)||motor==0||motor>16||motor_mask&(1u16<<(motor-1))==0 || (*complex && motor_mask.count_ones()!=2) {
                return Err("联动找零方向、步长或电机组无效".into());
            }
            p.extend([3,if *direction==2 {0}else{*direction}]);p.extend(step_unit.to_le_bytes());p.push((if *dual{10}else{8}) | (if *complex{16}else{0}) | if *direction==2{32}else{0});
            p.extend(motor_mask.to_le_bytes());
        }
        Command::HomingAdaptive{velocity_rpm,return_positive}=>{
            p.extend([3,0,100,0,if *return_positive==Some(false){134}else{6}]);
            if let Some(rpm)=velocity_rpm {
                if *rpm==0 || *rpm>60000 {return Err("Search speed must be 1-60000 rpm".into());}
                p.extend(rpm.to_le_bytes());
            }
        },
        Command::Homing{..}=>return Err("请先写入并回读主控找零参数，再单独开始找零".into()),
        Command::Move{position}|Command::LogicalMove{position}=>p.extend(count(position)?.to_le_bytes()),
        Command::Work{a,b,dwell_ms,cycles}|Command::LogicalWork{a,b,dwell_ms,cycles}=>{p.extend(count(a)?.to_le_bytes());p.extend(count(b)?.to_le_bytes());add32(&mut p,0);add32(&mut p,*cycles);add32(&mut p,*dwell_ms);}
        Command::Stop{after}=>p.push(*after),
        _=>{}
    }
    Ok(p)
}
fn u32_at(p:&[u8],i:usize)->u32{u32::from_le_bytes(p[i..i+4].try_into().unwrap())}
fn u64_at(p:&[u8],i:usize)->u64{u64::from_le_bytes(p[i..i+8].try_into().unwrap())}
fn i64_at(p:&[u8],i:usize)->i64{i64::from_le_bytes(p[i..i+8].try_into().unwrap())}
#[derive(Debug, Serialize)]
pub struct DeviceSnapshot {pub capabilities:u32,pub motors:u8,pub source:u8,pub active_motor:u8,pub stopping:bool,pub request_floor:u32}
#[derive(Debug, Serialize)]
pub struct MotorSnapshot {
    pub sampled_at_ms:u32,pub fault:u32,pub last_error:u32,
    pub position:String,pub negative_contact:String,pub positive_contact:String,
    pub velocity_raw:i32,pub iq_raw:i32,pub connection:bool,
    pub drive:u8,pub align_valid:bool,pub home_neg_valid:bool,pub home_pos_valid:bool,
    pub span_valid:bool,pub motion_owner:u8,pub feedback_fresh:bool,pub config_verified:bool,
    pub logic_power:bool,pub motion_active:bool,pub effective_iq_raw:u32,pub effective_velocity_raw:u32,
    pub mode:u8,pub safety_phase:u8,pub limits_valid:bool,pub pending_action:u8,
    pub logical_position:Option<String>,pub logical_span:Option<String>,pub margin_counts:Option<u32>,
    pub coordinate_valid:bool,
    pub temperature_raw:Option<i16>,
    pub arrival_phase:Option<u8>,pub arrival_flags:Option<u8>,pub arrival_ms:Option<u16>,
    pub arrival_tolerance:Option<u16>,pub arrival_dwell_ms:Option<u16>,
}
#[derive(Debug, Serialize)]
pub struct TelemetrySnapshot {
    pub sampled_at_ms:u32,
    pub bus_voltage_mv:Option<u32>,
    pub id_raw:Option<i32>,
    pub target_logical_position:Option<String>,
    pub protection_state:Option<u32>,
}
#[derive(Debug, Serialize)]
pub struct Response {
    pub protocol_version:u8,pub operation:u8,pub request_id:u32,pub boot_id:String,
    pub session_id:u32,pub task_id:u32,pub timestamp_ms:u32,pub result:u8,
    pub result_name:&'static str,pub replayed:bool,pub pending:bool,
    pub device:Option<DeviceSnapshot>,pub motor:Option<MotorSnapshot>,
    pub homing_config:Option<[u16;8]>,
    pub encoder:Option<Vec<u32>>,
    pub rtmi:Option<Vec<u8>>,
    pub identification:Option<Vec<u8>>,
    pub telemetry:Option<TelemetrySnapshot>,
}
pub fn decode(motor:u8,q:&Request,p:&[u8])->Result<Response,String>{
    let home_config=matches!(q.command,Command::HomingConfigRead|Command::HomingConfigWrite{..});
    let ident_query=matches!(q.command,Command::IdentState{..});
    let dense_request=matches!(q.command,Command::IdentState{cursor} if cursor&0xffff0000==0x80000000);
    let rtmi_query=matches!(q.command,Command::RtmiState{..});
    let telemetry_query=matches!(q.command,Command::TelemetryState);
    let encoder_query=matches!(q.command,Command::EncoderState);
    if motor>16 || (if telemetry_query {motor==0||p.len()!=60}else if ident_query {motor==0||p.len()<(if dense_request{44}else{92})||p.len()>124||(p.len()-44)%16!=0}else if rtmi_query {motor==0||p.len()<48||p.len()>120||(p.len()-48)%9!=0}else if encoder_query {motor==0||(p.len()!=76&&p.len()!=92)}else if home_config {motor==0||p.len()!=44}else if motor==0 {p.len()!=40}else{p.len()!=96 && p.len()!=120 && p.len()!=128}) {return Err("语义状态长度错误".into());}
    if p[0]!=2||p[1]!=q.command.code()||u32_at(p,2)!=q.request_id||p[23]&!3!=0 {return Err("语义响应身份/标志不匹配".into());}
    let names=["OK","BUSY","RESERVED_2","DRIVE_NOT_READY","ALIGN_INVALID","HOME_INVALID","OUT_OF_RANGE","STALE_SESSION","TIMEOUT","FAULT_LATCHED","CONFIG_MISMATCH","EEPROM_INVALID","UNSUPPORTED","IO_ERROR","BAD_REQUEST","TRAVEL_LIMIT"];
    let result=p[22];let result_name=*names.get(result as usize).ok_or("未知主控结果码")?;
    let boot=u64_at(p,6);
    if result==0 && q.boot_id!="0" && q.boot_id.parse::<u64>().ok()!=Some(boot){return Err("响应 boot_id 发生变化，请重新读取状态".into());}
    let b=&p[28..];
    if motor==0 {
        if b[4]!=16||b[5]>2||b[6]>16||b[7]>1||u32_at(b,0)&!3!=0{return Err("非法设备状态字段".into());}
    } else if !home_config && !encoder_query && !rtmi_query && !ident_query && !telemetry_query {
        if p.len()>=120 && (b[88]>1 || b[91]>1) {return Err("非法归零坐标扩展".into());}
        if p.len()>=120 && b[88]!=0 && (b[48]==0||b[49]==0||b[50]==0||i64_at(b,76)<=0||u32_at(b,84)==0||i64_at(b,76)<=2*i64::from(u32_at(b,84))) {return Err("归零坐标约束错误".into());}
        for i in [44,45,47,48,49,50,52,53,54,55,66]{if b[i]>1{return Err("非法布尔状态字段".into());}}
        if b[46]>3||b[51]>5||b[64]>3||b[65]>3||b[67]>7{return Err("非法电机状态枚举".into());}
    }
    if !ident_query && !rtmi_query && !telemetry_query && motor!=0 && p.len()==128 && (b[92]>4||b[93]&!7!=0) {return Err("非法到位状态扩展".into());}
    let device=if motor==0 {Some(DeviceSnapshot{capabilities:u32_at(b,0),motors:b[4],source:b[5],active_motor:b[6],stopping:b[7]!=0,request_floor:u32_at(b,8)})}else{None};
    let snapshot=if motor!=0 && !home_config && !encoder_query && !rtmi_query && !ident_query && !telemetry_query {Some(MotorSnapshot{
        sampled_at_ms:u32_at(b,0),fault:u32_at(b,4),last_error:u32_at(b,8),
        position:i64_at(b,12).to_string(),negative_contact:i64_at(b,20).to_string(),positive_contact:i64_at(b,28).to_string(),
        velocity_raw:u32_at(b,36) as i32,iq_raw:u32_at(b,40) as i32,connection:b[44]!=0,
        drive:b[46],align_valid:b[47]!=0,home_neg_valid:b[48]!=0,home_pos_valid:b[49]!=0,span_valid:b[50]!=0,
        motion_owner:b[51],feedback_fresh:b[52]!=0,config_verified:b[53]!=0,logic_power:b[54]!=0,motion_active:b[55]!=0,
        effective_iq_raw:u32_at(b,56),effective_velocity_raw:u32_at(b,60),mode:b[64],safety_phase:b[65],limits_valid:b[66]!=0,pending_action:b[67],
        logical_position:if p.len()>=120 && b[88]!=0 {Some(i64_at(b,68).to_string())}else{None},
        logical_span:if p.len()>=120 && b[88]!=0 {Some(i64_at(b,76).to_string())}else{None},
        margin_counts:if p.len()>=120 && b[88]!=0 {Some(u32_at(b,84))}else{None},
        coordinate_valid:p.len()>=120 && b[88]!=0,
        temperature_raw:if p.len()>=120 && b[91]==1 {Some(i16::from_le_bytes([b[89],b[90]]))}else{None},
        arrival_phase:if p.len()==128{Some(b[92])}else{None},
        arrival_flags:if p.len()==128{Some(b[93])}else{None},
        arrival_ms:if p.len()==128{Some(u16::from_le_bytes([b[94],b[95]]))}else{None},
        arrival_tolerance:if p.len()==128{Some(u16::from_le_bytes([b[96],b[97]]))}else{None},
        arrival_dwell_ms:if p.len()==128{Some(u16::from_le_bytes([b[98],b[99]]))}else{None},
    })}else{None};
    let telemetry=if telemetry_query && result==0 {
        if b[0]!=1||b[1]&!0x0f!=0||b[2]!=0||b[3]!=0||b[28..32].iter().any(|v|*v!=0)
            {return Err("非法遥测扩展".into());}
        Some(TelemetrySnapshot{
            sampled_at_ms:u32_at(b,4),
            bus_voltage_mv:if b[1]&1!=0{Some(u32_at(b,8))}else{None},
            id_raw:if b[1]&2!=0{Some(u32_at(b,12) as i32)}else{None},
            target_logical_position:if b[1]&4!=0{Some(i64_at(b,16).to_string())}else{None},
            protection_state:if b[1]&8!=0{Some(u32_at(b,24))}else{None},
        })
    }else{None};
    let homing_config=if home_config && result==0 {let mut c=[0;8];for i in 0..8 {c[i]=u16::from_le_bytes([b[i*2],b[i*2+1]]);}Some(c)}else{None};
    let encoder=if encoder_query&&result==0{let v:Vec<u32>=b.chunks_exact(4).map(|x|u32_at(x,0)).collect();if v[1]>1{return Err("编码器有效标志错误".into());}Some(v)}else{None};
    let rtmi=if rtmi_query&&result==0 {
        if b[16]>1||b[18]>127||b[19]>8||b.len()!=20+b[19] as usize*9{return Err("Invalid RTMI snapshot".into());}
        // Reserved cursor reads eight diagnostic words, not live RTMI channels.
        let diagnostic=matches!(q.command,Command::RtmiState{cursor:0xffff_fffe|0xffff_fffd});
        for i in 0..b[19] as usize{if b[24+i*9]>if diagnostic{7}else{6}{return Err("Invalid RTMI channel".into());}}
        Some(b.to_vec())
    }else{None};
    let identification=if ident_query&&result==0 {
        if b[0]==2 && dense_request {
            if b[1]<2||b[1]>3||b[2]!=motor||b[3]>3||u32_at(b,8)>22528||u32_at(b,12)>u32_at(b,8){return Err("Invalid dense identification page".into());}
        } else {
        if b.len()<64{return Err("Invalid identification header".into());}
        let diagnostic=matches!(q.command,Command::IdentState{cursor:0xffff_fffe})&&b.len()==96&&b[1]!=1&&u32_at(b,48)==0xffff_fffe&&u32_at(b,64)==0x31444950;
        if b[0]!=1||b[1]>3||b[2]>16||b[3]>3||u32_at(b,8)>22528||(!diagnostic&&u32_at(b,48)>u32_at(b,8)){return Err("Invalid identification snapshot".into());}
        }Some(b.to_vec())
    }else{None};
    Ok(Response{identification,rtmi,encoder,homing_config,telemetry,protocol_version:2,operation:p[1],request_id:q.request_id,boot_id:boot.to_string(),session_id:u32_at(p,14),task_id:u32_at(p,18),timestamp_ms:u32_at(p,24),result,result_name,replayed:p[23]&1!=0,pending:p[23]&2!=0,device,motor:snapshot})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn volatile_defaults_and_optional_home_return_are_explicit() {
        let mut payload=vec![0;105];payload[92]=2;
        let p=encode(1,&req(Command::ApplyConfiguration{payload})).unwrap();
        assert_eq!(p[22+92],2);
        let config=[16384,1,14,1,2000000,16,0,16383,4800,3,u32::MAX];
        let p=encode(1,&req(Command::EncoderTemporary{config})).unwrap();
        assert_eq!(p.len(),68);assert_eq!(p[67],1);
        let p=encode(1,&req(Command::HomingAdaptive{velocity_rpm:Some(4000),return_positive:Some(false)})).unwrap();
        assert_eq!(p[26],134);
    }
    #[test]
    fn ramp_apply_extension_fits_gateway_frame() {
        let mut payload=vec![0;105];payload[92]=1;
        assert_eq!(encode(1,&req(Command::ApplyConfiguration{payload})).unwrap().len(),127);
        for length in [94,104,106] {let mut payload=vec![0;length];payload[92]=1;assert!(encode(1,&req(Command::ApplyConfiguration{payload})).is_err());}
    }
    #[test]
    fn encoder_live_configuration_payload_and_extended_snapshot() {
        let config=[16384,1,14,1,2000000,17,0,16383,6000,3,u32::MAX];
        let p=encode(1,&req(Command::EncoderConfig{config})).unwrap();
        assert_eq!(p.len(),67);assert_eq!(p[22],11);
        for (i,v) in config.iter().enumerate(){assert_eq!(u32_at(&p,23+i*4),*v);}
        assert!(encode(0,&req(Command::EncoderConfig{config})).is_err());
        let q=req(Command::EncoderState);let p=encode(1,&q).unwrap();
        let mut r=vec![0;92];r[..22].copy_from_slice(&p[..22]);r[32]=1;
        r[76..80].copy_from_slice(&0xf6118d0eu32.to_le_bytes());
        let v=decode(1,&q,&r).unwrap().encoder.unwrap();
        assert_eq!(v.len(),16);assert_eq!(v[12],0xf6118d0e);
    }
    fn req(command:Command)->Request{Request{request_id:1,boot_id:"1311768467463790320".into(),session_id:123,task_id:0,command}}
    #[test]
    fn mode_task_vectors(){
        for mode in 0..4 {
            let p=encode(9,&req(Command::TaskSpeed{velocity_raw:152709,mode})).unwrap();
            assert_eq!(p[1],26);assert_eq!(&p[22..26],&152709u32.to_le_bytes());assert_eq!(p[26],mode);
        }
        let p=encode(9,&req(Command::VelocityStart{velocity_raw:-152709,lease_ms:700})).unwrap();
        assert_eq!(p[1],27);assert_eq!(&p[22..26],&(-152709i32).to_le_bytes());
        assert_eq!(&p[26..30],&700u32.to_le_bytes());
        let p=encode(9,&req(Command::OpenLoopStart{velocity_raw:-91626,lease_ms:700})).unwrap();
        assert_eq!(p[1],30);assert_eq!(&p[22..26],&(-91626i32).to_le_bytes());
        let mut payload=vec![0;93];payload[92]=1;
        assert_eq!(encode(9,&req(Command::ApplyConfiguration{payload})).unwrap().len(),115);
        assert!(encode(9,&req(Command::TaskSpeed{velocity_raw:0,mode:0})).is_err());
        assert!(encode(9,&req(Command::TaskSpeed{velocity_raw:1,mode:4})).is_err());
    }
    #[test]
    fn coefficient_only_tuning_and_encoder_cache_wire() {
        let q=req(Command::PiTune{group:0,expected_config:0x855c,coefficients:[0x400030,0x410031,0x1f400fa,0x1f40000]});
        let p=encode(9,&q).unwrap();assert_eq!(p.len(),43);assert_eq!(p[1],23);assert_eq!(p[22],0);
        assert_eq!(u32_at(&p,23),0x855c);assert_eq!(u32_at(&p,27),0x400030);
        assert!(encode(9,&req(Command::PiTune{group:3,expected_config:0,coefficients:[0;4]})).is_err());
        assert!(encode(9,&req(Command::ApplyConfiguration{payload:vec![0;87]})).is_err());
        assert_eq!(encode(9,&req(Command::ApplyConfiguration{payload:vec![0;88]})).unwrap().len(),110);
        let q=req(Command::EncoderState);let p=encode(9,&q).unwrap();assert_eq!(p[22],2);
        let mut r=vec![0;76];r[..22].copy_from_slice(&p[..22]);r[32]=1;
        r[44..48].copy_from_slice(&43210u32.to_le_bytes());
        let decoded=decode(9,&q,&r).unwrap();assert!(decoded.motor.is_none());assert_eq!(decoded.encoder.unwrap()[4],43210);
    }
    #[test]
    fn identification_contract() {
        for loop_id in 0..4 {
            let q=req(Command::IdentStart{loop_id,amplitude:50,duration_ms:3000,travel_counts:32768,sampling:None,excitation_sampling:None});
            let p=encode(9,&q).unwrap();
            assert_eq!(p[1],28);assert_eq!(p.len(),35);assert_eq!(p[22],loop_id);
            assert_eq!(u32_at(&p,23),50);assert_eq!(u32_at(&p,27),3000);
        }
        assert!(encode(9,&req(Command::IdentStart{loop_id:4,amplitude:50,duration_ms:3000,travel_counts:32768,sampling:None,excitation_sampling:None})).is_err());
        for sampling in [0,97,127,255] {
            let p=encode(9,&req(Command::IdentStart{loop_id:1,amplitude:50,duration_ms:3000,travel_counts:32768,sampling:Some(sampling),excitation_sampling:None})).unwrap();
            assert_eq!(p.len(),36);assert_eq!(p[35],sampling);
        }
        for sampling in [None,Some(0),Some(7),Some(255)] {
            let p=encode(9,&req(Command::IdentStart{loop_id:2,amplitude:50,duration_ms:3000,travel_counts:32768,sampling,excitation_sampling:Some(255)})).unwrap();
            assert_eq!(p.len(),37);assert_eq!(&p[35..],&[sampling.unwrap_or(7),255]);
        }
        for travel in [655361,43410456,i32::MAX as u32] {
            let p=encode(9,&req(Command::IdentStart{loop_id:1,amplitude:994,duration_ms:1000,travel_counts:travel,sampling:Some(7),excitation_sampling:Some(7)})).unwrap();
            assert_eq!(u32_at(&p,31),travel);
        }
        assert!(encode(9,&req(Command::IdentStart{loop_id:1,amplitude:994,duration_ms:1000,travel_counts:0x80000000,sampling:None,excitation_sampling:None})).is_err());
        assert_eq!(encode(9,&req(Command::IdentAbort)).unwrap()[1],29);
        let q=req(Command::IdentState{cursor:10});let p=encode(9,&q).unwrap();
        assert_eq!(&p[22..],&[4,10,0,0,0]);
        let mut r=vec![0;124];r[..22].copy_from_slice(&p[..22]);
        r[28]=1;r[29]=2;r[30]=9;r[31]=1;
        r[36..40].copy_from_slice(&12u32.to_le_bytes());
        r[76..80].copy_from_slice(&12u32.to_le_bytes());
        assert_eq!(decode(9,&q,&r).unwrap().identification.unwrap().len(),96);
        assert!(decode(9,&q,&r[..123]).is_err());
        r[36..40].copy_from_slice(&22528u32.to_le_bytes());assert!(decode(9,&q,&r).is_ok());
        r[36..40].copy_from_slice(&22529u32.to_le_bytes());assert!(decode(9,&q,&r).is_err());
        r[36..40].copy_from_slice(&12u32.to_le_bytes());
        r[76..80].copy_from_slice(&0xffff_fffeu32.to_le_bytes());
        r[92..96].copy_from_slice(&0x31444950u32.to_le_bytes());
        assert!(decode(9,&q,&r).is_err());
        let diagnostic=req(Command::IdentState{cursor:0xffff_fffe});
        assert!(decode(9,&diagnostic,&r).is_ok());
        r[92]=0;assert!(decode(9,&diagnostic,&r).is_err());
    }
    #[test]
    fn dense_identification_contract() {
        let q=req(Command::IdentState{cursor:0x80000000});let p=encode(9,&q).unwrap();
        let mut r=vec![0;124];r[..22].copy_from_slice(&p[..22]);
        r[28]=2;r[29]=2;r[30]=9;r[31]=1;
        r[36..40].copy_from_slice(&10u32.to_le_bytes());r[40..44].copy_from_slice(&5u32.to_le_bytes());
        assert_eq!(decode(9,&q,&r).unwrap().identification.unwrap().len(),96);
        assert!(decode(9,&req(Command::IdentState{cursor:0}),&r).is_err());
        r[30]=8;assert!(decode(9,&q,&r).is_err());r[30]=9;
        r[40..44].copy_from_slice(&11u32.to_le_bytes());assert!(decode(9,&q,&r).is_err());
        assert!(decode(9,&q,&r[..43]).is_err());
    }
    #[test]
    fn native_rtmi_contract() {
        let q=req(Command::RtmiConfig{enabled:true,sampling:255,addresses:[0x154,0x153,0x155,0x251,65535,65535,65535],decimation:2});
        let p=encode(9,&q).unwrap();assert_eq!(p.len(),39);assert_eq!(p[1],25);assert_eq!(&p[22..26],&[1,255,0x54,1]);
        let q=req(Command::RtmiState{cursor:123});let p=encode(9,&q).unwrap();assert_eq!(&p[22..],&[3,123,0,0,0]);
        let mut r=vec![0;57];r[..22].copy_from_slice(&p[..22]);r[44]=1;r[45]=255;r[46]=1;r[47]=1;r[52]=0;
        let d=decode(9,&q,&r).unwrap();assert!(d.motor.is_none());assert_eq!(d.rtmi.unwrap().len(),29);
        r[52]=7;assert!(decode(9,&q,&r).is_err());r[52]=0;r[47]=8;assert!(decode(9,&q,&r).is_err());
        for cursor in [0xffff_fffe,0xffff_fffd] {
            let q=req(Command::RtmiState{cursor});let p=encode(9,&q).unwrap();
            r.resize(120,0);r[..22].copy_from_slice(&p[..22]);r[47]=8;
            for i in 0..8{r[52+i*9]=i as u8;}
            assert_eq!(decode(9,&q,&r).unwrap().rtmi.unwrap().len(),92);
            r[52+7*9]=8;assert!(decode(9,&q,&r).is_err());
        }
    }
    #[test]
    fn shared_homing_config_has_separate_write_read_and_start() {
        let config=[400,1050,50,500,2000,360,2000,60];
        let q=req(Command::HomingConfigWrite{config});let bytes=encode(9,&q).unwrap();
        assert_eq!(bytes[1],22);assert_eq!(bytes.len(),38);
        let mut reply=vec![0;44];reply[..22].copy_from_slice(&bytes[..22]);reply[28..].copy_from_slice(&bytes[22..]);
        let result=decode(9,&q,&reply).unwrap();assert_eq!(result.homing_config,Some(config));assert!(result.motor.is_none());
        assert!(decode(9,&q,&reply[..43]).is_err());
        let read=req(Command::HomingConfigRead);assert_eq!(encode(16,&read).unwrap().len(),22);
        let start=encode(9,&req(Command::HomingStart{direction:1,step_unit:100,dual:true})).unwrap();
        assert_eq!(&start[22..],&[3,1,100,0,2]);
        for motor in [15,16] {
            let linked=encode(motor,&req(Command::HomingLinked{direction:0,step_unit:100,dual:true,motor_mask:0xc000,complex:false})).unwrap();
            assert_eq!(&linked[22..],&[3,0,100,0,10,0,192]);
        }
        assert!(encode(14,&req(Command::HomingLinked{direction:0,step_unit:100,dual:true,motor_mask:0xc000,complex:false})).is_err());
        let reverse=encode(15,&req(Command::HomingStart{direction:2,step_unit:100,dual:true})).unwrap();
        assert_eq!(&reverse[22..],&[3,0,100,0,34]);
        let reverse_pair=encode(15,&req(Command::HomingLinked{direction:2,step_unit:100,dual:true,motor_mask:0xc000,complex:true})).unwrap();
        assert_eq!(&reverse_pair[22..],&[3,0,100,0,58,0,192]);
        assert!(encode(15,&req(Command::HomingStart{direction:2,step_unit:100,dual:false})).is_err());
        let adaptive=encode(1,&req(Command::HomingAdaptive{velocity_rpm:None,return_positive:None})).unwrap();
        assert_eq!(&adaptive[22..],&[3,0,100,0,6]);
        let speed=encode(1,&req(Command::HomingAdaptive{velocity_rpm:Some(4000),return_positive:None})).unwrap();
        assert_eq!(&speed[22..],&[3,0,100,0,6,160,15]);
        assert!(encode(9,&req(Command::Homing{direction:1,step_unit:100,dual:true,config,debug_pi:false})).is_err());
    }
    #[test]
    fn telemetry_state_is_opt_in_and_validated() {
        let q=req(Command::TelemetryState);
        let encoded=encode(9,&q).unwrap();
        assert_eq!(encoded.len(),23);assert_eq!(encoded[22],5);
        let mut reply=vec![0u8;60];reply[..22].copy_from_slice(&encoded[..22]);
        let b=28usize;
        reply[b]=1;reply[b+1]=0x0f;
        reply[b+4..b+8].copy_from_slice(&1234u32.to_le_bytes());
        reply[b+8..b+12].copy_from_slice(&24100u32.to_le_bytes());
        reply[b+12..b+16].copy_from_slice(&(-120i32).to_le_bytes());
        reply[b+16..b+24].copy_from_slice(&32768i64.to_le_bytes());
        reply[b+24..b+28].copy_from_slice(&0x20000000u32.to_le_bytes());
        let p=decode(9,&q,&reply).unwrap();
        assert!(p.motor.is_none());
        let t=p.telemetry.unwrap();
        assert_eq!(t.sampled_at_ms,1234);
        assert_eq!(t.bus_voltage_mv,Some(24100));
        assert_eq!(t.id_raw,Some(-120));
        assert_eq!(t.target_logical_position.as_deref(),Some("32768"));
        assert_eq!(t.protection_state,Some(0x20000000));
        reply[b+1]=0;assert!(decode(9,&q,&reply).unwrap().telemetry.unwrap().bus_voltage_mv.is_none());
        reply[b+1]=0x80;assert!(decode(9,&q,&reply).is_err());
        reply[b+1]=0;reply[b+2]=1;assert!(decode(9,&q,&reply).is_err());
    }
    #[test]
    fn opt_in_arrival_snapshot_preserves_legacy() {
        let q=req(Command::PositionState);let encoded=encode(9,&q).unwrap();
        assert_eq!(encoded.len(),23);assert_eq!(encoded[22],1);
        let mut reply=vec![0u8;128];reply[..22].copy_from_slice(&encoded[..22]);
        reply[120]=4;reply[121]=7;reply[122..124].copy_from_slice(&250u16.to_le_bytes());
        reply[124..126].copy_from_slice(&182u16.to_le_bytes());reply[126..].copy_from_slice(&200u16.to_le_bytes());
        let m=decode(9,&q,&reply).unwrap().motor.unwrap();
        assert_eq!(m.arrival_phase,Some(4));assert_eq!(m.arrival_ms,Some(250));
        assert_eq!(m.arrival_tolerance,Some(182));assert_eq!(m.arrival_dwell_ms,Some(200));
        reply[120]=5;assert!(decode(9,&q,&reply).is_err());
        reply.truncate(120);assert!(decode(9,&q,&reply).unwrap().motor.unwrap().arrival_phase.is_none());
        assert_eq!(encode(9,&req(Command::GetState)).unwrap().len(),22);
    }
    #[test]
    fn golden_signed_count_and_bounds(){
        let q=req(Command::Move{position:"-5000000000".into()});let p=encode(9,&q).unwrap();
        assert_eq!(&p[..6],&[2,12,1,0,0,0]);
        assert_eq!(&p[6..14],&[0xf0,0xde,0xbc,0x9a,0x78,0x56,0x34,0x12]);
        assert_eq!(&p[22..],&(-5_000_000_000i64).to_le_bytes());
        assert!(encode(0,&q).is_err());
        assert!(encode(9,&req(Command::Move{position:"9223372036854775808".into()})).is_err());
    }
    #[test]
    fn logical_coordinate_extension_and_backward_compatibility(){
        let q=req(Command::GetState);let mut p=vec![0u8;120];
        p[..22].copy_from_slice(&encode(9,&q).unwrap());
        p[28+48]=1;p[28+49]=1;p[28+50]=1;p[28+88]=1;
        p[96..104].copy_from_slice(&(-1234i64).to_le_bytes());
        p[104..112].copy_from_slice(&15000i64.to_le_bytes());
        p[112..116].copy_from_slice(&182u32.to_le_bytes());
        let s=decode(9,&q,&p).unwrap().motor.unwrap();
        assert_eq!(s.logical_position.as_deref(),Some("-1234"));
        assert_eq!(s.logical_span.as_deref(),Some("15000"));assert!(s.coordinate_valid);
        let old=decode(9,&q,&p[..96]).unwrap().motor.unwrap();
        assert!(!old.coordinate_valid&&old.logical_position.is_none());
        p[28+49]=0;assert!(decode(9,&q,&p).is_err());p[28+49]=1;
        p[28+89..28+91].copy_from_slice(&(-1234i16).to_le_bytes());p[28+91]=1;
        assert_eq!(decode(9,&q,&p).unwrap().motor.unwrap().temperature_raw,Some(-1234));
        p[28+91]=2;assert!(decode(9,&q,&p).is_err());
        let m=encode(9,&req(Command::LogicalMove{position:"2000".into()})).unwrap();
        assert_eq!(m[1],19);assert_eq!(&m[22..],&2000i64.to_le_bytes());
        let w=encode(9,&req(Command::LogicalWork{a:"2000".into(),b:"8000".into(),dwell_ms:500,cycles:1})).unwrap();
        assert_eq!(w[1],20);assert_eq!(w.len(),50);
        assert_eq!(&w[38..42],&0u32.to_le_bytes());
        assert_eq!(&w[46..50],&500u32.to_le_bytes());
    }
    #[test]
    #[ignore = "Read-only real controller discovery; set MOTO_STORAGE_RS485 and MOTO_STORAGE_CAN"]
    fn hardware_semantic_discovery(){
        use std::time::Duration;
        let mut results=vec![];
        for (key,mode,baud) in [("MOTO_STORAGE_RS485","main485",1500000),("MOTO_STORAGE_CAN","maincan",2000000)] {
            let name=match std::env::var(key){Ok(p)=>p,Err(_)=>continue};
            let serial=serialport::new(&name,baud).timeout(Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
            let mut t=crate::gateway::Transport::new(serial,mode,9);
            // GET_STATE discovery is explicitly read-only: no OPEN, PULSE,
            // power command, emergency-stop, or raw UART request is sent.
            let mut boot=None;
            for motor in [0,9] {
                let q=Request{request_id:1+motor as u32,boot_id:"0".into(),session_id:0,task_id:0,command:Command::GetState};
                let r=decode(motor,&q,&t.call(motor,GATEWAY_OP,&encode(motor,&q).unwrap()).unwrap()).unwrap();
                assert_eq!(r.result,0);assert!(!r.replayed);
                if let Some(b)=&boot {assert_eq!(b,&r.boot_id);} else {boot=Some(r.boot_id.clone());}
                eprintln!("HARDWARE semantic {mode} motor={motor} boot={} result={}",r.boot_id,r.result_name);
                if motor==9&&std::env::var_os("MOTO_VERIFY_VALIDITY").is_some() {
                    let masks=t.call(0,10,&[74,2]).unwrap();assert_eq!(masks.len(),4);
                    let s=r.motor.as_ref().unwrap();
                    assert_eq!(u16::from_be_bytes([masks[0],masks[1]])&(1<<8)!=0,s.align_valid&&s.config_verified&&s.logic_power);
                    assert_eq!(u16::from_be_bytes([masks[2],masks[3]])&(1<<8)!=0,s.span_valid&&s.align_valid&&s.config_verified&&s.logic_power);
                    let q=Request{request_id:30,boot_id:"0".into(),session_id:0,task_id:0,command:Command::EncoderState};
                    let e=decode(9,&q,&t.call(9,GATEWAY_OP,&encode(9,&q).unwrap()).unwrap()).unwrap();
                    assert_eq!(e.result,0);assert_eq!(e.encoder.as_ref().unwrap()[1],1);
                    results.push(serde_json::json!({"port":name,"mode":mode,"validity_registers":masks,"encoder":e}));
                }
                results.push(serde_json::json!({"port":name,"mode":mode,"motor":motor,"response":r}));
            }
            if let Ok(raw)=std::env::var("MOTO_HOME_EXPECT") {
                let expected:[u16;8]=serde_json::from_str(&raw).unwrap();
                let q=Request{request_id:20,boot_id:boot.clone().unwrap(),session_id:0,task_id:0,command:Command::HomingConfigRead};
                for motor in [1,9,16] {
                    let r=decode(motor,&q,&t.call(motor,GATEWAY_OP,&encode(motor,&q).unwrap()).unwrap()).unwrap();
                    assert_eq!(r.result,0);assert_eq!(r.homing_config,Some(expected));
                    results.push(serde_json::json!({"port":name,"mode":mode,"motor":motor,"response":r}));
                }
            }
        }
        assert!(!results.is_empty(),"No hardware ports supplied");
        if let Ok(path)=std::env::var("MOTO_SEMANTIC_REPORT") {
            std::fs::write(path,serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        }
    }
    #[test]
    #[ignore = "Explicit real M9 commissioning; MOTO_COMMISSION_ACTION and report path required"]
    fn hardware_m9_commission(){
        use std::time::{Duration,Instant};
        let action:u8=std::env::var("MOTO_COMMISSION_ACTION").unwrap().parse().unwrap();
        assert!((1..=4).contains(&action));
        let path=std::env::var("MOTO_COMMISSION_REPORT").unwrap();
        let name=std::env::var("MOTO_STORAGE_RS485").unwrap();
        let serial=serialport::new(name,1500000).timeout(Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
        let mut transport=crate::gateway::Transport::new(serial,"main485",9);
        let mut records=vec![];
        let mut q=Request{request_id:1,boot_id:"0".into(),session_id:0,task_id:0,command:Command::GetState};
        let mut call=|m:u8,q:&Request|->Result<Response,String>{
            let r=decode(m,q,&transport.call(m,GATEWAY_OP,&encode(m,q)?).map_err(|e|e.to_string())?)?;
            eprintln!("M9 {}",serde_json::to_string(&r).unwrap());
            records.push(serde_json::to_value(&r).unwrap());
            std::fs::write(&path,serde_json::to_vec_pretty(&records).unwrap()).unwrap();
            Ok(r)
        };
        let first=call(0,&q).unwrap();q.boot_id=first.boot_id;
        q.request_id=first.device.unwrap().request_floor+1;q.session_id=0x4d390001;q.command=Command::Open;
        assert_eq!(call(0,&q).unwrap().result,0);
        let result=(||->Result<(),String>{
            if action==3 {
                q.request_id+=1;q.command=Command::Commission{action:1};
                if call(9,&q)?.result!=0{return Err("Initialize rejected".into());}
                let started=Instant::now();
                loop {
                    std::thread::sleep(Duration::from_millis(100));
                    q.request_id+=1;q.command=Command::Pulse;call(0,&q)?;
                    q.request_id+=1;q.command=Command::GetState;
                    let r=call(9,&q)?;let s=r.motor.ok_or("No state")?;
                    if s.fault!=0||s.last_error!=0{return Err("Initialize failed".into());}
                    if s.drive!=1&&s.config_verified{break;}
                    if started.elapsed()>Duration::from_secs(15){return Err("Initialize timeout".into());}
                }
            }
            if action==2||action==3 {
                q.request_id+=1;q.command=Command::GetState;
                let r=call(9,&q)?;if r.result!=0{return Err(r.result_name.into());}
            }
            q.request_id+=1;q.command=Command::Commission{action};
            let r=call(9,&q)?;if r.result!=0{return Err(r.result_name.into());}
            let start=Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(200));
                q.request_id+=1;q.command=Command::Pulse;
                let r=call(0,&q)?;if r.result!=0{return Err(r.result_name.into());}
                if action==2||action==3 {
                    q.request_id+=1;q.command=Command::GetState;
                    let r=call(9,&q)?;if r.result!=0{return Err(r.result_name.into());}
                }
                q.request_id+=1;q.command=Command::GetState;
                let r=call(9,&q)?;let s=r.motor.ok_or("Missing motor state")?;
                if s.last_error!=0||s.fault!=0{return Err(format!("job error={} fault={}",s.last_error,s.fault));}
                if s.drive!=1&&!s.motion_active {
                    if action==1&&!s.config_verified{return Err("Initialization unverified".into());}
                    if action==2&&!s.align_valid{return Err("Alignment unverified".into());}
                    if action==3&&!s.span_valid{return Err("Homing unverified".into());}
                    break;
                }
                if start.elapsed()>Duration::from_secs(160){return Err("Commission timeout".into());}
            }
            Ok(())
        })();
        q.request_id+=1;q.command=Command::DriveDisable;let _=call(9,&q);
        q.request_id+=1;q.command=Command::Close;let _=call(0,&q);
        assert!(result.is_ok(),"{result:?}");
    }
    #[test]
    fn malformed_and_mismatched_replies(){
        let q=req(Command::GetState);let mut p=vec![0;96];
        assert!(decode(9,&q,&p).is_err());p[..22].copy_from_slice(&encode(9,&q).unwrap());
        assert!(decode(9,&q,&p[..95]).is_err());p[22]=255;assert!(decode(9,&q,&p).is_err());
        p[22]=0;p[23]=4;assert!(decode(9,&q,&p).is_err());p[23]=0;
        p[40..48].copy_from_slice(&(-5_000_000_000i64).to_le_bytes());
        assert_eq!(decode(9,&q,&p).unwrap().motor.unwrap().position,"-5000000000");
        p[2]=2;assert!(decode(9,&q,&p).is_err());
    }
    #[test]
    #[ignore = "Set LOS_MOTO_SEMANTIC_RPC to the freshly built C host handler"]
    fn c_handler_loopback(){
        use std::{io::{BufRead,BufReader,Write},process::{Command as Process,Stdio}};
        let exe=std::env::var("LOS_MOTO_SEMANTIC_RPC").expect("C handler path is required");
        let mut child=Process::new(exe).arg("--rpc").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut input=child.stdin.take().unwrap();let mut output=BufReader::new(child.stdout.take().unwrap());
        let mut call=|m:u8,q:&Request,now:u32|{
            let hex:String=encode(m,q).unwrap().iter().map(|b|format!("{b:02x}")).collect();
            writeln!(input,"1 {m} {now} {hex}").unwrap();input.flush().unwrap();
            let mut line=String::new();assert!(output.read_line(&mut line).unwrap()>0);
            let h=line.trim();let bytes:Vec<u8>=(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect();
            decode(m,q,&bytes).unwrap()
        };
        let mut q=req(Command::GetState);q.boot_id="0".into();q.session_id=0;
        let d=call(0,&q,40);assert_eq!(d.device.unwrap().capabilities,3);
        q=req(Command::Open);q.request_id=2;assert_eq!(call(0,&q,41).result_name,"OK");
        q.command=Command::Move{position:"6000".into()};q.request_id=3;
        let a=call(9,&q,42);assert_eq!(a.result,0);assert!(a.pending);let task=a.task_id;
        let duplicate=call(9,&q,43);assert!(duplicate.replayed);assert_eq!(duplicate.task_id,task);
        q.command=Command::GetState;q.request_id=4;
        let state=call(9,&q,90).motor.unwrap();assert_eq!(state.position,"6000");assert!(!state.motion_active);
        q.command=Command::DriveEnable;q.request_id=5;assert_eq!(call(9,&q,91).result_name,"EEPROM_INVALID");
        q.command=Command::Pulse;q.request_id=6;assert_eq!(call(0,&q,2100).result_name,"STALE_SESSION");
        drop(call);drop(input);assert!(child.wait().unwrap().success());
    }
    #[test]
    #[ignore = "Set LOS_MOTO_GATEWAY_RPC to the production-policy C gateway host executable"]
    fn c_gateway_rtu_loopback(){
        use std::{collections::VecDeque,io::{self,BufRead,BufReader,Read,Write},process::{Child,ChildStdin,ChildStdout,Command as Process,Stdio}};
        use crate::gateway::{self,Transport,Wire};
        struct Pipe { child:Child,input:ChildStdin,output:BufReader<ChildStdout>,tx:Vec<u8>,rx:VecDeque<u8> }
        impl Drop for Pipe {fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
        impl Read for Pipe {fn read(&mut self,b:&mut[u8])->io::Result<usize>{let n=b.len().min(self.rx.len());for v in b.iter_mut().take(n){*v=self.rx.pop_front().unwrap();}Ok(n)}}
        impl Write for Pipe {
            fn write(&mut self,b:&[u8])->io::Result<usize>{self.tx.extend(b);Ok(b.len())}
            fn flush(&mut self)->io::Result<()>{
                assert!(self.tx.len()>=5);assert_eq!(&self.tx[..2],&[1,0x41]);assert_eq!(gateway::crc(&self.tx),0);
                let n=self.tx[2] as usize;assert_eq!(n+5,self.tx.len());
                let hex:String=self.tx[3..3+n].iter().map(|b|format!("{b:02x}")).collect();
                writeln!(self.input,"{hex}")?;self.input.flush()?;let mut line=String::new();assert!(self.output.read_line(&mut line)?>0);
                let h=line.trim();let data:Vec<u8>=(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect();
                let mut r=vec![1,0x41,data.len() as u8];r.extend(data);r.extend(gateway::crc(&r).to_le_bytes());self.rx.extend(r);self.tx.clear();Ok(())
            }
        }
        impl Wire for Pipe {
            fn clear(&self,_:serialport::ClearBuffer)->io::Result<()>{Ok(())}
            fn available(&self)->io::Result<u32>{Ok(self.rx.len() as u32)}
        }
        let path=std::env::var("LOS_MOTO_GATEWAY_RPC").expect("production-policy C gateway path required");
        let mut child=Process::new(path).arg("--rpc").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let input=child.stdin.take().unwrap();let output=BufReader::new(child.stdout.take().unwrap());
        let mut port=Transport::from_wire(Box::new(Pipe{child,input,output,tx:vec![],rx:VecDeque::new()}),"main485",9);
        let mut q=req(Command::GetState);q.boot_id="0".into();q.session_id=0;
        let r=port.call(0,GATEWAY_OP,&encode(0,&q).unwrap()).unwrap();
        assert_eq!(decode(0,&q,&r).unwrap().device.unwrap().capabilities,0);
        let r=port.call(9,GATEWAY_OP,&encode(9,&q).unwrap()).unwrap();
        let m=decode(9,&q,&r).unwrap().motor.unwrap();assert!(!m.config_verified&&!m.align_valid);
        assert!(port.call(9,1,&[0x5a,0x00,0,0,9,0x81]).is_err()); // legacy PWM/mode write blocked
        assert!(port.call(9,5,&[1]).is_err()); // legacy logic enable blocked
        assert!(port.call(9,12,&[0,100,0,2]).is_err()); // legacy homing blocked
        assert!(port.call(0,6,&[]).is_ok()); // physical shutdown retained
    }
}
