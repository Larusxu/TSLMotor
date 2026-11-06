"""电缸控制 — five independent LA channels behind the gateway."""

from __future__ import annotations

from dataclasses import dataclass, field

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ..core import cylinder
from ..theme import mono_font
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    Notice,
    NumField,
    SelectField,
    StatusDot,
    divider,
)
from .base import BasePage


@dataclass
class ChannelState:
    current: float = 3000
    temperature: float = 80
    cid: float = 1
    target: float = 0
    upper: float = 2000
    lower: float = 0
    initial: float = 0
    status: cylinder.Snapshot | None = None
    busy: bool = False
    error: str = ""


class CylinderCard(Card):
    def __init__(self, channel: int, page: "CylindersPage") -> None:
        self.channel = channel
        self.page = page
        state = page.state[channel]
        self.dot = StatusDot("#4c5768")
        self.state_label = Badge("未连接", "neutral")
        head = QWidget()
        h = QHBoxLayout(head)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(8)
        title = QLabel(f"C{channel}")
        title.setFont(mono_font(15, 600))
        sub = QLabel(f"电缸 · UART{channel + 17}")
        sub.setObjectName("tiny")
        h.addWidget(title)
        h.addWidget(sub)
        h.addStretch(1)
        h.addWidget(self.dot)
        h.addWidget(self.state_label)
        super().__init__("", "")
        self.body.addWidget(head)
        self.state = state

        metrics = QWidget()
        mg = QHBoxLayout(metrics)
        mg.setContentsMargins(0, 0, 0, 0)
        mg.setSpacing(10)
        self.metric_labels: dict[str, QLabel] = {}
        for key, title_text, unit in (
            ("current", "反馈电流", "mA"),
            ("restart", "回温启动值", "°C"),
            ("position", "实际行程", "步"),
        ):
            box = QWidget()
            box.setStyleSheet(f"background:{self.page.theme.inset};border:1px solid {self.page.theme.line_soft};border-radius:9px;")
            v = QVBoxLayout(box)
            v.setContentsMargins(10, 7, 10, 7)
            v.setSpacing(1)
            t = QLabel(title_text)
            t.setStyleSheet(f"color:{self.page.theme.text_3};font-size:10.5px;")
            value = QLabel("—")
            value.setFont(mono_font(13, 500))
            v.addWidget(t)
            v.addWidget(value)
            mg.addWidget(box, 1)
            self.metric_labels[key] = value
        self.add(metrics)
        self.add(divider(self.page.theme))

        self.f_current = NumField(state.current, 0, 65535, 50, 0, "mA")
        self.f_temp = NumField(state.temperature, 0, 150, 1, 0, "°C")
        self.f_id = NumField(state.cid, 1, 254, 1, 0)
        prot = QWidget()
        pg = QGridLayout(prot)
        pg.setContentsMargins(0, 0, 0, 0)
        pg.setHorizontalSpacing(8)
        pg.setVerticalSpacing(8)
        pg.addWidget(Field("过流阈值", self.f_current), 0, 0)
        pg.addWidget(Field("过温阈值", self.f_temp), 0, 1)
        pg.addWidget(Field("通信 ID", self.f_id), 0, 2)
        self.add(prot)
        prot_actions = QWidget()
        pa = QHBoxLayout(prot_actions)
        pa.setContentsMargins(0, 0, 0, 0)
        pa.setSpacing(6)
        read = Button("读取", "ghost", "sm")
        read.clicked.connect(lambda: self.page.run_op(self.channel, 1))
        write = Button("写入", "ghost", "sm")
        write.clicked.connect(self._write_protection)
        clear = Button("清除故障", "ghost", "sm")
        clear.clicked.connect(lambda: self.page.run_op(self.channel, 5))
        for b in (read, write, clear):
            pa.addWidget(b)
        pa.addStretch(1)
        self.add(prot_actions)
        self.add(divider(self.page.theme))

        self.f_upper = NumField(state.upper, 0, 2000, 10, 0, "步")
        self.f_lower = NumField(state.lower, 0, 2000, 10, 0, "步")
        self.f_initial = NumField(state.initial, 0, 2000, 10, 0, "步")
        travel = QWidget()
        tg = QGridLayout(travel)
        tg.setContentsMargins(0, 0, 0, 0)
        tg.setHorizontalSpacing(8)
        tg.setVerticalSpacing(8)
        tg.addWidget(Field("行程上限", self.f_upper), 0, 0)
        tg.addWidget(Field("行程下限", self.f_lower), 0, 1)
        tg.addWidget(Field("初始位置", self.f_initial), 0, 2)
        self.add(travel)
        travel_actions = QWidget()
        ta = QHBoxLayout(travel_actions)
        ta.setContentsMargins(0, 0, 0, 0)
        ta.setSpacing(6)
        t_read = Button("读取", "ghost", "sm")
        t_read.clicked.connect(lambda: self.page.run_op(self.channel, 1))
        t_write = Button("写入", "ghost", "sm")
        t_write.clicked.connect(self._write_travel)
        t_initial = Button("到初始位", "ghost", "sm")
        t_initial.clicked.connect(lambda: self.page.run_op(self.channel, 8))
        for b in (t_read, t_write, t_initial):
            ta.addWidget(b)
        ta.addStretch(1)
        self.add(travel_actions)
        self.add(divider(self.page.theme))

        self.f_target = NumField(state.target, 0, 2000, 10, 0, "步")
        target_row = QWidget()
        tr = QHBoxLayout(target_row)
        tr.setContentsMargins(0, 0, 0, 0)
        tr.setSpacing(8)
        self.target_label = QLabel("目标行程")
        self.target_label.setObjectName("fieldLabel")
        tr.addWidget(self.target_label)
        tr.addWidget(self.f_target, 1)
        self.add(target_row)
        go_row = QWidget()
        gr = QHBoxLayout(go_row)
        gr.setContentsMargins(0, 0, 0, 0)
        gr.setSpacing(6)
        move = Button("移动到目标", "primary", "sm")
        move.clicked.connect(self._move_target)
        minus = Button("−10", "ghost", "sm")
        minus.clicked.connect(lambda: self._nudge(-10))
        plus = Button("+10", "ghost", "sm")
        plus.clicked.connect(lambda: self._nudge(10))
        stop = Button("停止", "ghost", "sm")
        stop.clicked.connect(lambda: self.page.run_op(self.channel, 7))
        gr.addWidget(move)
        gr.addWidget(minus)
        gr.addWidget(plus)
        gr.addWidget(stop)
        gr.addStretch(1)
        self.add(go_row)
        self.error = QLabel("")
        self.error.setStyleSheet(f"color:{self.page.theme.danger};font-size:11px;")
        self.add(self.error)
        self.refresh()

    def _write_protection(self) -> None:
        self.page.run_op(
            self.channel,
            2,
            (int(self.f_current.value()), int(self.f_temp.value())),
            cid=int(self.f_id.value()),
        )

    def _write_travel(self) -> None:
        self.page.run_op(
            self.channel,
            3,
            (int(self.f_lower.value()), int(self.f_upper.value()), int(self.f_initial.value())),
            cid=int(self.f_id.value()),
            check_travel=True,
        )

    def _move_target(self) -> None:
        self.page.run_op(self.channel, 4, (int(self.f_target.value()),), cid=int(self.f_id.value()), check_target=True)

    def _nudge(self, delta: int) -> None:
        self.f_target.setValue(max(0, min(2000, self.f_target.value() + delta)))
        self._move_target()

    def refresh(self) -> None:
        s = self.page.state[self.channel]
        self.state = s
        online = bool(s.status and s.status.online)
        self.dot.set_color(self.page.theme.ok if online else self.page.theme.text_4)
        self.state_label.set_text("在线" if online else "离线")
        self.state_label.set_tone("ok" if online else "neutral")
        self.metric_labels["current"].setText(f"{s.status.current_ma}" if online else "—")
        self.metric_labels["restart"].setText(f"{s.status.restart_c}" if online else "—")
        self.metric_labels["position"].setText(f"{s.status.position}" if online else "—")
        self.error.setText(s.error)
        for widget in (self.f_current, self.f_temp, self.f_id, self.f_upper, self.f_lower, self.f_initial, self.f_target):
            widget.setEnabled(not s.busy)


class CylindersPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.state: dict[int, ChannelState] = {i: ChannelState(cid=float(i)) for i in range(1, 6)}
        self.selected = 1
        self._polling = False
        self._build()
        self._timer.setInterval(1200)

    def _build(self) -> None:
        toolbar = QWidget()
        toolbar.setObjectName("toolbar")
        toolbar.setFixedHeight(58)
        t = QHBoxLayout(toolbar)
        t.setContentsMargins(22, 9, 22, 9)
        t.setSpacing(10)
        label = QLabel("当前电缸")
        label.setStyleSheet(f"color:{self.theme.text_2};font-size:12px;")
        t.addWidget(label)
        self.select = SelectField([(i, f"C{i}") for i in range(1, 6)], 1, width=80)
        self.select.currentIndexChanged.connect(lambda: setattr(self, "selected", int(self.select.value())))
        t.addWidget(self.select)
        self.enable_btn = Button("开启运动授权")
        self.enable_btn.clicked.connect(self._toggle_permit)
        t.addWidget(self.enable_btn)
        self.stop_btn = Button("停止运行")
        self.stop_btn.clicked.connect(lambda: self.run_op(self.selected, 7))
        t.addWidget(self.stop_btn)
        self.stop_all_btn = Button("全部停止", "danger", icon_name="stop")
        self.stop_all_btn.clicked.connect(self._stop_all)
        t.addWidget(self.stop_all_btn)
        t.addStretch(1)
        self.summary = QLabel("5 独立通道 · 0 在线")
        self.summary.setStyleSheet(f"color:{self.theme.text_3};font-size:12px;")
        t.addWidget(self.summary)
        self.add(toolbar)

        self.notice = Notice("请连接主控网关模式以访问电缸。", "warn")
        self.add(self.notice)
        self.add(Notice("LA 系列 · 921600 bit/s · 行程单位：步 · 全行程 2000 步。保护阈值与行程写入后由主控回读确认。"))

        grid_host = QWidget()
        self.grid = QGridLayout(grid_host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setHorizontalSpacing(14)
        self.grid.setVerticalSpacing(14)
        self.cards: dict[int, CylinderCard] = {}
        for i in range(1, 6):
            card = CylinderCard(i, self)
            self.cards[i] = card
            self.grid.addWidget(card, (i - 1) // 2, (i - 1) % 2)
        self.add(grid_host)

    # -------------------------------------------------------------- actions
    def run_op(
        self,
        channel: int,
        op: int,
        values: tuple[int, ...] = (),
        cid: int | None = None,
        check_travel: bool = False,
        check_target: bool = False,
    ) -> None:
        if not self.store.connected or not self.store.mode_gateway:
            self.store.toast("warn", "请连接主控网关模式以访问电缸")
            return
        state = self.state[channel]
        cid = cid or int(state.cid)
        if check_travel:
            lower, upper, initial = values
            if not (lower <= initial <= upper <= 2000):
                state.error = "初始位置需位于行程上下限内。"
                self.cards[channel].refresh()
                return
        if check_target and values[0] > 2000:
            state.error = "目标行程超出 0…2000"
            self.cards[channel].refresh()
            return
        state.busy = True
        state.error = ""
        self.cards[channel].refresh()

        def work():
            return cylinder.execute(self.store.link, channel, op, cid, values)

        def done(snap: cylinder.Snapshot) -> None:
            state.busy = False
            state.status = snap
            state.lower = snap.lower
            state.upper = snap.upper
            state.initial = snap.initial
            state.target = snap.target
            state.cid = snap.id
            state.current = snap.current_limit_ma or state.current
            state.temperature = snap.temperature_limit_c or state.temperature
            self.cards[channel].f_lower.setValue(snap.lower)
            self.cards[channel].f_upper.setValue(snap.upper)
            self.cards[channel].f_initial.setValue(snap.initial)
            self.cards[channel].f_target.setValue(snap.target)
            self.cards[channel].f_id.setValue(snap.id)
            self.cards[channel].refresh()
            self._update_summary()

        def failed(exc: Exception) -> None:
            state.busy = False
            state.error = str(exc)
            self.cards[channel].refresh()
            self.store.toast("error", str(exc))

        self.store.spawn(work, done, failed)

    def _toggle_permit(self) -> None:
        state = self.state[self.selected]
        enabled = not (state.status and state.status.permit)
        self.run_op(self.selected, 6, (1 if enabled else 0,))

    def _stop_all(self) -> None:
        for i in range(1, 6):
            self.run_op(i, 7)

    def _update_summary(self) -> None:
        online = sum(1 for s in self.state.values() if s.status and s.status.online)
        self.summary.setText(f"5 独立通道 · {online} 在线电缸")
        state = self.state[self.selected].status
        self.enable_btn.setText("取消运动授权" if state and state.permit else "开启运动授权")

    def _poll(self) -> None:
        if not self.store.connected or not self.store.mode_gateway or self._polling or self.store.job_running:
            return
        self._polling = True

        def work():
            result = {}
            for i in range(1, 6):
                try:
                    result[i] = cylinder.execute(self.store.link, i, 0, int(self.state[i].cid))
                except Exception:
                    result[i] = None
            return result

        def done(result: dict) -> None:
            self._polling = False
            for i, snap in result.items():
                if snap is not None:
                    self.state[i].status = snap
                    self.state[i].lower = snap.lower
                    self.state[i].upper = snap.upper
                    self.state[i].initial = snap.initial
                    self.state[i].target = snap.target
                    self.state[i].error = ""
                self.cards[i].refresh()
            self._update_summary()

        self.store.spawn(work, done, lambda e: setattr(self, "_polling", False))

    def refresh(self) -> None:
        gateway = self.store.mode_gateway
        ready = gateway and self.store.connected
        self.notice.setVisible(not gateway)
        for btn in (self.enable_btn, self.stop_btn, self.stop_all_btn):
            btn.setEnabled(ready)
        self._poll()
        self._update_summary()

    def on_show(self) -> None:
        self.refresh()
