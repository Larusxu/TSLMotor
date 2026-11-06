"""Offline demo mode.

The production app talks to real hardware only.  ``--demo`` swaps the link for
a synthetic source so the layout and interactions can be reviewed without a
bench: same widgets, same conversions, no serial port.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass

from .core.link import LinkStats, LogLine, now_ms


class DemoLink:
    def __init__(self) -> None:
        self.on_batch = None
        self.on_log = None
        self.motor = 1
        self.mode = "direct"
        self.port_name = "DEMO"
        self.baud = 115200
        self._running = False
        self._thread: threading.Thread | None = None
        self._t0 = time.monotonic()
        self._frames = 0
        self._written: dict[int, int] = {}

    # ------------------------------------------------------------- surface
    def is_connected(self) -> bool:
        return True

    def is_gateway(self) -> bool:
        return False

    def log(self, level: str, source: str, message: str) -> None:
        if self.on_log:
            self.on_log(LogLine(now_ms(), level, source, message))

    def logs(self) -> list:
        return []

    def clear_logs(self) -> None:
        pass

    def stats(self) -> LinkStats:
        return LinkStats(
            connected=True,
            port="DEMO",
            baud=115200,
            mode="direct",
            motor=self.motor,
            rtmi_running=self._running,
            rtmi_frames=self._frames,
            rtmi_dropped=0,
            frame_rate=20.0 if self._running else 0.0,
            channels=[0, 1, 2, 3] if self._running else [],
            sampling=0,
            trigger_hz=1000.0,
        )

    # ------------------------------------------------------------ registers
    def _value(self, addr: int) -> int:
        t = time.monotonic() - self._t0
        if addr in self._written:
            return self._written[addr]
        if addr == 0x000:
            return 0x64600000
        if addr == 0x009:
            return 0xA0000000
        if addr == 0x083:
            return (240 << 16) | 12
        if addr == 0x084:
            return (18680 & 0xFFFF) << 16
        if addr == 0x100:
            return (3 << 9) | (3 << 7) | 1
        if addr == 0x101:
            return (1 << 31) | (1 << 16)
        if addr == 0x103:
            return 4800
        if addr == 0x154:
            return int(math.sin(t * 1.7) * 600 * 305.4 / 60) & 0xFFFFFFFF
        if addr == 0x150:
            return int(math.sin(t * 1.7) * 600 * 305.4 / 60) & 0xFFFFFFFF
        if addr == 0x153:
            return ((int(math.sin(t * 1.7 + 0.6) * 260) & 0xFFFF) << 16) | 0
        if addr == 0x155:
            return int((t * 12000) % 65536)
        if addr == 0x171:
            return (340 << 16) | 410
        if addr == 0x24D:
            return int((t * 1600) % 16384)
        if addr == 0x251:
            return int((t * 3200) % 65536)
        if addr == 0x247:
            return int((t * 6400) % 65536)
        if addr == 0x240:
            return 0x07000400
        if addr == 0x250:
            return 0x00400001
        if addr == 0x242:
            return 0x48F1
        if addr == 0x0C3:
            return 3
        if addr == 0x244:
            return 0x000DA71E
        if addr == 0x245:
            return 0xFFF00001
        if addr == 0x140:
            return 0x00855C
        if addr == 0x142:
            return (64 << 16) | 48
        if addr == 0x143:
            return (64 << 16) | 48
        if addr == 0x145:
            return (500 << 16) | 250
        if addr == 0x146:
            return (500 << 16) | 0
        if addr == 0x14A:
            return (3972 << 16) | 0
        if addr == 0x14B:
            return int(25000 * 305.4) & 0x7FFFFFFF
        if addr == 0x149:
            return 0x5A81
        if addr == 0x105:
            return 1
        return 0

    def read_reg(self, addr: int) -> int:
        return self._value(addr)

    def read_reg_retry(self, addr: int, tries: int = 3) -> int:
        return self._value(addr)

    def read_many(self, addrs: list[int]) -> dict:
        return {addr: self._value(addr) for addr in addrs}

    def write_reg(self, addr: int, value: int) -> None:
        self._written[addr] = value & 0xFFFFFFFF

    def write_verified(self, addr: int, value: int, mask: int = 0xFFFFFFFF) -> bool:
        self._written[addr] = value & 0xFFFFFFFF
        return True

    def pwm_frequency_hz(self) -> float:
        return 25000.0

    # ---------------------------------------------------------------- RTMI
    def start_rtmi(self, channels, sampling: int, crc: bool = False) -> None:
        self.stop_rtmi()
        self._running = True
        self._frames = 0
        chans = [ch for ch, _ in channels]
        self._thread = threading.Thread(target=self._feed, args=(chans,), daemon=True)
        self._thread.start()

    def _feed(self, channels: list[int]) -> None:
        start = time.monotonic()
        while self._running:
            t = time.monotonic() - start
            pts = []
            for ch in channels:
                if ch == 0:
                    pts.append((ch, int(math.sin(t * 1.7) * 600 * 305.4 / 60)))
                elif ch == 1:
                    pts.append((ch, int(math.sin(t * 1.7) * 600 * 305.4 / 60)))
                elif ch == 2:
                    pts.append((ch, (int(math.sin(t * 1.7 + 0.6) * 260) & 0xFFFF) << 16))
                elif ch == 3:
                    pts.append((ch, int((t * 1200) % 65536)))
                else:
                    pts.append((ch, int(math.sin(t * 3.1 + ch) * 400)))
            self._frames += len(pts)
            if self.on_batch:
                self.on_batch(now_ms(), pts)
            time.sleep(0.05)

    def stop_rtmi(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=0.5)
        self._thread = None

    def emergency_stop(self) -> None:
        self.log("warn", "safety", "演示模式：急停")

    def close(self) -> None:
        self.stop_rtmi()

    def open(self, *args, **kwargs):
        return self.stats()

    def probe_tmc(self, motors, attempts: int = 6):
        from .core.link import TmcProbe

        return [TmcProbe(m, True, 0x64600000, 1) for m in motors]

    def focus_motor(self, motor: int) -> None:
        self.motor = motor

    def gateway_control(self, *args, **kwargs):
        raise RuntimeError("演示模式没有主控链路")


def install_demo(store) -> None:
    store.link = DemoLink()
    store.link.on_batch = store._on_rtmi
    store.link.on_log = store._on_log
    store.connected = True
    store.ports = [("DEMO", "离线演示")]
    store.port = "DEMO"
    store.stats = store.link.stats()
    store.toast("ok", "演示模式：合成遥测，不打开串口")
    store.changed.emit()
    store.streamChanged.emit()
    try:
        from PyQt6.QtWidgets import QApplication

        app = QApplication.instance()
        if app is not None:
            app.aboutToQuit.connect(store.link.stop_rtmi)
    except Exception:
        pass
