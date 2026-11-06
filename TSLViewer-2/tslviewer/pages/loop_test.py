"""环路测试 — constant Iq/speed probes, speed-PI identification and position following."""

from __future__ import annotations

import math
import time

from PyQt6.QtWidgets import (
    QCheckBox,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import procedures, regs
from ..core.units import fmt
from ..theme import mono_font
from ..widgets.charts import LineChart
from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    KV,
    Notice,
    NumField,
    Segmented,
    StatTile,
    StepList,
    divider,
)
from .base import BasePage


class LoopTestPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.mode = "iq"
        self.pos_kind = "step"
        self._build()
        self.store.stepsChanged.connect(self._steps_changed)

    def _build(self) -> None:
        stats = QWidget()
        sh = QHBoxLayout(stats)
        sh.setContentsMargins(0, 0, 0, 0)
        sh.setSpacing(14)
        self.stat_state = StatTile("测试状态", "待机", "")
        self.stat_pos = StatTile("位置", "—", "°")
        self.stat_motion = StatTile("速度 / 电流", "—", "RPM")
        for tile in (self.stat_state, self.stat_pos, self.stat_motion):
            sh.addWidget(tile, 1)
        self.add(stats)

        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        # ---------------------------------------------------------- ① constant
        const = Card("① 恒 Iq / 恒速度", "CONSTANT PROBE", Badge("受保护行程内", "neutral"))
        self.mode_seg = Segmented([("iq", "恒 Iq"), ("rpm", "恒速度")], "iq")
        self.mode_seg.changed.connect(lambda v: setattr(self, "mode", v))
        self.const_iq = NumField(200, 1, 800, 10, 0, "mA")
        self.const_rpm = NumField(60, 1, 3000, 10, 0, "RPM")
        self.current_limit = NumField(800, 1, 8192, 10, 0, "mA")
        self.boundary = Segmented([("hold", "保持"), ("stop", "停止")], "hold")
        self.laps = NumField(1, 1, 100, 1, 0)
        self.seg_start = NumField(20, 0, 100, 5, 0, "%")
        self.seg_end = NumField(80, 0, 100, 5, 0, "%")
        cg = QGridLayout()
        cg.setHorizontalSpacing(8)
        cg.setVerticalSpacing(8)
        cg.addWidget(Field("给定类型", self.mode_seg), 0, 0)
        cg.addWidget(Field("Iq 给定", self.const_iq), 0, 1)
        cg.addWidget(Field("速度给定", self.const_rpm), 0, 2)
        cg.addWidget(Field("电流上限", self.current_limit, "0x14A[30:16]"), 0, 3)
        cg.addWidget(Field("边界策略", self.boundary, "到边界后"), 1, 0)
        cg.addWidget(Field("整程圈数", self.laps, "8 等分的基准"), 1, 1)
        cg.addWidget(Field("测试行程起段", self.seg_start), 1, 2)
        cg.addWidget(Field("测试行程止段", self.seg_end), 1, 3)
        const.add_layout(cg)
        crow = QWidget()
        cr = QHBoxLayout(crow)
        cr.setContentsMargins(0, 0, 0, 0)
        cr.setSpacing(8)
        self.const_start = Button("开始探测", "primary", icon_name="play")
        self.const_start.clicked.connect(self._run_constant)
        self.const_stop = Button("停止", "ghost")
        self.const_stop.clicked.connect(self._stop_all)
        cr.addWidget(self.const_start)
        cr.addWidget(self.const_stop)
        cr.addStretch(1)
        const.add(crow)
        grid.addWidget(const, 0, 0)

        # ------------------------------------------------------------- ② PI
        ident = Card("② 速度 PI 自动辨识", "0x145", Badge("候选倍率扫描", "neutral"))
        self.id_speed = NumField(300, 1, 5000, 10, 0, "RPM")
        self.id_limit = NumField(800, 1, 8192, 10, 0, "mA")
        self.id_kp = NumField(500, 1, 32767, 10, 0)
        self.id_ki = NumField(250, 0, 32767, 10, 0)
        self.id_scale = QLabel("0.5, 1, 2")
        self.id_group = NumField(2, 0.5, 10, 0.5, 1, "s")
        ig = QGridLayout()
        ig.setHorizontalSpacing(8)
        ig.setVerticalSpacing(8)
        ig.addWidget(Field("测试速度", self.id_speed, "符号按行程自动换"), 0, 0)
        ig.addWidget(Field("电流上限", self.id_limit, "顶限判废的门槛"), 0, 1)
        ig.addWidget(Field("基准 Kp", self.id_kp), 0, 2)
        ig.addWidget(Field("基准 Ki", self.id_ki), 0, 3)
        ig.addWidget(Field("倍率", self.id_scale, "逗号分隔"), 1, 0)
        ig.addWidget(Field("每组时间", self.id_group, "稳定时间取 30%"), 1, 1)
        ident.add_layout(ig)
        self.id_table = QTableWidget(0, 6)
        self.id_table.setHorizontalHeaderLabels(["Kp", "Ki", "errRMS", "|errMean|", "Iqσ", "顶限"])
        self.id_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.id_table.verticalHeader().setVisible(False)
        self.id_table.setMinimumHeight(130)
        ident.add(self.id_table)
        irow = QWidget()
        ir = QHBoxLayout(irow)
        ir.setContentsMargins(0, 0, 0, 0)
        ir.setSpacing(8)
        self.id_start = Button("开始辨识", "primary", icon_name="play")
        self.id_start.clicked.connect(self._run_ident)
        ir.addWidget(self.id_start)
        ir.addWidget(QLabel("每组重复 3 次、正反各一遍，饱和样本整组判废"))
        ir.addStretch(1)
        ident.add(irow)
        grid.addWidget(ident, 0, 1)

        # -------------------------------------------------------- ③ position
        pos = Card("③ 位置环测试", "MOTION_MODE=POSITION", Badge("位置跟随", "neutral"))
        self.pos_seg = Segmented([("step", "往复"), ("sine", "正弦"), ("hold", "保持")], "step")
        self.pos_seg.changed.connect(lambda v: setattr(self, "pos_kind", v))
        self.pos_start_seg = NumField(20, 0, 100, 5, 0, "%")
        self.pos_end_seg = NumField(80, 0, 100, 5, 0, "%")
        self.pos_period = NumField(4, 0.2, 60, 0.5, 1, "s")
        self.pos_a = NumField(0, -100000, 100000, 10, 0)
        self.pos_b = NumField(360, -100000, 100000, 10, 0)
        self.pos_cycles = NumField(1, 0, 1000, 1, 0)
        self.pos_center = NumField(180, -100000, 100000, 10, 0)
        self.pos_amp = NumField(90, 0, 100000, 10, 0)
        self.pos_vel = NumField(300, 0, 100000, 10, 0)
        self.pos_cur = NumField(800, 0, 8192, 10, 0, "mA")
        pg = QGridLayout()
        pg.setHorizontalSpacing(8)
        pg.setVerticalSpacing(8)
        pg.addWidget(Field("测试类型", self.pos_seg), 0, 0)
        pg.addWidget(Field("位置行程起段", self.pos_start_seg), 0, 1)
        pg.addWidget(Field("位置行程止段", self.pos_end_seg), 0, 2)
        pg.addWidget(Field("周期", self.pos_period), 0, 3)
        pg.addWidget(Field("A 点", self.pos_a), 1, 0)
        pg.addWidget(Field("B 点", self.pos_b), 1, 1)
        pg.addWidget(Field("循环数", self.pos_cycles, "0 = 无限"), 1, 2)
        pg.addWidget(Field("中心", self.pos_center), 1, 3)
        pg.addWidget(Field("幅值", self.pos_amp), 2, 0)
        pg.addWidget(Field("速度限制", self.pos_vel, "写 0x14B"), 2, 1)
        pg.addWidget(Field("电流限制", self.pos_cur, "写 0x14A"), 2, 2)
        pos.add_layout(pg)
        prow = QWidget()
        pr = QHBoxLayout(prow)
        pr.setContentsMargins(0, 0, 0, 0)
        pr.setSpacing(8)
        self.pos_start = Button("开始位置测试", "primary", icon_name="play")
        self.pos_start.clicked.connect(self._run_position)
        self.pos_stop = Button("停止", "ghost")
        self.pos_stop.clicked.connect(self._stop_all)
        pr.addWidget(self.pos_start)
        pr.addWidget(self.pos_stop)
        pr.addStretch(1)
        pos.add(prow)
        grid.addWidget(pos, 1, 0, 1, 2)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)

        live = Card("实时值", "LIVE · 60 ms", Badge("主控采样", "neutral"))
        self.live_kv = KV([
            ("位置", "—"),
            ("速度", "—"),
            ("Iq", "—"),
            ("模式", "—"),
        ])
        live.add(self.live_kv)
        grid.addWidget(live, 2, 0)
        self.add(host)

        wave = Card("波形", "CAPTURE")
        self.clear_btn = Button("清空", "ghost", "sm")
        self.clear_btn.clicked.connect(lambda: self.chart.clear())
        wave.body.insertWidget(0, row_widget(self.clear_btn))
        self.chart = LineChart(self.theme, 260, "值")
        wave.add(self.chart)
        self.add(wave)

        bottom = QWidget()
        bg = QGridLayout(bottom)
        bg.setContentsMargins(0, 0, 0, 0)
        bg.setHorizontalSpacing(14)
        bg.setVerticalSpacing(14)
        flow = Card("测试流程", "HOST STEPS", Badge("上位机执行", "neutral"))
        self.steps = StepList()
        self.steps.setMinimumHeight(190)
        flow.add(self.steps)
        bg.addWidget(flow, 0, 0)
        notes = Card("TMC6460 侧要改的地方", "NOTES")
        notes.add(KV([
            ("电流刻度", "s16A / 归一值两套 → 统一 mA（0.20131 mA/LSB）"),
            ("恒 Iq 限流", "0x14A[30:16] 钳的是力矩目标，力矩模式也生效"),
            ("速度环系数", "0x145[31:16]=P / [15:0]=I，受 0x140 归一化影响"),
            ("PI 输出", "无独立寄存器，用 0x153[31:16] 代替"),
            ("位置计数器", "0x152/0x155 是 32 位多圈，不是 16 位"),
            ("行程护栏", "0x14C/0x14D 可做硬件兜底，老固件只有上位机看门"),
        ]))
        bg.addWidget(notes, 0, 1)
        gate = Card("安全门控", "SAFETY")
        self.safe1 = QCheckBox("已确认测试行程两端有足够余量")
        self.safe2 = QCheckBox("已完成机械找零与电角度对齐")
        self.safe3 = QCheckBox("测试区域无人、机构无干涉")
        self.safe4 = QCheckBox("已确认急停手段可用")
        for box in (self.safe1, self.safe2, self.safe3, self.safe4):
            box.toggled.connect(lambda _: self.refresh())
            gate.add(box)
        self.gate_hint = QLabel("未勾选安全确认时所有启动按钮禁用。")
        self.gate_hint.setObjectName("tiny")
        gate.add(self.gate_hint)
        estop = Button("急停", "danger", icon_name="stop")
        estop.clicked.connect(self.store.emergency)
        gate.add(estop)
        bg.addWidget(gate, 1, 0, 1, 2)
        self.add(bottom)

    # -------------------------------------------------------------- actions
    def _safety(self) -> bool:
        return all(b.isChecked() for b in (self.safe1, self.safe2, self.safe3, self.safe4))

    def _run_constant(self) -> None:
        if not self._safety():
            self.store.toast("warn", "请先勾选安全确认")
            return
        mode = self.mode
        iq = self.const_iq.value()
        rpm = self.const_rpm.value()
        duration = 5.0
        cal = self.store.cal_dict()

        def fn(ctx: procedures.Ctx):
            link = self.store.link
            ctx.total = 5
            ctx.begin("安全态")
            procedures.ensure_stopped(link)
            link.stop_rtmi()
            ctx.ok("安全态", "驱动器已静止")
            ctx.begin("配置 RTMI")
            link.start_rtmi([(0, regs.FOC_PID_VELOCITY_TARGET), (1, regs.FOC_PID_VELOCITY_ACTUAL), (2, regs.FOC_PID_TORQUE_FLUX_ACTUAL)], 0, False)
            capture = procedures.Capture(link)
            ctx.ok("配置 RTMI", "3 通道")
            ctx.begin("使能")
            gdrv = link.read_reg_retry(regs.MCC_GDRV, 3)
            link.write_verified(regs.MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x80010000)
            if mode == "iq":
                link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_TORQUE, cal["poles"]), 0xFFFF)
                link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, int(iq / cal["ma_per_count"]) & 0xFFFF)
            else:
                link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_VELOCITY, cal["poles"]), 0xFFFF)
                link.write_reg(regs.FOC_PID_VELOCITY_TARGET, round(rpm * cal["counts_per_rpm"]) & 0xFFFFFFFF)
            ctx.ok("使能", f"{'恒 Iq ' + str(int(iq)) + ' mA' if mode == 'iq' else '恒速度 ' + str(int(rpm)) + ' RPM'}")
            ctx.begin("采集")
            ctx.sleep(duration * 1000)
            ctx.ok("采集", f"{len(capture.records)} 帧")
            ctx.begin("停止")
            link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0)
            link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, 0)
            link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, cal["poles"]))
            link.stop_rtmi()
            capture.close()
            ctx.ok("停止", "PWM_OFF")
            by: dict[int, list] = {}
            for ts, ch, raw in capture.records:
                by.setdefault(ch, []).append((ts, raw))
            return {"by": by, "mode": mode}

        self.store.run_job("looptest", {}, fn)
        self._pending = "constant"

    def _run_ident(self) -> None:
        if not self._safety():
            self.store.toast("warn", "请先勾选安全确认")
            return
        speed = self.id_speed.value()
        limit = self.id_limit.value()
        base_kp = self.id_kp.value()
        base_ki = self.id_ki.value()
        group_s = self.id_group.value()
        cal = self.store.cal_dict()
        scales = [0.5, 1.0, 2.0]

        def fn(ctx: procedures.Ctx):
            results = []
            ctx.total = len(scales) * 3
            for scale in scales:
                kp = max(1, round(base_kp * scale))
                ki = max(0, round(base_ki * scale))
                ctx.begin(f"Kp={kp} Ki={ki} · 采集")
                capture = procedures.capture_prbs(ctx, 2, speed, group_s, cal)
                ctx.ok("采集", f"{capture.count} 组")
                ctx.begin("统计")
                errs = []
                means = []
                effort = []
                for s in capture.samples:
                    errs.append(s.actual - s.reference)
                    means.append(abs(s.actual - s.reference))
                    effort.append(abs(s.effort))
                rms = math.sqrt(sum(e * e for e in errs) / max(1, len(errs)))
                mean = sum(means) / max(1, len(means))
                sigma = math.sqrt(sum((e - sum(effort) / max(1, len(effort))) ** 2 for e in effort) / max(1, len(effort))) if effort else 0
                saturated = any(abs(e) >= limit / cal["ma_per_count"] * 0.98 for e in effort)
                results.append({
                    "kp": kp, "ki": ki, "err_rms": rms, "err_mean": mean,
                    "iq_sigma": sigma * cal["ma_per_count"], "saturated": saturated,
                })
                ctx.ok("统计", f"errRMS={rms:.1f} · {'顶限' if saturated else '未饱和'}")
                ctx.begin("试用")
                if not saturated:
                    word = (kp << 16) | (ki & 0xFFFF)
                    self.store.link.write_verified(regs.FOC_PID_VELOCITY_COEFF, word, 0xFFFFFFFF)
                    ctx.ok("试用", f"0x{word:08X}")
                else:
                    ctx.ok("试用", "饱和 → 保留原参数")
            return {"ident": results}

        self.store.run_job("looptest", {}, fn)
        self._pending = "ident"

    def _run_position(self) -> None:
        if not self._safety():
            self.store.toast("warn", "请先勾选安全确认")
            return
        kind = self.pos_kind
        period = self.pos_period.value()
        a = self.pos_a.value()
        b = self.pos_b.value()
        center = self.pos_center.value()
        amp = self.pos_amp.value()
        cycles = max(1, int(self.pos_cycles.value()))
        cal = self.store.cal_dict()

        def fn(ctx: procedures.Ctx):
            link = self.store.link
            ctx.total = 4
            ctx.begin("安全态")
            procedures.ensure_stopped(link)
            link.stop_rtmi()
            link.start_rtmi([(0, regs.FOC_PID_POSITION_TARGET), (1, regs.FOC_PID_POSITION_ACTUAL)], 0, False)
            capture = procedures.Capture(link)
            gdrv = link.read_reg_retry(regs.MCC_GDRV, 3)
            link.write_verified(regs.MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x80010000)
            link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_POSITION, cal["poles"]), 0xFFFF)
            ctx.ok("使能", "POSITION 模式")
            ctx.begin("执行轨迹")
            steps = int(period * 100)
            for i in range(steps * cycles):
                if ctx.cancelled():
                    break
                phase = (i / steps) % 1
                if kind == "sine":
                    pos = center + amp * math.sin(2 * math.pi * phase)
                elif kind == "hold":
                    pos = center
                else:
                    pos = a + (b - a) * phase
                link.write_reg(regs.FOC_PID_POSITION_TARGET, int(pos) & 0xFFFFFFFF)
                ctx.sleep(10)
            ctx.ok("执行轨迹", f"{cycles} 周期")
            ctx.begin("停止")
            link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, cal["poles"]))
            link.stop_rtmi()
            capture.close()
            ctx.ok("停止", "PWM_OFF")
            by: dict[int, list] = {}
            for ts, ch, raw in capture.records:
                by.setdefault(ch, []).append((ts, raw))
            ctx.begin("结果")
            ctx.ok("结果", f"{sum(len(v) for v in by.values())} 帧")
            return {"by": by, "kind": kind}

        self.store.run_job("looptest", {}, fn)
        self._pending = "position"

    def _stop_all(self) -> None:
        self.store.cancel_job()
        self.store.stop_motion()
        self.store.stop_stream()

    def _steps_changed(self, kind: str) -> None:
        if kind == "looptest":
            self.steps.set_steps(self.store.steps_by_kind.get("looptest", []))

    # --------------------------------------------------------------- render
    def refresh(self) -> None:
        running = self.store.job_running
        safety = self._safety()
        connected = self.store.connected
        for btn in (self.const_start, self.id_start, self.pos_start):
            btn.setEnabled(connected and safety and not running)
        self.const_stop.setEnabled(running)
        self.pos_stop.setEnabled(running)
        self.gate_hint.setVisible(not safety)
        self.stat_state.set_value("运行中" if running else "待机")
        self.stat_state.value.setStyleSheet(f"color:{self.theme.accent};" if running else f"color:{self.theme.text};")
        pos = self.store.scope.latest.get(0)
        if pos is not None:
            self.stat_pos.set_value(fmt(pos, 1), "RTMI CH0")
        speed = self.store.scope.latest.get(1)
        torque = self.store.scope.latest.get(2)
        if speed is not None or torque is not None:
            self.stat_motion.set_value(fmt(speed or 0, 0), f"Iq {fmt(torque or 0, 0)} mA")
        state = self.store.semantic.get("state")
        if state:
            self.live_kv.set_rows([
                ("位置", str(state.position)),
                ("速度", f"{state.velocity_raw / self.store.cal.counts_per_rpm:.0f} RPM"),
                ("Iq", f"{state.iq_raw * self.store.cal.ma_per_count:.0f} mA"),
                ("模式", str(state.mode)),
            ])
        last = self.store.last_done
        if last and last.get("job") == "looptest" and last.get("ok"):
            data = last.get("data") or {}
            if isinstance(data, dict) and data.get("ident"):
                rows = data["ident"]
                self.id_table.setRowCount(len(rows))
                for i, item in enumerate(rows):
                    values = [
                        f"{item['kp']:.0f}", f"{item['ki']:.0f}", f"{item['err_rms']:.1f}",
                        f"{item['err_mean']:.1f}", f"{item['iq_sigma']:.0f}", "是" if item["saturated"] else "否",
                    ]
                    for j, text in enumerate(values):
                        cell = QTableWidgetItem(text)
                        cell.setFont(mono_font(10))
                        self.id_table.setItem(i, j, cell)
            if isinstance(data, dict) and data.get("by"):
                by = data["by"]
                series = []
                for ch, pts in by.items():
                    if not pts:
                        continue
                    t0 = pts[0][0]
                    color = self.theme.ch[ch % len(self.theme.ch)]
                    series.append((f"CH{ch}", [((ts - t0) / 1000, raw) for ts, raw in pts[:4000]], color))
                self.chart.set_series(series)

    def on_show(self) -> None:
        self.steps.set_steps(self.store.steps_by_kind.get("looptest", []))
        self.refresh()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.chart.theme = theme
        self.chart.update()


def row_widget(*widgets) -> QWidget:
    host = QWidget()
    h = QHBoxLayout(host)
    h.setContentsMargins(0, 0, 0, 0)
    h.setSpacing(8)
    for w in widgets:
        h.addWidget(w)
    h.addStretch(1)
    return host
