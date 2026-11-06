"""Shared page scaffolding."""

from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import QGridLayout, QHBoxLayout, QVBoxLayout, QWidget

from ..core.store import AppStore
from ..theme import Theme


class BasePage(QWidget):
    def __init__(self, store: AppStore, theme: Theme, shell=None) -> None:
        super().__init__()
        self.store = store
        self.theme = theme
        self.shell = shell
        self.col = QVBoxLayout(self)
        self.col.setContentsMargins(0, 0, 0, 0)
        self.col.setSpacing(14)
        self._timers: list[QTimer] = []
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh)
        self._timer.start(600)

    def add(self, widget: QWidget) -> None:
        self.col.addWidget(widget)

    def add_layout(self, layout) -> None:
        self.col.addLayout(layout)

    def refresh(self) -> None:
        pass

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        self._relax_children()

    def _relax_children(self) -> None:
        """Tables and lists advertise large minimum hints; let layouts shrink them."""
        from PyQt6.QtWidgets import QAbstractItemView, QTableWidget, QSizePolicy

        for view in self.findChildren(QAbstractItemView):
            view.setMinimumWidth(0)
            view.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Expanding)
        for table in self.findChildren(QTableWidget):
            if table.editTriggers() == QTableWidget.EditTrigger.NoEditTriggers:
                table.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
                table.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            table.setShowGrid(False)
            table.verticalHeader().setDefaultSectionSize(28)

    def on_show(self) -> None:
        self._relax_children()
        self.refresh()

    def apply_theme(self, theme: Theme) -> None:
        self.theme = theme

    def rows(self, columns: int = 2, stretch: tuple[int, ...] | None = None) -> QGridLayout:
        grid = QGridLayout()
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)
        for i in range(columns):
            grid.setColumnStretch(i, stretch[i] if stretch else 1)
        return grid


def stack(*widgets: QWidget, spacing: int = 14) -> QWidget:
    host = QWidget()
    col = QVBoxLayout(host)
    col.setContentsMargins(0, 0, 0, 0)
    col.setSpacing(spacing)
    for w in widgets:
        col.addWidget(w)
    col.addStretch(1)
    return host


def row(*widgets: QWidget, spacing: int = 8, stretch_last: bool = False) -> QWidget:
    host = QWidget()
    h = QHBoxLayout(host)
    h.setContentsMargins(0, 0, 0, 0)
    h.setSpacing(spacing)
    for w in widgets:
        h.addWidget(w)
    if stretch_last:
        h.addStretch(1)
    return host
