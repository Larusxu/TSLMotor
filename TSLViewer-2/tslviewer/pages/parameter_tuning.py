"""参数整定 — PRBS identification, PI design and trial application."""

from __future__ import annotations

from PyQt6.QtWidgets import (
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
from ..core import regs
from ..theme import mono_font
from ..widgets.charts import WaveformChart
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    KV,
    Notice,
    NumField,
    SelectField,
    StepList,
    Toggle,
    divider,
)
from .base import BasePage

LOOP_NAMES = ["电流环 Id", "电流环 Iq", "速度环", "位置环"]
LOOP_REGS = [regs.FOC_PID_FLUX_COEFF, regs.FOC_PID_TORQUE_COEFF, regs.FOC_PID_VELOCITY_COEFF, regs.FOC_PID_POSITION_COEFF]


class ParameterTuningPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.capture: procedures.PiCapture | None = None
        self.candidate: dict | None = None
        self.history: list[dict] = []
        self.results: list[dict] = []
        self._build()
        self.store.stepsChanged.connect(self._steps_changed)

    def _build(self) -> None:
        status = Card("", "", Badge("TMC 系统辨识", "neutral"))
        self.status_kv = KV([
            ("当前电机", f"M{self.store.motor}"),
            ("整定状态", "待开始"),
            ("实际采样", "—"),
            ("参数状态", "原配置保持"),
        ])
        status.add(self.status_kv)
        self.add(status)

        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        card = Card("系统辨识", "PRBS · HOST EXCITATION", Badge("芯片内部激励", "neutral"))
        self.loop = SelectField([(i, name) for i, name in enumerate(LOOP_NAMES)], 0)
        self.amplitude = NumField(300, 1, 30000, 10, 0, "mA")
        self.duration = NumField(3, 1, 7, 1, 0, "s")
        self.range = SelectField([("20-80", "20%–80%"), ("30-70", "30%–70%"), ("40-60", "40%–60%")], "20-80")
        self.bandwidth = NumField(200, 0.1, 5000, 1, 1, "Hz")
        self.sampling = NumField(4, 0, 255, 1, 0)
        self.excitation = NumField(4, 0, 255, 1, 0)
        self.shared = Toggle(True)
        g = QGridLayout()
        g.setHorizontalSpacing(8)
        g.setVerticalSpacing(8)
        g.addWidget(Field("辨识对象", self.loop, "芯片内部激励"), 0, 0)
        g.addWidget(Field("激励幅值", self.amplitude, "mA / RPM / °"), 0, 1)
        g.addWidget(Field("采集时长", self.duration), 1, 0)
        g.addWidget(Field("整定行程范围", self.range), 1, 1)
        g.addWidget(Field("期望闭环带宽", self.bandwidth, "响应速度目标"), 2, 0)
        g.addWidget(Field("RTMI 采样分频", self.sampling, "PWM / (N+1)"), 2, 1)
        g.addWidget(Field("PRBS 激励分频", self.excitation), 3, 0)
        shared_box = QWidget()
        shr = QHBoxLayout(shared_box)
        shr.setContentsMargins(0, 0, 0, 0)
        shr.setSpacing(8)
        shr.addWidget(QLabel("电流环 Id / Iq 使用同一份 PI 参数"))
        shr.addWidget(self.shared)
        g.addWidget(shared_box, 3, 1)
        card.add_layout(g)
        buttons = QWidget()
        bh = QHBoxLayout(buttons)
        bh.setContentsMargins(0, 0, 0, 0)
        bh.setSpacing(8)
        self.start_btn = Button("单环整定", "primary", icon_name="sequence")
        self.start_btn.clicked.connect(lambda: self._start(False))
        self.seq_btn = Button("三环整定")
        self.seq_btn.clicked.connect(lambda: self._start(True))
        self.stop_btn = Button("停止", "danger", icon_name="stop")
        self.stop_btn.clicked.connect(self.store.cancel_job)
        bh.addWidget(self.start_btn)
        bh.addWidget(self.seq_btn)
        bh.addWidget(self.stop_btn)
        bh.addStretch(1)
        card.add(buttons)
        self.message = QLabel("等待开始")
        self.message.setObjectName("tiny")
        self.message.setWordWrap(True)
        card.add(self.message)
        card.add(Notice("激励由上位机按 PRBS 序列写入目标寄存器，RTMI 同步记录参考/实际/电流。辨识使用带工具变量的 ARX(1,1)，只在训练前半段拟合、后半段自由响应用来验模。", "warn"))
        grid.addWidget(card, 0, 0)

        wave_card = Card("辨识响应", "IDENTIFICATION", Badge("0 / 0 组", "neutral"))
        self.wave = WaveformChart(self.theme)
        self.wave.setMinimumHeight(260)
        wave_card.add(self.wave)
        legend = QLabel("-- PRBS参考      — 实际反馈")
        legend.setObjectName("tiny")
        wave_card.add(legend)
        self.wave_badge = wave_card.findChild(Badge)
        grid.addWidget(wave_card, 0, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)

        result_card = Card("整定结果", "RESULT", Badge("自动试用并回读", "neutral"))
        self.result_kv = KV([
            ("频域相干度", "—"),
            ("整定行程范围", "20%–80%"),
            ("候选 P / I", "—"),
            ("一阶模型", "—"),
        ])
        result_card.add(self.result_kv)
        self.result_table = QTableWidget(0, 4)
        self.result_table.setHorizontalHeaderLabels(["控制环", "P", "I", "结果"])
        self.result_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.result_table.verticalHeader().setVisible(False)
        self.result_table.setMinimumHeight(140)
        result_card.add(self.result_table)
        apply_row = QWidget()
        ar = QHBoxLayout(apply_row)
        ar.setContentsMargins(0, 0, 0, 0)
        ar.setSpacing(8)
        self.trial_btn = Button("试用", "primary")
        self.trial_btn.clicked.connect(self._trial)
        self.save_btn = Button("保存到芯片")
        self.save_btn.clicked.connect(self._trial)
        ar.addWidget(self.trial_btn)
        ar.addWidget(self.save_btn)
        ar.addStretch(1)
        result_card.add(apply_row)
        grid.addWidget(result_card, 1, 0)

        flow_card = Card("整定流程", "STEPS")
        self.steps = StepList()
        self.steps.setMinimumHeight(200)
        flow_card.add(self.steps)
        grid.addWidget(flow_card, 1, 1)
        self.add(host)

        hist_card = Card("已完成轮次", "HISTORY", Badge("点击查看波形", "neutral"))
        self.history_table = QTableWidget(0, 4)
        self.history_table.setHorizontalHeaderLabels(["环 / 轮次", "P / I", "评分", "响应峰值"])
        self.history_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.history_table.verticalHeader().setVisible(False)
        self.history_table.setMinimumHeight(160)
        hist_card.add(self.history_table)
        self.add(hist_card)

    # --------------------------------------------------------------- actions
    def _start(self, sequence: bool) -> None:
        if not self.store.connected:
            self.store.toast("warn", "串口未连接")
            return
        loop = int(self.loop.value() or 0)
        amplitude = self.amplitude.value()
        duration = self.duration.value()
        bandwidth = self.bandwidth.value()
        cal = self.store.cal_dict()
        shared = self.shared.isChecked()

        def run_one(ctx, loop_id: int) -> dict:
            ctx.total = 3
            ctx.begin(f"{LOOP_NAMES[loop_id]} · 采集")
            capture = procedures.capture_prbs(ctx, loop_id, amplitude, duration, cal)
            ctx.ok("采集", f"{capture.count} 组 @ {capture.sample_hz:.0f} Hz")
            ctx.begin(f"{LOOP_NAMES[loop_id]} · 辨识")
            candidate = procedures.calculate_pi(capture, bandwidth)
            ctx.ok("辨识", f"P={candidate['p']} I={candidate['i']} · 验证 {candidate['model']['validationFit'] * 100:.1f}%")
            ctx.begin(f"{LOOP_NAMES[loop_id]} · 试用")
            word = (candidate["p"] << 16) | (candidate["i"] & 0xFFFF)
            targets = [loop_id]
            if loop_id < 2 and shared:
                targets = [0, 1]
            for target in targets:
                if not self.store.link.write_verified(LOOP_REGS[target], word, 0xFFFFFFFF):
                    raise RuntimeError(f"{LOOP_NAMES[target]} 写入校验失败")
            ctx.ok("试用", f"0x{word:08X} 已回读")
            return {"loop": loop_id, "capture": capture, "candidate": candidate, "p": candidate["p"], "i": candidate["i"]}

        def fn(ctx):
            loops = [0, 1, 2] if sequence else [loop]
            results = []
            for loop_id in loops:
                results.append(run_one(ctx, loop_id))
            return {"results": results, "sequence": sequence}

        self.store.run_job("autotune", {}, fn)
        self._pending_loop = loop

    def _trial(self) -> None:
        if not self.candidate:
            self.store.toast("warn", "请先完成一次整定")
            return
        loop = self.candidate["loop"]
        word = (self.candidate["p"] << 16) | (self.candidate["i"] & 0xFFFF)

        def work():
            if not self.store.link.write_verified(LOOP_REGS[loop], word, 0xFFFFFFFF):
                raise RuntimeError("写入校验失败")
            return self.store.link.read_reg_retry(LOOP_REGS[loop], 3)

        def done(value: int) -> None:
            self.store.toast("ok", f"{LOOP_NAMES[loop]} 已写入并回读 0x{value:08X}")

        self.store.spawn(work, done, lambda e: self.store.toast("error", str(e)))

    def _steps_changed(self, kind: str) -> None:
        if kind == "autotune":
            self.steps.set_steps(self.store.steps_by_kind.get("autotune", []))

    # --------------------------------------------------------------- render
    def refresh(self) -> None:
        running = self.store.job_running
        self.start_btn.setEnabled(not running and self.store.connected)
        self.seq_btn.setEnabled(not running and self.store.connected)
        self.stop_btn.setEnabled(running)
        loop = int(self.loop.value() or 0)
        unit = "mA" if loop < 2 else "RPM" if loop == 2 else "°"
        self.amplitude.setSuffix(" " + unit)
        self.status_kv.set_rows([
            ("当前电机", f"M{self.store.motor}"),
            ("整定状态", "正在辨识" if running else ("已完成" if self.candidate else "待开始")),
            ("实际采样", f"{self.capture.sample_hz:.1f} Hz" if self.capture else "—"),
            ("参数状态", "整定中 · 未保存" if running else ("已试用 · 未保存" if self.candidate else "原配置保持")),
        ])
        last = self.store.last_done
        if last and last.get("job") == "autotune" and last.get("ok"):
            data = last.get("data") or {}
            results = data.get("results") if isinstance(data, dict) else None
            if results:
                self.results = results
                first = results[0]
                self.capture = first["capture"]
                self.candidate = {**first["candidate"], "loop": first["loop"]}
                ref = [s.reference for s in self.capture.samples][:600]
                act = [s.actual for s in self.capture.samples][:600]
                self.wave.set_data(ref, act)
                if self.wave_badge:
                    self.wave_badge.set_text(f"{len(self.capture.samples)} 组")
                model = self.candidate["model"]
                self.result_kv.set_rows([
                    ("频域相干度", f"{model['validationFit'] * 100:.1f}%"),
                    ("整定行程范围", self.range.value()),
                    ("候选 P / I", f"{self.candidate['p']} / {self.candidate['i']}"),
                    ("一阶模型", f"a={model['a']:.4f} · b={model['b']:.3g}"),
                ])
                self.result_table.setRowCount(len(results))
                for i, item in enumerate(results):
                    for j, text in enumerate([
                        LOOP_NAMES[item["loop"]], str(item["p"]), str(item["i"]), "已改善并应用"
                    ]):
                        cell = QTableWidgetItem(text)
                        cell.setFont(mono_font(10))
                        self.result_table.setItem(i, j, cell)
                self.history.append({"loop": first["loop"], "p": first["p"], "i": first["i"], "capture": self.capture})
                self.history_table.setRowCount(len(self.history))
                for i, item in enumerate(self.history):
                    for j, text in enumerate([LOOP_NAMES[item["loop"]], f"{item['p']} / {item['i']}",
                                              f"{item['capture'].count}", "—"]):
                        cell = QTableWidgetItem(text)
                        cell.setFont(mono_font(10))
                        self.history_table.setItem(i, j, cell)
        elif last and last.get("job") == "autotune":
            self.message.setText(str(last.get("message", "")))

    def on_show(self) -> None:
        self.steps.set_steps(self.store.steps_by_kind.get("autotune", []))
        self.refresh()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.wave.theme = theme
        self.wave.update()
