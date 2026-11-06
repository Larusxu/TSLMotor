"""Reusable UI primitives that mirror the React component set in ``ui.tsx``."""

from __future__ import annotations

import math
from typing import Any, Callable, Iterable

from PyQt6.QtCore import QEasingCurve, QPointF, QPropertyAnimation, QRectF, QSize, Qt, QVariantAnimation, pyqtSignal
from PyQt6.QtGui import (
    QColor,
    QFont,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
)
from PyQt6.QtWidgets import (
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from .. import icons
from ..theme import Theme, mono_font, ui_font


def vbox(widget: QWidget, margin: int = 0, spacing: int = 0) -> QVBoxLayout:
    layout = QVBoxLayout(widget)
    layout.setContentsMargins(margin, margin, margin, margin)
    layout.setSpacing(spacing)
    return layout


def hbox(widget: QWidget | None = None, margin: int = 0, spacing: int = 0) -> QHBoxLayout:
    layout = QHBoxLayout(widget) if widget is not None else QHBoxLayout()
    layout.setContentsMargins(margin, margin, margin, margin)
    layout.setSpacing(spacing)
    return layout


def label(text: str, role: str = "", theme: Theme | None = None, wrap: bool = False) -> QLabel:
    lab = QLabel(text)
    if role:
        lab.setObjectName(role)
    lab.setWordWrap(wrap)
    if theme is not None and role in ("muted", "tiny"):
        lab.setStyleSheet(f"color:{theme.text_3};")
    return lab


def divider(theme: Theme, vertical: bool = False) -> QFrame:
    frame = QFrame()
    frame.setObjectName("vdivider" if vertical else "divider")
    if vertical:
        frame.setFixedWidth(1)
    else:
        frame.setFixedHeight(1)
    return frame


def spacer(width: int = 0, height: int = 0) -> QWidget:
    w = QWidget()
    if width:
        w.setFixedWidth(width)
    if height:
        w.setFixedHeight(height)
    w.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    return w


class Card(QFrame):
    """Panel with an optional title row and a content column."""

    def __init__(
        self,
        title: str = "",
        sub: str = "",
        right: QWidget | None = None,
        pad: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("card")
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self._outer = QVBoxLayout(self)
        self._outer.setContentsMargins(16 if pad else 0, 14 if pad else 0, 16 if pad else 0, 16 if pad else 0)
        self._outer.setSpacing(10)
        if title or right:
            head = QWidget()
            row = QHBoxLayout(head)
            row.setContentsMargins(0, 0, 0, 0)
            row.setSpacing(10)
            text_col = QVBoxLayout()
            text_col.setContentsMargins(0, 0, 0, 0)
            text_col.setSpacing(1)
            if title:
                self.title_label = QLabel(title)
                self.title_label.setObjectName("cardTitle")
                text_col.addWidget(self.title_label)
            if sub:
                self.sub_label = QLabel(sub)
                self.sub_label.setObjectName("cardSub")
                text_col.addWidget(self.sub_label)
            row.addLayout(text_col)
            row.addStretch(1)
            if right is not None:
                row.addWidget(right)
            self._outer.addWidget(head)
        self.body = QVBoxLayout()
        self.body.setContentsMargins(0, 0, 0, 0)
        self.body.setSpacing(10)
        self._outer.addLayout(self.body)

    def add(self, item: Any) -> None:
        if isinstance(item, QWidget):
            self.body.addWidget(item)
        else:
            self.body.addLayout(item)

    def add_layout(self, layout) -> None:
        self.body.addLayout(layout)

    def add_stretch(self) -> None:
        self.body.addStretch(1)


class Badge(QFrame):
    def __init__(self, text: str, tone: str = "neutral", dot: str | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("badge")
        self.tone = tone
        self._row = QHBoxLayout(self)
        self._row.setContentsMargins(8, 2, 8, 2)
        self._row.setSpacing(5)
        self.dot = None
        if dot:
            self.dot = QLabel("●")
            self.dot.setObjectName("badgeDot")
            self.dot.setStyleSheet("font-size:8px;")
            self._row.addWidget(self.dot)
        self.text_label = QLabel(text)
        self.text_label.setObjectName("badgeText")
        self.text_label.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        self.text_label.setToolTip(text)
        self._row.addWidget(self.text_label)
        self.setFixedHeight(21)
        self.setMaximumWidth(300)
        self.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self.set_tone(tone)

    def set_tone(self, tone: str) -> None:
        self.tone = tone
        self.setProperty("tone", tone)
        self.style().unpolish(self)
        self.style().polish(self)
        if self.dot is not None:
            from ..theme import current

            color = {
                "neutral": current().text_3,
                "ok": current().ok,
                "warn": current().warn,
                "danger": current().danger,
                "accent": current().accent,
            }.get(tone, current().text_3)
            self.dot.setStyleSheet(f"font-size:8px;color:{color};")

    def set_text(self, text: str) -> None:
        self.text_label.setText(text)
        self.text_label.setToolTip(text)


class Button(QPushButton):
    def __init__(
        self,
        text: str = "",
        variant: str = "default",
        size: str = "md",
        icon_name: str | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(text, parent)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("variant", variant)
        self.setProperty("size", size)
        if size == "sm":
            self.setFixedHeight(26)
        else:
            self.setMinimumHeight(32)
        if icon_name:
            self.apply_icon(icon_name)

    def apply_icon(self, name: str, color: str = "#e8eef7") -> None:
        self.setIcon(icons.icon(name, color, 14))
        self.setIconSize(QSize(14, 14))


class IconButton(Button):
    def __init__(self, icon_name: str, tooltip: str = "", parent: QWidget | None = None) -> None:
        super().__init__("", "ghost", "sm", icon_name, parent)
        self.setFixedSize(26, 26)
        self.setToolTip(tooltip)


class Field(QWidget):
    def __init__(self, text: str, widget: QWidget | None = None, hint: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        col = QVBoxLayout(self)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(5)
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        head.setSpacing(6)
        lab = QLabel(text)
        lab.setObjectName("fieldLabel")
        lab.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        head.addWidget(lab)
        if hint:
            hint_label = QLabel(hint)
            hint_label.setStyleSheet("font-size:9.5px;color:#4c5768;")
            hint_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            hint_label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
            hint_label.setMinimumWidth(0)
            head.addWidget(hint_label, 1)
        col.addLayout(head)
        if widget is not None:
            col.addWidget(widget)

    def set_content(self, widget: QWidget) -> None:
        self.layout().addWidget(widget)


class NumField(QDoubleSpinBox):
    def __init__(
        self,
        value: float = 0,
        minimum: float = -1e9,
        maximum: float = 1e9,
        step: float = 1,
        decimals: int | None = None,
        unit: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        if decimals is None:
            decimals = 0 if float(step).is_integer() and float(value).is_integer() else 4 if step < 0.01 else 2
        self.setDecimals(decimals)
        self.setRange(minimum, maximum)
        self.setSingleStep(step)
        self.setValue(value)
        self.setButtonSymbols(QDoubleSpinBox.ButtonSymbols.NoButtons)
        self.setKeyboardTracking(False)
        self.setFont(mono_font(12))
        self.setMinimumHeight(32)
        self.setMinimumWidth(56)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setAlignment(Qt.AlignmentFlag.AlignLeft)
        if unit:
            self.setSuffix(" " + unit)


class SelectField(QComboBox):
    def __init__(
        self,
        options: Iterable[tuple[Any, str]] = (),
        value: Any = None,
        width: int | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setMinimumHeight(32)
        self.setMinimumWidth(56)
        self.setFont(ui_font(12))
        self.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
        self.setMinimumContentsLength(5)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.set_options(options, value)
        if width:
            self.setFixedWidth(width)

    def set_options(self, options: Iterable[tuple[Any, str]], value: Any = None) -> None:
        self.blockSignals(True)
        self.clear()
        for opt_value, opt_label in options:
            self.addItem(opt_label, opt_value)
        if value is not None:
            index = self.findData(value)
            if index >= 0:
                self.setCurrentIndex(index)
        self.blockSignals(False)

    def value(self) -> Any:
        return self.currentData()


class TextField(QLineEdit):
    def __init__(self, text: str = "", placeholder: str = "", mono: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self.setPlaceholderText(placeholder)
        self.setMinimumHeight(32)
        self.setMinimumWidth(56)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        if mono:
            self.setFont(mono_font(12))


class Toggle(QWidget):
    toggled = pyqtSignal(bool)

    def __init__(self, checked: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedSize(36, 19)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._checked = checked
        self._pos = 17.0 if checked else 0.0
        self._anim = QVariantAnimation(self)
        self._anim.setDuration(160)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self._anim.valueChanged.connect(self._on_anim)

    def _on_anim(self, value: Any) -> None:
        self._pos = float(value)
        self.update()

    def isChecked(self) -> bool:
        return self._checked

    def setChecked(self, checked: bool) -> None:
        if checked == self._checked:
            return
        self._checked = checked
        self._anim.stop()
        self._anim.setStartValue(self._pos)
        self._anim.setEndValue(17.0 if checked else 0.0)
        self._anim.start()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self.isEnabled():
            self.setChecked(not self._checked)
            self.toggled.emit(self._checked)
        super().mouseReleaseEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        from ..theme import alpha, current

        t = current()
        on = self._checked
        track = QColor(alpha(t.accent, 31)) if on else QColor(alpha(t.text, 15))
        border = QColor(alpha(t.accent, 87)) if on else QColor(t.line_strong)
        p.setPen(QPen(border, 1))
        p.setBrush(track)
        p.drawRoundedRect(QRectF(0.5, 0.5, 35, 18), 9, 9)
        knob = QColor(t.accent) if on else QColor(t.text_3)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(knob)
        p.drawEllipse(QRectF(3 + self._pos, 3, 13, 13))
        p.end()


class Segmented(QFrame):
    changed = pyqtSignal(str)

    def __init__(self, options: list[tuple[str, str]], value: str | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("segmented")
        self.setStyleSheet(
            "QFrame#segmented{background:#0a0d12;border:1px solid #232a36;border-radius:10px;}"
        )
        row = QHBoxLayout(self)
        row.setContentsMargins(3, 3, 3, 3)
        row.setSpacing(2)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons: dict[str, QPushButton] = {}
        for key, text in options:
            btn = QPushButton(text)
            btn.setCheckable(True)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setStyleSheet(
                "QPushButton{background:transparent;border:none;border-radius:7px;padding:5px 11px;"
                "font-size:11.5px;color:#6d7b8e;font-weight:550;}"
                "QPushButton:hover{color:#a3b0c2;}"
                "QPushButton:checked{background:qlineargradient(x1:0,y1:0,x2:0,y2:1,stop:0 #212a36,stop:1 #1a212b);"
                "color:#e8eef7;}"
            )
            btn.clicked.connect(lambda _=False, k=key: self._select(k))
            self.group.addButton(btn)
            row.addWidget(btn)
            self.buttons[key] = btn
        if value and value in self.buttons:
            self.buttons[value].setChecked(True)

    def _select(self, key: str) -> None:
        self.changed.emit(key)

    def set_value(self, key: str) -> None:
        if key in self.buttons:
            self.buttons[key].setChecked(True)


class Notice(QFrame):
    def __init__(self, text: str, tone: str = "accent", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("noticeWarn" if tone == "warn" else "noticeDanger" if tone == "danger" else "notice")
        row = QHBoxLayout(self)
        row.setContentsMargins(12, 10, 12, 10)
        row.setSpacing(9)
        mark = QLabel("!")
        mark.setFixedSize(16, 16)
        mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        color = "#f5b544" if tone == "warn" else "#ff5f6d" if tone == "danger" else "#2ee6e6"
        mark.setStyleSheet(f"background:#22{color[1:]};color:{color};border-radius:8px;font-size:10px;font-weight:700;")
        row.addWidget(mark, 0, Qt.AlignmentFlag.AlignTop)
        self.label = QLabel(text)
        self.label.setObjectName("noticeText")
        self.label.setWordWrap(True)
        row.addWidget(self.label, 1)

    def setText(self, text: str) -> None:  # noqa: N802 - Qt naming
        self.label.setText(text)


class KV(QWidget):
    def __init__(self, rows: Iterable[tuple[str, Any]], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(8)
        self._grid = grid
        self.set_rows(rows)

    def set_rows(self, rows: Iterable[tuple[str, Any]]) -> None:
        while self._grid.count():
            item = self._grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for i, (key, value) in enumerate(rows):
            k = QLabel(key)
            k.setObjectName("kvKey")
            self._grid.addWidget(k, i, 0)
            if isinstance(value, QWidget):
                self._grid.addWidget(value, i, 1, alignment=Qt.AlignmentFlag.AlignRight)
            else:
                v = QLabel(str(value))
                v.setObjectName("kvValue")
                v.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
                self._grid.addWidget(v, i, 1)
        self._grid.setColumnStretch(1, 1)


class StatusDot(QWidget):
    def __init__(self, color: str = "#6d7b8e", size: int = 8, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._color = QColor(color)
        self.setFixedSize(size + 4, size + 4)

    def set_color(self, color: str) -> None:
        self._color = QColor(color)
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        glow = QColor(self._color)
        glow.setAlpha(42)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(glow)
        p.drawEllipse(QRectF(0, 0, self.width(), self.height()))
        p.setBrush(self._color)
        p.drawEllipse(QRectF(2, 2, self.width() - 4, self.height() - 4))
        p.end()


class Sparkline(QWidget):
    def __init__(self, color: str = "#2ee6e6", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.values: list[float] = []
        self.color = QColor(color)
        self.setMinimumHeight(30)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

    def set_values(self, values: list[float]) -> None:
        self.values = list(values)[-60:]
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        if len(self.values) < 2:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        w, h = self.width(), self.height()
        lo, hi = min(self.values), max(self.values)
        span = hi - lo if hi - lo > 1e-9 else 1.0
        path = QPainterPath()
        for i, v in enumerate(self.values):
            x = w * i / (len(self.values) - 1)
            y = h - 3 - (v - lo) / span * (h - 6)
            if i == 0:
                path.moveTo(x, y)
            else:
                path.lineTo(x, y)
        area = QPainterPath(path)
        area.lineTo(w, h)
        area.lineTo(0, h)
        area.closeSubpath()
        grad = QLinearGradient(0, 0, 0, h)
        top = QColor(self.color)
        top.setAlpha(64)
        bottom = QColor(self.color)
        bottom.setAlpha(0)
        grad.setColorAt(0, top)
        grad.setColorAt(1, bottom)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(grad)
        p.drawPath(area)
        p.setPen(QPen(self.color, 1.4))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(path)
        p.end()


class StatTile(QFrame):
    def __init__(
        self,
        text: str,
        value: str = "—",
        unit: str = "",
        delta: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("stat")
        self.setMinimumHeight(92)
        col = QVBoxLayout(self)
        col.setContentsMargins(16, 14, 16, 12)
        col.setSpacing(2)
        self.label = QLabel(text)
        self.label.setObjectName("statLabel")
        col.addWidget(self.label)
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(6)
        self.value = QLabel(value)
        self.value.setObjectName("statValue")
        row.addWidget(self.value)
        self.unit = QLabel(unit)
        self.unit.setObjectName("statUnit")
        self.unit.setAlignment(Qt.AlignmentFlag.AlignBottom)
        row.addWidget(self.unit, 0, Qt.AlignmentFlag.AlignBottom)
        row.addStretch(1)
        col.addLayout(row)
        self.delta = QLabel(delta)
        self.delta.setObjectName("statDelta")
        col.addWidget(self.delta)
        self.spark: Sparkline | None = None
        self._spark_host = QWidget(self)
        self._spark_host.setGeometry(0, 0, 0, 0)

    def set_value(self, value: str, delta: str | None = None, tone: str | None = None) -> None:
        self.value.setText(value)
        if delta is not None:
            self.delta.setText(delta)
        self.value.setStyleSheet(f"color:{tone};" if tone else "")

    def enable_spark(self, color: str = "#2ee6e6") -> None:
        self.spark = Sparkline(color, self)
        self.spark.setGeometry(0, 0, 0, 0)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        if self.spark is not None:
            self.spark.setGeometry(int(self.width() * 0.48), self.height() - 34, int(self.width() * 0.48), 30)


class StepList(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.col = QVBoxLayout(self)
        self.col.setContentsMargins(0, 0, 0, 0)
        self.col.setSpacing(1)
        self.col.addStretch(1)
        self._rows: dict[int, QWidget] = {}

    def clear(self) -> None:
        while self.col.count() > 1:
            item = self.col.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self._rows.clear()

    def set_steps(self, steps: list[Any]) -> None:
        self.clear()
        if not steps:
            empty = QLabel("尚未开始 · 步骤会在这里实时出现")
            empty.setObjectName("stepEmpty")
            self.col.insertWidget(0, empty)
            return
        for step in steps[-60:]:
            self._rows[step.idx] = self._row(step)
            self.col.insertWidget(self.col.count() - 1, self._rows[step.idx])

    def _row(self, step) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(2, 3, 2, 3)
        layout.setSpacing(8)
        from ..theme import current

        t = current()
        index = QLabel(f"{step.idx:02d}")
        index.setObjectName("stepIndex")
        index.setFixedWidth(18)
        layout.addWidget(index)
        dot = QLabel("●")
        color = {
            "run": t.blue,
            "ok": t.ok,
            "fail": t.danger,
            "info": t.warn,
        }.get(step.status, t.text_4)
        dot.setStyleSheet(f"color:{color};font-size:9px;")
        layout.addWidget(dot)
        text = QLabel(step.label)
        text.setObjectName("stepLabel")
        text.setProperty("finished", "true" if step.status != "run" else "false")
        layout.addWidget(text)
        layout.addStretch(1)
        if step.detail:
            detail = QLabel(step.detail)
            detail.setObjectName("stepDetail")
            detail.setMaximumWidth(320)
            detail.setMinimumWidth(0)
            detail.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
            detail.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            layout.addWidget(detail, 1)
        return row


class Toast(QFrame):
    dismissed = pyqtSignal(int)

    def __init__(self, key: int, tone: str, text: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.key = key
        self.setObjectName("toast")
        row = QHBoxLayout(self)
        row.setContentsMargins(12, 10, 12, 10)
        row.setSpacing(10)
        from ..theme import current

        t = current()
        bar = QFrame()
        bar.setFixedWidth(3)
        color = t.ok if tone == "ok" else t.warn if tone == "warn" else t.danger
        bar.setStyleSheet(f"background:{color};border-radius:2px;")
        row.addWidget(bar)
        lab = QLabel(text)
        lab.setObjectName("toastText")
        lab.setWordWrap(True)
        row.addWidget(lab, 1)
        close = QPushButton("✕")
        close.setFixedSize(18, 18)
        close.setCursor(Qt.CursorShape.PointingHandCursor)
        close.setStyleSheet(f"background:transparent;border:none;color:{t.text_3};font-size:11px;")
        close.clicked.connect(lambda: self.dismissed.emit(self.key))
        row.addWidget(close)
        self.setMaximumWidth(420)


class ToastHost(QWidget):
    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, False)
        self.col = QVBoxLayout(self)
        self.col.setContentsMargins(0, 0, 0, 0)
        self.col.setSpacing(8)
        self.col.addStretch(1)
        self.toasts: list[Toast] = []

    def push(self, key: int, tone: str, text: str) -> None:
        toast = Toast(key, tone, text, self)
        toast.dismissed.connect(self.remove)
        self.toasts.append(toast)
        self.col.addWidget(toast)
        while len(self.toasts) > 4:
            self.remove(self.toasts[0].key)
        from PyQt6.QtCore import QTimer

        QTimer.singleShot(4600, lambda: self.remove(key))

    def remove(self, key: int) -> None:
        for toast in list(self.toasts):
            if toast.key == key:
                self.toasts.remove(toast)
                toast.setParent(None)
                toast.deleteLater()
                break
