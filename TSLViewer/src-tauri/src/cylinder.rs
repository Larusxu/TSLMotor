//! LA native protocol stays in firmware. Desktop only sends typed intents.
use crate::link::Link;
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, thread, time::{Duration, Instant}};
static TRANSACTION: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize)]
#[serde(tag="kind",rename_all="snake_case")]
pub enum Request {
    Snapshot { id:u8 }, Read { id:u8 },
    Protection { id:u8, current_ma:u16, temperature_c:u16 },
    Travel { id:u8, lower:u16, upper:u16, initial:u16 },
    Target { id:u8, position:u16 }, Clear { id:u8 },
    Permit { id:u8, enabled:bool }, Stop { id:u8 }, Initial { id:u8 },
}
#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub pending:bool,pub result:i16,pub ticket:u16,pub permit:bool,pub online:bool,
    pub id:u8,pub position:u16,pub target:u16,pub current_ma:u16,pub temperature_c:i16,
    pub restart_c:u16,pub current_limit_ma:u16,pub temperature_limit_c:u16,pub fault:u16,
    pub lower:u16,pub upper:u16,pub initial:u16,pub storage_ready:bool,
}
fn encode(r:&Request)->Result<Vec<u8>,String>{
    let (op,id,values)=match *r {
        Request::Snapshot{id}=>(0,id,vec![]),Request::Read{id}=>(1,id,vec![]),
        Request::Protection{id,current_ma,temperature_c}=>(2,id,vec![current_ma,temperature_c]),
        Request::Travel{id,lower,upper,initial}=>{
            if lower>upper||upper>2000||initial<lower||initial>upper{return Err("行程需满足 0 ≤ 下限 ≤ 初始位置 ≤ 上限 ≤ 2000".into());}
            (3,id,vec![lower,upper,initial])
        },
        Request::Target{id,position}=>{if position>2000{return Err("目标行程超出 0…2000".into());}(4,id,vec![position])},
        Request::Clear{id}=>(5,id,vec![]),Request::Permit{id,enabled}=>return if (1..=254).contains(&id){Ok(vec![6,id,enabled as u8])}else{Err("电缸 ID 需为 1…254".into())},
        Request::Stop{id}=>(7,id,vec![]),Request::Initial{id}=>(8,id,vec![]),
    };
    if !(1..=254).contains(&id){return Err("电缸 ID 需为 1…254".into());}
    let mut p=vec![op,id];for v in values{p.extend(v.to_le_bytes());}Ok(p)
}
fn decode(p:&[u8])->Result<Snapshot,String>{
    if p.len()!=68||p[0]!=1{return Err("电缸响应格式不匹配，请确认已更新主控固件".into());}
    let w=|i:usize|u16::from_le_bytes([p[i],p[i+1]]);
    let reg=|a:usize|w(8+2*(a-0x16));
    Ok(Snapshot{pending:p[1]!=0,result:w(2) as i16,ticket:w(4),permit:p[6]!=0,online:p[7]!=0,
        id:p[67],target:reg(0x29),position:reg(0x2a),current_ma:reg(0x2b),temperature_c:reg(0x2e) as i16,
        restart_c:reg(0x1f),current_limit_ma:reg(0x20),temperature_limit_c:reg(0x1e),fault:reg(0x2f),
        lower:w(60),upper:w(62),initial:w(64),storage_ready:p[66]!=0})
}
pub fn execute(link:&Link,channel:u8,r:&Request)->Result<Snapshot,String>{
    if !(1..=5).contains(&channel){return Err("电缸通道需为 1…5".into());}
    let payload=encode(r)?;
    let _guard=TRANSACTION.lock().map_err(|_|"电缸通信锁异常")?;
    let call=|p:&[u8]|link.gateway_control(channel,34,p).map_err(|e|e.to_string()).and_then(|p|decode(&p));
    let mut s=call(&payload)?;
    if payload[0]==0{return Ok(s);}
    if s.result!=0{return Err(format!("电缸 C{channel} 请求未执行，主控结果 {}",s.result));}
    let ticket=s.ticket;let start=Instant::now();
    while s.pending {
        if start.elapsed()>Duration::from_secs(4){return Err(format!("电缸 C{channel} 操作完成状态未确认，请读取核对；未自动重发"));}
        thread::sleep(Duration::from_millis(25));s=call(&[0,payload[1]])?;
        if s.ticket!=ticket{return Err("电缸请求被另一控制端替换，请读取当前状态".into());}
    }
    if s.result!=0{return Err(format!("电缸 C{channel} 操作失败（{}），请检查 ID、接线及供电",s.result));}
    link.log("ok","cylinder",format!("C{channel} UART{} 操作 {} 完成",channel+17,payload[0]));
    Ok(s)
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn travel_is_controller_configuration(){assert_eq!(encode(&Request::Travel{id:1,lower:100,upper:1800,initial:900}).unwrap(),[3,1,100,0,8,7,132,3]);}
    #[test]fn invalid_limits_do_not_reach_board(){assert!(encode(&Request::Travel{id:1,lower:1000,upper:500,initial:700}).is_err());}
    #[test]fn snapshot_does_not_issue_motion(){assert_eq!(encode(&Request::Snapshot{id:1}).unwrap(),[0,1]);}
    #[test]fn decode_uses_total_current_and_local_travel(){let mut p=vec![0;68];p[0]=1;p[50]=0x34;p[51]=0x12;p[62]=0xd0;p[63]=7;p[67]=1;let s=decode(&p).unwrap();assert_eq!(s.current_ma,0x1234);assert_eq!(s.upper,2000);}
}
