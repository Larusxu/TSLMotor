"""运行日志 — full link/job history with level, search and export."""

from __future__ import annotations

import time
from datetime import datetime

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QFont, QTextCursor
from PyQt6.QtWidgets import QFileDialog, QHBoxLayout, QLabel, QTextEdit, QVBoxLayout, QWidget

from ..theme import mono_font
from ..widgets.primitives import Badge, Button, Card, Segmented, TextField
from .base import BasePage

LEVEL_LABEL = {"info": "INFO", "ok": "OK", "warn": "WARN", "error": "ERROR"}
LEVEL_COLOR = {"info": "#6ea8fe", "ok": "#3ddc84", "warn": "#f5b544", "error": "#ff5f6d"}


class LogsPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.follow = True
        self.level = "all"
        self._build()
        self.store.logsChanged.connect(self._schedule)
        self._pending = False
        self.repaint_timer = QTimer(self)
        self.repaint_timer.setInterval(120)
        self.repaint_timer.timeout.connect(self._flush)
        self.repaint_timer.start()

    def _build(self) -> None:
        self.follow_btn = Button("跟随中", "ghost", "sm")
        self.follow_btn.clicked.connect(self._toggle_follow)
        self.level_seg = Segmented(
            [("all", "全部"), ("info", "info"), ("ok", "ok"), ("warn", "warn"), ("error", "error")], "all"
        )
        self.level_seg.changed.connect(self._set_level)
        self.search = TextField("", "关键字检索…")
        self.search.setFixedWidth(220)
        self.search.textChanged.connect(lambda _: self._render())
        copy = Button("复制", "ghost", "sm")
        copy.clicked.connect(self._copy)
        clear = Button("清空", "ghost", "sm")
        clear.clicked.connect(self.store.clear_logs)
        right = QWidget()
        h = QHBoxLayout(right)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(8)
        h.addWidget(self.follow_btn)
        h.addWidget(self.level_seg)
        h.addWidget(self.search)
        h.addWidget(copy)
        h.addWidget(clear)
        self.card = Card("运行日志", "LINK · JOBS · SAFETY", right)
        self.view = QTextEdit()
        self.view.setReadOnly(True)
        self.view.setFont(mono_font(11))
        self.view.setMinimumHeight(560)
        self.view.setStyleSheet(
            f"QTextEdit{{background:{self.theme.inset};border:1px solid {self.theme.line};border-radius:10px;padding:8px;}}"
        )
        self.card.add(self.view)
        self.count = QLabel("0 条日志")
        self.count.setObjectName("tiny")
        self.card.add(self.count)
        self.add(self.card)

    def _set_level(self, level: str) -> None:
        self.level = level
        self._render()

    def _toggle_follow(self) -> None:
        self.follow = not self.follow
        self.follow_btn.setText("跟随中" if self.follow else "已暂停")
        if self.follow:
            self._scroll_bottom()

    def _schedule(self) -> None:
        self._pending = True

    def _flush(self) -> None:
        if self._pending:
            self._pending = False
            self._render()

    def _filtered(self):
        rows = self.store.logs
        if self.level != "all":
            rows = [r for r in rows if r.level == self.level]
        query = self.search.text().strip().lower()
        if query:
            rows = [r for r in rows if query in r.message.lower() or query in r.source.lower()]
        return rows

    def _render(self) -> None:
        rows = self._filtered()
        chunks = []
        for line in rows[-1200:]:
            stamp = time.strftime("%H:%M:%S", time.localtime(line.ts / 1000))
            color = LEVEL_COLOR.get(line.level, self.theme.text_2)
            message = (
                line.message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            )
            chunks.append(
                f"<div style='white-space:pre-wrap;padding:2px 0;'>"
                f"<span style='color:{self.theme.text_4};font-family:Consolas;'>{stamp}</span> "
                f"<span style='color:{color};font-weight:600;'>{LEVEL_LABEL.get(line.level, line.level)}</span> "
                f"<span style='color:{self.theme.text_3};'>{line.source}</span> "
                f"<span style='color:{self.theme.text_2};'>{message}</span></div>"
            )
        html = (
            f"<div style='font-family:Consolas,Cascadia Code;font-size:11px;line-height:1.65;'>"
            + ("".join(chunks) or f"<div style='color:{self.theme.text_3};padding:8px;'>暂无日志</div>")
            + "</div>"
        )
        self.view.setHtml(html)
        self.count.setText(f"{len(rows)} 条日志（最多保留 2500 条）")
        if self.follow:
            self._scroll_bottom()

    def _scroll_bottom(self) -> None:
        sb = self.view.verticalScrollBar()
        sb.setValue(sb.maximum())

    def _copy(self) -> None:
        text = "\n".join(
            f"{time.strftime('%H:%M:%S', time.localtime(r.ts / 1000))} "
            f"{LEVEL_LABEL.get(r.level, r.level)} {r.source} {r.message}"
            for r in self._filtered()
        )
        from PyQt6.QtWidgets import QApplication

        QApplication.clipboard().setText(text)
        self.store.toast("ok", "日志已复制到剪贴板")

    def refresh(self) -> None:
        self._render()

    def on_show(self) -> None:
        self.follow = True
        self.follow_btn.setText("跟随中")
        self._render()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.view.setStyleSheet(
            f"QTextEdit{{background:{theme.inset};border:1px solid {theme.line};border-radius:10px;padding:8px;}}"
        )
        self._render()
