#![allow(dead_code)]
//! TMC6460 UART datagram framing.
//!
//! Reference: tmc6460.pdf rev.0, "UART Interface" p.35-44.
//!
//! * read request  : 16 bit, {0x42|addr[9:8]<<4, addr[7:0]}
//! * read response : 48 bit, {echo0, echo1, D31..D0}
//! * write request : 48 bit, {0x4A|addr[9:8]<<4, addr[7:0], D31..D0}
//! * write response: 40 bit, only sent when `UART.RTMI_CH_7.CH_7_EN` is set
//! * RTMI frame    : 40 bit, {sync/ch/writecnt, D31..D0}
//!
//! Bits are sent LSB first on the wire but packed MSB-first inside each byte.

pub const SYNC_BIT0: u8 = 0x01;
pub const SYNC_BIT7_CLEAR: u8 = 0x80;

/// 16-bit read request datagram.
pub fn read_request(addr: u16) -> [u8; 2] {
    let hi = ((addr >> 8) & 0x03) as u8;
    [0x42 | (hi << 4), (addr & 0xFF) as u8]
}

/// 48-bit write request datagram.
pub fn write_request(addr: u16, value: u32) -> [u8; 6] {
    let hi = ((addr >> 8) & 0x03) as u8;
    let d = value.to_be_bytes();
    [
        0x4A | (hi << 4),
        (addr & 0xFF) as u8,
        d[0],
        d[1],
        d[2],
        d[3],
    ]
}

/// Decode the 32-bit payload of a 6-byte read response.
///
/// Byte 0 echoes the request, so it carries the `010b` low sync and the `10b`
/// high sync instead of the `1b`/`0b` pair used by RTMI frames.
pub fn parse_read_response(buf: &[u8]) -> Option<u32> {
    if buf.len() < 6 {
        return None;
    }
    if !is_normal_header(buf[0]) {
        return None;
    }
    Some(u32::from_be_bytes([buf[2], buf[3], buf[4], buf[5]]))
}

/// Normal read/write datagram header: bits[2:0] = 010b, bits[7:6] = 10b.
pub fn is_normal_header(b0: u8) -> bool {
    (b0 & 0x07) == 0x02 && (b0 & 0xC0) == 0x40
}

/// Channel id carried by an RTMI / write-response frame header.
pub fn frame_channel(byte0: u8) -> Option<u8> {
    if byte0 & SYNC_BIT0 != SYNC_BIT0 || byte0 & SYNC_BIT7_CLEAR != 0 {
        return None;
    }
    Some((byte0 >> 1) & 0x07)
}

/// Number of executed write requests reported inside a write response / RTMI header.
pub fn frame_write_count(byte0: u8) -> u8 {
    (byte0 >> 4) & 0x07
}

/// Decode the 32-bit payload of an RTMI channel response datagram.
pub fn parse_rtmi_frame(buf: &[u8]) -> Option<(u8, i32)> {
    if buf.len() < 5 {
        return None;
    }
    let ch = frame_channel(buf[0])?;
    let v = i32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    Some((ch, v))
}

/// CRC-8 used by `NORMAL_CRC_EN` / `RTMI_CRC_EN` (poly 0x1D, reflected input,
/// init 0x00, no final xor). Verified against the datasheet example
/// `{0x52 0x40 0x12}`.
pub fn crc8(datagram: &[u8]) -> u8 {
    let mut crc: u8 = 0x00;
    for byte in datagram {
        crc ^= byte.reverse_bits();
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x1D
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// MT6701 SSI CRC-6, polynomial x^6 + x + 1, computed over the 18 data bits
/// (D[13:0] + Mg[3:0]) MSB first. Reference: MT6701.pdf §7.8.2.
pub fn mt6701_crc6(data18: u32) -> u8 {
    let mut crc: u8 = 0;
    for i in (0..18).rev() {
        let bit = ((data18 >> i) & 1) as u8;
        crc = ((crc << 1) | bit) & 0x7F;
        if crc & 0x40 != 0 {
            crc ^= 0x43; // x^6 + x + 1
        }
    }
    crc & 0x3F
}

/// Streaming frame aligner. Accepts arbitrary byte chunks and yields complete
/// RTMI frames.
pub struct RtmiParser {
    buf: Vec<u8>,
    frame_len: usize,
    pub dropped: u64,
}

impl RtmiParser {
    pub fn new(frame_len: usize) -> Self {
        Self {
            buf: Vec::with_capacity(512),
            frame_len,
            dropped: 0,
        }
    }

    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<(u8, i32)>) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > 8192 {
            // runaway buffer: keep the tail only
            let keep = self.buf.len() - 1024;
            self.buf.drain(..keep);
            self.dropped += keep as u64;
        }
        let mut i = 0usize;
        while self.buf.len() - i >= self.frame_len {
            if frame_channel(self.buf[i]).is_some() && (self.frame_len != 6 || crc8(&self.buf[i..i+5]) == self.buf[i+5]) {
                let end = i + self.frame_len;
                match parse_rtmi_frame(&self.buf[i..end]) {
                    Some(frame) => out.push(frame),
                    None => {}
                }
                i = end;
            } else {
                i += 1;
                self.dropped += 1;
            }
        }
        if i > 0 {
            self.buf.drain(..i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_request_matches_datasheet() {
        assert_eq!(read_request(0x140), [0x52, 0x40]);
    }

    #[test]
    fn write_request_matches_datasheet() {
        assert_eq!(
            write_request(0x14E, 0x01000100),
            [0x5A, 0x4E, 0x01, 0x00, 0x01, 0x00]
        );
        assert_eq!(
            write_request(0x344, 0x0001_0082),
            [0x7A, 0x44, 0x00, 0x01, 0x00, 0x82]
        );
    }

    #[test]
    fn read_response_decodes() {
        let resp = [0x52, 0x40, 0x00, 0x00, 0x85, 0x5C];
        assert_eq!(parse_read_response(&resp), Some(0x0000_855C));
    }

    #[test]
    fn crc8_multibyte_is_deterministic() {
        // sanity: same input -> same output, and single byte round trip is stable
        assert_eq!(crc8(&[0x52, 0x40]), 0x12);
        assert_eq!(crc8(&[0x52,0x40,0,0,0x85,0x5c]),0x6a);
        assert_ne!(crc8(&[0x52, 0x40]), crc8(&[0x52, 0x41]));
    }

    #[test]
    fn rtmi_parser_streams() {
        let mut p = RtmiParser::new(5);
        let mut out = Vec::new();
        // channel 0 -> 0x00010000, channel 1 -> 0x80000000
        let stream = [0x01, 0x00, 0x01, 0x00, 0x00, 0x03, 0x80, 0x00, 0x00, 0x00];
        p.push(&stream, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], (0, 0x0001_0000));
        assert_eq!(out[1], (1, i32::MIN));
    }
}
