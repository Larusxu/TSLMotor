"""寄存器 — 189-register explorer with bit editing and snapshots."""

from __future__ import annotations

import time

from PyQt6.QtCore import QSize, Qt
from PyQt6.QtGui import QColor, QFont
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..core.registers import (
    FAVORITES,
    GROUP_LABELS,
    REG_META,
    REGISTERS,
    reg_by_addr,
    reg_label,
    reg_name,
)
from ..theme import mono_font
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    KV,
    Notice,
    SelectField,
    TextField,
    divider,
)
from .base import BasePage, row


class RegistersPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.selected: int | None = None
        self.current: int | None = None
        self.snapshot: dict[int, int] = {}
        self._bits: list[QLabel] = []
        self._build()
        self.refresh_list()

    # ------------------------------------------------------------------ UI
    def _build(self) -> None:
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        self.search = TextField("", "地址 / 名称 / 标签…")
        self.search.textChanged.connect(lambda _: self.refresh_list())
        self.group = SelectField(
            [("", "全部分组")] + [(g, f"{label}") for g, label in GROUP_LABELS.items()], ""
        )
        self.group.currentIndexChanged.connect(lambda: self.refresh_list())
        list_card = Card("寄存器列表", "TMC6460 / 189", Badge("只读标记来自手册", "neutral"))
        filters = QWidget()
        fh = QHBoxLayout(filters)
        fh.setContentsMargins(0, 0, 0, 0)
        fh.setSpacing(8)
        fh.addWidget(self.search, 1)
        fh.addWidget(self.group)
        list_card.add(filters)
        self.list = QListWidget()
        self.list.setMinimumWidth(360)
        self.list.setWordWrap(True)
        self.list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.list.setStyleSheet(
            f"QListWidget{{background:{self.theme.inset};border:1px solid {self.theme.line};border-radius:10px;padding:4px;}}"
            f"QListWidget::item{{padding:6px 8px;border-radius:6px;color:{self.theme.text_2};font-family:'Cascadia Code',Consolas;font-size:11px;}}"
            f"QListWidget::item:selected{{background:{self.theme.accent_soft};color:{self.theme.text};}}"
            f"QListWidget::item:hover{{background:{self.theme.fill_1};}}"
        )
        self.list.setMinimumHeight(560)
        self.list.currentItemChanged.connect(self._select_item)
        list_card.add(self.list)
        grid.addWidget(list_card, 0, 0)

        right = QWidget()
        rc = QVBoxLayout(right)
        rc.setContentsMargins(0, 0, 0, 0)
        rc.setSpacing(14)
        self.detail_title = QLabel("选择一个寄存器")
        self.detail_title.setObjectName("cardTitle")
        self.detail_meta = Badge("—", "neutral")
        self.detail = Card("寄存器详情", "REGISTER", self.detail_meta)
        self.detail.add(self.detail_title)
        self.desc = QLabel("")
        self.desc.setWordWrap(True)
        self.desc.setObjectName("tiny")
        self.detail.add(self.desc)
        self.kv = KV([
            ("当前值（读回）", "—"),
            ("待写入", "—"),
            ("十进制", "—"),
        ])
        self.detail.add(self.kv)
        self.hex_field = TextField("0x00000000", "十六进制")
        self.hex_field.textChanged.connect(self._hex_changed)
        self.hex_field.setFont(mono_font(12))
        self.dec_field = TextField("0", "有符号 / 无符号")
        self.dec_field.textChanged.connect(self._dec_changed)
        self.dec_field.setFont(mono_font(12))
        fields = QWidget()
        fg = QHBoxLayout(fields)
        fg.setContentsMargins(0, 0, 0, 0)
        fg.setSpacing(8)
        fg.addWidget(Field("待写入", self.hex_field, "十六进制"))
        fg.addWidget(Field("十进制", self.dec_field, "有符号 / 无符号"))
        self.detail.add(fields)
        self.bit_host = QWidget()
        self.bit_grid = QGridLayout(self.bit_host)
        self.bit_grid.setContentsMargins(0, 0, 0, 0)
        self.bit_grid.setHorizontalSpacing(3)
        self.bit_grid.setVerticalSpacing(3)
        self.bit_buttons: list[Button] = []
        for bit in range(31, -1, -1):
            btn = Button("", "ghost", "sm")
            btn.setCheckable(True)
            btn.setFixedSize(34, 24)
            btn.setFont(mono_font(9))
            btn.setToolTip(f"bit {bit}")
            btn.clicked.connect(lambda checked, b=bit: self._toggle_bit(b, checked))
            self.bit_buttons.append(btn)
            self.bit_grid.addWidget(btn, (31 - bit) // 16, (31 - bit) % 16)
        self.detail.add(Field("二进制", self.bit_host, "点击位翻转"))
        self.bit_desc = QWidget()
        self.bit_desc_grid = QGridLayout(self.bit_desc)
        self.bit_desc_grid.setContentsMargins(0, 0, 0, 0)
        self.bit_desc_grid.setHorizontalSpacing(10)
        self.bit_desc_grid.setVerticalSpacing(4)
        self.detail.add(divider(self.theme))
        self.detail.add(self.bit_desc)

        actions = QWidget()
        ah = QHBoxLayout(actions)
        ah.setContentsMargins(0, 0, 0, 0)
        ah.setSpacing(8)
        read = Button("读取", "ghost", "sm")
        read.clicked.connect(self._read_selected)
        write = Button("写入并校验", "primary", "sm")
        write.clicked.connect(self._write_selected)
        ah.addWidget(read)
        ah.addWidget(write)
        ah.addStretch(1)
        self.detail.add(actions)
        rc.addWidget(self.detail)

        batch = Card("批量操作", "SNAPSHOT")
        bfull = Button("读取快照（常用 36 个）", "ghost", "sm")
        bfull.clicked.connect(self._read_snapshot)
        bsave = Button("保存快照到文件", "ghost", "sm")
        bsave.clicked.connect(self._save_snapshot)
        bcompare = Button("与快照对比", "ghost", "sm")
        bcompare.clicked.connect(self._compare_snapshot)
        brow = QWidget()
        bh = QHBoxLayout(brow)
        bh.setContentsMargins(0, 0, 0, 0)
        bh.setSpacing(8)
        bh.addWidget(bfull)
        bh.addWidget(bsave)
        bh.addWidget(bcompare)
        bh.addStretch(1)
        batch.add(brow)
        self.snapshot_note = QLabel("尚未建立快照")
        self.snapshot_note.setObjectName("tiny")
        batch.add(self.snapshot_note)
        rc.addWidget(batch)
        rc.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(right)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        grid.addWidget(scroll, 0, 1)
        grid.setColumnStretch(0, 0)
        grid.setColumnStretch(1, 1)
        grid.setColumnMinimumWidth(0, 400)
        self.add(host)

    # -------------------------------------------------------------- listing
    def refresh_list(self) -> None:
        query = self.search.text().strip().lower()
        group = self.group.value() or ""
        self.list.blockSignals(True)
        self.list.clear()
        items = sorted(REGISTERS, key=lambda r: (r.addr not in FAVORITES, r.addr))
        for reg in items:
            if group and reg.group != group:
                continue
            text = f"0x{reg.addr:03X}   {reg.name}\n{reg_label(reg.addr)}"
            if query and query not in text.lower() and query not in f"{reg.addr:x}":
                continue
            item = QListWidgetItem(text)
            item.setSizeHint(QSize(0, 40))
            item.setToolTip(f"{reg.name} · {reg_label(reg.addr)}")
            item.setData(Qt.ItemDataRole.UserRole, reg.addr)
            if reg.addr in FAVORITES:
                font = item.font()
                font.setBold(True)
                item.setFont(font)
            self.list.addItem(item)
        self.list.blockSignals(False)
        if self.selected is not None:
            for i in range(self.list.count()):
                if self.list.item(i).data(Qt.ItemDataRole.UserRole) == self.selected:
                    self.list.setCurrentRow(i)
                    break

    def _select_item(self, current: QListWidgetItem | None, previous=None) -> None:
        if current is None:
            return
        addr = int(current.data(Qt.ItemDataRole.UserRole))
        self.selected = addr
        self._render_detail()
        self._read_selected()

    def _render_detail(self) -> None:
        if self.selected is None:
            return
        addr = self.selected
        meta = REG_META.get(addr)
        self.detail_title.setText(f"0x{addr:03X} · {reg_name(addr)}")
        self.detail_meta.set_text("只读" if meta and meta.ro else "可写")
        self.detail_meta.set_tone("neutral" if meta and meta.ro else "accent")
        self.desc.setText(meta.desc if meta and meta.desc else (meta.label if meta else "手册未提供中文说明"))
        bits = meta.bits if meta else []
        while self.bit_desc_grid.count():
            item = self.bit_desc_grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        if not bits:
            empty = QLabel("该寄存器没有手写的位域说明。")
            empty.setObjectName("tiny")
            self.bit_desc_grid.addWidget(empty, 0, 0)
        for i, (lo, hi, name) in enumerate(bits):
            bit_label = QLabel(f"[{hi}:{lo}]" if hi != lo else f"bit {lo}")
            bit_label.setFont(mono_font(10))
            bit_label.setStyleSheet(f"color:{self.theme.text_4};")
            name_label = QLabel(name)
            name_label.setStyleSheet(f"color:{self.theme.text_2};font-size:11px;")
            self.bit_desc_grid.addWidget(bit_label, i, 0)
            self.bit_desc_grid.addWidget(name_label, i, 1)
        for i, btn in enumerate(self.bit_buttons):
            bit = 31 - i
            btn.setText(str(bit))
        self._apply_value(self.current if self.current is not None else 0)

    def _apply_value(self, value: int) -> None:
        self.hex_field.blockSignals(True)
        self.dec_field.blockSignals(True)
        self.hex_field.setText(f"0x{value & 0xFFFFFFFF:08X}")
        self.dec_field.setText(str(value if value < 0x80000000 else value - 0x100000000))
        self.hex_field.blockSignals(False)
        self.dec_field.blockSignals(False)
        for i, btn in enumerate(self.bit_buttons):
            bit = 31 - i
            on = bool((value >> bit) & 1)
            btn.blockSignals(True)
            btn.setChecked(on)
            btn.blockSignals(False)
            if on:
                btn.setStyleSheet(
                    f"QPushButton{{background:{self.theme.accent_soft};border:1px solid {self.theme.accent_line};"
                    f"color:{self.theme.accent};border-radius:4px;font-size:9px;}}"
                )
            else:
                btn.setStyleSheet(
                    f"QPushButton{{background:{self.theme.inset};border:1px solid {self.theme.line};"
                    f"color:{self.theme.text_4};border-radius:4px;font-size:9px;}}"
                )
        self.kv.set_rows([
            ("当前值（读回）", "—" if self.current is None else f"0x{self.current:08X}"),
            ("待写入", f"0x{self._edited_value():08X}"),
            ("十进制", str(self._edited_value())),
        ])

    def _edited_value(self) -> int:
        text = self.hex_field.text().strip()
        try:
            return int(text, 16) & 0xFFFFFFFF if text.lower().startswith("0x") else int(text, 16) & 0xFFFFFFFF
        except ValueError:
            return self.current or 0

    def _hex_changed(self, text: str) -> None:
        try:
            value = int(text, 16) & 0xFFFFFFFF
        except ValueError:
            return
        self._apply_value(value)

    def _dec_changed(self, text: str) -> None:
        try:
            value = int(text, 10) & 0xFFFFFFFF
        except ValueError:
            return
        self._apply_value(value)

    def _toggle_bit(self, bit: int, checked: bool) -> None:
        value = self._edited_value()
        value = (value | (1 << bit)) if checked else (value & ~(1 << bit))
        self._apply_value(value & 0xFFFFFFFF)

    # -------------------------------------------------------------- actions
    def _read_selected(self) -> None:
        if self.selected is None or not self.store.connected:
            return
        addr = self.selected

        def done(value: int) -> None:
            if self.selected != addr:
                return
            self.current = value
            self._apply_value(value)

        self.store.read_reg(addr, done)

    def _write_selected(self) -> None:
        if self.selected is None:
            return
        value = self._edited_value()
        addr = self.selected

        def done(ok: bool) -> None:
            if ok:
                self.store.toast("ok", f"0x{addr:03X} 已写入并校验")
                self._read_selected()
            else:
                self.store.toast("error", f"0x{addr:03X} 写入校验失败")

        self.store.write_reg(addr, value, True, done)

    def _read_snapshot(self) -> None:
        if not self.store.connected:
            return
        self.snapshot_note.setText("正在读取…")
        addrs = FAVORITES

        def done(values: dict) -> None:
            self.snapshot.update(values)
            self.snapshot_note.setText(f"{time.strftime('%H:%M:%S')} 已读取 {len(values)} 个寄存器")

        self.store.read_many(addrs, done)

    def _save_snapshot(self) -> None:
        if not self.snapshot:
            self.store.toast("warn", "请先读取快照")
            return
        path, _ = QFileDialog.getSaveFileName(self, "保存寄存器快照", "registers.snapshot.txt", "Text (*.txt)")
        if not path:
            return
        with open(path, "w", encoding="utf-8") as fh:
            for addr in sorted(self.snapshot):
                fh.write(f"0x{addr:03X}\t0x{self.snapshot[addr]:08X}\t{reg_name(addr)}\n")
        self.store.toast("ok", f"快照已保存到 {path}")

    def _compare_snapshot(self) -> None:
        if not self.snapshot or not self.store.connected:
            self.store.toast("warn", "请先建立快照并连接")
            return

        def done(values: dict) -> None:
            diff = [
                (addr, self.snapshot[addr], value)
                for addr, value in values.items()
                if self.snapshot.get(addr) != value
            ]
            if not diff:
                self.snapshot_note.setText("与快照一致")
                self.store.toast("ok", "寄存器与快照一致")
            else:
                text = " · ".join(f"0x{addr:03X}: 0x{old:08X}→0x{new:08X}" for addr, old, new in diff[:4])
                self.snapshot_note.setText(f"{len(diff)} 个差异：{text}")
                self.store.toast("warn", f"{len(diff)} 个寄存器与快照不同")

        self.store.read_many(FAVORITES, done)

    def refresh(self) -> None:
        self.group.setEnabled(True)
        if self.selected is None and self.list.count():
            self.list.setCurrentRow(0)

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.list.setStyleSheet(
            f"QListWidget{{background:{theme.inset};border:1px solid {theme.line};border-radius:10px;padding:4px;}}"
            f"QListWidget::item{{padding:6px 8px;border-radius:6px;color:{theme.text_2};font-family:'Cascadia Code',Consolas;font-size:11px;}}"
            f"QListWidget::item:selected{{background:{theme.accent_soft};color:{theme.text};}}"
        )
        if self.selected is not None:
            self._apply_value(self.current if self.current is not None else 0)
