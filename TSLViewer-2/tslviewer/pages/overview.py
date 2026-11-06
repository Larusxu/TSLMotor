"""运行概览 — KPIs, drive state, fault matrix and live telemetry."""

from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ..core import regs
from ..core.presets import SIGNALS
from ..core.registers import STATUS_BITS
from ..core.units import fmt, hexs, s16hi, temp_c
from ..theme import Theme, mono_font
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    KV,
    Notice,
    NumField,
    Segmented,
    SelectField,
    StatTile,
    divider,
)
from ..widgets.scope import ScopeWidget
from .base import BasePage, row, stack
from .fleet_overview import FleetOverview

MODES = regs.MODE_NAMES


class OverviewPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.regs: dict[int, int] = {}
        self.speed_history: list[float] = []
        self._polling = False
        self._build()

    # ------------------------------------------------------------------ UI
    def _build(self) -> None:
        self.gateway_box = FleetOverview(self.store, self.theme, self.shell)
        self.add(self.gateway_box)

        self.stats_row = QWidget()
        srow = QHBoxLayout(self.stats_row)
        srow.setContentsMargins(0, 0, 0, 0)
        srow.setSpacing(14)
        self.stat_speed = StatTile("实际转速", "—", "RPM", "芯片读回")
        self.stat_speed.enable_spark(self.theme.accent)
        self.stat_torque = StatTile("力矩电流 iQ", "—", "mA", "")
        self.stat_temp = StatTile("温度", "—", "°C", "结温 · 外部")
        for tile in (self.stat_speed, self.stat_torque, self.stat_temp):
            tile.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            srow.addWidget(tile, 1)
        self.add(self.stats_row)

        self.jog_card = self._jog_card()
        self.const_card = self._constant_card()
        grid = QGridLayout()
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)
        grid.addWidget(self.jog_card, 0, 0)
        grid.addWidget(self.const_card, 0, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        self.add_layout(grid)

        self.drive_card = self._drive_card()
        self.fault_card = self._fault_card()
        self.direct_grid = QGridLayout()
        self.direct_grid.setContentsMargins(0, 0, 0, 0)
        self.direct_grid.setHorizontalSpacing(14)
        self.direct_grid.setVerticalSpacing(14)
        self.direct_grid.addWidget(self.drive_card, 0, 0)
        self.direct_grid.addWidget(self.fault_card, 0, 1)
        self.direct_grid.setColumnStretch(0, 1)
        self.direct_grid.setColumnStretch(1, 1)
        self.add_layout(self.direct_grid)

        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(700)
        self._poll_timer.timeout.connect(self._poll)
        self._poll_timer.start()

    def _jog_card(self) -> Card:
        card = Card("开环点动", "OPEN LOOP JOG")
        self.jog_rpm = NumField(300, 1, 28730, 10, 0, "rpm")
        card.add(Field("开环转速", self.jog_rpm, "只下发电机端速度，不闭环"))
        self.authorize_btn = Button("开启运动授权", "default", "sm")
        self.authorize_btn.clicked.connect(self._toggle_permit)
        card.body.insertWidget(0, row(self.authorize_btn, stretch_last=True))
        btns = QWidget()
        h = QHBoxLayout(btns)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(8)
        self.jog_neg = Button("负向点动")
        self.jog_pos = Button("正向点动")
        for btn, sign in ((self.jog_neg, -1), (self.jog_pos, 1)):
            btn.pressed.connect(lambda s=sign: self._jog_start(s))
            btn.released.connect(self._jog_stop)
            h.addWidget(btn)
        card.add(btns)
        self.jog_hint = QLabel("需主控模式并开启运动授权")
        self.jog_hint.setObjectName("tiny")
        card.add(self.jog_hint)
        return card

    def _constant_card(self) -> Card:
        card = Card("机器常数", "UNIT CONVERSION")
        self.poles = NumField(self.store.cal.poles, 1, 127, 1, 0)
        self.pwm_max = NumField(self.store.cal.pwm_max_count, 600, 20000, 10, 0)
        self.ma_count = NumField(self.store.cal.ma_per_count, 0, 10, 0.0001, 5)
        self.cpr_rpm = NumField(self.store.cal.counts_per_rpm, 0, 100000, 0.1, 1)
        self.poles.valueChanged.connect(lambda v: self._set_cal("poles", int(v)))
        self.pwm_max.valueChanged.connect(lambda v: self._set_cal("pwm_max_count", int(v)))
        self.ma_count.valueChanged.connect(lambda v: self._set_cal("ma_per_count", v))
        self.cpr_rpm.valueChanged.connect(lambda v: self._set_cal("counts_per_rpm", v))
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(10)
        grid.addWidget(Field("极对数", self.poles), 0, 0)
        grid.addWidget(Field("PWM MAX_COUNT", self.pwm_max, "fPWM = 120 MHz / n"), 0, 1)
        grid.addWidget(Field("mA / LSB", self.ma_count), 1, 0)
        grid.addWidget(Field("counts / RPM", self.cpr_rpm), 1, 1)
        card.add_layout(grid)
        card.add(Notice("Tesla 平台默认：极对数 1、16384 CPR、4× CSA → 0.20131 mA/LSB、305.4 counts/RPM、25 kHz PWM。"))
        return card

    def _drive_card(self) -> Card:
        card = Card("驱动状态", "MCC_STATUS / GDRV")
        self.kv = KV([
            ("运动模式", "—"),
            ("极对数", "—"),
            ("驱动使能", "—"),
            ("供电 VM (raw)", "—"),
            ("电流矢量", "—"),
            ("状态字", "—"),
        ])
        card.add(self.kv)
        card.add(divider(self.theme))
        buttons = QWidget()
        h = QHBoxLayout(buttons)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(8)
        reread = Button("重新读取", "ghost", "sm")
        reread.clicked.connect(lambda: self._poll(force=True))
        enable = Button("使能驱动", "ghost", "sm")
        enable.clicked.connect(self._enable_drive)
        clear = Button("清事件", "ghost", "sm")
        clear.clicked.connect(self._clear_events)
        h.addWidget(reread)
        h.addWidget(enable)
        h.addWidget(clear)
        h.addStretch(1)
        card.add(buttons)
        return card

    def _fault_card(self) -> Card:
        self.fault_badge = Badge("无故障", "ok")
        card = Card("故障位", "STATUS_FLAGS 0x009", self.fault_badge)
        self.fault_host = QWidget()
        self.fault_grid = QGridLayout(self.fault_host)
        self.fault_grid.setContentsMargins(0, 0, 0, 0)
        self.fault_grid.setHorizontalSpacing(8)
        self.fault_grid.setVerticalSpacing(8)
        empty = QLabel("尚未读取状态字")
        empty.setObjectName("tiny")
        self.fault_grid.addWidget(empty, 0, 0)
        card.add(self.fault_host)
        return card

    def _gateway_overview(self) -> Card:
        card = Card("主控阵列概览", "CONTROLLER ARRAY", Badge("主控语义状态", "neutral"))
        self.gw_summary = QWidget()
        g = QHBoxLayout(self.gw_summary)
        g.setContentsMargins(0, 0, 0, 0)
        g.setSpacing(12)
        self.gw_tiles: dict[str, QLabel] = {}
        for key, title in (("cap", "设备能力"), ("motors", "电机数"), ("active", "活动电机"), ("floor", "请求下限")):
            box = QWidget()
            box.setStyleSheet(f"background:{self.theme.surface};border:1px solid {self.theme.line};border-radius:12px;")
            v = QVBoxLayout(box)
            v.setContentsMargins(14, 12, 14, 12)
            v.setSpacing(2)
            t = QLabel(title)
            t.setStyleSheet(f"font-size:11px;color:{self.theme.text_3};")
            value = QLabel("—")
            value.setFont(mono_font(20, 500))
            v.addWidget(t)
            v.addWidget(value)
            g.addWidget(box, 1)
            self.gw_tiles[key] = value
        card.add(self.gw_summary)
        self.gw_motor_kv = KV([
            ("逻辑供电", "—"),
            ("配置校验", "—"),
            ("运动授权", "—"),
            ("驱动 / 模式", "—"),
            ("编码器对齐", "—"),
            ("行程零点", "—"),
            ("故障 / 最后错误", "—"),
        ])
        card.add(self.gw_motor_kv)
        card.add(Notice("主控模式下所有运动、找零与判据由主控固件执行；上位机只下发授权与工艺参数。"))
        return card

    def _telemetry(self) -> QWidget:
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        self.window_seg = Segmented(
            [("2000", "2s"), ("5000", "5s"), ("15000", "15s"), ("60000", "60s")], "5000"
        )
        self.window_seg.changed.connect(self._window_changed)
        self.pause_btn = Button("暂停", "ghost", "sm")
        self.pause_btn.clicked.connect(self._toggle_pause)
        self.stream_btn = Button("开始采集", "primary", "sm")
        self.stream_btn.clicked.connect(self._toggle_stream)
        right = QWidget()
        r = QHBoxLayout(right)
        r.setContentsMargins(0, 0, 0, 0)
        r.setSpacing(6)
        r.addWidget(self.window_seg)
        r.addWidget(self.pause_btn)
        r.addWidget(self.stream_btn)
        self.scope_card = Card("实时遥测", "LIVE TELEMETRY", right)
        self.scope = ScopeWidget(self.store.scope, self.theme, height=330)
        self.scope_card.add(self.scope)
        footer = QWidget()
        f = QHBoxLayout(footer)
        f.setContentsMargins(0, 0, 0, 0)
        f.setSpacing(8)
        self.stream_badge = Badge("未采集", "neutral")
        self.stream_note = QLabel("")
        self.stream_note.setObjectName("tiny")
        f.addWidget(self.stream_badge)
        f.addWidget(self.stream_note, 1)
        self.scope_card.add(footer)

        self.channel_selects: list[SelectField] = []
        chan_card = Card("信号通道", "RTMI CHANNELS", Badge("7 可用", "neutral"))
        for ch in range(4):
            row_widget = QWidget()
            h = QHBoxLayout(row_widget)
            h.setContentsMargins(0, 0, 0, 0)
            h.setSpacing(8)
            tag = QLabel(f"CH{ch}")
            tag.setFont(mono_font(10))
            tag.setStyleSheet(f"color:{self.theme.text_4};")
            tag.setFixedWidth(26)
            select = SelectField(
                [("", "— 未使用 —")] + [(s.id, f"{s.label} ({s.unit})") for s in SIGNALS],
                self.store.channels[ch] or "",
            )
            select.currentIndexChanged.connect(
                lambda _=0, c=ch, s=select: self.store.set_channel(c, s.value() or None)
            )
            h.addWidget(tag)
            h.addWidget(select, 1)
            self.channel_selects.append(select)
            chan_card.add(row_widget)
        rate_row = QWidget()
        rr = QHBoxLayout(rate_row)
        rr.setContentsMargins(0, 0, 0, 0)
        rr.setSpacing(8)
        self.rate_select = SelectField([(v, f"{v} Hz") for v in (100, 250, 500, 1000, 2000, 4000)], self.store.sample_hz)
        self.rate_select.currentIndexChanged.connect(
            lambda: setattr(self.store, "sample_hz", int(self.rate_select.value()))
        )
        sync = SelectField([("pwm_z", "PWM_Z 起点")], "pwm_z")
        rr.addWidget(Field("采样率", self.rate_select))
        rr.addWidget(Field("同步", sync))
        chan_card.add(rate_row)
        polarity_row = QWidget()
        pr = QHBoxLayout(polarity_row)
        pr.setContentsMargins(0, 0, 0, 0)
        pr.setSpacing(8)
        pol_label = QLabel("信号极性")
        pol_label.setObjectName("tiny")
        self.polarity = Segmented([("1", "正向"), ("-1", "反向")], str(self.store.cal.polarity))
        self.polarity.changed.connect(lambda v: self._set_cal("polarity", int(v)))
        pr.addWidget(pol_label)
        pr.addWidget(self.polarity)
        pr.addStretch(1)
        chan_card.add(polarity_row)
        self.chan_notice = Notice("RTMI 使用芯片原生分频；请确认直连串口波特率与芯片一致。")
        chan_card.add(self.chan_notice)

        grid.addWidget(self.scope_card, 0, 0)
        grid.addWidget(chan_card, 0, 1)
        grid.setColumnStretch(0, 2)
        grid.setColumnStretch(1, 1)
        return host

    # -------------------------------------------------------------- actions
    def _set_cal(self, key: str, value) -> None:
        setattr(self.store.cal, key, value)
        self.store.save_settings()
        self.store.changed.emit()

    def _window_changed(self, value: str) -> None:
        self.store.window_ms = int(value)
        self.store.scope.window_ms = float(value)

    def _toggle_pause(self) -> None:
        paused = not self.scope.canvas.paused
        self.scope.set_paused(paused)
        self.pause_btn.setText("继续" if paused else "暂停")

    def _toggle_stream(self) -> None:
        if self.store.streaming:
            self.store.stop_stream()
        else:
            self.store.start_stream()

    def _stream_changed(self) -> None:
        streaming = self.store.streaming
        self.stream_btn.setText("停止" if streaming else "开始采集")
        self.stream_btn.setProperty("variant", "ghost" if streaming else "primary")
        self.stream_btn.style().unpolish(self.stream_btn)
        self.stream_btn.style().polish(self.stream_btn)
        self.stream_btn.setEnabled(self.store.connected)
        self.stream_badge.set_text(
            f"{self.store.stats.frame_rate:.0f} 帧/s" if streaming else "未采集"
        )
        self.stream_badge.set_tone("accent" if streaming else "neutral")
        self.stream_note.setText(
            f"触发 {self.store.sample_hz} Hz · sampling={self.store.samples} · 丢弃 {self.store.stats.rtmi_dropped} 字节"
            if self.store.mode == "direct"
            else (self.store.trace_status or "主控 RTMI · PWM 同步")
        )
        assigned = [i for i, sid in enumerate(self.store.channels) if sid]
        self.scope.set_channels(assigned)

    def _toggle_permit(self) -> None:
        state = self.store.semantic.get("state")
        self.store.set_permit(not (state and state.permit))

    def _jog_start(self, sign: int) -> None:
        state = self.store.semantic.get("state")
        if not (self.store.connected and self.store.mode_gateway and state and state.permit):
            self.store.toast("warn", "需要主控模式并开启运动授权")
            return
        velocity = int(sign * round(self.jog_rpm.value() * self.store.cal.counts_per_rpm))

        def work():
            if self.store.semantic_session is None:
                raise RuntimeError("请先连接主控")
            return self.store.semantic_session.open_loop_start(velocity)

        self.store.spawn(work, lambda r: self.store._apply_semantic(r), lambda e: self.store.toast("error", str(e)))

    def _jog_stop(self) -> None:
        def work():
            if self.store.semantic_session is None:
                return None
            return self.store.semantic_session.stop(True)

        self.store.spawn(work, lambda r: self.store._apply_semantic(r) if r else None, lambda e: None)

    def _enable_drive(self) -> None:
        def work():
            reg_value = self.store.link.read_reg_retry(0x101, 3)
            self.store.link.write_reg(0x101, (reg_value | (1 << 31) | (1 << 16)) & 0xFFFFFFFF)
            return True

        self.store.spawn(work, lambda _: (self.store.toast("ok", "驱动已使能（DRV_EN + 电荷泵）"), self._poll(force=True)),
                         lambda e: self.store.toast("error", str(e)))

    def _clear_events(self) -> None:
        self.store.write_reg(0x00A, 0xFFFFFFFF, False, lambda _: self.store.toast("ok", "事件锁存已清"))

    # --------------------------------------------------------------- polling
    def _poll(self, force: bool = False) -> None:
        if not self.store.connected or self.store.mode != "direct" or self._polling:
            return
        self._polling = True

        def work():
            return self.store.link.read_many(
                [0x009, 0x083, 0x084, 0x100, 0x101, 0x105, 0x154, 0x153, 0x171]
            )

        def done(values: dict) -> None:
            self._polling = False
            self.regs.update(values)
            self._render()

        self.store.spawn(work, done, lambda e: setattr(self, "_polling", False))

    def _render(self) -> None:
        r = self.regs
        if not r:
            return
        status = r.get(0x009, 0)
        mode = (r.get(0x100, 0) >> 9) & 0x0F
        poles = r.get(0x100, 0) & 0x7F
        drv_on = (r.get(0x101, 0) >> 16) & 1
        vm = s16hi(r.get(0x083, 0))
        temp_raw = r.get(0x084)
        i_s = r.get(0x171, 0) & 0xFFFF
        speed = self.store.scope.latest.get(0)
        if speed is None:
            raw = r.get(0x154, 0)
            if raw & 0x80000000:
                raw -= 1 << 32
            speed = raw / self.store.cal.counts_per_rpm
        torque = self.store.scope.latest.get(2)
        if torque is None:
            torque = s16hi(r.get(0x153, 0)) * self.store.cal.ma_per_count
        self.speed_history.append(speed)
        self.speed_history = self.speed_history[-50:]
        self.stat_speed.set_value(fmt(speed, 0), "RTMI" if self.store.streaming else "芯片读回")
        self.stat_torque.set_value(fmt(torque, 0), f"限幅 800 mA")
        self.stat_torque.value.setStyleSheet(f"color:{self.theme.warn};" if abs(torque) > 700 else f"color:{self.theme.text};")
        self.stat_temp.set_value(
            "—" if temp_raw is None else fmt(temp_c(temp_raw, self.store.cal.temp_offset), 1)
        )
        if self.stat_speed.spark:
            self.stat_speed.spark.set_values(self.speed_history)
        enable_label = QLabel("已使能" if drv_on else "未使能")
        enable_label.setStyleSheet(
            f"color:{self.theme.ok if drv_on else self.theme.text_3};font-family:'Cascadia Code',Consolas;font-size:11px;"
        )
        self.kv.set_rows([
            ("运动模式", MODES[mode] if mode < len(MODES) else f"?? ({mode})"),
            ("极对数", str(poles)),
            ("驱动使能", enable_label),
            ("供电 VM (raw)", str(vm)),
            ("电流矢量", f"{i_s} LSB ≈ {fmt(i_s * self.store.cal.ma_per_count, 0)} mA"),
            ("状态字", hexs(status)),
        ])
        active = [(bit, label, tone) for bit, label, tone in STATUS_BITS if (status >> bit) & 1]
        self.fault_badge.set_text(f"{len(active)} 个告警" if active else "无故障")
        self.fault_badge.set_tone("danger" if active else "ok")
        while self.fault_grid.count():
            item = self.fault_grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        if not active:
            empty = QLabel("尚未读取状态字" if status == 0 else "无故障位 · 状态字 0x%08X" % status)
            empty.setObjectName("tiny")
            self.fault_grid.addWidget(empty, 0, 0)
        for i, (bit, label, tone) in enumerate(active):
            cell = QWidget()
            color = self.theme.ok if tone == "info" else self.theme.warn if tone == "warn" else self.theme.danger
            cell.setStyleSheet(
                f"background:#1F{color[1:]};border:1px solid #44{color[1:]};border-radius:9px;"
            )
            v = QVBoxLayout(cell)
            v.setContentsMargins(10, 8, 10, 8)
            v.setSpacing(1)
            name = QLabel(label)
            name.setStyleSheet(f"font-size:11.5px;color:{color};font-weight:600;")
            bit_label = QLabel(f"bit {bit}")
            bit_label.setFont(mono_font(9))
            bit_label.setStyleSheet(f"color:{self.theme.text_3};")
            v.addWidget(name)
            v.addWidget(bit_label)
            self.fault_grid.addWidget(cell, i // 2, i % 2)

    def refresh(self) -> None:
        gateway = self.store.mode_gateway
        self.gateway_box.setVisible(gateway)
        self.stats_row.setVisible(not gateway)
        self.jog_card.setVisible(True)
        self.const_card.setVisible(True)
        self.drive_card.setVisible(not gateway)
        self.fault_card.setVisible(not gateway)
        self.authorize_btn.setVisible(gateway)
        self.jog_neg.setEnabled(gateway and self.store.connected)
        self.jog_pos.setEnabled(gateway and self.store.connected)
        self.jog_hint.setText(
            "需主控模式并开启运动授权" if gateway else "直连模式不支持开环点动；请用「环路测试」的恒 Iq / 恒速度"
        )
        state = self.store.semantic.get("state")
        self.authorize_btn.setText("取消运动授权" if state and state.permit else "开启运动授权")
        if not gateway:
            self._poll()

    def on_show(self) -> None:
        self.refresh()
