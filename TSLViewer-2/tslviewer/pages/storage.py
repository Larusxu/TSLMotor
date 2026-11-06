"""板载存储 — MCU W25 archive and M24 backup."""

from __future__ import annotations

from PyQt6.QtWidgets import QFileDialog, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ..core import procedures
from ..widgets.primitives import Badge, Button, Card, Notice, divider
from .base import BasePage


class StoragePage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.image: list[int] | None = None
        self.object_motor: int | None = None
        self.record: dict | None = None
        self._busy = False
        self._build()

    def _build(self) -> None:
        host = QWidget()
        h = QHBoxLayout(host)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(14)

        left = QWidget()
        lc = QVBoxLayout(left)
        lc.setContentsMargins(0, 0, 0, 0)
        lc.setSpacing(14)
        self.w25 = Card("主控 W25 配置档案", "PUBLIC + 16 MOTORS", Badge("公共区 + 16 路电机", "neutral"))
        self.w25.add(Notice(
            "保存只更新档案，不应用寄存器、不使能电机。主控检查会话、禁能状态、CRC、编号与公共配置绑定。公共配置改变后，旧电机档案可能需要重新确认。",
            "warn",
        ))
        self.direct_notice = Notice("请通过主控 485 或 CAN 连接；电机直连模式不支持主控 W25 档案。", "warn")
        self.w25.add(self.direct_notice)
        row1 = QWidget()
        r1 = QHBoxLayout(row1)
        r1.setContentsMargins(0, 0, 0, 0)
        r1.setSpacing(8)
        self.btn_public = Button("读取公共配置", "default", icon_name="refresh")
        self.btn_public.clicked.connect(lambda: self._run(0, procedures.STORAGE_OP_READ))
        self.btn_motor = Button("读取当前电机档案")
        self.btn_motor.clicked.connect(lambda: self._run(self.store.motor, procedures.STORAGE_OP_READ))
        self.btn_import = Button("导入档案", "ghost")
        self.btn_import.clicked.connect(self._import)
        self.btn_export = Button("导出档案", "ghost")
        self.btn_export.clicked.connect(self._export)
        for b in (self.btn_public, self.btn_motor, self.btn_import, self.btn_export):
            r1.addWidget(b)
        r1.addStretch(1)
        self.w25.add(row1)
        self.w25.add(divider(self.theme))
        save_row = QWidget()
        sr = QHBoxLayout(save_row)
        sr.setContentsMargins(0, 0, 0, 0)
        self.btn_save = Button("保存到 W25 并读回", "primary", icon_name="save")
        self.btn_save.clicked.connect(lambda: self._run(self.object_motor or 0, procedures.STORAGE_OP_WRITE))
        sr.addWidget(self.btn_save)
        sr.addStretch(1)
        self.w25.add(save_row)
        self.buffer_note = QLabel("尚未读取或导入档案")
        self.buffer_note.setObjectName("tiny")
        self.w25.add(self.buffer_note)
        lc.addWidget(self.w25)
        lc.addStretch(1)

        right = QWidget()
        rc = QVBoxLayout(right)
        rc.setContentsMargins(0, 0, 0, 0)
        rc.setSpacing(14)
        self.m24 = Card("M24C02 校准备份", "CALIBRATION BACKUP", Badge(f"M{self.store.motor}", "neutral"))
        backup_note = QLabel("备份 HandID、电机编号和电角度偏移，仅使用 0x00–0x0F。保存前核对 W25 与 TMC；中断写入可能使单槽备份失效。")
        backup_note.setWordWrap(True)
        backup_note.setObjectName("tiny")
        self.m24.add(backup_note)
        m24_row = QWidget()
        mr = QHBoxLayout(m24_row)
        mr.setContentsMargins(0, 0, 0, 0)
        mr.setSpacing(8)
        self.btn_m24_read = Button("读取校准备份")
        self.btn_m24_read.clicked.connect(lambda: self._run(self.store.motor, procedures.STORAGE_OP_M24_READ))
        self.btn_m24_save = Button("从 W25 备份并校验", "primary", icon_name="save")
        self.btn_m24_save.clicked.connect(lambda: self._run(self.store.motor, procedures.STORAGE_OP_M24_SAVE))
        mr.addWidget(self.btn_m24_read)
        mr.addWidget(self.btn_m24_save)
        mr.addStretch(1)
        self.m24.add(m24_row)
        rc.addWidget(self.m24)

        result = Card("操作结果", "STATUS")
        self.message = QLabel("等待操作")
        self.message.setWordWrap(True)
        self.message.setObjectName("tiny")
        result.add(self.message)
        self.record_label = QLabel("")
        self.record_label.setObjectName("tiny")
        result.add(self.record_label)
        rc.addWidget(result)
        rc.addStretch(1)

        h.addWidget(left, 1)
        h.addWidget(right, 1)
        self.add(host)

    def _run(self, motor: int, op: int) -> None:
        if self._busy:
            return
        if not self.store.connected or self.store.mode == "direct":
            self.store.toast("warn", "请通过主控 485 或 CAN 连接")
            return
        self._busy = True
        self.message.setText("正在等待主控确认…")
        self.record = None
        self._set_buttons(False)

        def work():
            return procedures.storage_request(self.store.link, motor, op)

        def done(record: dict) -> None:
            self._busy = False
            self._set_buttons(True)
            self.record = record
            if self.store.hand_id is not None and self.store.hand_id != record["hand_id"]:
                self.store.toast("warn", "主控 HandID 已改变，请重新连接后读取")
            if op in (procedures.STORAGE_OP_READ, procedures.STORAGE_OP_WRITE):
                self.image = record["data"]
                self.object_motor = motor
                self.buffer_note.setText(
                    f"当前缓冲：{'公共配置' if motor == 0 else f'M{motor}'}，{len(self.image)} B"
                )
            name = "公共配置" if motor == 0 else f"M{motor}"
            if op == procedures.STORAGE_OP_M24_READ or op == procedures.STORAGE_OP_M24_SAVE:
                data = record["data"]
                if len(data) >= 8:
                    hand = int.from_bytes(bytes(data[0:2]), "little")
                    offset = int.from_bytes(bytes(data[4:6]), "little")
                    self.message.setText(
                        f"备份已校验：HandID {hand} · M{motor} · 电角度偏移 {offset} · 代数 {record['generation']}；恢复标志 {record['flags']}"
                    )
                else:
                    self.message.setText(f"已读取备份 · 代数 {record['generation']}")
            elif motor == 0:
                self.message.setText(f"公共区已读取 · HandID {record['hand_id']} · 代数 {record['generation']}")
            else:
                self.message.setText(f"W25 档案已读取：{name} · HandID {record['hand_id']} · 代数 {record['generation']}")
            self.record_label.setText(
                f"结果 {record['result']} · 请求 {record['id']} · 状态 {record['phase']} · 偏移 {record['offset']}"
            )
            self.store.toast("ok", "存储操作完成")
            self._sync()

        def failed(exc: Exception) -> None:
            self._busy = False
            self._set_buttons(True)
            self.message.setText(str(exc))
            self.store.toast("error", str(exc))
            self._sync()

        self.store.spawn(work, done, failed)

    def _set_buttons(self, enabled: bool) -> None:
        for btn in (self.btn_public, self.btn_motor, self.btn_import, self.btn_export):
            btn.setEnabled(enabled)
        self.btn_save.setEnabled(enabled and self.image is not None)
        self.btn_m24_read.setEnabled(enabled)
        self.btn_m24_save.setEnabled(enabled)

    def _import(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "导入档案", "", "Binary (*.bin)")
        if not path:
            return
        data = list(open(path, "rb").read())
        if len(data) != 128 or bytes(data[:4]).decode("ascii", "ignore") not in ("ENC1", "ENC2", "MTR1"):
            self.store.toast("error", "仅接受 ENC1/ENC2/MTR1 128 字节档案")
            return
        magic = bytes(data[:4]).decode("ascii", "ignore")
        motor = 0 if magic.startswith("ENC") else data[12] | data[13] << 8
        if motor not in (0, self.store.motor):
            self.store.toast("error", "档案电机编号与当前选择不一致")
            return
        self.image = data
        self.object_motor = motor
        self.buffer_note.setText(f"当前缓冲：{'公共配置' if motor == 0 else f'M{motor}'}，128 B")
        self.message.setText("已导入编辑缓冲，尚未写入主控；保存时主控会验证 CRC 和配置绑定。")
        self._sync()

    def _export(self) -> None:
        if not self.image:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出档案", f"Hand{self.store.hand_id}-object{self.object_motor}.bin", "Binary (*.bin)")
        if not path:
            return
        with open(path, "wb") as fh:
            fh.write(bytes(self.image))
        self.store.toast("ok", f"档案已导出到 {path}")

    def _sync(self) -> None:
        direct = self.store.mode == "direct"
        self.direct_notice.setVisible(direct)
        for btn in (self.btn_public, self.btn_motor, self.btn_m24_read, self.btn_m24_save):
            btn.setEnabled(self.store.connected and not direct and not self._busy)
        self.btn_save.setEnabled(self.store.connected and not direct and not self._busy and self.image is not None)
        self.btn_import.setEnabled(not self._busy)
        self.btn_export.setEnabled(bool(self.image))
        self.m24.title_label.setText("M24C02 校准备份")
        self.m24.sub_label.setText("CALIBRATION BACKUP")

    def refresh(self) -> None:
        self._sync()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
