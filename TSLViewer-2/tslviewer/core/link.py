"""Serial link: datagram transactions, gateway transport and RTMI streaming.

Ported from ``src-tauri/src/link.rs`` + ``gateway.rs``.  One link owns the
serial port; every page shares it through :class:`~tslviewer.core.store.AppStore`.
All public methods are thread safe.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import serial
from serial.tools import list_ports

from . import protocol, regs
from .registers import STATUS_BITS

BATCH_INTERVAL_S = 0.05

# CHIP addresses used by the backend procedures (mirrors regs.rs).
REG_CHIP_ID = 0x000
REG_IO_MATRIX = 0x006
REG_STATUS = 0x009
REG_EVENTS = 0x00A
REG_MCC_MOTOR = 0x100
REG_MCC_GDRV = 0x101
REG_PID_CONFIG = 0x140
REG_TORQUE_TARGET = 0x14E
REG_VEL_TARGET = 0x150
REG_VEL_ACTUAL = 0x154
REG_POS_ACTUAL = 0x155
REG_UART_CONTROL = 0x340
REG_UART_RTMI_CH = 0x344


@dataclass
class LinkError(Exception):
    message: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.message


@dataclass
class LogLine:
    ts: float
    level: str
    source: str
    message: str


@dataclass
class LinkStats:
    connected: bool = False
    port: str = ""
    baud: int = 0
    mode: str = "direct"
    motor: int = 1
    tx_bytes: int = 0
    rx_bytes: int = 0
    rtmi_running: bool = False
    rtmi_frames: int = 0
    rtmi_dropped: int = 0
    frame_rate: float = 0.0
    channels: list[int] = field(default_factory=list)
    sampling: int = 0
    trigger_hz: float = 0.0


@dataclass
class TmcProbe:
    motor: int
    online: bool
    chip_id: int | None
    tries: int


def now_ms() -> float:
    return time.time() * 1000.0


def list_serial_ports() -> list[tuple[str, str]]:
    """Return (device, description) sorted naturally like the original."""
    ports = []
    for p in list_ports.comports():
        ports.append((p.device, p.description or ""))
    ports.sort(key=lambda item: _natural_key(item[0]))
    return ports


def _natural_key(text: str):
    import re

    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


class Transport:
    """Wraps the serial port and hides direct vs. gateway framing."""

    def __init__(self, port: serial.Serial, mode: str, motor: int) -> None:
        self.serial = port
        self.mode = mode
        self.motor = motor
        self.seq = 0
        self._rx = bytearray()

    @property
    def gateway(self) -> bool:
        return self.mode != "direct"

    # ---------------------------------------------------------- framing
    def call(self, motor: int, op: int, data: bytes = b"") -> bytes:
        if len(data) > 128:
            raise LinkError("主控数据长度超限")
        self.seq = (self.seq + 1) & 0xFFFF
        q = bytes(
            [1, self.seq & 0xFF, (self.seq >> 8) & 0xFF, motor & 0xFF, op & 0xFF, len(data), 0]
        ) + bytes(data)
        deadline = time.monotonic() + 1.5
        if self.mode == "main485":
            frame = bytearray([1, 0x41, len(q)]) + q
            frame += protocol.crc16_modbus(bytes(frame)).to_bytes(2, "little")
            self.serial.reset_input_buffer()
            self.serial.write(bytes(frame))
            self.serial.flush()
            buf = bytearray()
            reply = None
            while time.monotonic() < deadline:
                buf.extend(self.serial.read(1))
                reply = self._match_rtu(bytes(buf), q)
                if reply is not None:
                    break
                if len(buf) > 140:
                    del buf[0]
            if reply is None:
                raise LinkError("主控响应超时")
        else:
            for i in range(0, len(q), 6):
                part = q[i : i + 6]
                last = i + 6 >= len(q)
                w = bytearray([0xAA, 0xC0 | (len(part) + 2), 0x00, 0x06, self.seq & 0xFF, (i // 6) | (0x80 if last else 0)])
                w.extend(part)
                w.append(0x55)
                self.serial.write(bytes(w))
                self.serial.flush()
                time.sleep(0.002)
            packet = bytearray()
            next_index = 0
            while time.monotonic() < deadline:
                if self._byte(deadline) != 0xAA:
                    continue
                ty = self._byte(deadline)
                dlc = ty & 0x0F
                if dlc > 8:
                    raise LinkError("CAN DLC 非法")
                extended = bool(ty & 0x20)
                ident = 0
                for i in range(4 if extended else 2):
                    ident |= self._byte(deadline) << (8 * i)
                payload = bytes(self._byte(deadline) for _ in range(dlc))
                tail = self._byte(deadline)
                if tail != 0x55:
                    raise LinkError("CAN 帧结束符错误")
                if extended or ident != 0x580 or len(payload) < 3 or payload[0] != (self.seq & 0xFF):
                    continue
                if payload[1] & 0x7F != next_index:
                    raise LinkError("CAN 分片顺序错误")
                next_index += 1
                packet.extend(payload[2:])
                if len(packet) > 135:
                    raise LinkError("CAN 数据包溢出")
                if payload[1] & 0x80:
                    break
            else:
                raise LinkError("主控响应超时")
            reply = bytes(packet)
        if len(reply) < 7 or reply[:5] != q[:5] or len(reply) != 7 + reply[5]:
            raise LinkError(
                f"主控响应序号/长度不匹配 request={q.hex()} response={reply.hex()}"
            )
        if reply[6] != 0:
            raise LinkError(f"主控错误 {reply[6]} (motor M{motor}, op {op})")
        return reply[7:]

    def _byte(self, deadline: float) -> int:
        while time.monotonic() < deadline:
            chunk = self.serial.read(1)
            if chunk:
                return chunk[0]
        raise LinkError("主控响应超时")

    @staticmethod
    def _match_rtu(buf: bytes, request: bytes) -> bytes | None:
        for start in range(0, max(0, len(buf) - 4)):
            if buf[start : start + 2] != b"\x01\x41":
                continue
            n = buf[start + 2]
            if not (7 <= n <= 135) or start + n + 5 > len(buf):
                continue
            frame = buf[start : start + n + 5]
            if protocol.crc16_modbus(frame) != 0:
                continue
            reply = frame[3 : 3 + n]
            if reply[:5] == request[:5] and n == 7 + reply[5]:
                return bytes(reply)
        return None

    # ------------------------------------------------- I/O facade used by Link
    def uart_write(self, data: bytes) -> None:
        if self.gateway:
            for i in range(0, len(data), 128):
                self.call(self.motor, 1, data[i : i + 128])
        else:
            self.serial.write(data)
            self.serial.flush()

    def uart_read(self, want: int, timeout_ms: int) -> bytes:
        deadline = time.monotonic() + timeout_ms / 1000.0
        if self.gateway:
            while len(self._rx) < want and time.monotonic() < deadline:
                self._rx.extend(self.call(self.motor, 2, b""))
                if len(self._rx) >= want:
                    break
            out = bytes(self._rx[:want])
            del self._rx[:want]
            return out
        buf = bytearray()
        while len(buf) < want and time.monotonic() < deadline:
            chunk = self.serial.read(want - len(buf))
            if chunk:
                buf.extend(chunk)
        return bytes(buf)

    def clear_input(self) -> None:
        if self.gateway:
            self._rx.clear()
            try:
                self.call(self.motor, 3, b"")
            except LinkError:
                pass
        else:
            self.serial.reset_input_buffer()

    def available(self) -> int:
        if self.gateway:
            return len(self._rx)
        return self.serial.in_waiting

    def read_some(self, size: int = 4096) -> bytes:
        if self.gateway:
            if not self._rx:
                self._rx.extend(self.call(self.motor, 2, b""))
            chunk = bytes(self._rx[:size])
            del self._rx[:size]
            return chunk
        return self.serial.read(max(1, min(size, self.serial.in_waiting or 1)))


class Link:
    """Owns the port, transactions, RTMI thread and the shared log buffer."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._transport: Transport | None = None
        self._paused = False
        self._running = False
        self._rtmi_thread: threading.Thread | None = None
        self._rtmi_channels: list[int] = []
        self._rtmi_sampling = 0
        self._rtmi_crc = False
        self._rtmi_trigger = 0.0
        self._rtmi_frames = 0
        self._rtmi_dropped = 0
        self._rate_mark = (time.monotonic(), 0)
        self._frame_rate = 0.0
        self._tx = 0
        self._rx = 0
        self._logs: list[LogLine] = []
        self.motor = 1
        self.mode = "direct"
        self.port_name = ""
        self.baud = 0
        self.on_batch: Callable[[float, list[tuple[int, int]]], None] | None = None
        self.on_log: Callable[[LogLine], None] | None = None

    # ------------------------------------------------------------- logging
    def log(self, level: str, source: str, message: str) -> None:
        line = LogLine(now_ms(), level, source, message)
        self._logs.append(line)
        if len(self._logs) > 2500:
            self._logs = self._logs[-2000:]
        cb = self.on_log
        if cb:
            cb(line)

    def logs(self) -> list[LogLine]:
        with self._lock:
            return list(self._logs)

    def clear_logs(self) -> None:
        with self._lock:
            self._logs.clear()

    # ------------------------------------------------------------ lifecycle
    def is_connected(self) -> bool:
        return self._transport is not None

    def is_gateway(self) -> bool:
        return self.mode != "direct"

    def open(self, name: str, baud: int, mode: str = "direct", motor: int = 1) -> LinkStats:
        self.close()
        with self._lock:
            port = serial.Serial(
                port=name,
                baudrate=baud,
                timeout=0.02,
                write_timeout=0.5,
                exclusive=True,
            )
            self._transport = Transport(port, mode, motor)
            self.mode = mode
            self.motor = motor
            self.port_name = name
            self.baud = baud
            self._tx = 0
            self._rx = 0
        self.log("info", "link", f"打开 {name} @ {baud} bit/s（{mode}）")
        if mode != "direct":
            self.gateway_control(0, 4, b"")  # controller handshake
            self.focus_motor(motor)
        else:
            try:
                chip = self.read_reg_retry(REG_CHIP_ID, 2)
                self.log("info", "link", f"CHIP.ID = 0x{chip:08X}")
            except LinkError as exc:
                self.log("warn", "link", f"已打开串口，但读取 CHIP.ID 失败: {exc}")
        return self.stats()

    def close(self) -> None:
        self.stop_rtmi()
        with self._lock:
            if self._transport is not None:
                try:
                    self._transport.serial.close()
                except Exception:
                    pass
            self._transport = None
            self.port_name = ""
            self._frame_rate = 0.0

    def stats(self) -> LinkStats:
        with self._lock:
            if self._transport is not None:
                self._tx = getattr(self, "_tx", 0)
            return LinkStats(
                connected=self._transport is not None,
                port=self.port_name,
                baud=self.baud,
                mode=self.mode,
                motor=self.motor,
                tx_bytes=self._tx,
                rx_bytes=self._rx,
                rtmi_running=self._running,
                rtmi_frames=self._rtmi_frames,
                rtmi_dropped=self._rtmi_dropped,
                frame_rate=self._frame_rate,
                channels=list(self._rtmi_channels),
                sampling=self._rtmi_sampling,
                trigger_hz=self._rtmi_trigger,
            )

    # ------------------------------------------------------------ transport
    def _require(self) -> Transport:
        if self._transport is None:
            raise LinkError("串口未连接")
        return self._transport

    def gateway_control(self, motor: int, op: int, data: bytes = b"") -> bytes:
        if not self.is_gateway():
            raise LinkError("当前是直连模式，主控指令不可用")
        with self._lock:
            return self._require().call(motor, op, data)

    def main_control(self, motor: int, op: int, data: list[int] | bytes = b"") -> list[int]:
        return list(self.gateway_control(motor, op, bytes(data)))

    def focus_motor(self, motor: int) -> None:
        if not self.is_gateway():
            with self._lock:
                self.motor = motor
            return
        with self._lock:
            self._require().motor = motor
            self.motor = motor
            try:
                self._require().call(motor, 8, b"")
            except LinkError:
                pass

    def _transact(self, req: bytes, want: int, timeout_ms: int = 60) -> bytes:
        with self._lock:
            sp = self._require()
            self._paused = True
            try:
                time.sleep(0.003)
                sp.clear_input()
                sp.uart_write(req)
                self._tx += len(req)
                resp = sp.uart_read(want, timeout_ms)
                self._rx += len(resp)
                if not resp:
                    raise LinkError("串口响应超时")
                return resp
            finally:
                self._paused = False

    def read_reg(self, addr: int) -> int:
        if not 0 <= addr <= 0x3FF:
            raise LinkError("寄存器地址必须为 0..0x3FF")
        req = protocol.read_request(addr)
        resp = self._transact(req, 6)
        if len(resp) < 6:
            raise LinkError("串口响应超时")
        if resp[0] != req[0] or resp[1] != req[1]:
            raise LinkError("响应校验失败")
        value = protocol.parse_read_response(resp)
        if value is None:
            raise LinkError("响应校验失败")
        return value

    def read_reg_retry(self, addr: int, tries: int = 3) -> int:
        last = LinkError("串口响应超时")
        for _ in range(max(1, tries)):
            try:
                return self.read_reg(addr)
            except LinkError as exc:
                last = exc
                time.sleep(0.002)
        raise last

    def write_reg(self, addr: int, value: int) -> None:
        if not 0 <= addr <= 0x3FF:
            raise LinkError("寄存器地址必须为 0..0x3FF")
        with self._lock:
            sp = self._require()
            if addr == REG_UART_CONTROL and sp.gateway:
                current = self.read_reg(REG_UART_CONTROL)
                if (current ^ value) & 0x001FFFFF:
                    raise LinkError("主控模式保留 UART 波特率、正常帧 CRC 和接口配置；请使用 RTMI 控件")
            req = protocol.write_request(addr, value)
            self._paused = True
            try:
                time.sleep(0.002)
                sp.clear_input()
                sp.uart_write(req)
                self._tx += len(req)
            finally:
                self._paused = False

    def write_verified(self, addr: int, value: int, mask: int = 0xFFFFFFFF) -> bool:
        last: LinkError | None = None
        for _ in range(3):
            self.write_reg(addr, value)
            time.sleep(0.002)
            try:
                if (self.read_reg_retry(addr, 2) & mask) == (value & mask):
                    return True
            except LinkError as exc:
                last = exc
        self.log("error", "link", f"写 0x{addr:03X} = 0x{value:08X} 校验失败 ({last})")
        return False

    # ---------------------------------------------------------------- RTMI
    def start_rtmi(self, channels: list[tuple[int, int]], sampling: int, crc: bool = False) -> None:
        self.stop_rtmi()
        if not channels:
            raise LinkError("至少选择一个 RTMI 通道")
        gateway = self.is_gateway()
        if gateway:
            pwm = self.pwm_frequency_hz() or 25_000.0
            required = int(-(-pwm * len(channels) * (6.0 if crc else 5.0) // 2000))
            if required > 256:
                raise LinkError("主控链路 RTMI 限 2000 B/s；请减少采集通道")
            sampling = max(sampling, max(0, required - 1))
            self.log("info", "gateway", f"主控 RTMI sampling={sampling}，非硬实时采集")
        base = self.read_reg_retry(REG_UART_CONTROL, 3)
        for ch, addr in channels:
            if ch > 6:
                raise LinkError("RTMI 通道 0..6 可用")
            value = (1 << 16) | (addr & 0x03FF)
            if not self.write_verified(REG_UART_RTMI_CH + ch, value, 0x000103FF):
                raise LinkError(f"RTMI 通道 {ch} 配置失败")
        ctrl = base & ~(0xFF << 24) & ~(1 << 22) & ~(1 << 21)
        ctrl |= (sampling & 0xFF) << 24 | (1 << 22)
        if crc:
            ctrl |= 1 << 21
        if not self.write_verified(REG_UART_CONTROL, ctrl, 0xFFE00000):
            raise LinkError("UART.CONTROL 写入失败")

        pwm_hz = self.pwm_frequency_hz() or 25_000.0
        with self._lock:
            self._rtmi_channels = [ch for ch, _ in channels]
            self._rtmi_sampling = sampling
            self._rtmi_crc = crc
            self._rtmi_trigger = pwm_hz / (sampling + 1.0)
            self._rtmi_frames = 0
            self._rtmi_dropped = 0
            self._rate_mark = (time.monotonic(), 0)
            self._running = True
        self.log(
            "info",
            "rtmi",
            f"RTMI 已启动: {len(channels)} 通道, sampling={sampling} → {self._rtmi_trigger:.0f} Hz 触发",
        )
        thread = threading.Thread(target=self._rtmi_loop, args=(6 if crc else 5,), daemon=True, name="tsl-rtmi")
        self._rtmi_thread = thread
        thread.start()

    def stop_rtmi(self) -> None:
        was_running = self._running
        self._running = False
        if self._rtmi_thread is not None and self._rtmi_thread is not threading.current_thread():
            self._rtmi_thread.join(timeout=1.0)
        self._rtmi_thread = None
        if was_running and self.is_connected():
            try:
                base = self.read_reg_retry(REG_UART_CONTROL, 3)
                self.write_reg(REG_UART_CONTROL, base & ~(1 << 22) & ~(0xFF << 24))
                self.log("info", "rtmi", "RTMI 已停止")
            except LinkError:
                pass
        with self._lock:
            self._frame_rate = 0.0
            self._rtmi_channels = []
            self._rtmi_sampling = 0

    def _rtmi_loop(self, frame_len: int) -> None:
        parser = protocol.RtmiParser(frame_len)
        batch: list[tuple[int, int]] = []
        last_emit = time.monotonic()
        while self._running:
            try:
                with self._lock:
                    sp = self._transport
                    if sp is None:
                        break
                    if self._paused:
                        time.sleep(0.002)
                        continue
                    data = sp.read_some(4096)
                if data:
                    self._rx += len(data)
                    parser.push(data, batch)
                    self._rtmi_frames += len(batch)
                now = time.monotonic()
                if batch and now - last_emit >= BATCH_INTERVAL_S:
                    pts = batch
                    batch = []
                    last_emit = now
                    cb = self.on_batch
                    if cb:
                        cb(now_ms(), pts)
                mark_at, mark_frames = self._rate_mark
                if now - mark_at >= 1.0:
                    self._frame_rate = (self._rtmi_frames - mark_frames) / (now - mark_at)
                    self._rate_mark = (now, self._rtmi_frames)
                if not data:
                    time.sleep(0.004)
            except LinkError as exc:
                self.log("error", "rtmi", f"RTMI 读取失败：{exc}")
                time.sleep(0.05)
            except Exception as exc:  # pragma: no cover - defensive
                self.log("error", "rtmi", f"RTMI 线程异常：{exc}")
                time.sleep(0.05)
        with self._lock:
            self._rtmi_dropped += parser.dropped
            self._running = False

    def pwm_frequency_hz(self) -> float | None:
        try:
            period = self.read_reg(0x103)
            max_count = period & 0xFFFF
            return 120_000_000.0 / max(1, max_count)
        except LinkError:
            return None

    def emergency_stop(self) -> None:
        self.log("warn", "safety", "急停：关闭 PWM 与驱动使能")
        for addr, value in (
            (0x150, 0),
            (0x14E, 0),
            (0x15F, 0),
            (0x15D, 0),
            (0x15E, 0),
        ):
            try:
                self.write_reg(addr, value)
            except LinkError:
                pass
        try:
            mm = self.read_reg(0x100)
            self.write_reg(0x100, (3 << 7) | (mm & 0x7F))
        except LinkError:
            pass
        try:
            gdrv = self.read_reg(0x101)
            self.write_reg(0x101, gdrv & ~(1 << 16))
        except LinkError:
            pass
        if self.is_gateway():
            try:
                self.gateway_control(0, 6, b"")
            except LinkError:
                pass

    def probe_tmc(self, motors: list[int], attempts: int = 6) -> list[TmcProbe]:
        if self._running:
            raise LinkError("请先停止采集再检测 TMC")
        attempts = max(1, min(20, attempts))
        origin = self.motor
        out: list[TmcProbe] = []
        for motor in motors:
            if not 1 <= motor <= 16:
                continue
            chip_id = None
            tries = 0
            try:
                self.focus_motor(motor)
            except LinkError:
                pass
            for i in range(attempts):
                tries = i + 1
                try:
                    chip_id = self.read_reg(REG_CHIP_ID)
                    break
                except LinkError:
                    time.sleep(0.02)
            out.append(TmcProbe(motor, chip_id is not None, chip_id, tries))
        if self.motor != origin:
            try:
                self.focus_motor(origin)
            except LinkError:
                pass
        self.log("info", "gateway", f"TMC 检测完成：{sum(1 for p in out if p.online)}/{len(out)} 在线")
        return out
