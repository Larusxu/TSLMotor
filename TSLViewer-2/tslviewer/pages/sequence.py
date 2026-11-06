"""自动测试 — speed sequence with CSV report."""

from __future__ import annotations

import os

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import procedures
from ..theme import mono_font
from ..widgets.charts import LineChart
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    Notice,
    NumField,
    SelectField,
    StepList,
    TextField,
)
from .base import BasePage, row


class SequencePage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self._build()
        self.store.stepsChanged.connect(self._steps_changed)

    def _build(self) -> None:
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        self.serial = TextField("", "例如 TSL-0001")
        self.operator = TextField("", "操作员")
        self.note = TextField("", "备注")
        self.mode = SelectField([("closed", "闭环测速"), ("open", "开环电压")], "closed")
        self.max_ud = NumField(0x200, 0, 65535, 1, 0)
        self.tolerance = NumField(50, 0, 10000, 1, 0, "RPM")
        self.interval = NumField(1, 0, 60, 0.5, 1, "s")
        card = Card("测试配置", "RUN CONFIG")
        fields = QWidget()
        fg = QGridLayout(fields)
        fg.setContentsMargins(0, 0, 0, 0)
        fg.setHorizontalSpacing(10)
        fg.setVerticalSpacing(10)
        fg.addWidget(Field("电机序列号", self.serial, "必填，用于文件名"), 0, 0)
        fg.addWidget(Field("操作员", self.operator), 0, 1)
        fg.addWidget(Field("备注", self.note), 1, 0, 1, 2)
        fg.addWidget(Field("控制模式", self.mode, "闭环测速 / 开环电压"), 2, 0)
        fg.addWidget(Field("最大 UD", self.max_ud, "0x200"), 2, 1)
        fg.addWidget(Field("容差", self.tolerance), 3, 0)
        fg.addWidget(Field("档位间隔", self.interval), 3, 1)
        card.add(fields)

        step_head = QWidget()
        sh = QHBoxLayout(step_head)
        sh.setContentsMargins(0, 0, 0, 0)
        sh.setSpacing(8)
        title = QLabel("测试档位")
        title.setObjectName("fieldLabel")
        add = Button("+ 档位", "ghost", "sm")
        add.clicked.connect(self._add_step)
        remove = Button("删除末档", "ghost", "sm")
        remove.clicked.connect(self._remove_step)
        sh.addWidget(title)
        sh.addStretch(1)
        sh.addWidget(add)
        sh.addWidget(remove)
        card.add(step_head)
        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["转速 RPM", "保持 s"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setMinimumHeight(220)
        self.table.setEditTriggers(
            QAbstractItemView.EditTrigger.DoubleClicked | QAbstractItemView.EditTrigger.SelectedClicked
        )
        card.add(self.table)
        for rpm, hold in ((300, 3), (600, 3), (900, 3), (1200, 3)):
            self._add_step_values(rpm, hold)
        actions = QWidget()
        ah = QHBoxLayout(actions)
        ah.setContentsMargins(0, 0, 0, 0)
        ah.setSpacing(8)
        self.run_btn = Button("开始测试序列", "primary", icon_name="play")
        self.run_btn.clicked.connect(self._run)
        self.cancel_btn = Button("取消", "ghost")
        self.cancel_btn.clicked.connect(self.store.cancel_job)
        reports = Button("打开报告目录", "ghost")
        reports.clicked.connect(lambda: os.startfile(str(self.store.reports_path)))
        ah.addWidget(self.run_btn)
        ah.addWidget(self.cancel_btn)
        ah.addWidget(reports)
        ah.addStretch(1)
        card.add(actions)
        self.warning = Notice("序列号必填（用于 CSV 文件名与追溯）。")
        card.add(self.warning)
        grid.addWidget(card, 0, 0)

        self.progress_card = Card("执行进度", "PROGRESS")
        self.steps = StepList()
        self.progress_card.add(self.steps)
        grid.addWidget(self.progress_card, 1, 0)

        self.summary_badge = Badge("尚未测试", "neutral")
        summary = Card("汇总", "WINDOWS", self.summary_badge)
        self.summary_table = QTableWidget(0, 5)
        self.summary_table.setHorizontalHeaderLabels(["档位", "均值", "纹波", "结论", "电流"])
        self.summary_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.summary_table.verticalHeader().setVisible(False)
        self.summary_table.setMinimumHeight(180)
        self.summary_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        summary.add(self.summary_table)
        grid.addWidget(summary, 0, 1, 2, 1)

        chart_card = Card("采集曲线", "MEASURED MEAN", Badge("闭环 / 开环", "neutral"))
        self.chart = LineChart(self.theme, 240, "RPM")
        chart_card.add(self.chart)
        self.add(host)
        self.add(chart_card)

    # --------------------------------------------------------------- table
    def _add_step(self) -> None:
        self._add_step_values(1000, 3)

    def _add_step_values(self, rpm: float, hold: float) -> None:
        row_index = self.table.rowCount()
        self.table.insertRow(row_index)
        self.table.setItem(row_index, 0, QTableWidgetItem(str(rpm)))
        self.table.setItem(row_index, 1, QTableWidgetItem(str(hold)))

    def _remove_step(self) -> None:
        if self.table.rowCount() > 1:
            self.table.removeRow(self.table.rowCount() - 1)

    def _steps_payload(self) -> list[dict]:
        out = []
        for i in range(self.table.rowCount()):
            try:
                rpm = float(self.table.item(i, 0).text())
                hold = float(self.table.item(i, 1).text())
            except (AttributeError, ValueError):
                continue
            out.append({"rpm": rpm, "hold_s": hold})
        return out

    def _steps_changed(self, kind: str) -> None:
        if kind == "sequence":
            self.steps.set_steps(self.store.steps_by_kind.get("sequence", []))

    # -------------------------------------------------------------- actions
    def _run(self) -> None:
        serial_no = self.serial.text().strip()
        if not serial_no:
            self.store.toast("warn", "序列号必填（用于 CSV 文件名与追溯）")
            self.serial.setFocus()
            return
        steps = self._steps_payload()
        if not steps:
            self.store.toast("warn", "至少需要一个有效档位")
            return
        cfg = {
            "serial": serial_no,
            "operator": self.operator.text().strip(),
            "note": self.note.text().strip(),
            "mode": self.mode.value(),
            "tolerance": self.tolerance.value(),
            "steps": steps,
        }
        self.summary_table.setRowCount(0)
        self.chart.clear()
        self.store.run_job(
            "sequence",
            cfg,
            lambda ctx: procedures.run_sequence(ctx, cfg, self.store.cal_dict(), self.store.reports_path),
        )
        self._seq_cfg = cfg

    def refresh(self) -> None:
        running = self.store.job_running
        self.run_btn.setEnabled(not running and self.store.connected)
        self.cancel_btn.setEnabled(running)
        self.run_btn.setText("测试运行中…" if running else "开始测试序列")
        last = self.store.last_done
        if last and last.get("job") == "sequence":
            data = last.get("data") or {}
            rows = data.get("summary") if isinstance(data, dict) else None
            if rows:
                self.summary_table.setRowCount(len(rows))
                for i, item in enumerate(rows):
                    values = [
                        f"{item['idx']} · {item['rpm']:.0f}",
                        f"{item['mean']:.1f}",
                        f"{item['ripple']:.1f}",
                        "通过" if item["verdict"] == "pass" else "超差",
                        f"{item['current']:.0f} mA",
                    ]
                    for j, text in enumerate(values):
                        cell = QTableWidgetItem(text)
                        cell.setFont(mono_font(10))
                        if j == 3:
                            cell.setForeground(
                                Qt.GlobalColor.green if item["verdict"] == "pass" else Qt.GlobalColor.red
                            )
                        self.summary_table.setItem(i, j, cell)
                passed = sum(1 for r in rows if r["verdict"] == "pass")
                self.summary_badge.set_text(f"{passed}/{len(rows)} 通过")
                self.summary_badge.set_tone("ok" if passed == len(rows) else "warn")
                self.chart.set_series([
                    ("目标", [(r["rpm"], r["rpm"]) for r in rows], self.theme.text_3),
                    ("实测", [(r["rpm"], r["mean"]) for r in rows], self.theme.accent),
                ])
            elif last.get("ok") is False:
                self.summary_badge.set_text("失败")
                self.summary_badge.set_tone("danger")

    def on_show(self) -> None:
        self.steps.set_steps(self.store.steps_by_kind.get("sequence", []))
        self.refresh()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.chart.theme = theme
        self.chart.update()
