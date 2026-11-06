"""Small vector icons painted with QPainter (no external assets)."""

from __future__ import annotations

import math

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap


def _pen(color: QColor, width: float) -> QPen:
    pen = QPen(color, width)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    return pen


def draw_icon(p: QPainter, name: str, color: QColor, size: float = 24.0) -> None:
    p.setPen(_pen(color, 1.7))
    p.setBrush(Qt.BrushStyle.NoBrush)
    s = size
    if name == "gauge":
        p.drawArc(QRectF(s * 0.16, s * 0.2, s * 0.68, s * 0.68), 30 * 16, 120 * 16)
        p.drawLine(QPointF(s * 0.5, s * 0.54), QPointF(s * 0.68, s * 0.38))
        p.drawPoint(QPointF(s * 0.5, s * 0.54))
    elif name == "ruler":
        p.drawLine(QPointF(s * 0.2, s * 0.7), QPointF(s * 0.8, s * 0.3))
        for i in range(4):
            x = s * (0.3 + i * 0.13)
            y = s * (0.66 - i * 0.09)
            p.drawLine(QPointF(x, y), QPointF(x + s * 0.07, y - s * 0.11))
    elif name == "encoder":
        p.drawEllipse(QRectF(s * 0.22, s * 0.22, s * 0.56, s * 0.56))
        p.drawEllipse(QRectF(s * 0.42, s * 0.42, s * 0.16, s * 0.16))
        for i in range(8):
            a = i * math.pi / 4
            p.drawLine(
                QPointF(s * 0.5 + math.cos(a) * s * 0.28, s * 0.5 + math.sin(a) * s * 0.28),
                QPointF(s * 0.5 + math.cos(a) * s * 0.35, s * 0.5 + math.sin(a) * s * 0.35),
            )
    elif name == "target":
        p.drawEllipse(QRectF(s * 0.2, s * 0.2, s * 0.6, s * 0.6))
        p.drawEllipse(QRectF(s * 0.4, s * 0.4, s * 0.2, s * 0.2))
        p.drawLine(QPointF(s * 0.5, s * 0.08), QPointF(s * 0.5, s * 0.2))
        p.drawLine(QPointF(s * 0.5, s * 0.8), QPointF(s * 0.5, s * 0.92))
    elif name == "tuning":
        p.drawLine(QPointF(s * 0.16, s * 0.5), QPointF(s * 0.84, s * 0.5))
        for x, y in ((0.32, 0.36), (0.56, 0.64), (0.74, 0.42)):
            p.drawEllipse(QRectF(s * x - s * 0.07, s * y - s * 0.07, s * 0.14, s * 0.14))
    elif name == "save":
        path = QPainterPath()
        path.moveTo(s * 0.24, s * 0.2)
        path.lineTo(s * 0.7, s * 0.2)
        path.lineTo(s * 0.8, s * 0.32)
        path.lineTo(s * 0.8, s * 0.8)
        path.lineTo(s * 0.24, s * 0.8)
        path.closeSubpath()
        p.drawPath(path)
        p.drawRect(QRectF(s * 0.34, s * 0.2, s * 0.24, s * 0.16))
        p.drawRect(QRectF(s * 0.34, s * 0.54, s * 0.36, s * 0.26))
    elif name == "registers":
        for i in range(3):
            y = s * (0.3 + i * 0.2)
            p.drawRoundedRect(QRectF(s * 0.18, y - s * 0.06, s * 0.64, s * 0.12), 2, 2)
    elif name == "sequence":
        p.drawLine(QPointF(s * 0.22, s * 0.32), QPointF(s * 0.78, s * 0.32))
        p.drawLine(QPointF(s * 0.22, s * 0.5), QPointF(s * 0.6, s * 0.5))
        p.drawLine(QPointF(s * 0.22, s * 0.68), QPointF(s * 0.7, s * 0.68))
        p.drawEllipse(QRectF(s * 0.66, s * 0.6, s * 0.16, s * 0.16))
    elif name == "logs":
        p.drawRoundedRect(QRectF(s * 0.2, s * 0.22, s * 0.6, s * 0.56), 3, 3)
        for y in (0.36, 0.5, 0.64):
            p.drawLine(QPointF(s * 0.32, s * y), QPointF(s * 0.68, s * y))
    elif name == "refresh":
        p.drawArc(QRectF(s * 0.24, s * 0.24, s * 0.52, s * 0.52), 40 * 16, 280 * 16)
        p.drawLine(QPointF(s * 0.7, s * 0.24), QPointF(s * 0.76, s * 0.4))
        p.drawLine(QPointF(s * 0.7, s * 0.24), QPointF(s * 0.54, s * 0.28))
    elif name == "gear":
        p.drawEllipse(QRectF(s * 0.38, s * 0.38, s * 0.24, s * 0.24))
        for i in range(8):
            a = i * math.pi / 4
            p.drawLine(
                QPointF(s * 0.5 + math.cos(a) * s * 0.24, s * 0.5 + math.sin(a) * s * 0.24),
                QPointF(s * 0.5 + math.cos(a) * s * 0.34, s * 0.5 + math.sin(a) * s * 0.34),
            )
    elif name == "stop":
        p.drawRoundedRect(QRectF(s * 0.3, s * 0.3, s * 0.4, s * 0.4), 2, 2)
    elif name == "play":
        path = QPainterPath()
        path.moveTo(s * 0.34, s * 0.26)
        path.lineTo(s * 0.76, s * 0.5)
        path.lineTo(s * 0.34, s * 0.74)
        path.closeSubpath()
        p.drawPath(path)
    elif name == "alert":
        path = QPainterPath()
        path.moveTo(s * 0.5, s * 0.2)
        path.lineTo(s * 0.86, s * 0.8)
        path.lineTo(s * 0.14, s * 0.8)
        path.closeSubpath()
        p.drawPath(path)
        p.drawLine(QPointF(s * 0.5, s * 0.42), QPointF(s * 0.5, s * 0.6))
        p.drawPoint(QPointF(s * 0.5, s * 0.7))
    elif name == "check":
        p.drawLine(QPointF(s * 0.24, s * 0.52), QPointF(s * 0.44, s * 0.72))
        p.drawLine(QPointF(s * 0.44, s * 0.72), QPointF(s * 0.78, s * 0.3))
    elif name == "close":
        p.drawLine(QPointF(s * 0.3, s * 0.3), QPointF(s * 0.7, s * 0.7))
        p.drawLine(QPointF(s * 0.7, s * 0.3), QPointF(s * 0.3, s * 0.7))
    elif name == "download":
        p.drawLine(QPointF(s * 0.5, s * 0.2), QPointF(s * 0.5, s * 0.62))
        p.drawLine(QPointF(s * 0.32, s * 0.46), QPointF(s * 0.5, s * 0.64))
        p.drawLine(QPointF(s * 0.68, s * 0.46), QPointF(s * 0.5, s * 0.64))
        p.drawLine(QPointF(s * 0.24, s * 0.78), QPointF(s * 0.76, s * 0.78))
    elif name == "upload":
        p.drawLine(QPointF(s * 0.5, s * 0.7), QPointF(s * 0.5, s * 0.28))
        p.drawLine(QPointF(s * 0.32, s * 0.44), QPointF(s * 0.5, s * 0.26))
        p.drawLine(QPointF(s * 0.68, s * 0.44), QPointF(s * 0.5, s * 0.26))
        p.drawLine(QPointF(s * 0.24, s * 0.8), QPointF(s * 0.76, s * 0.8))
    else:
        p.drawEllipse(QRectF(s * 0.3, s * 0.3, s * 0.4, s * 0.4))


def icon(name: str, color: QColor | str, size: int = 16) -> QIcon:
    c = QColor(color) if isinstance(color, str) else color
    dpr = 2
    pm = QPixmap(size * dpr, size * dpr)
    pm.fill(Qt.GlobalColor.transparent)
    pm.setDevicePixelRatio(dpr)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.scale(size / 24.0, size / 24.0)
    draw_icon(p, name, c, 24.0)
    p.end()
    return QIcon(pm)


def pixmap(name: str, color: QColor | str, size: int = 16) -> QPixmap:
    return icon(name, color, size).pixmap(size, size)
