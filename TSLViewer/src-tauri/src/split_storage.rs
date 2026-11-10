//! MCU-owned W25 archive / compact M24 backup. No native ROM access here.
use serde::{Deserialize, Serialize};
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u32,
    pub operation: u8,
    #[serde(default)] pub offset: u8,
    #[serde(default)] pub data: Vec<u8>,
}
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u32, pub phase: u8, pub result: i32, pub motor: u8,
    pub operation: u8, pub generation: u32, pub hand_id: u16,
    pub flags: u8, pub offset: u8, pub data: Vec<u8>,
}
pub fn encode(motor:u8, q:&Request)->Result<Vec<u8>,String> {
    if motor>16 || q.id==0 || !(1..=11).contains(&q.operation) ||
       q.offset>128 || q.data.len()>106 || q.offset as usize+q.data.len()>128 ||
       (q.operation==2 && q.data.is_empty()) ||
       (q.operation!=2 && !q.data.is_empty()) ||
       (![2,6].contains(&q.operation) && q.offset!=0) ||
       ([4,5,9,10,11].contains(&q.operation) && motor==0) ||
       ([7,8].contains(&q.operation) && motor!=0) {
        return Err("Invalid split-storage request".into());
    }
    let mut p=vec![1,q.operation]; p.extend(q.id.to_le_bytes());
    p.extend([q.offset,q.data.len() as u8]); p.extend(&q.data); Ok(p)
}
pub fn decode(motor:u8,q:&Request,p:&[u8])->Result<Response,String> {
    if p.len()<22 || p.len()>128 || p[0]!=1 || p[1]>5 || p[18]&!7!=0 ||
       p[19]!=0 || p[20]>128 || p[21]>106 || p.len()!=22+p[21] as usize ||
       p[20] as usize+p[21] as usize>128 ||
       (p[1]!=4 && p[21]!=0) || (q.operation==6 && p[20]!=q.offset) {
        return Err("Invalid split-storage response".into());
    }
    let id=u32::from_le_bytes(p[2..6].try_into().unwrap());
    let result=i32::from_le_bytes(p[6..10].try_into().unwrap());
    if id!=q.id || p[10]!=motor || p[11]<1 || p[11]>11 ||
       (q.operation!=6 && p[11]!=q.operation) {
        // Older firmware returns the previous job's identity on rejection.
        // Report BUSY without exposing its data or treating it as our result.
        if result == -7 && q.operation != 6 {
            return Ok(Response{id:q.id,phase:5,result,motor,operation:q.operation,
                generation:0,hand_id:0,flags:0,offset:0,data:vec![]});
        }
        return Err(format!("存储响应与当前请求不匹配（请求 {}，响应 {}，结果 {}）；请重新读取配置",q.id,id,result));
    }
    Ok(Response{id,phase:p[1],result,motor,operation:p[11],
        generation:u32::from_le_bytes(p[12..16].try_into().unwrap()),
        hand_id:u16::from_le_bytes(p[16..18].try_into().unwrap()),
        flags:p[18],offset:p[20],data:p[22..].to_vec()})
}
#[cfg(test)] mod tests {
    use super::*;
    #[test]
    #[ignore="Passive page navigation regression on COM10; no motor motion"]
    fn hardware_page_reads_without_owner(){
        use std::{time::{Duration,Instant,SystemTime,UNIX_EPOCH},thread};
        let port=std::env::var("MOTO_STORAGE_RS485").expect("test port required");
        let serial=serialport::new(port,1500000).timeout(Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
        let mut t=crate::gateway::Transport::new(serial,"main485",9);
        // Wait beyond the old five-second legacy lease, without OPEN/permit.
        thread::sleep(Duration::from_millis(5200));
        let seed=(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()%0xffffffff) as u32;
        for (i,(motor,operation)) in [(0,7),(0,1),(9,1),(9,9),(0,7),(1,1),(0,1),(0,7)].into_iter().enumerate(){
            let mut q=Request{id:seed+i as u32,operation,offset:0,data:vec![]};
            let started=Instant::now();
            let mut r=decode(motor,&q,&t.call(motor,33,&encode(motor,&q).unwrap()).unwrap()).unwrap();
            while r.phase==2||r.phase==3{
                assert!(started.elapsed()<Duration::from_secs(10));thread::sleep(Duration::from_millis(40));q.operation=6;
                r=decode(motor,&q,&t.call(motor,33,&encode(motor,&q).unwrap()).unwrap()).unwrap();
            }
            assert!([0,-4].contains(&r.result),"op={operation} result={}",r.result);
            if r.result==0 {q.operation=6;q.offset=106;let tail=decode(motor,&q,&t.call(motor,33,&encode(motor,&q).unwrap()).unwrap()).unwrap();assert_eq!(tail.data.len(),22);assert_eq!(tail.generation,r.generation);}
            eprintln!("PASS passive motor={motor} op={operation} result={} elapsed_ms={}",r.result,started.elapsed().as_millis());
        }
        for (id,base,count) in [(1u16,528u16,14u16),(2,576,20),(3,640,60),(4,1024,60),(5,1252,60)]{
            let mut q=vec![];q.extend(id.to_be_bytes());q.push(3);q.extend(base.to_be_bytes());q.extend(count.to_be_bytes());
            let r=t.call(0,35,&q).unwrap();assert_eq!(&r[..3],&q[..3]);assert_eq!(r[3],0);assert_eq!(r.len(),4+2*count as usize);
            eprintln!("PASS motion registers base={base} count={count}");
        }
        // Reuse the factory tool's semantic session for an unchanged bitmap
        // write: exercises the real write route without enqueuing any motion.
        use crate::semantic_control as sem;
        let mut q=sem::Request{request_id:1,boot_id:"0".into(),session_id:0,task_id:0,command:sem::Command::GetState};
        let r=sem::decode(0,&q,&t.call(0,32,&sem::encode(0,&q).unwrap()).unwrap()).unwrap();
        let d=r.device.unwrap();assert_eq!(d.active_motor,0);assert!(!d.stopping);assert_eq!(r.session_id,0);
        q.boot_id=r.boot_id;q.request_id=d.request_floor+1;q.session_id=0x43464701;q.command=sem::Command::Open;
        let r=sem::decode(0,&q,&t.call(0,32,&sem::encode(0,&q).unwrap()).unwrap()).unwrap();assert_eq!(r.result,0);
        let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            let read=t.call(0,35,&[0,20,3,2,81,0,1]).unwrap();assert_eq!(read[3],0);
            let write=t.call(0,35,&[0,21,16,2,81,0,1,read[4],read[5]]).unwrap();assert_eq!(write,[0,21,16,0]);
            let after=t.call(0,35,&[0,22,3,2,81,0,1]).unwrap();assert_eq!(&read[4..],&after[4..]);
            let pending=t.call(0,35,&[0,23,3,2,29,0,1]).unwrap();assert_eq!(&pending[3..],&[0,0,0]);
            eprintln!("PASS same-source semantic session register write, unchanged READY mask; no queued motion");
        }));
        q.request_id+=1;q.command=sem::Command::Close;
        let r=sem::decode(0,&q,&t.call(0,32,&sem::encode(0,&q).unwrap()).unwrap()).unwrap();assert_eq!(r.result,0);
        assert!(outcome.is_ok());
    }
    #[test] fn rejected_busy_is_not_stale_success(){
        let mut q=Request{id:9,operation:1,offset:0,data:vec![]};
        let mut p=vec![0;22];p[0]=1;p[1]=5;p[2]=8;p[10]=1;p[11]=7;
        p[6..10].copy_from_slice(&(-7i32).to_le_bytes());
        let r=decode(9,&q,&p).unwrap();
        assert_eq!((r.id,r.motor,r.operation,r.phase,r.result),(9,9,1,5,-7));
        assert!(r.data.is_empty());
        q.operation=6;assert!(decode(9,&q,&p).is_err());
        q.operation=1;p[6..10].fill(0);assert!(decode(9,&q,&p).is_err());
    }
    #[test]
    #[ignore="Actual C gateway/storage with fake NOR; set LOS_MOTO_GATEWAY_RPC"]
    fn c_storage_roundtrip(){
        use std::{io::{BufRead,BufReader,Write},process::{Command,Stdio}};
        let path=std::env::var("LOS_MOTO_GATEWAY_RPC").expect("C gateway executable required");
        let mut child=Command::new(path).arg("--rpc").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut input=child.stdin.take().unwrap();let mut output=BufReader::new(child.stdout.take().unwrap());
        let mut sequence=0u16;
        let mut call=|motor:u8,op:u8,p:&[u8]|->Vec<u8>{
            sequence+=1;let mut frame=vec![1,sequence as u8,(sequence>>8) as u8,motor,op,p.len() as u8,0];frame.extend(p);
            let line:String=frame.iter().map(|v|format!("{v:02x}")).collect();writeln!(input,"{line}").unwrap();input.flush().unwrap();
            let mut line=String::new();assert!(output.read_line(&mut line).unwrap()>0);
            let h=line.trim();let r:Vec<u8>=(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect();
            assert_eq!(&r[..5],&frame[..5]);assert_eq!(r.len(),7+r[5] as usize);assert_eq!(r[6],0);r[7..].to_vec()
        };
        assert!(call(9,8,&[]).is_empty());
        let mut q=Request{id:1,operation:1,offset:0,data:vec![]};
        assert_eq!(decode(0,&q,&call(0,33,&encode(0,&q).unwrap())).unwrap().phase,2);
        q.operation=6;let empty=decode(0,&q,&call(0,33,&encode(0,&q).unwrap())).unwrap();assert_eq!(empty.result,-4);
        let mut common=vec![0u8;128];common[..4].copy_from_slice(b"ENC1");common[4..8].copy_from_slice(&0x00800001u32.to_le_bytes());
        let words:[u32;14]=[1,16384,60000000,2000000,14|(1<<8)|(16<<16)|(3<<24),4800,1050,2000,500,100,20,100,0,0];
        for (i,w) in words.iter().enumerate(){common[8+4*i..12+4*i].copy_from_slice(&w.to_le_bytes());}
        let crc=crate::motor_profile::crc32(&common[..120]);common[120..124].copy_from_slice(&crc.to_le_bytes());common[124..].copy_from_slice(&0x31544d43u32.to_le_bytes());
        for offset in [0usize,106] {
            q=Request{id:2,operation:2,offset:offset as u8,data:common[offset..(offset+106).min(128)].to_vec()};
            assert_eq!(decode(0,&q,&call(0,33,&encode(0,&q).unwrap())).unwrap().phase,1);
        }
        q=Request{id:2,operation:3,offset:0,data:vec![]};
        assert_eq!(decode(0,&q,&call(0,33,&encode(0,&q).unwrap())).unwrap().phase,2);
        let mut actual=vec![];q.operation=6;
        for offset in [0,106] {q.offset=offset;let r=decode(0,&q,&call(0,33,&encode(0,&q).unwrap())).unwrap();assert_eq!((r.phase,r.result,r.generation,r.flags),(4,0,1,1));actual.extend(r.data);}
        // Explicit common SAVE adds MCU identity/provenance; policy bytes and
        // motor compatibility hash remain canonical ENC1, not ENC2 CRC.
        assert_eq!(&actual[..4],b"ENC2");assert_eq!(&actual[8..64],&common[8..64]);
        assert_eq!(u32::from_le_bytes(actual[120..124].try_into().unwrap()),crate::motor_profile::crc32(&actual[..120]));
        assert!(call(9,9,&[]).is_empty());
        drop(call);drop(input);assert!(child.wait().unwrap().success());
    }
    #[test]
    #[ignore="Real controller storage reads; set MOTO_STORAGE_RS485 and optional MOTO_STORAGE_CAN"]
    fn hardware_storage_readonly(){
        use std::{time::{Duration,Instant},thread};
        let mut results=vec![];
        for (key,mode,baud) in [("MOTO_STORAGE_RS485","main485",1500000),("MOTO_STORAGE_CAN","maincan",2000000)] {
            let name=match std::env::var(key){Ok(p)=>p,Err(_)=>continue};
            let serial=serialport::new(&name,baud).timeout(Duration::from_millis(10)).dtr_on_open(false).open().unwrap();
            let mut t=crate::gateway::Transport::new(serial,mode,9);
            t.call(9,8,&[]).unwrap();
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                for (i,(motor,operation)) in [(0,1),(9,1),(9,4)].into_iter().enumerate(){
                    let mut q=Request{id:1000+i as u32,operation,offset:0,data:vec![]};
                    let reply=t.call(motor,33,&encode(motor,&q).unwrap()).unwrap();
                    let mut r=decode(motor,&q,&reply).unwrap();let end=Instant::now()+Duration::from_secs(20);
                    while r.phase==2||r.phase==3 {
                        assert!(Instant::now()<end,"worker timeout");thread::sleep(Duration::from_millis(80));
                        q.operation=6;
                        r=decode(motor,&q,&t.call(motor,33,&encode(motor,&q).unwrap()).unwrap()).unwrap();
                    }
                    assert!([4,5].contains(&r.phase));assert!([0,-4].contains(&r.result),"{mode}: result {}",r.result);
                    if operation==4 {assert_ne!(r.flags&4,0,"ROM/SSI restore missing");}
                    eprintln!("HARDWARE {mode} motor={motor} op={operation} result={} flags={}",r.result,r.flags);
                    results.push(serde_json::json!({"port":name,"mode":mode,"response":r}));
                }
            }));
            t.call(9,9,&[]).unwrap();
            assert!(result.is_ok(),"read-only storage test failed; CLOSE completed");
        }
        assert!(!results.is_empty(),"No hardware ports supplied");
        if let Ok(path)=std::env::var("MOTO_STORAGE_REPORT") {
            std::fs::write(path,serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        }
    }
    #[test] fn boundaries_and_stale_data(){
        let mut q=Request{id:9,operation:2,offset:106,data:vec![0;22]};
        assert_eq!(encode(9,&q).unwrap().len(),30);
        q.data.push(1);assert!(encode(9,&q).is_err());
        q=Request{id:9,operation:6,offset:106,data:vec![]};
        let mut p=vec![0;44];p[0]=1;p[1]=4;p[2]=9;p[10]=9;p[11]=1;p[16]=1;p[20]=106;p[21]=22;
        assert_eq!(decode(9,&q,&p).unwrap().data.len(),22);
        p[2]=8;assert!(decode(9,&q,&p).is_err());p[2]=9;
        p[1]=3;assert!(decode(9,&q,&p).is_err());
    }
}
