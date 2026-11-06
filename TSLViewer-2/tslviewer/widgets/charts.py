"""Custom painted gauge and line charts."""

from __future__ import annotations

import math

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPainterPath, QPen
from PyQt6.QtWidgets import QSizePolicy, QVBoxLayout, QWidget

from ..theme import Theme, mono_font
from .primitives import QLabel


class AngleGauge(QWidget):
    def __init__(self, theme: Theme, label: str = "MECHANICAL", sub: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.theme = theme
        self.angle = 0.0
        self.label = label
        self.sub = sub
        self.setFixedSize(132, 150)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)

    def set_angle(self, angle: float, sub: str | None = None) -> None:
        self.angle = angle
        if sub is not None:
            self.sub = sub
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self.theme
        cx, cy, r = 66.0, 66.0, 46.0
        frac = (self.angle % 360) / 360
        track = QColor(255, 255, 255, 20) if t.name == "dark" else QColor(16, 24, 40, 24)
        p.setPen(QPen(track, 6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(QRectF(cx - r, cy - r, r * 2, r * 2))

        grad = QLinearGradient(cx - r, cy - r, cx + r, cy + r)
        grad.setColorAt(0, QColor(t.accent))
        grad.setColorAt(1, QColor(t.blue))
        pen = QPen(grad, 6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
        p.setPen(pen)
        p.drawArc(QRectF(cx - r, cy - r, r * 2, r * 2), 90 * 16, -int(360 * 16 * frac))

        p.save()
        p.translate(cx, cy)
        p.rotate(self.angle)
        p.setPen(QPen(QColor(t.warn), 2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        p.drawLine(QPointF(0, 0), QPointF(0, -38))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(t.warn))
        p.drawEllipse(QPointF(0, -38), 3, 3)
        p.restore()

        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(t.accent))
        p.drawEllipse(QPointF(cx, cy), 3.4, 3.4)

        p.setPen(QColor(t.text))
        p.setFont(mono_font(14, 500))
        p.drawText(QRectF(0, 96, 132, 18), Qt.AlignmentFlag.AlignCenter, f"{self.angle:.1f}°")
        p.setPen(QColor(t.text_3))
        f = QFont(p.font())
        f.setPointSize(7)
        f.setLetterSpacing(QFont.SpacingType.AbsoluteSpacing, 1.6)
        p.setFont(f)
        p.drawText(QRectF(0, 116, 132, 12), Qt.AlignmentFlag.AlignCenter, self.label)
        p.end()


class LineChart(QWidget):
    """Simple time-domain plot used for step responses and test sequences."""

    def __init__(
        self,
        theme: Theme,
        height: int = 240,
        y_label: str = "",
        series_colors: list[str] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.theme = theme
        self.series: list[tuple[str, list[tuple[float, float]], str]] = []
        self.y_label = y_label
        self.colors = series_colors or [theme.accent, theme.warn, theme.violet]
        self.setMinimumHeight(height)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def set_series(self, series: list[tuple[str, list[tuple[float, float]], str]]) -> None:
        self.series = series
        self.update()

    def clear(self) -> None:
        self.series = []
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self.theme
        w, h = self.width(), self.height()
        grad = QLinearGradient(0, 0, 0, h)
        grad.setColorAt(0, QColor(t.screen_a))
        grad.setColorAt(1, QColor(t.screen_b))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(grad)
        p.drawRoundedRect(QRectF(0, 0, w, h), 12, 12)

        pad_l, pad_r, pad_t, pad_b = 54, 16, 14, 26
        plot_w = max(10, w - pad_l - pad_r)
        plot_h = max(10, h - pad_t - pad_b)
        all_pts = [pt for _, data, _ in self.series for pt in data]
        if not all_pts:
            p.setPen(QColor(t.text_3))
            p.setFont(mono_font(11))
            p.drawText(QRectF(0, 0, w, h), Qt.AlignmentFlag.AlignCenter, "无数据")
            p.end()
            return
        xs = [x for x, _ in all_pts]
        ys = [y for _, y in all_pts]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        if x1 - x0 < 1e-9:
            x1 = x0 + 1
        if y1 - y0 < 1e-9:
            y1 = y0 + 1
        pad = (y1 - y0) * 0.1
        y0 -= pad
        y1 += pad

        p.setFont(mono_font(9))
        for i in range(5):
            y = pad_t + plot_h * i / 4
            p.setPen(QPen(QColor(t.grid), 1))
            p.drawLine(QPointF(pad_l, y), QPointF(pad_l + plot_w, y))
            value = y1 - (y1 - y0) * i / 4
            p.setPen(QColor(t.grid_ink))
            p.drawText(QRectF(4, y - 8, pad_l - 12, 16), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, f"{value:.1f}")
        for i in range(5):
            x = pad_l + plot_w * i / 4
            p.setPen(QPen(QColor(t.grid), 1))
            p.drawLine(QPointF(x, pad_t), QPointF(x, pad_t + plot_h))
            p.setPen(QColor(t.grid_ink))
            p.drawText(
                QRectF(x - 24, h - 18, 60, 14),
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                f"{x0 + (x1 - x0) * i / 4:.2f}",
            )
        if self.y_label:
            p.save()
            p.translate(12, pad_t + plot_h / 2)
            p.rotate(-90)
            p.setPen(QColor(t.text_4))
            p.drawText(QRectF(-60, -12, 120, 16), Qt.AlignmentFlag.AlignCenter, self.y_label)
            p.restore()

        for idx, (name, data, color) in enumerate(self.series):
            if not data:
                continue
            color = color or self.colors[idx % len(self.colors)]
            path = QPainterPath()
            for i, (x, y) in enumerate(data):
                px = pad_l + (x - x0) / (x1 - x0) * plot_w
                py = pad_t + plot_h - (y - y0) / (y1 - y0) * plot_h
                if i == 0:
                    path.moveTo(px, py)
                else:
                    path.lineTo(px, py)
            p.setPen(QPen(QColor(color), 1.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawPath(path)
        p.end()


class WaveformChart(QWidget):
    """Reference vs. actual overlay with automatic normalisation."""

    def __init__(self, theme: Theme, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.theme = theme
        self.reference: list[float] = []
        self.actual: list[float] = []
        self.setMinimumHeight(220)

    def set_data(self, reference: list[float], actual: list[float]) -> None:
        self.reference = reference
        self.actual = actual
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self.theme
        w, h = self.width(), self.height()
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(t.screen_b))
        p.drawRoundedRect(QRectF(0, 0, w, h), 12, 12)
        if not self.actual:
            p.setPen(QColor(t.text_3))
            p.setFont(mono_font(11))
            p.drawText(QRectF(0, 0, w, h), Qt.AlignmentFlag.AlignCenter, "完成采集后显示实际响应")
            p.end()
            return
        pad_l, pad_r, pad_t, pad_b = 16, 16, 16, 18
        plot_w, plot_h = w - pad_l - pad_r, h - pad_t - pad_b
        values = self.reference + self.actual
        lo, hi = min(values), max(values)
        span = hi - lo if hi - lo > 1e-9 else 1.0
        p.setPen(QPen(QColor(t.grid), 1))
        for i in range(4):
            y = pad_t + plot_h * i / 3
            p.drawLine(QPointF(pad_l, y), QPointF(pad_l + plot_w, y))

        def draw(data: list[float], color: str, width: float) -> None:
            if not data:
                return
            path = QPainterPath()
            for i, v in enumerate(data):
                x = pad_l + plot_w * i / max(1, len(data) - 1)
                y = pad_t + plot_h - (v - lo) / span * plot_h
                if i == 0:
                    path.moveTo(x, y)
                else:
                    path.lineTo(x, y)
            p.setPen(QPen(QColor(color), width))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawPath(path)

        draw(self.reference, t.warn, 1.1)
        draw(self.actual, t.accent, 1.8)
        p.end()
