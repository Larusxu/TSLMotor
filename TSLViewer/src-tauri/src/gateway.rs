//! TeslaHand gateway wire format. Fixed deadlines; no serial reconfiguration in flight.
use serialport::{ClearBuffer, SerialPort};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    time::{Duration, Instant},
};
fn err(s: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::Other, s.into())
}
pub fn crc(p: &[u8]) -> u16 {
    let mut c = 0xffff;
    for b in p {
        c ^= *b as u16;
        for _ in 0..8 {
            c = (c >> 1) ^ if c & 1 != 0 { 0xa001 } else { 0 };
        }
    }
    c
}
pub trait Wire: Read + Write + Send {
    fn clear(&self, which: ClearBuffer) -> io::Result<()>;
    fn available(&self) -> io::Result<u32>;
}
struct SerialWire(Box<dyn SerialPort>);
impl Read for SerialWire {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        self.0.read(b)
    }
}
impl Write for SerialWire {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}
impl Wire for SerialWire {
    fn clear(&self, w: ClearBuffer) -> io::Result<()> {
        self.0.clear(w).map_err(|e| err(e.to_string()))
    }
    fn available(&self) -> io::Result<u32> {
        self.0.bytes_to_read().map_err(|e| err(e.to_string()))
    }
}
pub struct Transport {
    serial: Box<dyn Wire>,
    pub mode: String,
    pub motor: u8,
    seq: u16,
    rx: VecDeque<u8>,
}
impl Transport {
    pub fn new(serial: Box<dyn SerialPort>, mode: &str, motor: u8) -> Self {
        Self::from_wire(Box::new(SerialWire(serial)), mode, motor)
    }

    /// Build a transport over any wire implementation (used by the built-in
    /// simulator, which has no serial port behind it).
    pub fn from_wire(serial: Box<dyn Wire>, mode: &str, motor: u8) -> Self {
        Self {
            serial,
            mode: mode.into(),
            motor,
            seq: 0,
            rx: VecDeque::new(),
        }
    }
    pub fn gateway(&self) -> bool {
        self.mode != "direct"
    }
    fn byte(&mut self, end: Instant) -> io::Result<u8> {
        let mut b = [0];
        while Instant::now() < end {
            match self.serial.read(&mut b) {
                Ok(1) => return Ok(b[0]),
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::TimedOut => {}
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "主控响应超时"))
    }
    pub fn call(&mut self, motor: u8, op: u8, data: &[u8]) -> io::Result<Vec<u8>> {
        if data.len() > 128 {
            return Err(err("payload too large"));
        }
        self.seq = self.seq.wrapping_add(1);
        let mut q = vec![
            1,
            self.seq as u8,
            (self.seq >> 8) as u8,
            motor,
            op,
            data.len() as u8,
            0,
        ];
        q.extend_from_slice(data);
        let end = Instant::now() + Duration::from_millis(1500);
        let r = if self.mode == "main485" {
            let mut wire = vec![1, 0x41, q.len() as u8];
            wire.extend(&q);
            wire.extend(crc(&wire).to_le_bytes());
            self.serial.write_all(&wire)?;
            self.serial.flush()?;
            let mut header = Vec::new();
            while header.len() < 3 {
                header.push(self.byte(end)?);
            }
            if header[0] != 1 || header[1] != 0x41 || header[2] > 135 {
                return Err(err(format!("主控 RTU 头错误 header={header:02x?} motor={motor} op={op}")));
            }
            let n = header[2] as usize;
            for _ in 0..n + 2 {
                header.push(self.byte(end)?);
            }
            if crc(&header) != 0 {
                return Err(err("主控 RTU CRC 错误"));
            }
            header[3..3 + n].to_vec()
        } else {
            for (i, part) in q.chunks(6).enumerate() {
                let last = (i + 1) * 6 >= q.len();
                let mut w = vec![
                    0xaa,
                    0xc0 | (part.len() as u8 + 2),
                    0x00,
                    0x06,
                    self.seq as u8,
                    i as u8 | if last { 128 } else { 0 },
                ];
                w.extend(part);
                w.push(0x55);
                self.serial.write_all(&w)?;
                // Verified USB-CAN-A needs spacing between serial-framed CAN
                // requests; unpaced fragments intermittently lose replies.
                self.serial.flush()?;
                std::thread::sleep(Duration::from_millis(2));
            }
            self.serial.flush()?;
            let mut packet = Vec::new();
            let mut next = 0u8;
            loop {
                if self.byte(end)? != 0xaa {
                    continue;
                }
                let ty = self.byte(end)?;
                let dlc = (ty & 15) as usize;
                if dlc > 8 {
                    return Err(err("CAN DLC"));
                }
                let ext = ty & 0x20 != 0;
                let mut id = 0u32;
                for i in 0..if ext { 4 } else { 2 } {
                    id |= (self.byte(end)? as u32) << (8 * i);
                }
                let mut d = Vec::new();
                for _ in 0..dlc {
                    d.push(self.byte(end)?);
                }
                let tail = self.byte(end)?;
                if tail != 0x55 {
                    return Err(err(format!("CAN end type={ty:02x} id={id:08x} data={d:02x?} tail={tail:02x}")));
                }
                if ext || id != 0x580 || d.len() < 3 || d[0] != self.seq as u8 {
                    continue;
                }
                if d[1] & 127 != next {
                    return Err(err("CAN fragment order"));
                }
                next += 1;
                packet.extend_from_slice(&d[2..]);
                if packet.len() > 135 {
                    return Err(err("CAN packet overflow"));
                }
                if d[1] & 128 != 0 {
                    break packet;
                }
            }
        };
        if r.len() < 7 || r[0..5] != q[0..5] || r.len() != 7 + r[5] as usize {
            return Err(err(format!("主控响应序号/长度不匹配 request={q:02x?} response={r:02x?}")));
        }
        if r[6] != 0 {
            return Err(err(format!(
                "主控错误 {} (motor M{}, op {})",
                r[6], motor, op
            )));
        }
        Ok(r[7..].to_vec())
    }
    pub fn clear(&mut self, which: ClearBuffer) -> io::Result<()> {
        if self.gateway() {
            self.rx.clear();
            self.call(self.motor, 3, &[])?;
            Ok(())
        } else {
            self.serial.clear(which).map_err(|e| err(e.to_string()))
        }
    }
    pub fn write_all(&mut self, b: &[u8]) -> io::Result<()> {
        if self.gateway() {
            for p in b.chunks(128) {
                self.call(self.motor, 1, p)?;
            }
            Ok(())
        } else {
            self.serial.write_all(b)
        }
    }
    pub fn flush(&mut self) -> io::Result<()> {
        self.serial.flush()
    }
    pub fn bytes_to_read(&mut self) -> io::Result<u32> {
        if self.gateway() {
            if self.rx.is_empty() {
                let d = self.call(self.motor, 2, &[])?;
                self.rx.extend(d);
            }
            Ok(self.rx.len() as u32)
        } else {
            self.serial.available().map_err(|e| err(e.to_string()))
        }
    }
    pub fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        if !self.gateway() {
            return self.serial.read(b);
        }
        self.bytes_to_read()?;
        let n = b.len().min(self.rx.len());
        for v in &mut b[..n] {
            *v = self.rx.pop_front().unwrap();
        }
        Ok(n)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modbus_vector() {
        assert_eq!(crc(&[1, 3, 0, 0, 0, 10]), 0xcdc5);
    }
}
#[cfg(test)]
mod integration {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    struct Fake {
        child: Child,
        output: BufReader<std::process::ChildStdout>,
        tx: Vec<u8>,
        rx: VecDeque<u8>,
        can: bool,
        bad: bool,
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    impl Read for Fake {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            let n = b.len().min(self.rx.len()).min(3);
            for p in &mut b[..n] {
                *p = self.rx.pop_front().unwrap();
            }
            Ok(n)
        }
    }
    impl Write for Fake {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.tx.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.tx.is_empty() {
                return Ok(());
            }
            if self.can {
                let mut off = 0;
                let mut last = false;
                while off < self.tx.len() {
                    let n = (self.tx[off + 1] & 15) as usize;
                    last = self.tx[off + 5] & 128 != 0;
                    off += n + 5;
                }
                if !last {
                    return Ok(());
                }
            }
            let tx = std::mem::take(&mut self.tx);
            let q = if self.can {
                let mut q = Vec::new();
                let mut off = 0;
                let mut next = 0;
                while off < tx.len() {
                    assert_eq!(tx[off], 0xaa);
                    assert_eq!(&tx[off + 2..off + 4], &[0, 6]);
                    let n = (tx[off + 1] & 15) as usize;
                    assert_eq!(tx[off + 5] & 127, next);
                    next += 1;
                    assert_eq!(tx[off + 4], tx[4]);
                    assert_eq!(tx[off + 4 + n], 0x55);
                    q.extend_from_slice(&tx[off + 6..off + 4 + n]);
                    off += n + 5;
                }
                q
            } else {
                assert_eq!(crc(&tx), 0);
                assert_eq!(tx[1], 0x41);
                tx[3..tx.len() - 2].to_vec()
            };
            let line = q.iter().map(|b| format!("{b:02x}")).collect::<String>();
            writeln!(self.child.stdin.as_mut().unwrap(), "{line}")?;
            self.child.stdin.as_mut().unwrap().flush()?;
            let mut answer = String::new();
            self.output.read_line(&mut answer)?;
            let r = (0..answer.trim().len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&answer[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>();
            assert!(!r.is_empty());
            if self.can {
                for (i, p) in r.chunks(6).enumerate() {
                    let mut w = vec![
                        0xaa,
                        0xc0 | (p.len() as u8 + 2),
                        0x80,
                        5,
                        q[1],
                        i as u8 | if (i + 1) * 6 >= r.len() { 128 } else { 0 },
                    ];
                    w.extend(p);
                    w.push(0x55);
                    self.rx.extend(w);
                }
            } else {
                let mut w = vec![1, 0x41, r.len() as u8];
                w.extend(r);
                w.extend(crc(&w).to_le_bytes());
                if self.bad {
                    let n = w.len();
                    w[n - 1] ^= 1;
                }
                self.rx.extend(w);
            }
            Ok(())
        }
    }
    impl Wire for Fake {
        fn clear(&self, _: ClearBuffer) -> io::Result<()> {
            Ok(())
        }
        fn available(&self) -> io::Result<u32> {
            Ok(self.rx.len() as u32)
        }
    }
    fn transport(can: bool, bad: bool) -> Transport {
        let exe = std::env::var("MOTO_SIM")
            .expect("set MOTO_SIM to compiled tests/host/run_moto_tests.py output");
        let mut child = Command::new(exe)
            .arg("--rpc")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Transport {
            serial: Box::new(Fake {
                child,
                output,
                tx: vec![],
                rx: VecDeque::new(),
                can,
                bad,
            }),
            mode: if can { "maincan" } else { "main485" }.into(),
            motor: 1,
            seq: 0,
            rx: VecDeque::new(),
        }
    }
    #[test]
    #[ignore = "requires compiled firmware simulator; run with MOTO_SIM"]
    fn firmware_roundtrip_both_transports_all_motors() {
        for can in [false, true] {
            let mut t = transport(can, false);
            t.call(1, 8, &[]).unwrap();
            for m in 1..=16 {
                t.motor = m;
                let info = t.call(m, 4, &[]).unwrap();
                assert_eq!(info.len(), 10);
                t.write_all(&crate::proto::write_request(0x150, 1000 + m as u32))
                    .unwrap();
                t.clear(ClearBuffer::Input).unwrap();
                t.write_all(&crate::proto::read_request(0x150)).unwrap();
                let mut b = [0; 6];
                let n = t.read(&mut b).unwrap();
                assert_eq!(n, 6);
                assert_eq!(crate::proto::parse_read_response(&b), Some(1000 + m as u32));
                t.call(m, 5, &[1]).unwrap();
                let s = t.call(m, 4, &[]).unwrap();
                assert_ne!(s[9] & (1 << (s[2] - 1)), 0);
                t.call(m, 5, &[0]).unwrap();
            }
            assert_eq!(t.call(0, 10, &[0, 64]).unwrap().len(), 128);
            assert!(t.call(17, 4, &[]).is_err());
            t.call(0, 6, &[]).unwrap();
            t.call(0, 9, &[]).unwrap();
        }
    }
    #[test]
    #[ignore = "requires firmware simulator"]
    fn corrupt_outer_crc_rejected() {
        assert!(transport(false, true).call(0, 4, &[]).is_err());
    }
    #[test]
    #[ignore = "requires connected main board; read-only requests and logic power OFF only"]
    fn hardware_gateway_readonly() {
        for (key, mode, baud) in [("MOTO_HW_RS485", "main485", 460800),
                                  ("MOTO_HW_CAN", "maincan", 2000000)] {
            let port = std::env::var(key).expect("set both hardware port variables");
            let serial = serialport::new(port, baud)
                .timeout(Duration::from_millis(20)).dtr_on_open(false).open().unwrap();
            let mut t = Transport::new(serial, mode, 1);
            assert_eq!(&t.call(0, 4, &[]).unwrap()[..3], &[1, 16, 1]);
            for m in 1..=16 {
                assert_eq!(t.call(m, 4, &[]).unwrap().len(), 10);
            }
            assert_eq!(t.call(0, 10, &[0, 64]).unwrap().len(), 128);
            // Exercise a maximum 135-byte/23-frame request without UART IO:
            // motor=0 / unknown opcode is rejected before any device action.
            assert_eq!(t.call(0, 127, &[0; 128]).unwrap_err().kind(), io::ErrorKind::Other);
            t.call(1, 8, &[]).unwrap();
            t.call(0, 9, &[]).unwrap();
        }
    }

    #[test]
    #[ignore = "real hardware focused stress, no power enable or motor writes"]
    fn hardware_focus_stress() {
        let mode = std::env::var("MOTO_STRESS_MODE").unwrap_or("main485".into());
        let phase = std::env::var("MOTO_STRESS_PHASE").unwrap_or("mapping".into());
        assert!(["mapping", "board", "reopen", "uart", "invalid"].contains(&phase.as_str()));
        let rounds: u32 = std::env::var("MOTO_STRESS_ROUNDS").unwrap_or("100".into()).parse().unwrap();
        assert!((1..=10000).contains(&rounds));
        let name = std::env::var(if mode=="main485" {"MOTO_HW_RS485"} else {"MOTO_HW_CAN"}).unwrap();
        let baud = if mode=="main485" {460800} else {2000000};
        let open = || Transport::new(serialport::new(&name, baud).timeout(Duration::from_millis(8))
                    .dtr_on_open(false).open().unwrap(), &mode, 1);
        let mut t = open();
        t.call(1, 8, &[]).unwrap();
        let start = Instant::now();
        let mut errors = 0;
        for i in 0..rounds {
            if i%10==0 {eprintln!("FOCUS {mode} {phase} round={i} elapsed={:?}",start.elapsed());}
            match phase.as_str() {
                "mapping" => {match t.call((i%16+1) as u8,4,&[]) {
                    Ok(v)=>assert_eq!(v.len(),10),
                    Err(e)=>{errors+=1;eprintln!("FOCUS ERROR round={i}: {e}"); if std::env::var_os("MOTO_CATCH_STALL").is_none(){panic!("{e}");}}
                }}
                "board" => {assert_eq!(t.call(0,10,&[((i%4)*64) as u8,64]).unwrap().len(),128);}
                "reopen" => {t.call(0,9,&[]).unwrap();drop(t);t=open();assert_eq!(t.call(0,4,&[]).unwrap().len(),4);t.call(1,8,&[]).unwrap();}
                "uart" => {t.motor=(i%16+1) as u8;t.clear(ClearBuffer::Input).unwrap();t.write_all(&crate::proto::read_request(0)).unwrap();let mut b=[0;6];assert_eq!(t.read(&mut b).unwrap(),0);}
                "invalid" => {assert!(t.call(0,127,&[0;128]).is_err());assert_eq!(t.call(0,4,&[]).unwrap().len(),4);}
                _ => unreachable!(),
            }
        }
        t.call(0,9,&[]).unwrap();
        assert_eq!(errors,0,"diagnostic errors must never count as PASS");
        eprintln!("FOCUS PASS {mode} {phase} rounds={rounds} elapsed={:?}",start.elapsed());
    }

    #[test]
    #[ignore = "real controller identity read only; both adapters required"]
    fn hardware_hand_identity_read() {
        for (key,mode,baud) in [("MOTO_HW_RS485","main485",460800),("MOTO_HW_CAN","maincan",2000000)] {
            let serial=serialport::new(std::env::var(key).unwrap(),baud)
                .timeout(Duration::from_millis(8)).dtr_on_open(false).open().unwrap();
            let mut t=Transport::new(serial,mode,1);
            let fw=t.call(0,10,&[8,8]).unwrap();
            let fw=String::from_utf8(fw).unwrap().trim_matches('\0').to_string();
            assert_eq!(fw,std::env::var("MOTO_EXPECT_FW").unwrap());
            let id=t.call(0,10,&[73,1]).unwrap();
            assert_eq!(id.len(),2);
            let id=u16::from_be_bytes([id[0],id[1]]);
            assert_eq!(id,std::env::var("MOTO_EXPECT_HAND_ID").unwrap().parse::<u16>().unwrap());
            eprintln!("IDENTITY PASS {mode} FW_Version={fw} HandID={id}");
        }
    }

    /// Uses the exact desktop transport. No motor writes except CHIP.ID read
    /// requests; no power enable, motion, DFU or persistent-memory operations.
    #[test]
    #[ignore = "requires real controller, 16 motor boards absent, both adapters"]
    fn hardware_command_stress() {
        let rounds: u32 = std::env::var("MOTO_STRESS_ROUNDS").unwrap_or("100".into()).parse().unwrap();
        assert!((1..=500).contains(&rounds));
        let started = Instant::now();
        for (key, mode, baud) in [("MOTO_HW_RS485", "main485", 460800),
                                  ("MOTO_HW_CAN", "maincan", 2000000)] {
            let name = std::env::var(key).expect("set hardware ports");
            let mut calls = 0;
            for cycle in 0..rounds {
                // Reopen every cycle: deliberately exercise sequence reuse,
                // lease release and port-close behaviour, as the desktop does.
                let serial = serialport::new(&name, baud).timeout(Duration::from_millis(8))
                    .dtr_on_open(false).open().unwrap();
                let mut t = Transport::new(serial, mode, 1);
                eprintln!("STRESS {mode} round={cycle} phase=controller elapsed={:?}", started.elapsed());
                assert_eq!(&t.call(0, 4, &[]).unwrap()[..3], &[1, 16, 1]); calls += 1;
                t.call(1, 8, &[]).unwrap(); calls += 1;
                for base in [0, 64, 128, 192] {
                    assert_eq!(t.call(0, 10, &[base, 64]).unwrap().len(), 128); calls += 1;
                }
                eprintln!("STRESS {mode} round={cycle} phase=routes");
                for m in 1..=16 {
                    assert_eq!(t.call(m, 4, &[]).unwrap().len(), 10); calls += 1;
                }
                // A no-response downstream UART must not wedge controller IO.
                t.motor = (cycle % 16 + 1) as u8;
                t.clear(ClearBuffer::Input).unwrap();
                t.write_all(&crate::proto::read_request(0)).unwrap();
                std::thread::sleep(Duration::from_millis(5));
                let mut absent = [0; 6];
                assert_eq!(t.read(&mut absent).unwrap(), 0); calls += 3;
                // Maximum request and invalid ranges must be rejected, then
                // the next valid transaction must still be decoded correctly.
                assert!(t.call(0, 127, &[0; 128]).is_err()); calls += 1;
                assert!(t.call(0, 10, &[255, 2]).is_err()); calls += 1;
                assert!(t.call(17, 4, &[]).is_err()); calls += 1;
                t.call(0, 7, &[]).unwrap(); calls += 1;
                t.call(0, 9, &[]).unwrap(); calls += 1;
                eprintln!("STRESS {mode} round={cycle} phase=closed calls={calls}");
            }
            eprintln!("STRESS PASS {mode} rounds={rounds} calls={calls} elapsed={:?}", started.elapsed());
        }
    }
}
