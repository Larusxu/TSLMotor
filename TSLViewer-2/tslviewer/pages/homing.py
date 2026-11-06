"""机械找零 — MCU hard-stop homing with technology parameters."""

from __future__ import annotations

from PyQt6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ..widgets.primitives import (
    Badge,
    Button,
    Card,
    Field,
    Notice,
    NumField,
    Segmented,
    SelectField,
    StatTile,
    StepList,
    divider,
)
from .base import BasePage

DEFAULT_CONFIG = [400, 1000, 60, 800, 20, 900, 300, 20]


class HomingPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.config = list(DEFAULT_CONFIG)
        self.direction = 0
        self._build()
        self.store.stepsChanged.connect(self._steps_changed)

    def _build(self) -> None:
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        stats = QWidget()
        sh = QHBoxLayout(stats)
        sh.setContentsMargins(0, 0, 0, 0)
        sh.setSpacing(14)
        self.stat_state = StatTile("找零状态", "未确认", "")
        self.stat_limit = StatTile("实际位置", "—", "Count")
        self.stat_iq = StatTile("机构速度", "—", "rpm")
        for tile in (self.stat_state, self.stat_limit, self.stat_iq):
            sh.addWidget(tile, 1)
        self.add(stats)
        self.gw_extra = QWidget()
        extra_col = QVBoxLayout(self.gw_extra)
        extra_col.setContentsMargins(0, 0, 0, 0)
        extra_col.setSpacing(14)
        self.gw_footer = QLabel("")
        self.gw_footer.setObjectName("tiny")
        extra_col.addWidget(self.gw_footer)

        live = QWidget()
        lh = QHBoxLayout(live)
        lh.setContentsMargins(0, 0, 0, 0)
        lh.setSpacing(14)
        self.live_speed = StatTile("实际转速", "—", "RPM", "主控反馈")
        self.live_iq = StatTile("力矩电流 iQ", "—", "mA")
        self.live_temp = StatTile("温度", "—", "°C")
        for tile in (self.live_speed, self.live_iq, self.live_temp):
            lh.addWidget(tile, 1)
        self.live_row = live
        extra_col.addWidget(live)

        self.motor_card = self._motor_card()
        extra_col.addWidget(self.motor_card)
        self.add(self.gw_extra)

        self.notice = Notice("主控模式下运动、找零与判据由主控固件执行；上位机只下发授权与工艺参数。", "warn")
        self.add(self.notice)

        left = QWidget()
        lc = QVBoxLayout(left)
        lc.setContentsMargins(0, 0, 0, 0)
        lc.setSpacing(14)
        self.config_badge = Badge("未读取", "neutral")
        config_card = Card("找零参数", "HOMING TECHNOLOGY", self.config_badge)
        self.fields = {
            "k": NumField(0.4, 0.1, 2, 0.05, 2, "k"),
            "rated": NumField(1000, 1, 20000, 50, 0, "mA"),
            "confirm": NumField(60, 5, 2000, 5, 0, "ms"),
            "limit": NumField(800, 1, 20000, 50, 0, "mA"),
            "max_rpm": NumField(20, 1, 500, 1, 0, "RPM"),
            "retreat": NumField(900, 0, 20000, 50, 0, "°"),
            "settle": NumField(300, 0, 5000, 50, 0, "ms"),
            "timeout": NumField(20, 1, 300, 1, 0, "s"),
        }
        g = QGridLayout()
        g.setHorizontalSpacing(8)
        g.setVerticalSpacing(10)
        g.addWidget(Field("判定系数 k", self.fields["k"], "阈值 = k × 额定电流"), 0, 0)
        g.addWidget(Field("额定电流", self.fields["rated"], "判据基准"), 0, 1)
        g.addWidget(Field("连续确认", self.fields["confirm"], "抗瞬态"), 0, 2)
        g.addWidget(Field("找零电流上限", self.fields["limit"], "必须 > 阈值"), 0, 3)
        g.addWidget(Field("推进速度上限", self.fields["max_rpm"]), 1, 0)
        g.addWidget(Field("退开量", self.fields["retreat"], "电机端角度"), 1, 1)
        g.addWidget(Field("退开稳定等待", self.fields["settle"]), 1, 2)
        g.addWidget(Field("找零超时", self.fields["timeout"]), 1, 3)
        config_card.add_layout(g)
        self.threshold = QLabel("")
        self.threshold.setObjectName("tiny")
        config_card.add(self.threshold)
        actions = QWidget()
        ah = QHBoxLayout(actions)
        ah.setContentsMargins(0, 0, 0, 0)
        ah.setSpacing(8)
        pull = Button("从主控读取", "ghost", "sm")
        pull.clicked.connect(self._read_config)
        push = Button("写入并回读", "primary", "sm")
        push.clicked.connect(self._write_config)
        ah.addWidget(pull)
        ah.addWidget(push)
        ah.addStretch(1)
        config_card.add(actions)
        lc.addWidget(config_card)
        lc.addStretch(1)

        right = QWidget()
        rc = QVBoxLayout(right)
        rc.setContentsMargins(0, 0, 0, 0)
        rc.setSpacing(14)
        control = Card("找零控制", "HOMING · HARD-STOP", Badge("主控执行", "neutral"))
        self.dir_seg = Segmented([("0", "双端：负端 → 正端"), ("-1", "负向单端"), ("1", "正向单端")], "0")
        self.dir_seg.changed.connect(lambda v: setattr(self, "direction", int(v)))
        self.direction = 0
        self.step_unit = NumField(1500, 100, 6000, 100, 0)
        cg = QGridLayout()
        cg.setHorizontalSpacing(8)
        cg.setVerticalSpacing(8)
        cg.addWidget(Field("找零方向", self.dir_seg, "按机构方向，已反转芯片符号"), 0, 0)
        cg.addWidget(Field("每拍步进", self.step_unit, "0.01° · 1500 = 15°"), 0, 1)
        control.add_layout(cg)
        ctl = QWidget()
        ch = QHBoxLayout(ctl)
        ch.setContentsMargins(0, 0, 0, 0)
        ch.setSpacing(8)
        self.start_btn = Button("开始找零", "primary", icon_name="play")
        self.start_btn.clicked.connect(self._start)
        self.cancel_btn = Button("取消找零", "ghost")
        self.cancel_btn.clicked.connect(self._cancel)
        ch.addWidget(self.start_btn)
        ch.addWidget(self.cancel_btn)
        ch.addStretch(1)
        control.add(ctl)
        self.homing_hint = QLabel("")
        self.homing_hint.setObjectName("tiny")
        control.add(self.homing_hint)
        control.add(Notice("找零前确认：驱动器禁能、行程内无障碍、逻辑供电已开启并完成编码器校准。找零过程会撞限位，属正常工艺。", "warn"))
        rc.addWidget(control)

        flow = Card("找零流程", "MCU PROGRESS")
        self.steps = StepList()
        self.steps.setMinimumHeight(180)
        flow.add(self.steps)
        rc.addWidget(flow)

        details = Card("详细配置与存储", "ENCODER · ALIGN · PID · SAVE")
        details.add(QLabel("留在本页完成编码器、对齐、PID 和参数保存。"))
        btns = QWidget()
        bh = QHBoxLayout(btns)
        bh.setContentsMargins(0, 0, 0, 0)
        bh.setSpacing(8)
        for text, page in (("编码器与对齐", "encoder"), ("PID 与限幅", "tuning"), ("板载存储", "storage"), ("机械行程", "axis")):
            b = Button(text, "ghost", "sm")
            b.clicked.connect(lambda _=False, p=page: self.shell.navigate(p) if self.shell else None)
            bh.addWidget(b)
        bh.addStretch(1)
        details.add(btns)
        rc.addWidget(details)
        rc.addStretch(1)

        grid.addWidget(left, 0, 0)
        grid.addWidget(right, 1, 0)
        self.add(host)
        self._sync_fields()

    def _motor_card(self) -> Card:
        self.drive_badge = Badge("M1 · 未确认", "neutral")
        card = Card("电机控制", "MOTION · PERMIT", self.drive_badge)
        row = QWidget()
        rh = QHBoxLayout(row)
        rh.setContentsMargins(0, 0, 0, 0)
        rh.setSpacing(8)
        self.permit_btn = Button("开启运动授权")
        self.permit_btn.clicked.connect(self._toggle_permit)
        stop = Button("停止运行", icon_name="stop")
        stop.clicked.connect(self._stop)
        disable = Button("断使能", "ghost")
        disable.clicked.connect(self._disable)
        clear = Button("清除故障", "ghost")
        clear.clicked.connect(self._clear_fault)
        estop = Button("急停", "danger", icon_name="stop")
        estop.clicked.connect(self.store.emergency)
        for btn in (self.permit_btn, stop, disable, clear):
            rh.addWidget(btn)
        rh.addStretch(1)
        rh.addWidget(estop)
        card.add(row)
        self.mode_select = SelectField(
            [("position_direct", "位置直通"), ("position_ramp", "位置插补 · Ramp"),
             ("velocity_direct", "速度直通"), ("velocity_ramp", "速度斜坡 · Ramp")],
            "position_direct",
        )
        self.task_rpm = NumField(60, 1, 28730, 10, 0, "rpm")
        self.task_accel = NumField(10000, 1, 1000000, 1000, 0, "°/s²")
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(8)
        grid.addWidget(Field("运动模式", self.mode_select), 0, 0)
        grid.addWidget(Field("本次任务转速", self.task_rpm, "长期限幅由主控校验"), 0, 1)
        grid.addWidget(Field("加速度", self.task_accel), 0, 2)
        card.add_layout(grid)
        jog_row = QWidget()
        jh = QHBoxLayout(jog_row)
        jh.setContentsMargins(0, 0, 0, 0)
        jh.setSpacing(8)
        neg = Button("负向点动")
        neg.pressed.connect(lambda: self._jog(-1))
        neg.released.connect(self._stop)
        pos = Button("正向点动")
        pos.pressed.connect(lambda: self._jog(1))
        pos.released.connect(self._stop)
        jh.addWidget(neg)
        jh.addWidget(pos)
        jh.addStretch(1)
        card.add(jog_row)
        self.motor_note = QLabel("运动授权、驱动状态与限幅由主控判定。")
        self.motor_note.setObjectName("tiny")
        card.add(self.motor_note)
        return card

    def _toggle_permit(self) -> None:
        state = self.store.semantic.get("state")
        self.store.set_permit(not (state and state.permit))

    def _stop(self) -> None:
        def work():
            if self.store.semantic_session is None:
                return None
            return self.store.semantic_session.stop(True)

        self.store.spawn(work, lambda r: self.store._apply_semantic(r) if r else None, lambda e: None)

    def _disable(self) -> None:
        def work():
            if self.store.semantic_session is None:
                return None
            return self.store.semantic_session.stop(True)

        self.store.spawn(work, lambda r: self.store._apply_semantic(r) if r else None, lambda e: None)

    def _clear_fault(self) -> None:
        def work():
            if self.store.semantic_session is None:
                return None
            return self.store.semantic_session.command(self.store.motor, "clear_fault")

        self.store.spawn(work, lambda r: self.store._apply_semantic(r) if r else None,
                         lambda e: self.store.toast("error", str(e)))

    def _jog(self, sign: int) -> None:
        state = self.store.semantic.get("state")
        if not (state and state.permit):
            self.store.toast("warn", "请先开启运动授权")
            return
        velocity = int(sign * round(self.task_rpm.value() * self.store.cal.counts_per_rpm))

        def work():
            if self.store.semantic_session is None:
                return None
            return self.store.semantic_session.jog(velocity)

        self.store.spawn(work, lambda r: self.store._apply_semantic(r) if r else None,
                         lambda e: self.store.toast("error", str(e)))

    # ------------------------------------------------------------- helpers
    def _sync_fields(self) -> None:
        f = self.fields
        self.config = [
            int(f["k"].value() * 1000),
            int(f["rated"].value()),
            int(f["confirm"].value()),
            int(f["limit"].value()),
            int(f["max_rpm"].value()),
            int(f["retreat"].value()),
            int(f["settle"].value()),
            int(f["timeout"].value()),
        ]
        threshold = self.config[0] * self.config[1] / 1000
        self.threshold.setText(f"阈值 = {threshold:.0f} mA · 上限 {self.config[3]} mA" + ("（必须大于阈值）" if self.config[3] <= threshold else ""))

    def _apply_config(self, values: list[int]) -> None:
        f = self.fields
        f["k"].setValue(values[0] / 1000)
        f["rated"].setValue(values[1])
        f["confirm"].setValue(values[2])
        f["limit"].setValue(values[3])
        f["max_rpm"].setValue(values[4])
        f["retreat"].setValue(values[5])
        f["settle"].setValue(values[6])
        f["timeout"].setValue(values[7])
        self._sync_fields()

    def _session(self):
        session = self.store.semantic_session
        if session is None or not self.store.connected or not self.store.mode_gateway:
            self.store.toast("warn", "需切到主控模式（485 / CAN）")
            return None
        return session

    # ------------------------------------------------------------- actions
    def _read_config(self) -> None:
        session = self._session()
        if session is None:
            return

        def done(reply) -> None:
            if reply.homing_config:
                self._apply_config(reply.homing_config)
                self.config_badge.set_text("已回读")
                self.config_badge.set_tone("ok")
                self.store.toast("ok", "找零参数已回读")
            else:
                self.store.toast("warn", reply.result_name)

        self.store.spawn(session.homing_config_read, done, lambda e: self.store.toast("error", str(e)))

    def _write_config(self) -> None:
        session = self._session()
        if session is None:
            return
        self._sync_fields()
        config = self.config

        def work():
            reply = session.homing_config_write(config)
            if reply.result != 0:
                raise RuntimeError(f"写入失败：{reply.result_name}")
            check = session.homing_config_read()
            if check.homing_config != config:
                raise RuntimeError("找零参数回读不一致")
            return True

        def done(_):
            self.config_badge.set_text("已校验")
            self.config_badge.set_tone("ok")
            self.store.toast("ok", "找零参数已写入并回读确认")

        self.store.spawn(work, done, lambda e: self.store.toast("error", str(e)))

    def _start(self) -> None:
        session = self._session()
        if session is None:
            return
        self._sync_fields()
        if self.config[3] <= self.config[0] * self.config[1] / 1000:
            self.store.toast("warn", "找零电流上限必须大于判定阈值")
            return

        def work():
            check = session.homing_config_read()
            if check.homing_config != self.config:
                session.homing_config_write(self.config)
                check = session.homing_config_read()
                if check.homing_config != self.config:
                    raise RuntimeError("找零参数回读失败，请先写入确认")
            chip_direction = 0 if self.direction == 1 else 1
            reply = session.homing_start(chip_direction, int(self.step_unit.value()), self.direction == 0)
            if reply.result != 0:
                raise RuntimeError(f"主控拒绝找零：{reply.result_name}")
            return session.wait(self.config[7] + 5, lambda r: bool(r.motor and r.motor.span_valid))

        def done(reply) -> None:
            self.store._apply_semantic(reply)
            self.store.toast("ok", "找零完成，零点有效")
            self.steps.set_steps([
                type("S", (), {"idx": 1, "total": 1, "label": "主控机械找零", "status": "ok", "detail": "零点有效"})(),
            ])

        self.store.spawn(work, done, lambda e: self.store.toast("error", str(e)))

    def _cancel(self) -> None:
        session = self._session()
        if session is None:
            return
        self.store.spawn(lambda: session.stop(True), lambda r: self.store.toast("warn", "已请求取消找零"),
                         lambda e: self.store.toast("error", str(e)))

    def _steps_changed(self, kind: str) -> None:
        if kind == "homing":
            self.steps.set_steps(self.store.steps_by_kind.get("homing", []))

    def refresh(self) -> None:
        gateway = self.store.mode_gateway
        connected = self.store.connected
        state = self.store.semantic.get("state")
        self.notice.setVisible(not gateway)
        self.start_btn.setEnabled(gateway and connected)
        self.cancel_btn.setEnabled(gateway and connected and bool(state and state.motion_active))
        self.gw_extra.setVisible(gateway)
        if state:
            moving = state.motion_active or state.pending_action != 0
            self.stat_state.set_value(
                "找零中" if state.motion_owner == 2 else "已完成" if state.span_valid else "待找零",
                tone=self.theme.ok if state.span_valid else None,
            )
            self.stat_limit.set_value(
                str(state.logical_position) if state.feedback_fresh and state.coordinate_valid else "—"
            )
            speed = -state.velocity_raw * 3600000000 / 1099511627776 if state.feedback_fresh else None
            self.stat_iq.set_value("—" if speed is None else f"{speed:.1f}")
            self.gw_footer.setText(
                f"全行程 {state.logical_span if state.coordinate_valid else '—'} Count · "
                f"故障 {state.fault if state.fault else state.last_error if state.last_error else '无'}"
            )
            self.live_speed.set_value(
                "—" if not state.feedback_fresh else f"{-state.velocity_raw / self.store.cal.counts_per_rpm:.0f}"
            )
            torque = state.iq_raw * self.store.cal.ma_per_count if state.feedback_fresh else None
            self.live_iq.set_value("—" if torque is None else f"{torque:.0f}",
                                   tone=self.theme.warn if torque is not None and abs(torque) > 700 else None)
            from ..core.units import temp_c

            self.live_temp.set_value(
                "—" if state.temperature_raw is None else f"{temp_c(state.temperature_raw * 65536, self.store.cal.temp_offset):.1f}"
            )
            drive_text = ["驱动禁能", "准备中", "驱动使能", "故障"][state.drive] if state.drive < 4 else "未确认"
            self.drive_badge.set_text(f"M{self.store.motor} · {drive_text}")
            self.drive_badge.set_tone("ok" if state.drive == 2 else "neutral")
            self.permit_btn.setText("取消运动授权" if state.permit else "开启运动授权")
            self.motor_note.setText(
                f"逻辑供电 {'开' if state.logic_power else '关'} · 授权 {'有' if state.permit else '无'} · "
                f"配置 {'通过' if state.config_verified else '待确认'} · 故障 0x{state.fault:X}"
            )
            self.homing_hint.setText(f"找零前置：授权{'已开启' if state.permit else '未开启'} · 对齐{'有效' if state.align_valid else '待标定'}")
            if state.span_valid:
                self.config_badge.set_text("零点有效")
                self.config_badge.set_tone("ok")
        else:
            self.stat_state.set_value("未确认")
            self.stat_limit.set_value("—")
            self.stat_iq.set_value("—")
            self.gw_footer.setText("全行程 — Count · 故障 未确认")
            self.live_speed.set_value("—")
            self.live_iq.set_value("—")
            self.live_temp.set_value("—")
            self.drive_badge.set_text(f"M{self.store.motor} · 未确认")
            self.permit_btn.setText("开启运动授权")
            self.homing_hint.setText("等待主控状态" if gateway else "需切到主控模式（485 / CAN）")

    def on_show(self) -> None:
        self.steps.set_steps(self.store.steps_by_kind.get("homing", []))
        if self.store.mode_gateway and self.store.connected:
            self._read_config()
