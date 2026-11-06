"""Live telemetry panel (scope + RTMI channel mapping), ported from TelemetryPanels.tsx."""

from __future__ import annotations

from PyQt6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QWidget

from ..core.presets import SIGNALS
from ..theme import Theme
from .primitives import Badge, Button, Card, Field, Notice, Segmented, SelectField
from .scope import ScopeWidget


class TelemetryPanels(QWidget):
    def __init__(self, store, theme: Theme, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.store = store
        self.theme = theme
        self.channel_selects: list[SelectField] = []
        self._build()
        self.store.streamChanged.connect(self.refresh)
        self.refresh()

    def _build(self) -> None:
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        self.window_seg = Segmented([("2000", "2s"), ("5000", "5s"), ("15000", "15s"), ("60000", "60s")], "5000")
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

        chan_card = Card("信号通道", "RTMI CHANNELS", Badge("7 可用", "neutral"))
        for ch in range(4):
            row_widget = QWidget()
            h = QHBoxLayout(row_widget)
            h.setContentsMargins(0, 0, 0, 0)
            h.setSpacing(8)
            tag = QLabel(f"CH{ch}")
            tag.setObjectName("kvValue")
            tag.setFixedWidth(28)
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
        self.polarity.changed.connect(self._set_polarity)
        pr.addWidget(pol_label)
        pr.addWidget(self.polarity)
        pr.addStretch(1)
        chan_card.add(polarity_row)
        self.notice = Notice("RTMI 使用芯片原生分频；请确认直连串口波特率与芯片一致。")
        chan_card.add(self.notice)

        grid.addWidget(self.scope_card, 0, 0)
        grid.addWidget(chan_card, 0, 1)
        grid.setColumnStretch(0, 2)
        grid.setColumnStretch(1, 1)

    def _set_polarity(self, value: str) -> None:
        self.store.cal.polarity = int(value)
        self.store.save_settings()

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

    def apply_theme(self, theme: Theme) -> None:
        self.theme = theme
        self.scope.set_theme(theme)

    def refresh(self) -> None:
        streaming = self.store.streaming
        self.stream_btn.setText("停止" if streaming else "开始采集")
        self.stream_btn.setProperty("variant", "ghost" if streaming else "primary")
        self.stream_btn.style().unpolish(self.stream_btn)
        self.stream_btn.style().polish(self.stream_btn)
        self.stream_btn.setEnabled(self.store.connected)
        self.stream_badge.set_text(f"{self.store.stats.frame_rate:.0f} 帧/s" if streaming else "未采集")
        self.stream_badge.set_tone("accent" if streaming else "neutral")
        self.stream_note.setText(
            f"触发 {self.store.sample_hz} Hz · sampling={self.store.samples} · 丢弃 {self.store.stats.rtmi_dropped} 字节"
            if not self.store.mode_gateway
            else (self.store.trace_status or "主控 RTMI · PWM 同步")
        )
        self.scope.set_channels([i for i, sid in enumerate(self.store.channels) if sid])
        self.notice.setText(
            "RTMI 使用芯片原生分频；请确认直连串口波特率与芯片一致。"
            if not self.store.mode_gateway
            else "主控转发芯片原生 RTMI，CRC 校验。业务串口与电机串口使用 1.5 Mbps，保留实际采样时刻。实际 sampling 与丢帧见曲线下方。请在驱动禁能时开始、停止或修改采集配置。"
        )
        for i, select in enumerate(self.channel_selects):
            select.blockSignals(True)
            index = select.findData(self.store.channels[i] or "")
            if index >= 0:
                select.setCurrentIndex(index)
            select.blockSignals(False)
