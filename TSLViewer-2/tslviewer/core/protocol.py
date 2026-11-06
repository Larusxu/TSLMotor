"""TMC6460 UART datagram framing and checksums.

Ported from ``src-tauri/src/proto.rs`` (reference: tmc6460.pdf rev.0 p.35-44).

* read request  : 16 bit, ``{0x42|addr[9:8]<<4, addr[7:0]}``
* read response : 48 bit, ``{echo0, echo1, D31..D0}``
* write request : 48 bit, ``{0x4A|addr[9:8]<<4, addr[7:0], D31..D0}``
* RTMI frame    : 40 bit, ``{sync/ch/writecnt, D31..D0}``
"""

from __future__ import annotations

SYNC_BIT0 = 0x01
SYNC_BIT7_CLEAR = 0x80


def u32(value: int) -> int:
    return value & 0xFFFFFFFF


def s32(value: int) -> int:
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value & 0x80000000 else value


def read_request(addr: int) -> bytes:
    hi = (addr >> 8) & 0x03
    return bytes([0x42 | (hi << 4), addr & 0xFF])


def write_request(addr: int, value: int) -> bytes:
    hi = (addr >> 8) & 0x03
    return bytes([0x4A | (hi << 4), addr & 0xFF]) + u32(value).to_bytes(4, "big")


def is_normal_header(b0: int) -> bool:
    return (b0 & 0x07) == 0x02 and (b0 & 0xC0) == 0x40


def parse_read_response(buf: bytes) -> int | None:
    if len(buf) < 6 or not is_normal_header(buf[0]):
        return None
    return int.from_bytes(buf[2:6], "big")


def frame_channel(byte0: int) -> int | None:
    if byte0 & SYNC_BIT0 != SYNC_BIT0 or byte0 & SYNC_BIT7_CLEAR != 0:
        return None
    return (byte0 >> 1) & 0x07


def frame_write_count(byte0: int) -> int:
    return (byte0 >> 4) & 0x07


def parse_rtmi_frame(buf: bytes) -> tuple[int, int] | None:
    if len(buf) < 5:
        return None
    ch = frame_channel(buf[0])
    if ch is None:
        return None
    return ch, s32(int.from_bytes(buf[1:5], "big"))


def _reverse_bits(value: int) -> int:
    out = 0
    for i in range(8):
        out |= ((value >> i) & 1) << (7 - i)
    return out


def crc8(datagram: bytes) -> int:
    """CRC-8 used by NORMAL_CRC_EN / RTMI_CRC_EN (poly 0x1D)."""
    crc = 0
    for byte in datagram:
        crc ^= _reverse_bits(byte)
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1D) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def crc16_modbus(data: bytes) -> int:
    """Gateway RS-485 outer CRC (reflected 0xA001, init 0xFFFF)."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def mt6701_crc6(data18: int) -> int:
    """MT6701 SSI CRC-6, polynomial x^6 + x + 1 over D[13:0]+Mg[3:0]."""
    crc = 0
    for i in range(17, -1, -1):
        bit = (data18 >> i) & 1
        crc = ((crc << 1) | bit) & 0x7F
        if crc & 0x40:
            crc ^= 0x43
    return crc & 0x3F


class RtmiParser:
    """Streaming frame aligner; yields complete RTMI frames from byte chunks."""

    def __init__(self, frame_len: int = 5) -> None:
        self.buf = bytearray()
        self.frame_len = frame_len
        self.dropped = 0

    def push(self, data: bytes, out: list[tuple[int, int]]) -> None:
        self.buf.extend(data)
        if len(self.buf) > 8192:
            keep = len(self.buf) - 1024
            del self.buf[:keep]
            self.dropped += keep
        i = 0
        while len(self.buf) - i >= self.frame_len:
            ok = frame_channel(self.buf[i]) is not None
            if ok and self.frame_len == 6:
                ok = crc8(bytes(self.buf[i : i + 5])) == self.buf[i + 5]
            if ok:
                frame = parse_rtmi_frame(bytes(self.buf[i : i + self.frame_len]))
                if frame is not None:
                    out.append(frame)
                i += self.frame_len
            else:
                i += 1
                self.dropped += 1
        if i:
            del self.buf[:i]
