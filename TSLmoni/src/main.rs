//! TSLHand simulator CLI.
//!
//! ```text
//! tslmoni --selftest              # run the built-in protocol self check
//! tslmoni --rpc [--mode main485]  # hex packet lines on stdin -> hex on stdout
//! ```
//!
//! `--rpc` mirrors the firmware host test double: each stdin line is one
//! gateway packet (`1, seq_lo, seq_hi, motor, op, len, 0, payload...`) in hex,
//! and the response packet is printed the same way. A malformed packet prints
//! an empty line, which is what "no answer" looks like on the wire.

use std::io::{self, BufRead, Write};

use tslmoni::*;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| "main485".into());

    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest());
    }
    if args.iter().any(|a| a == "--rpc") {
        rpc(&mode);
        return;
    }

    println!("tslmoni {} — TSLHand main-controller simulator", env!("CARGO_PKG_VERSION"));
    println!("  --selftest             run the protocol self check");
    println!("  --rpc [--mode <m>]     hex packet server on stdin/stdout (m = main485|maincan)");
}

fn rpc(mode: &str) {
    let mut sim = Simulator::new(mode, 1);
    let stdin = io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let hex: String = line.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        let packet: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        let reply = sim.request(&packet).unwrap_or_default();
        let text: String = reply.iter().map(|b| format!("{b:02x}")).collect();
        println!("{text}");
        let _ = io::stdout().flush();
    }
}

fn packet(sim: &mut Simulator, seq: u8, motor: u8, op: u8, data: &[u8]) -> Option<Vec<u8>> {
    let mut q = vec![1, seq, 0, motor, op, data.len() as u8, 0];
    q.extend_from_slice(data);
    sim.request(&q)
}

fn expect(ok: bool, what: &str) -> bool {
    println!("  [{}] {what}", if ok { "ok" } else { "FAIL" });
    ok
}

fn selftest() -> i32 {
    let mut pass = true;
    let mut sim = Simulator::new("main485", 1);

    let ctl = packet(&mut sim, 1, 0, OP_INFO, &[]).unwrap_or_default();
    pass &= expect(ctl.get(5) == Some(&4) && &ctl[7..] == [1, 16, 1, 0], "主控 INFO = [1,16,1,owner]");

    let mut motors_ok = true;
    for m in 1..=16u8 {
        let info = packet(&mut sim, 2, m, OP_INFO, &[]).unwrap_or_default();
        motors_ok &= info.len() == 17
            && info[7] == ROUTES[m as usize - 1].0
            && info[16] == 16;
    }
    pass &= expect(motors_ok, "16 路 INFO 路由/掩码符合固件");

    pass &= expect(
        packet(&mut sim, 3, 17, OP_INFO, &[]).map(|r| r[6]) == Some(MOTO_BAD),
        "motor 17 -> MOTO_BAD",
    );

    let fw = packet(&mut sim, 4, 0, OP_BOARD, &[8, 8]).unwrap_or_default();
    pass &= expect(&fw[7..] == FW_TEXT, "BOARD 0x08 = 固件串 TSL-SIM FWHOST01");
    pass &= expect(
        packet(&mut sim, 5, 0, OP_BOARD, &[0, 64]).map(|r| r[5] as usize) == Some(128),
        "BOARD 0x00 x64 = 128 字节",
    );
    pass &= expect(
        packet(&mut sim, 6, 0, OP_BOARD, &[73, 1]).map(|r| r[7..] == [0, 1]) == Some(true),
        "BOARD 0x49 = HandID",
    );
    packet(&mut sim, 7, 0, OP_HAND_ID, &[0x12, 0x34]);
    pass &= expect(
        packet(&mut sim, 8, 0, OP_BOARD, &[73, 1]).map(|r| r[7..] == [0x12, 0x34]) == Some(true),
        "HAND_ID 写入后 BOARD 回读一致",
    );

    packet(&mut sim, 9, 3, OP_POWER, &[1]);
    let info = packet(&mut sim, 10, 3, OP_INFO, &[]).unwrap_or_default();
    let bit = 1u8 << (ROUTES[2].2 - 1);
    pass &= expect(
        info[15] == 1 && info[16] == 16 | bit,
        "POWER 上电 -> INFO diagnostics_live / config 掩码",
    );
    packet(&mut sim, 11, 0, OP_ALL_OFF, &[]);
    pass &= expect(
        packet(&mut sim, 12, 3, OP_INFO, &[]).map(|r| r[15]) == Some(0),
        "ALL_OFF 清空掩码",
    );

    let mut can = Simulator::new("maincan", 1);    pass &= expect(
        packet(&mut can, 13, 0, OP_INFO, &[]).map(|r| r[5]) == Some(4),
        "maincan 通道可用",
    );

    let mut direct = Simulator::new("direct", 1);
    direct.write(&write_request(0x150, 4321));
    direct.clear();
    direct.write(&read_request(0x150));
    let mut b = [0u8; 6];
    let mut n = 0;
    for _ in 0..20 {
        n += direct.read(&mut b[n..]);
        if n == 6 {
            break;
        }
    }
    pass &= expect(
        n == 6 && u32::from_be_bytes([b[2], b[3], b[4], b[5]]) == 4321,
        "direct 模式原始 TMC 数据报读写",
    );

    // M24C02 behind the I/O controller I²C master: INIT_OD -> WRITE -> READ.
    let mut ee = Simulator::new("direct", 1);
    ee.write(&write_request(0x381, 0xAA02_0095));
    ee.clear();
    ee.write(&write_request(0x381, 0xE010_005A)); // I2C_WRITE addr 0x10 = 0x5A
    ee.clear();
    ee.write(&write_request(0x381, 0xD010_0000)); // I2C_READ  addr 0x10
    ee.clear();
    ee.write(&read_request(0x383));
    let mut e = [0u8; 6];
    let mut m = 0;
    for _ in 0..20 {
        m += ee.read(&mut e[m..]);
        if m == 6 {
            break;
        }
    }
    pass &= expect(
        m == 6 && u32::from_be_bytes([e[2], e[3], e[4], e[5]]) & 0xFF == 0x5A,
        "EEPROM I2C_WRITE/READ 回读一致",
    );
    ee.clear();
    ee.write(&write_request(0x381, 0xAA03_0000)); // I2C_EEPROM -> I/O RAM
    ee.clear();
    ee.write(&write_request(0x381, 0xC008_0000)); // RAM_READ word 8 = byte 0x10/0x11
    ee.clear();
    ee.write(&read_request(0x383));
    let mut r = [0u8; 6];
    let mut k = 0;
    for _ in 0..20 {
        k += ee.read(&mut r[k..]);
        if k == 6 {
            break;
        }
    }
    pass &= expect(
        k == 6 && u32::from_be_bytes([r[2], r[3], r[4], r[5]]) >> 8 & 0xFF == 0x5A,
        "I2C_EEPROM 整片载入 RAM 后 RAM_READ 可读",
    );

    let mut rtmi = Simulator::new("main485", 1);
    packet(&mut rtmi, 14, 1, OP_OPEN, &[]);
    packet(
        &mut rtmi,
        15,
        1,
        OP_WRITE,
        &write_request(regs_ch(0), rtmi_channel(0x155)),
    );
    packet(
        &mut rtmi,
        16,
        1,
        OP_WRITE,
        &write_request(0x340, uart_control_rtmi(0, 0, false)),
    );
    let mut buf: Vec<u8> = Vec::new();
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        if let Some(p) = packet(&mut rtmi, 17, 1, OP_READ, &[]) {
            buf.extend_from_slice(&p[7..]);
        }
        if buf.len() > 200 {
            break;
        }
    }
    let mut frames = 0;
    let mut i = 0;
    while i + 5 <= buf.len() {
        if buf[i] & 0x01 != 0 && buf[i] & 0x80 == 0 {
            frames += 1;
            i += 5;
        } else {
            i += 1;
        }
    }
    pass &= expect(frames > 10, &format!("RTMI 连续出帧（{frames} 帧）"));

    println!("{}", if pass { "PASS" } else { "FAIL" });
    if pass {
        0
    } else {
        1
    }
}

fn regs_ch(ch: u16) -> u16 {
    0x344 + ch
}
