"""PID 与限幅 — three cascaded loops, normalisation and step response."""

from __future__ import annotations

import math

from PyQt6.QtWidgets import (
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import procedures
from ..core.units import (
    CUR_NORM_LABELS,
    NORM_I_LABELS,
    NORM_P_LABELS,
    fmt,
    parse_pid_config,
    suggest_pi,
)
from ..theme import mono_font
from ..widgets.charts import LineChart
from ..widgets.telemetry import TelemetryPanels
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    KV,
    Notice,
    NumField,
    Segmented,
    SelectField,
    StepList,
    Toggle,
    divider,
)
from .base import BasePage


class TuningPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.snapshot = procedures.PidSnapshot()
        self.kind = "speed"
        self._build()
        self.store.stepsChanged.connect(self._steps_changed)

    def _build(self) -> None:
        self.telemetry = TelemetryPanels(self.store, self.theme)
        self.add(self.telemetry)
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        self.read_btn = Button("从芯片读取", "ghost", "sm")
        self.read_btn.clicked.connect(self._read)
        self.apply_btn = Button("应用并校验", "primary", "sm")
        self.apply_btn.clicked.connect(self._apply)
        pid = Card("PID 参数", "CASCADE · 0x140…0x146", self.read_btn)
        self.flux_p = NumField(64, -32768, 32767, 1, 0)
        self.flux_i = NumField(48, -32768, 32767, 1, 0)
        self.torque_p = NumField(64, -32768, 32767, 1, 0)
        self.torque_i = NumField(48, -32768, 32767, 1, 0)
        self.vel_p = NumField(500, -32768, 32767, 1, 0)
        self.vel_i = NumField(250, -32768, 32767, 1, 0)
        self.pos_p = NumField(500, -32768, 32767, 1, 0)
        self.pos_i = NumField(0, -32768, 32767, 1, 0)
        self.cur_norm_p = SelectField([(i, t) for i, t in enumerate(CUR_NORM_LABELS)], 1)
        self.cur_norm_i = SelectField([(i, t) for i, t in enumerate(CUR_NORM_LABELS)], 1)
        self.vel_norm_p = SelectField([(i, t) for i, t in enumerate(NORM_P_LABELS)], 1)
        self.vel_norm_i = SelectField([(i, t) for i, t in enumerate(NORM_I_LABELS)], 0)
        self.pos_norm_p = SelectField([(i, t) for i, t in enumerate(NORM_P_LABELS)], 1)
        self.pos_norm_i = SelectField([(i, t) for i, t in enumerate(NORM_I_LABELS)], 0)
        self.vel_shift = NumField(0, 0, 15, 1, 0)
        self.pos_sampling = NumField(0, 0, 127, 1, 0)
        self.overwrite = Toggle(False)
        self.keep_pos = Toggle(False)
        self.torque_limit = NumField(800, 0, 3000, 10, 0, "mA")
        self.flux_limit = NumField(0, 0, 3000, 10, 0, "mA")
        self.vel_limit = NumField(25000, 0, 60000, 100, 0, "RPM")
        self.uq_ud = NumField(0x5A81, 0, 65535, 1, 0)

        current = Card("电流环", "0x142 / 0x143", Badge("Q8.8", "neutral"))
        cg = QGridLayout()
        cg.setHorizontalSpacing(8)
        cg.setVerticalSpacing(8)
        cg.addWidget(Field("Iq P · 0x143", self.torque_p), 0, 0)
        cg.addWidget(Field("Iq I · 0x143", self.torque_i), 0, 1)
        cg.addWidget(Field("Id P · 0x142", self.flux_p), 1, 0)
        cg.addWidget(Field("Id I · 0x142", self.flux_i), 1, 1)
        cg.addWidget(Field("P 归一化", self.cur_norm_p), 2, 0)
        cg.addWidget(Field("I 归一化", self.cur_norm_i), 2, 1)
        current.add_layout(cg)
        pid.add(current)

        velocity = Card("速度环", "0x145", Badge("0x140 归一化", "neutral"))
        vg = QGridLayout()
        vg.setHorizontalSpacing(8)
        vg.setVerticalSpacing(8)
        vg.addWidget(Field("P", self.vel_p), 0, 0)
        vg.addWidget(Field("I", self.vel_i), 0, 1)
        vg.addWidget(Field("P 归一化", self.vel_norm_p), 1, 0)
        vg.addWidget(Field("I 归一化", self.vel_norm_i), 1, 1)
        vg.addWidget(Field("速度输出右移", self.vel_shift, "0x140[15:12]"), 2, 0)
        velocity.add_layout(vg)
        pid.add(velocity)

        position = Card("位置环", "0x146", Badge("P 归一化", "neutral"))
        pg = QGridLayout()
        pg.setHorizontalSpacing(8)
        pg.setVerticalSpacing(8)
        pg.addWidget(Field("P", self.pos_p), 0, 0)
        pg.addWidget(Field("I", self.pos_i), 0, 1)
        pg.addWidget(Field("P 归一化", self.pos_norm_p), 1, 0)
        pg.addWidget(Field("I 归一化", self.pos_norm_i), 1, 1)
        pg.addWidget(Field("位置降采样", self.pos_sampling, "0x140[22:16]"), 2, 0)
        position.add_layout(pg)
        pid.add(position)

        toggles = QWidget()
        th = QHBoxLayout(toggles)
        th.setContentsMargins(0, 0, 0, 0)
        th.setSpacing(18)
        for label_text, widget in (("平滑切换 OVERWRITE_TARGET", self.overwrite), ("写实际位置不改目标", self.keep_pos)):
            box = QWidget()
            bh = QHBoxLayout(box)
            bh.setContentsMargins(0, 0, 0, 0)
            bh.setSpacing(8)
            lab = QLabel(label_text)
            lab.setObjectName("tiny")
            bh.addWidget(lab)
            bh.addWidget(widget)
            th.addWidget(box)
        th.addStretch(1)
        pid.add(toggles)
        pid.add(divider(self.theme))

        limits = QWidget()
        lg = QGridLayout(limits)
        lg.setContentsMargins(0, 0, 0, 0)
        lg.setHorizontalSpacing(8)
        lg.setVerticalSpacing(8)
        lg.addWidget(Field("驱动器 Iq 上限", self.torque_limit, "0x14A[30:16]"), 0, 0)
        lg.addWidget(Field("驱动器 Id 上限", self.flux_limit, "0x14A[15:0]"), 0, 1)
        lg.addWidget(Field("驱动器速度上限", self.vel_limit, "0x14B"), 1, 0)
        lg.addWidget(Field("电压限幅", self.uq_ud, "0x149 · 18900 = 100%"), 1, 1)
        pid.add(limits)
        actions = QWidget()
        ah = QHBoxLayout(actions)
        ah.setContentsMargins(0, 0, 0, 0)
        ah.setSpacing(8)
        ah.addWidget(self.apply_btn)
        self.cancel_btn = Button("取消任务", "ghost", "sm")
        self.cancel_btn.clicked.connect(self.store.cancel_job)
        ah.addWidget(self.cancel_btn)
        self.loaded = QLabel("")
        self.loaded.setObjectName("tiny")
        ah.addWidget(self.loaded)
        ah.addStretch(1)
        pid.add(actions)
        pid.add(Notice(
            "新上位机默认“电流归一化 = No shift（Q16.0）”。若把 64/48 或 359/129 直接写进去而不改成 Shift by 8，实际增益会差 256 倍。",
            "warn",
        ))
        grid.addWidget(pid, 0, 0)

        right = QWidget()
        rc = QVBoxLayout(right)
        rc.setContentsMargins(0, 0, 0, 0)
        rc.setSpacing(14)
        units_card = Card("单位换算", "DERIVED")
        units_card.add(KV([
            ("电流刻度", "0.20131 mA / LSB"),
            ("4× 满量程", "8192 LSB = 1.65 A"),
            ("速度刻度", "305.4 counts / RPM"),
            ("位置换算", "65536 LSB / 圈"),
            ("调制满幅", "18900 = 100%"),
        ]))
        rc.addWidget(units_card)

        compare = Card("生产参数对照", "TESLA PROFILE")
        table = QTableWidget(4, 3)
        table.setHorizontalHeaderLabels(["项", "生产", "实测"])
        table.verticalHeader().setVisible(False)
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        rows = [
            ("电流 P / I", "64 / 48", "359 / 129"),
            ("近似带宽", "356 Hz", "2000 Hz"),
            ("速度 P / I", "500 / 250", "500 / 250"),
            ("力矩限幅", "800 mA", "1000 mA"),
        ]
        for i, values in enumerate(rows):
            for j, text in enumerate(values):
                cell = QTableWidgetItem(text)
                cell.setFont(mono_font(10))
                table.setItem(i, j, cell)
        table.horizontalHeader().setStretchLastSection(True)
        table.setMinimumHeight(160)
        compare.add(table)
        rc.addWidget(compare)
        rc.addStretch(1)
        grid.addWidget(right, 0, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        self.add(host)

        step = Card("阶跃测试", "STEP RESPONSE")
        self.kind_seg = Segmented([("speed", "速度阶跃"), ("current", "电流阶跃")], "speed")
        self.kind_seg.changed.connect(lambda v: setattr(self, "kind", v))
        self.amplitude = NumField(300, 1, 30000, 10, 0)
        self.duration = NumField(2, 0.2, 20, 0.5, 1, "s")
        self.r_ohm = NumField(2.01, 0.01, 100, 0.01, 2, "Ω")
        self.l_uh = NumField(111.8, 1, 100000, 0.1, 1, "µH")
        self.bandwidth = NumField(2000, 1, 50000, 10, 0, "Hz")
        controls = QWidget()
        ch = QGridLayout(controls)
        ch.setContentsMargins(0, 0, 0, 0)
        ch.setHorizontalSpacing(8)
        ch.setVerticalSpacing(8)
        ch.addWidget(Field("激励类型", self.kind_seg), 0, 0)
        ch.addWidget(Field("阶跃幅度", self.amplitude, "mA / RPM"), 0, 1)
        ch.addWidget(Field("采集时长", self.duration), 0, 2)
        ch.addWidget(Field("R", self.r_ohm, "用于反算 PI"), 1, 0)
        ch.addWidget(Field("L", self.l_uh), 1, 1)
        ch.addWidget(Field("带宽", self.bandwidth), 1, 2)
        step.add(controls)
        btn_row = QWidget()
        bh = QHBoxLayout(btn_row)
        bh.setContentsMargins(0, 0, 0, 0)
        bh.setSpacing(8)
        pi_btn = Button("反算电流 PI", "ghost")
        pi_btn.clicked.connect(self._suggest_pi)
        run = Button("运行阶跃", "primary", icon_name="play")
        run.clicked.connect(self._run_step)
        bh.addWidget(pi_btn)
        bh.addWidget(run)
        bh.addStretch(1)
        step.add(btn_row)
        self.step_footprint = Badge("等待测试", "neutral")
        step.body.insertWidget(0, self.step_footprint)
        self.chart = LineChart(self.theme, 240, "响应")
        step.add(self.chart)
        self.metrics_label = QLabel("—")
        self.metrics_label.setObjectName("tiny")
        step.add(self.metrics_label)
        self.add(step)

        flow = Card("参数写入流程", "APPLY SEQUENCE")
        self.steps = StepList()
        self.steps.setMinimumHeight(160)
        flow.add(self.steps)
        self.add(flow)

    # -------------------------------------------------------------- actions
    def _read(self) -> None:
        if not self.store.connected:
            return

        def done(snap: procedures.PidSnapshot) -> None:
            self.snapshot = snap
            bits = parse_pid_config(snap.config)
            self.flux_p.setValue(snap.flux_coeff >> 16 if snap.flux_coeff < 0x80000000 else (snap.flux_coeff >> 16) - 0x10000)
            self.flux_i.setValue(snap.flux_coeff & 0xFFFF)
            self.torque_p.setValue(snap.torque_coeff >> 16)
            self.torque_i.setValue(snap.torque_coeff & 0xFFFF)
            self.vel_p.setValue(snap.vel_coeff >> 16)
            self.vel_i.setValue(snap.vel_coeff & 0xFFFF)
            self.pos_p.setValue(snap.pos_coeff >> 16)
            self.pos_i.setValue(snap.pos_coeff & 0xFFFF)
            self.cur_norm_p.setCurrentIndex(bits.cur_norm_p)
            self.cur_norm_i.setCurrentIndex(bits.cur_norm_i)
            self.vel_norm_p.setCurrentIndex(bits.vel_norm_p)
            self.vel_norm_i.setCurrentIndex(bits.vel_norm_i)
            self.pos_norm_p.setCurrentIndex(bits.pos_norm_p)
            self.pos_norm_i.setCurrentIndex(bits.pos_norm_i)
            self.vel_shift.setValue(bits.vel_shift)
            self.pos_sampling.setValue(bits.pos_sampling)
            self.overwrite.setChecked(bits.overwrite_target)
            self.keep_pos.setChecked(bits.keep_pos_target)
            self.torque_limit.setValue(((snap.tf_limits >> 16) & 0x7FFF) * self.store.cal.ma_per_count)
            self.flux_limit.setValue((snap.tf_limits & 0x7FFF) * self.store.cal.ma_per_count)
            self.vel_limit.setValue((snap.vel_limit & 0x7FFFFFFF) / self.store.cal.counts_per_rpm)
            self.uq_ud.setValue(snap.uq_ud_limit & 0xFFFF)
            self.loaded.setText("已从芯片读取")
            self.store.toast("ok", "PID 参数已读取")

        self.store.spawn(lambda: procedures.read_pid(self.store.link), done,
                         lambda e: self.store.toast("error", f"读取 PID 失败：{e}"))

    def _cfg(self) -> procedures.PidCfg:
        return procedures.PidCfg(
            flux_p=int(self.flux_p.value()),
            flux_i=int(self.flux_i.value()),
            torque_p=int(self.torque_p.value()),
            torque_i=int(self.torque_i.value()),
            vel_p=int(self.vel_p.value()),
            vel_i=int(self.vel_i.value()),
            pos_p=int(self.pos_p.value()),
            pos_i=int(self.pos_i.value()),
            cur_norm_p=int(self.cur_norm_p.value() or 0),
            cur_norm_i=int(self.cur_norm_i.value() or 0),
            vel_norm_p=int(self.vel_norm_p.value() or 0),
            vel_norm_i=int(self.vel_norm_i.value() or 0),
            pos_norm_p=int(self.pos_norm_p.value() or 0),
            pos_norm_i=int(self.pos_norm_i.value() or 0),
            vel_shift=int(self.vel_shift.value()),
            pos_sampling=int(self.pos_sampling.value()),
            overwrite_target=self.overwrite.isChecked(),
            keep_pos_target=self.keep_pos.isChecked(),
            torque_limit_ma=self.torque_limit.value(),
            flux_limit_ma=self.flux_limit.value(),
            vel_limit_rpm=self.vel_limit.value(),
            uq_ud_limit=int(self.uq_ud.value()),
            ma_per_count=self.store.cal.ma_per_count,
            counts_per_rpm=self.store.cal.counts_per_rpm,
        )

    def _apply(self) -> None:
        cfg = self._cfg()
        self.store.run_job("pid", {}, lambda ctx: procedures.apply_pid(ctx, cfg))

    def _suggest_pi(self) -> None:
        p, i, kp, ki = suggest_pi(
            self.r_ohm.value(),
            self.l_uh.value(),
            self.bandwidth.value(),
            120_000_000 / max(1, self.store.cal.pwm_max_count),
        )
        self.torque_p.setValue(p)
        self.torque_i.setValue(i)
        self.flux_p.setValue(p)
        self.flux_i.setValue(i)
        self.store.toast("ok", f"建议 PI：P={p} · I={i}（Kp={kp:.3f}，Ki={ki:.1f}/s）")

    def _run_step(self) -> None:
        kind = self.kind
        amplitude = self.amplitude.value()
        duration = self.duration.value()
        cal = self.store.cal_dict()

        def fn(ctx):
            return procedures.step_response(ctx, kind, amplitude, duration, cal)

        self.store.run_job("step", {}, fn)
        self.step_footprint.set_text("运行中…")
        self.step_footprint.set_tone("accent")

    def _steps_changed(self, kind: str) -> None:
        if kind in ("pid", "step"):
            self.steps.set_steps(self.store.steps_by_kind.get(kind, []))

    def refresh(self) -> None:
        self.telemetry.refresh()
        running = self.store.job_running
        self.apply_btn.setEnabled(not running and self.store.connected)
        self.read_btn.setEnabled(not running and self.store.connected)
        self.cancel_btn.setEnabled(running)
        self.amplitude.setSuffix(" mA" if self.kind == "current" else " RPM")
        last = self.store.last_done
        if last and last.get("job") == "step":
            data = last.get("data") or {}
            if isinstance(data, dict) and data.get("samples"):
                cal = self.store.cal_dict()
                k = cal["counts_per_rpm"] if self.kind != "current" else cal["ma_per_count"]
                points = []
                t0 = data["samples"][0][0]
                for ts, raw in data["samples"]:
                    value = raw / k
                    points.append(((ts - t0) / 1000, value))
                self.chart.set_series([("响应", points, self.theme.accent)])
                m = data.get("metrics", {})
                self.metrics_label.setText(
                    f"上升 {m.get('rise_ms', 0):.1f} ms · 超调 {m.get('overshoot_pct', 0):.1f} % · 调节 {m.get('settle_ms', 0):.1f} ms"
                )
                self.step_footprint.set_text("已完成")
                self.step_footprint.set_tone("ok")
            elif last.get("ok") is False:
                self.step_footprint.set_text("失败")
                self.step_footprint.set_tone("danger")

    def on_show(self) -> None:
        self.steps.set_steps(self.store.steps_by_kind.get("pid", []))
        if self.store.connected:
            self._read()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.chart.theme = theme
        self.chart.update()
        self.telemetry.apply_theme(theme)
