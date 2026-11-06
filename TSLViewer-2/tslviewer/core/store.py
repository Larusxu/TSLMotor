"""Application state hub.

The React ``AppProvider`` becomes a QObject: it owns the serial link, the scope
ring buffers, job progress, logs and settings, and exposes Qt signals so pages
can stay dumb.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from PyQt6.QtCore import QObject, QSettings, QTimer, pyqtSignal

from . import procedures, regs
from .link import Link, LinkError, LinkStats, LogLine, TmcProbe, list_serial_ports, now_ms
from .presets import SIGNALS, SIGNAL_BY_ID, TESLA_PROFILE, convert_signal
from .semantic import SemanticSession
from .units import pwm_hz

CAP = 24_000


@dataclass
class Series:
    ch: int
    signal_id: str
    label: str
    unit: str
    color: int
    t: list[float] = field(default_factory=list)
    v: list[float] = field(default_factory=list)

    def push(self, t: float, value: float) -> None:
        self.t.append(t)
        self.v.append(value)
        if len(self.t) > CAP:
            del self.t[: len(self.t) - CAP]
            del self.v[: len(self.v) - CAP]


class ScopeStore:
    def __init__(self) -> None:
        self.series: dict[int, Series] = {}
        self.latest: dict[int, float] = {}
        self.start = 0.0
        self.window_ms = 5000.0
        self._lock = threading.RLock()

    def clear(self) -> None:
        with self._lock:
            for s in self.series.values():
                s.t.clear()
                s.v.clear()
            self.latest.clear()
            self.start = 0.0

    def ensure(self, ch: int, signal_id: str, color: int) -> Series:
        sig = SIGNAL_BY_ID.get(signal_id)
        existing = self.series.get(ch)
        if existing and existing.signal_id == signal_id:
            existing.color = color
            return existing
        s = Series(ch, signal_id, sig.label if sig else signal_id, sig.unit if sig else "", color)
        self.series[ch] = s
        return s

    def push_batch(self, ts: float, pts: list[tuple[int, int]], convert: Callable[[int, int], float]) -> None:
        with self._lock:
            if not self.start:
                self.start = ts
            rel = ts - self.start
            for ch, raw in pts:
                s = self.series.get(ch)
                if s is None:
                    continue
                value = convert(ch, raw)
                s.push(rel, value)
                self.latest[ch] = value

    def now(self) -> float:
        return now_ms() - self.start if self.start else 0.0

    def bounds(self, channels: list[int]) -> tuple[float, float]:
        lo, hi = float("inf"), float("-inf")
        from_ = self.now() - self.window_ms
        with self._lock:
            for ch in channels:
                s = self.series.get(ch)
                if not s or not s.t:
                    continue
                for t, v in zip(s.t, s.v):
                    if t >= from_:
                        lo = min(lo, v)
                        hi = max(hi, v)
        if lo == float("inf"):
            return -1.0, 1.0
        if hi - lo < 1e-9:
            pad = max(1.0, abs(hi) * 0.1)
            return lo - pad, hi + pad
        pad = (hi - lo) * 0.12
        return lo - pad, hi + pad

    def window_points(self, ch: int) -> list[tuple[float, float]]:
        s = self.series.get(ch)
        if not s or not s.t:
            return []
        from_ = self.now() - self.window_ms
        out = []
        for t, v in zip(s.t, s.v):
            if t >= from_:
                out.append((t, v))
        return out


@dataclass
class AxisLimits:
    enabled: bool = False
    ch: int = 0
    min: int = -32768
    max: int = 32768
    action: str = "loose"


@dataclass
class AxisState:
    limits: AxisLimits = field(default_factory=AxisLimits)
    pos: int = 0
    tripped: bool = False
    done: bool = False
    moving: bool = False
    cmd_rpm: float = 0.0


@dataclass
class Cal:
    poles: int = TESLA_PROFILE.poles
    cpr: int = TESLA_PROFILE.cpr
    pwm_max_count: int = TESLA_PROFILE.pwm_max_count
    ma_per_count: float = TESLA_PROFILE.ma_per_count
    counts_per_rpm: float = TESLA_PROFILE.counts_per_rpm
    csa_gain: int = TESLA_PROFILE.csa_gain
    polarity: int = 1
    temp_offset: float = 0.0

    def as_dict(self) -> dict:
        return {
            "poles": self.poles,
            "cpr": self.cpr,
            "pwm_max_count": self.pwm_max_count,
            "ma_per_count": self.ma_per_count,
            "counts_per_rpm": self.counts_per_rpm,
            "csa_gain": self.csa_gain,
            "polarity": self.polarity,
            "temp_offset": self.temp_offset,
        }


class AppStore(QObject):
    changed = pyqtSignal()
    streamChanged = pyqtSignal()
    rtmiTick = pyqtSignal()
    logsChanged = pyqtSignal()
    stepsChanged = pyqtSignal(str)
    toastRequested = pyqtSignal(str, str)
    jobChanged = pyqtSignal()
    semanticChanged = pyqtSignal()
    axisChanged = pyqtSignal()
    fleetChanged = pyqtSignal()
    reconnectNeeded = pyqtSignal()
    _dispatchEvent = pyqtSignal(object)

    def __init__(self) -> None:
        super().__init__()
        self._dispatchEvent.connect(self._run_dispatched)
        self.link = Link()
        self.scope = ScopeStore()
        self.executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="tsl")
        self.settings = QSettings("TSLViewer", "TSLViewerPy")
        self.reports_path = Path.home() / "Documents" / "TSLViewer" / "reports"
        self.reports_path.mkdir(parents=True, exist_ok=True)

        self.mode = str(self.settings.value("connection/mode", "direct"))
        self.port = str(self.settings.value("connection/port", "COM6"))
        self.baud = int(self.settings.value("connection/baud", 115200))
        self.motor = int(self.settings.value("connection/motor", 1))
        self.ports: list[tuple[str, str]] = []
        self.connected = False
        self.busy = False
        self.stats = LinkStats()
        self.cal = Cal(
            poles=int(self.settings.value("cal/poles", TESLA_PROFILE.poles)),
            cpr=int(self.settings.value("cal/cpr", TESLA_PROFILE.cpr)),
            pwm_max_count=int(self.settings.value("cal/pwm_max", TESLA_PROFILE.pwm_max_count)),
            ma_per_count=float(self.settings.value("cal/ma_per_count", TESLA_PROFILE.ma_per_count)),
            counts_per_rpm=float(self.settings.value("cal/counts_per_rpm", TESLA_PROFILE.counts_per_rpm)),
            csa_gain=int(self.settings.value("cal/csa_gain", TESLA_PROFILE.csa_gain)),
            polarity=int(self.settings.value("cal/polarity", 1)),
            temp_offset=float(self.settings.value("cal/temp_offset", 0.0)),
        )
        self.channels: list[str | None] = [
            "vel_act",
            "vel_tgt" if self.mode == "direct" else "torque",
            "torque" if self.mode == "direct" else "pos_act",
            None,
            None,
            None,
            None,
        ]
        self.streaming = False
        self.sample_hz = 1000
        self.window_ms = 5000
        self.trace_rate = 0.0
        self.trace_status = ""
        self.steps_by_kind: dict[str, list[procedures.StepEvent]] = {}
        self.logs: list[LogLine] = []
        self.job_running = False
        self.last_done: dict | None = None
        self.job_motor = 1
        self.job_started_at = 0.0
        self.axis = AxisState()
        self.alignments: dict[int, procedures.CalibResult] = {}
        self.semantic: dict[str, Any] = {
            "motor": self.motor,
            "boot_id": "0",
            "state": None,
            "received_at": 0.0,
            "error": "",
        }
        self.semantic_session: SemanticSession | None = None
        self.motor_tmc = "unknown"
        self.fw_version = ""
        self.hand_id: int | None = None
        self.motion_active = False
        self.acquiring = False
        self.toasts: list[tuple[int, str, str]] = []
        self.theme_name = str(self.settings.value("ui/theme", "dark"))
        self.production_mode = str(self.settings.value("ui/mode", "op")) != "op"
        self._axis_ctx: procedures.Ctx | None = None
        self._active_ctx: procedures.Ctx | None = None
        self._axis_stop = threading.Event()

        from .fleet import CHIP_BLOCK, MOTOR_BLOCK_A, MOTOR_BLOCK_B, decode_chips, decode_power, words

        self._fleet_decode = (CHIP_BLOCK, MOTOR_BLOCK_A, MOTOR_BLOCK_B, decode_chips, decode_power, words)
        self.fleet_motors: dict[int, dict] = {}
        self.fleet_power: list = []
        self.fleet_chips: list = []
        self.fleet_power_at = 0.0
        self.fleet_cylinders: list = []
        self._fleet_motor = 1
        self._fleet_next_power = 0.0
        self._fleet_busy = False

        self.link.on_batch = self._on_rtmi
        self.link.on_log = self._on_log

        self._poll = QTimer(self)
        self._poll.setInterval(1000)
        self._poll.timeout.connect(self._poll_stats)
        self._semantic_timer = QTimer(self)
        self._semantic_timer.setInterval(500)
        self._semantic_timer.timeout.connect(self._poll_semantic)
        self._axis_timer = QTimer(self)
        self._axis_timer.setInterval(300)
        self._axis_timer.timeout.connect(self._poll_axis)
        self._fleet_timer = QTimer(self)
        self._fleet_timer.setInterval(250)
        self._fleet_timer.timeout.connect(self._poll_fleet)
        self.refresh_ports()

    # ------------------------------------------------------------- helpers
    @property
    def mode_gateway(self) -> bool:
        return self.mode != "direct"

    @property
    def samples(self) -> int:
        hz = pwm_hz(self.cal.pwm_max_count)
        return max(0, min(255, round(hz / max(50, self.sample_hz)) - 1))

    def cal_dict(self) -> dict:
        return self.cal.as_dict()

    def spawn(self, fn: Callable[[], Any], on_done=None, on_error=None) -> None:
        def run() -> None:
            try:
                result = fn()
            except Exception as exc:  # noqa: BLE001 - surfaced in the UI
                error = exc
                if on_error:
                    self._dispatch(lambda err=error: on_error(err))
                else:
                    self._dispatch(lambda err=error: self.toast("error", str(err)))
                return
            if on_done:
                self._dispatch(lambda value=result: on_done(value))

        self.executor.submit(run)

    def _dispatch(self, fn: Callable[[], None]) -> None:
        """Marshal a callable from any worker thread onto the GUI thread."""
        self._dispatchEvent.emit(fn)

    def _run_dispatched(self, fn: Callable[[], None]) -> None:
        try:
            fn()
        except Exception as exc:  # pragma: no cover - defensive
            self.toast("error", str(exc))

    def toast(self, tone: str, text: str) -> None:
        self.toasts.append((int(time.time() * 1000), tone, text))
        self.toasts = self.toasts[-4:]
        self.toastRequested.emit(tone, text)

    # ------------------------------------------------------------- settings
    def save_settings(self) -> None:
        self.settings.setValue("connection/mode", self.mode)
        self.settings.setValue("connection/port", self.port)
        self.settings.setValue("connection/baud", self.baud)
        self.settings.setValue("connection/motor", self.motor)
        self.settings.setValue("ui/theme", self.theme_name)
        self.settings.setValue("ui/mode", "production" if self.production_mode else "op")
        self.settings.setValue("cal/poles", self.cal.poles)
        self.settings.setValue("cal/cpr", self.cal.cpr)
        self.settings.setValue("cal/pwm_max", self.cal.pwm_max_count)
        self.settings.setValue("cal/ma_per_count", self.cal.ma_per_count)
        self.settings.setValue("cal/counts_per_rpm", self.cal.counts_per_rpm)
        self.settings.setValue("cal/csa_gain", self.cal.csa_gain)
        self.settings.setValue("cal/polarity", self.cal.polarity)
        self.settings.setValue("cal/temp_offset", self.cal.temp_offset)
        self.settings.sync()

    # ------------------------------------------------------------- link I/O
    def refresh_ports(self) -> None:
        self.ports = list_serial_ports()
        if self.ports and self.port not in [p[0] for p in self.ports]:
            self.port = self.ports[0][0]
        self.changed.emit()

    def connect(self) -> None:
        if self.busy or self.connected:
            return
        self.busy = True
        self.changed.emit()
        port, mode, motor = self.port, self.mode, self.motor
        baud = 1_500_000 if mode == "main485" else 2_000_000 if mode == "maincan" else self.baud

        def work():
            stats = self.link.open(port, baud, mode, motor)
            if mode != "direct":
                session = SemanticSession(self.link, motor)
                session.open_session()
                self.semantic_session = session
            return stats

        def done(stats: LinkStats) -> None:
            self.stats = stats
            self.connected = stats.connected
            self.busy = False
            self.motor_tmc = "unknown"
            self.toast("ok", f"已连接 {port} @ {stats.baud}")
            if mode != "direct":
                self._read_identity()
            self._poll.start()
            if mode != "direct":
                self._semantic_timer.start()
                self._fleet_timer.start()
                self.fleet_motors.clear()
                self.fleet_power = []
                self.fleet_chips = []
                self.fleet_power_at = 0.0
            self._axis_timer.start()
            self.changed.emit()
            self.streamChanged.emit()

        def failed(exc: Exception) -> None:
            self.connected = False
            self.busy = False
            self.toast("error", f"连接失败：{exc}")
            self.link.close()
            self.changed.emit()

        self.spawn(work, done, failed)

    def _read_identity(self) -> None:
        def work():
            version = bytes(self.link.main_control(0, 10, [8, 8])).decode("ascii", "ignore").replace("\x00", "").strip()
            ident = self.link.main_control(0, 10, [73, 1])
            hand = ident[0] * 256 + ident[1] if len(ident) == 2 and (ident[0] * 256 + ident[1]) else None
            return version, hand

        def done(result) -> None:
            self.fw_version, self.hand_id = result
            self.changed.emit()

        def failed(exc: Exception) -> None:
            self.toast("warn", f"主控身份读取失败：{exc}")

        self.spawn(work, done, failed)

    def update_hand_id(self, value: int) -> None:
        if not self.connected or self.mode == "direct":
            raise LinkError("HandID 修改需要连接主控")
        if not 1 <= value <= 65535:
            raise LinkError("HandID 必须是 1～65535 的整数")

        def work():
            self.link.main_control(0, 11, [value >> 8, value & 0xFF])
            data = self.link.main_control(0, 10, [73, 1])
            if len(data) != 2 or data[0] * 256 + data[1] != value:
                raise LinkError("HandID 读回不一致")
            return value

        self.spawn(work, lambda v: self._set_hand(v), lambda e: self.toast("error", str(e)))

    def _set_hand(self, value: int) -> None:
        self.hand_id = value
        self.toast("ok", "HandID 已保存并读回确认")
        self.changed.emit()

    def disconnect(self) -> None:
        self.stop_stream()
        if self.semantic_session is not None:
            try:
                self.semantic_session.command(0, "close")
            except Exception:
                pass
            self.semantic_session = None
        self._semantic_timer.stop()
        self._axis_timer.stop()
        self._fleet_timer.stop()
        self._poll.stop()
        self.fleet_motors.clear()
        self.fleet_power = []
        self.fleet_chips = []
        self.fleet_power_at = 0.0

        def work():
            if self.connected and not self.mode_gateway:
                self.link.emergency_stop()
            self.link.close()
            return self.link.stats()

        def done(stats: LinkStats) -> None:
            self.stats = stats
            self.connected = False
            self.fw_version = ""
            self.hand_id = None
            self.motor_tmc = "unknown"
            self.alignments.clear()
            self.toast("warn", "已断开连接")
            self.changed.emit()

        self.spawn(work, done, lambda e: self.toast("warn", str(e)))

    def _poll_stats(self) -> None:
        if not self.connected:
            return

        def done(stats: LinkStats) -> None:
            self.stats = stats
            if not stats.connected:
                self.connected = False
                self.changed.emit()

        self.spawn(self.link.stats, done)

    # --------------------------------------------------------------- motor
    def set_mode(self, mode: str) -> None:
        if self.connected:
            return
        self.mode = mode
        self.save_settings()
        self.channels = [
            "vel_act",
            "vel_tgt" if mode == "direct" else "torque",
            "torque" if mode == "direct" else "pos_act",
            None,
            None,
            None,
            None,
        ]
        self.changed.emit()

    def set_motor(self, motor: int) -> None:
        if motor == self.motor or self.job_running or self.motion_active:
            return
        self.stop_stream()
        old = self.motor
        self.motor = motor
        self.motor_tmc = "unknown"
        self.save_settings()
        if self.connected and self.mode_gateway:
            def work():
                if self.semantic_session is not None:
                    try:
                        self.semantic_session.command(0, "close")
                    except Exception:
                        pass
                self.link.focus_motor(motor)
                session = SemanticSession(self.link, motor)
                session.open_session()
                self.semantic_session = session
                return session.get_state()

            def done(reply) -> None:
                self._apply_semantic(reply)
                self.toast("warn", f"已切到 M{motor}：采集已停止，软限位与标定需重新确认")
                self.changed.emit()

            self.spawn(work, done, lambda e: self.toast("error", f"切换电机失败：{e}"))
        else:
            self.changed.emit()
        self.semantic = {"motor": motor, "boot_id": "0", "state": None, "received_at": 0.0, "error": ""}
        self.semanticChanged.emit()

    def enable_motor(self) -> None:
        if not self.connected or self.busy:
            return
        self.busy = True
        self.changed.emit()

        def work():
            if self.mode_gateway:
                session = self.semantic_session
                if session is None:
                    session = SemanticSession(self.link, self.motor)
                    session.open_session()
                    self.semantic_session = session
                current = session.get_state()
                m = current.motor
                if not (m and m.logic_power and m.config_verified and m.limits_valid and not current.pending):
                    current = session.initialize()
                session.permit(True)
                return ("gateway", current)
            probes = self.link.probe_tmc([self.motor], 6)
            return ("direct", probes[0])

        def done(result) -> None:
            self.busy = False
            kind, payload = result
            if kind == "gateway":
                self.motor_tmc = "online"
                self._apply_semantic(payload)
                self.toast("ok", f"M{self.motor} 逻辑供电与配置已就绪，可直接操作")
            else:
                probe: TmcProbe = payload
                if probe.online:
                    self.motor_tmc = "online"
                    self.toast("ok", f"M{self.motor} 已使能 · CHIP.ID 0x{(probe.chip_id or 0):08X}")
                else:
                    self.motor_tmc = "offline"
                    self.toast("error", f"M{self.motor} 上电后读不到 CHIP.ID（轮询 {probe.tries} 次）")
            self.changed.emit()

        def failed(exc: Exception) -> None:
            self.busy = False
            self.motor_tmc = "offline"
            self.toast("error", str(exc))
            self.changed.emit()

        self.spawn(work, done, failed)

    def disable_motor(self) -> None:
        if not self.connected or self.busy or not self.mode_gateway:
            return
        self.busy = True
        self.changed.emit()

        def work():
            self.stop_stream()
            if self.semantic_session is not None:
                self.semantic_session.power_off()
            return True

        def done(_):
            self.busy = False
            self.motor_tmc = "offline"
            self.semantic = {**self.semantic, "received_at": 0.0, "state": None}
            self.toast("ok", f"M{self.motor} 逻辑电源已关闭")
            self.changed.emit()
            self.semanticChanged.emit()

        def failed(exc: Exception) -> None:
            self.busy = False
            self.toast("error", str(exc))
            self.changed.emit()

        self.spawn(work, done, failed)

    def set_permit(self, enabled: bool) -> None:
        def work():
            if self.semantic_session is None:
                raise LinkError("请先连接主控")
            return self.semantic_session.permit(enabled)

        self.spawn(work, lambda r: (self._apply_semantic(r), self.toast("ok", "运动授权已" + ("开启" if enabled else "取消"))),
                   lambda e: self.toast("error", str(e)))

    def emergency(self) -> None:
        if not self.connected:
            return

        def work():
            if self.mode_gateway and self.semantic_session is not None:
                return self.semantic_session.emergency()
            self.link.emergency_stop()
            return None

        def done(reply):
            if reply is not None:
                self._apply_semantic(reply)
            self.toast("warn", "急停已下发")

        self.spawn(work, done, lambda e: self.toast("error", f"急停失败：{e}"))

    def stop_motion(self) -> None:
        def work():
            if self.mode_gateway and self.semantic_session is not None:
                return self.semantic_session.stop(True)
            self.link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0)
            self.link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, 0)
            self.link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, self.cal.poles))
            return None

        self.spawn(work, lambda r: self.toast("ok", "已停止运行"), lambda e: self.toast("error", str(e)))

    # ------------------------------------------------------------ registers
    def read_reg(self, addr: int, on_done=None) -> None:
        self.spawn(lambda: self.link.read_reg_retry(addr, 3),
                   on_done or (lambda v: None),
                   lambda e: self.toast("error", f"读 0x{addr:03X} 失败：{e}"))

    def write_reg(self, addr: int, value: int, verify: bool = True, on_done=None) -> None:
        def work():
            if verify:
                return self.link.write_verified(addr, value, 0xFFFFFFFF)
            self.link.write_reg(addr, value)
            return True

        self.spawn(work, on_done or (lambda v: None),
                   lambda e: self.toast("error", f"写 0x{addr:03X} 失败：{e}"))

    def read_many(self, addrs: list[int], on_done) -> None:
        def work():
            out = {}
            for addr in addrs[:64]:
                try:
                    out[addr] = self.link.read_reg_retry(addr, 2)
                except LinkError:
                    break
            return out

        self.spawn(work, on_done, lambda e: None)

    # --------------------------------------------------------------- stream
    def set_channel(self, ch: int, signal_id: str | None) -> None:
        if signal_id:
            for i, current in enumerate(self.channels):
                if current == signal_id:
                    self.channels[i] = None
        self.channels[ch] = signal_id
        for i, sid in enumerate(self.channels):
            if sid:
                self.scope.ensure(i, sid, i)
            elif i in self.scope.series:
                del self.scope.series[i]
        self.changed.emit()

    def start_stream(self, override: tuple[int, str] | None = None) -> None:
        if not self.connected:
            self.toast("warn", "请先连接串口")
            return
        mapping = list(self.channels)
        if override:
            ch, sid = override
            mapping[ch] = sid
        assigned: list[tuple[int, int]] = []
        for ch, sid in enumerate(mapping):
            if not sid:
                continue
            sig = SIGNAL_BY_ID.get(sid)
            if sig:
                assigned.append((ch, sig.addr))
        if not assigned:
            self.toast("warn", "请先选择至少一个信号")
            return
        self.streaming = False
        self.streamChanged.emit()
        self.scope.clear()
        for ch, _ in assigned:
            sid = mapping[ch]
            if sid:
                self.scope.ensure(ch, sid, ch)
        sampling = self.samples

        def work():
            if self.mode_gateway and not (self.semantic_session and self.semantic["state"]):
                raise LinkError("等待当前电机的主控状态")
            try:
                self.link.stop_rtmi()
            except Exception:
                pass
            self.link.start_rtmi(assigned, sampling, False)
            return sampling

        def done(_):
            self.streaming = True
            self.toast("ok", f"RTMI 已启动 · {len(assigned)} 通道 @ {self.sample_hz} Hz")
            self.streamChanged.emit()
            self.changed.emit()

        self.spawn(work, done, lambda e: self.toast("error", f"启动数据流失败：{e}"))

    def stop_stream(self) -> None:
        if not self.streaming and not self.link.is_connected():
            return

        def work():
            try:
                self.link.stop_rtmi()
            except Exception:
                pass
            return True

        self.streaming = False
        self.streamChanged.emit()
        self.spawn(work)

    def _on_rtmi(self, ts: float, pts: list[tuple[int, int]]) -> None:
        cal = self.cal
        mapping = list(self.channels)

        def convert(ch: int, raw: int) -> float:
            sid = mapping[ch] if ch < len(mapping) else None
            sig = SIGNAL_BY_ID.get(sid) if sid else None
            if sig is None:
                return float(raw)
            return convert_signal(sig, raw, cal.as_dict())

        self.scope.push_batch(ts, pts, convert)
        self._dispatch(self.rtmiTick.emit)

    def _on_log(self, line: LogLine) -> None:
        self.logs.append(line)
        if len(self.logs) > 2500:
            self.logs = self.logs[-2000:]
        self._dispatch(self.logsChanged.emit)

    def clear_logs(self) -> None:
        self.link.clear_logs()
        self.logs = []
        self.logsChanged.emit()

    def host_log(self, level: str, source: str, message: str) -> None:
        self._on_log(LogLine(now_ms(), level, source, message))

    # ---------------------------------------------------------------- steps
    def _step_event(self, kind: str, event: procedures.StepEvent) -> None:
        def apply() -> None:
            steps = self.steps_by_kind.setdefault(kind, [])
            if event.status == "run":
                steps.append(event)
            else:
                for i in range(len(steps) - 1, -1, -1):
                    if steps[i].idx == event.idx and steps[i].status == "run":
                        steps[i] = event
                        break
                else:
                    steps.append(event)
            del steps[:-400]
            level = "error" if event.status == "fail" else "ok" if event.status == "ok" else "info"
            if event.status != "run":
                self.host_log(level, f"job/{kind}", f"{event.idx:02d}/{event.total} {event.label}" + (f" · {event.detail}" if event.detail else ""))
            self.stepsChanged.emit(kind)

        self._dispatch(apply)

    # ----------------------------------------------------------------- jobs
    def run_job(self, kind: str, payload: dict, fn: Callable[[procedures.Ctx], Any]) -> None:
        if self.job_running or self.motion_active:
            self.toast("warn", "请等待当前任务结束")
            return
        if not self.connected:
            self.toast("error", "串口未连接")
            return
        self.job_running = True
        self.job_motor = self.motor
        self.job_started_at = time.time()
        self.steps_by_kind[kind] = []
        self.last_done = None
        label = procedures.JOB_LABEL.get(kind, kind)
        self.host_log("info", f"job/{kind}", f"▶ 开始 {label}")
        self.stepsChanged.emit(kind)
        self.jobChanged.emit()

        ctx = procedures.Ctx(self.link, self.motor)
        ctx.on_step = lambda ev: self._step_event(kind, ev)
        ctx.on_log = lambda level, message: self._dispatch(lambda: self.host_log(level, f"job/{kind}", message))
        self._active_ctx = ctx

        def work():
            try:
                return fn(ctx)
            finally:
                pass

        def done(result) -> None:
            self.job_running = False
            self._active_ctx = None
            secs = time.time() - self.job_started_at
            self.last_done = {"job": kind, "ok": True, "data": result}
            if isinstance(result, procedures.CalibResult):
                self.alignments[self.job_motor] = result
            summary = self._result_text(result)
            if summary:
                self.host_log("ok", f"job/{kind}", f"◆ 结果 {summary}")
            self.host_log("ok", f"job/{kind}", f"■ 结束 {label}·成功（{secs:.1f} s）")
            self.toast("ok", "任务完成")
            self.jobChanged.emit()
            self.changed.emit()

        def failed(exc: Exception) -> None:
            self.job_running = False
            self._active_ctx = None
            secs = time.time() - self.job_started_at
            self.last_done = {"job": kind, "ok": False, "message": str(exc), "data": None}
            self.host_log("error", f"job/{kind}", f"■ 结束 {label}·失败（{secs:.1f} s） · {exc}")
            self.toast("error", f"任务失败：{exc}")
            self.jobChanged.emit()
            self.changed.emit()

        self.spawn(work, done, failed)

    @staticmethod
    def _result_text(result) -> str:
        if isinstance(result, procedures.CalibResult):
            return f"PHI_E_OFFSET {result.offset} · R²={result.r2:.5f} · 斜率 {result.slope:.4f} LSB/°"
        if isinstance(result, dict):
            if "metrics" in result:
                m = result["metrics"]
                return f"上升 {m.get('rise_ms', 0):.1f} ms · 超调 {m.get('overshoot_pct', 0):.1f} %"
            if "summary" in result:
                rows = result["summary"]
                passed = sum(1 for r in rows if r.get("verdict") == "pass")
                return f"{passed}/{len(rows)} 档通过 · {result.get('csv_path', '')}"
            if "message" in result:
                return str(result["message"])
        if isinstance(result, str):
            return result
        return ""

    def cancel_job(self) -> None:
        self.host_log("warn", "job", "已请求取消当前任务")
        if self._active_ctx is not None:
            self._active_ctx.cancel.set()
        if self._axis_ctx is not None:
            self._axis_ctx.cancel.set()

    # ---------------------------------------------------------------- axis
    def refresh_axis(self) -> None:
        if not self.connected or self.mode_gateway:
            self.axisChanged.emit()
            return

        def work():
            pos = self.link.read_reg_retry(regs.FOC_PID_POSITION_ACTUAL, 2)
            if pos & 0x80000000:
                pos -= 0x100000000
            return pos

        def done(pos: int) -> None:
            self.axis.pos = pos
            self.axisChanged.emit()

        self.spawn(work, done, lambda e: None)

    def _poll_axis(self) -> None:
        if not self.connected:
            return
        self.refresh_axis()
        if self.mode_gateway and not self.job_running:
            self._poll_semantic()
        limits = self.axis.limits
        if limits.enabled and not self.axis.tripped and self.mode == "direct":
            if self.axis.pos < limits.min or self.axis.pos > limits.max:
                self.axis.tripped = True
                self.axis.moving = False
                self.host_log(
                    "error",
                    "safety",
                    f"软限位触发：位置 {self.axis.pos}（限 {limits.min}…{limits.max}）",
                )
                self.toast("error", f"软限位触发：位置 {self.axis.pos}（限 {limits.min}…{limits.max}）")
                self.axisChanged.emit()
                if limits.action == "brake":
                    self.spawn(self.stop_motion_blocking)
                else:
                    self.spawn(lambda: self.link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0))

    def set_axis_limits(self, limits: AxisLimits) -> None:
        self.axis.limits = limits
        self.axis.tripped = False
        self.axisChanged.emit()

    def axis_jog(self, rpm: float) -> None:
        self.axis.cmd_rpm = rpm
        self.axis.moving = rpm != 0

        def work():
            if self.mode_gateway and self.semantic_session:
                return self.semantic_session.jog(int(rpm * self.cal.counts_per_rpm))
            self.link.write_reg(regs.FOC_PID_VELOCITY_TARGET, int(rpm * self.cal.counts_per_rpm) & 0xFFFFFFFF)
            if rpm:
                self.link.write_verified(
                    regs.MCC_MOTOR_MOTION,
                    regs.motor_motion(regs.MODE_VELOCITY, self.cal.poles) | (1 << 15),
                    0xFFFF,
                )
            return None

        self.spawn(work, lambda r: self.axisChanged.emit(), lambda e: self.toast("error", str(e)))

    def axis_hold(self) -> None:
        self.axis.cmd_rpm = 0
        self.axis.moving = False
        self.spawn(self.stop_motion_blocking, lambda r: self.axisChanged.emit(),
                   lambda e: self.toast("error", str(e)))

    def stop_motion_blocking(self):
        if self.mode_gateway and self.semantic_session:
            return self.semantic_session.stop(True)
        self.link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0)
        self.link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, 0)
        self.link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, self.cal.poles))
        return None

    def axis_clear(self) -> None:
        self.axis.tripped = False
        self.axis.done = False
        self.axisChanged.emit()

    # ----------------------------------------------------------- semantic
    def _poll_semantic(self) -> None:
        if not self.connected or not self.mode_gateway or self.semantic_session is None:
            return
        if self.job_running:
            return

        def work():
            return self.semantic_session.get_state()

        self.spawn(work, self._apply_semantic, lambda e: self._semantic_error(str(e)))

    def _poll_fleet(self) -> None:
        if (not self.connected or not self.mode_gateway or self._fleet_busy
                or self.streaming or self.acquiring or self.semantic_session is None):
            return
        self._fleet_busy = True
        motor = self._fleet_motor
        session = self.semantic_session
        read_power = time.monotonic() >= self._fleet_next_power
        chip_block, block_a, block_b, decode_chips, decode_power, words = self._fleet_decode

        def work():
            state = None
            try:
                reply = session.command(motor, "get_state")
                state = reply.motor if reply.result == 0 else None
            except Exception:
                state = None
            power = None
            if read_power:
                try:
                    chips = words(self.link.main_control(0, 10, list(chip_block)), chip_block[1])
                    first = words(self.link.main_control(0, 10, list(block_a)), block_a[1])
                    last = words(self.link.main_control(0, 10, list(block_b)), block_b[1])
                    rows = first + last
                    power = (decode_power(chips, rows), decode_chips(chips, rows))
                except Exception:
                    power = None
            cylinders = None
            if read_power:
                from . import cylinder as cyl

                cylinders = []
                for ch in range(1, 6):
                    try:
                        cylinders.append(cyl.execute(self.link, ch, 0, 1))
                    except Exception:
                        cylinders.append(None)
            return motor, state, power, cylinders

        def done(result) -> None:
            self._fleet_busy = False
            motor_id, state, power, cylinders = result
            self._fleet_motor = motor_id % 16 + 1
            if state is not None:
                self.fleet_motors[motor_id] = {"state": state, "at": time.time()}
            if power is not None:
                self.fleet_power, self.fleet_chips = power
                self.fleet_power_at = time.time()
                self._fleet_next_power = time.monotonic() + 2.0
            if cylinders is not None:
                self.fleet_cylinders = cylinders
            self.fleetChanged.emit()

        def failed(_exc) -> None:
            self._fleet_busy = False
            self._fleet_motor = motor % 16 + 1

        self.spawn(work, done, failed)

    def set_power(self, motor: int, enabled: bool) -> None:
        if not self.connected or not self.mode_gateway:
            return

        def work():
            self.link.main_control(motor, 5, [1 if enabled else 0])
            time.sleep(0.08)
            chip_block, block_a, block_b, decode_chips, decode_power, words = self._fleet_decode
            chips = words(self.link.main_control(0, 10, list(chip_block)), chip_block[1])
            rows = words(self.link.main_control(0, 10, list(block_a)), block_a[1]) + words(
                self.link.main_control(0, 10, list(block_b)), block_b[1]
            )
            return decode_power(chips, rows), decode_chips(chips, rows)

        def done(power) -> None:
            self.fleet_power, self.fleet_chips = power
            self.fleet_power_at = time.time()
            self.fleetChanged.emit()
            self.toast("ok", f"M{motor} 输入供电已{'开启' if enabled else '关闭'}")

        self.spawn(work, done, lambda e: self.toast("error", f"M{motor} 供电切换失败：{e}"))

    def _semantic_error(self, message: str) -> None:
        self.semantic = {**self.semantic, "error": message}
        self.semanticChanged.emit()

    def _apply_semantic(self, reply) -> None:
        if reply is None or getattr(reply, "motor", None) is None:
            return
        self.semantic = {
            "motor": self.motor,
            "boot_id": reply.boot_id,
            "state": reply.motor,
            "received_at": time.time(),
            "error": "",
            "task_id": reply.task_id,
        }
        self.motion_active = bool(reply.motor.motion_active or reply.motor.drive == 1)
        if reply.motor.permit:
            self.motor_tmc = "online"
        self.semanticChanged.emit()

    # --------------------------------------------------------------- toasts
    def dismiss_toast(self, key: int) -> None:
        self.toasts = [t for t in self.toasts if t[0] != key]
