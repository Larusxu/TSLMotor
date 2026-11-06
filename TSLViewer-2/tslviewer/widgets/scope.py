"""Canvas oscilloscope, ported from ``src/components/Scope.tsx``."""

from __future__ import annotations

import math

from PyQt6.QtCore import QPointF, QRectF, Qt, QTimer
from PyQt6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPainterPath, QPen
from PyQt6.QtWidgets import QHBoxLayout, QSizePolicy, QVBoxLayout, QWidget

from ..core.store import ScopeStore
from ..theme import Theme, mono_font
from .primitives import QLabel


class ScopeCanvas(QWidget):
    def __init__(self, store: ScopeStore, theme: Theme, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.store = store
        self.theme = theme
        self.channels: list[int] = []
        self.paused = False
        self.hover_x: float | None = None
        self.setMinimumHeight(220)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self._timer = QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    def _tick(self) -> None:
        if not self.paused:
            self.update()

    def set_channels(self, channels: list[int]) -> None:
        self.channels = channels
        self.update()

    def set_theme(self, theme: Theme) -> None:
        self.theme = theme
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        self.hover_x = event.position().x()
        self.update()

    def leaveEvent(self, event) -> None:  # noqa: N802
        self.hover_x = None
        self.update()

    def _format_tick(self, value: float) -> str:
        if abs(value) >= 1000:
            return f"{value / 1000:.1f}k"
        if abs(value) >= 10:
            return f"{value:.0f}"
        if abs(value) >= 1:
            return f"{value:.1f}"
        return f"{value:.2f}"

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self.theme
        w, h = self.width(), self.height()
        grad = QLinearGradient(0, 0, 0, h)
        grad.setColorAt(0, QColor(t.screen_a))
        grad.setColorAt(0.7, QColor(t.screen_b))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(grad)
        p.drawRoundedRect(QRectF(0, 0, w, h), 12, 12)

        pad_l, pad_r, pad_t, pad_b = 52, 14, 12, 22
        plot_w = max(10, w - pad_l - pad_r)
        plot_h = max(10, h - pad_t - pad_b)
        lo, hi = self.store.bounds(self.channels)
        now = self.store.now()
        window = self.store.window_ms
        from_time = now - window

        p.setFont(mono_font(9))
        grid = QColor(t.grid)
        label_color = QColor(t.grid_ink)
        for i in range(6):
            y = pad_t + plot_h * i / 5
            p.setPen(QPen(grid, 1))
            p.drawLine(QPointF(pad_l, y), QPointF(pad_l + plot_w, y))
            value = hi - (hi - lo) * i / 5
            p.setPen(label_color)
            p.drawText(QRectF(4, y - 7, pad_l - 10, 14), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, self._format_tick(value))
        for i in range(6):
            x = pad_l + plot_w * i / 5
            p.setPen(QPen(grid, 1))
            p.drawLine(QPointF(x, pad_t), QPointF(x, pad_t + plot_h))
            label = f"{-window / 1000 + window / 1000 * i / 5:.1f}s"
            p.setPen(label_color)
            p.drawText(QRectF(x - 20, h - 18, 46, 14), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, label)

        if lo < 0 < hi:
            y0 = pad_t + plot_h - ((0 - lo) / (hi - lo)) * plot_h
            p.setPen(QPen(QColor(t.line_strong), 1))
            p.drawLine(QPointF(pad_l, y0), QPointF(pad_l + plot_w, y0))

        def x_for(tv: float) -> float:
            return pad_l + ((tv - from_time) / window) * plot_w

        def y_for(v: float) -> float:
            return pad_t + plot_h - ((v - lo) / (hi - lo)) * plot_h

        primary = self.channels[0] if self.channels else -1
        for ch in self.channels:
            series = self.store.series.get(ch)
            if not series:
                continue
            points = self.store.window_points(ch)
            if len(points) < 2:
                continue
            color = QColor(t.ch[ch % len(t.ch)])
            path = QPainterPath()
            started = False
            for tv, v in points:
                pt = QPointF(x_for(tv), y_for(v))
                if not started:
                    path.moveTo(pt)
                    started = True
                else:
                    path.lineTo(pt)
            if not started:
                continue
            p.setPen(QPen(color, 1.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawPath(path)
            if ch == primary:
                area = QPainterPath(path)
                area.lineTo(pad_l + plot_w, pad_t + plot_h)
                area.lineTo(pad_l, pad_t + plot_h)
                area.closeSubpath()
                ag = QLinearGradient(0, pad_t, 0, pad_t + plot_h)
                top = QColor(color)
                top.setAlpha(28)
                bottom = QColor(color)
                bottom.setAlpha(0)
                ag.setColorAt(0, top)
                ag.setColorAt(1, bottom)
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(ag)
                p.drawPath(area)
            latest = self.store.latest.get(ch)
            if latest is not None:
                y = y_for(latest)
                if pad_t <= y <= pad_t + plot_h:
                    p.setPen(Qt.PenStyle.NoPen)
                    p.setBrush(color)
                    p.drawEllipse(QPointF(pad_l + plot_w - 2, y), 2.6, 2.6)

        if self.hover_x is not None and pad_l <= self.hover_x <= pad_l + plot_w:
            p.setPen(QPen(QColor(t.accent_line), 1, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(self.hover_x, pad_t), QPointF(self.hover_x, pad_t + plot_h))
            frac = (self.hover_x - pad_l) / plot_w
            tv = from_time + frac * window
            lines = []
            for ch in self.channels:
                series = self.store.series.get(ch)
                if not series or not series.t:
                    continue
                best = min(range(len(series.t)), key=lambda i: abs(series.t[i] - tv))
                lines.append(f"{series.label} {series.v[best]:.2f} {series.unit}")
            if lines:
                p.setFont(mono_font(9))
                text = "   ".join(lines)
                box = QRectF(pad_l + 8, pad_t + 6, min(plot_w - 16, 8.4 * len(text)), 18 + 12 * (len(lines) - 1))
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(QColor(t.legend_bg))
                p.drawRoundedRect(box, 6, 6)
                p.setPen(QColor(t.text_2))
                p.drawText(box.adjusted(8, 2, -8, -2), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, text)
        p.end()


class ScopeWidget(QWidget):
    """Canvas + legend chips."""

    def __init__(self, store: ScopeStore, theme: Theme, height: int | None = 320, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.store = store
        self.theme = theme
        self.channels: list[int] = []
        self.hidden: set[int] = set()
        self.canvas = ScopeCanvas(store, theme, self)
        if height:
            self.canvas.setFixedHeight(height)
        col = QVBoxLayout(self)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(0)
        col.addWidget(self.canvas)
        self.legend = QWidget()
        self.legend.setStyleSheet(f"background:{theme.legend_bg};border-top:1px solid {theme.line_soft};border-bottom-left-radius:12px;border-bottom-right-radius:12px;")
        self.legend_row = QHBoxLayout(self.legend)
        self.legend_row.setContentsMargins(10, 6, 10, 6)
        self.legend_row.setSpacing(6)
        self.legend_row.addStretch(1)
        col.addWidget(self.legend)
        self.chips: dict[int, QLabel] = {}
        self._chip_timer = QTimer(self)
        self._chip_timer.setInterval(220)
        self._chip_timer.timeout.connect(self._refresh_chips)
        self._chip_timer.start()

    def set_channels(self, channels: list[int]) -> None:
        self.channels = channels
        self.canvas.set_channels([ch for ch in channels if ch not in self.hidden])
        self._rebuild_legend()

    def set_theme(self, theme: Theme) -> None:
        self.theme = theme
        self.canvas.set_theme(theme)
        self.legend.setStyleSheet(f"background:{theme.legend_bg};border-top:1px solid {theme.line_soft};border-bottom-left-radius:12px;border-bottom-right-radius:12px;")
        self._rebuild_legend()

    def set_paused(self, paused: bool) -> None:
        self.canvas.paused = paused

    def _rebuild_legend(self) -> None:
        while self.legend_row.count():
            item = self.legend_row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.chips.clear()
        for ch in self.channels:
            series = self.store.series.get(ch)
            if not series:
                continue
            chip = QLabel()
            chip.setObjectName("chip")
            color = self.theme.ch[ch % len(self.theme.ch)]
            chip.setStyleSheet(
                f"QLabel#chip{{border:1px solid {self.theme.line};background:{self.theme.fill_3};"
                f"border-radius:11px;padding:2px 8px;font-size:10.5px;"
                f"color:{self.theme.text if ch not in self.hidden else self.theme.text_4};}}"
            )
            self.legend_row.addWidget(chip)
            self.chips[ch] = chip
        self.legend_row.addStretch(1)
        self._refresh_chips()

    def _refresh_chips(self) -> None:
        for ch, chip in self.chips.items():
            series = self.store.series.get(ch)
            if not series:
                continue
            value = self.store.latest.get(ch)
            text = f"{series.label}"
            if value is not None:
                text += f"  {value:.1f} {series.unit}"
            chip.setText(text)
