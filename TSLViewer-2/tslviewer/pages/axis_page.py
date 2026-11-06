"""机械行程 — lead-screw math, soft limits and guarded motion."""

from __future__ import annotations

import time

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ..core import regs
from ..core.store import AxisLimits
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
    StatTile,
    divider,
)
from .base import BasePage


class AxisPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.lead = 2.0
        self.travel = 50.0
        self.margin = 2.0
        self.direction = 1
        self.zero = 0
        self._build()
        self.store.axisChanged.connect(self._render_state)

    def _build(self) -> None:
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        state_card = Card("轴状态", "TRAVEL GUARD")
        self.axis_badges = QWidget()
        bh = QHBoxLayout(self.axis_badges)
        bh.setContentsMargins(0, 0, 0, 0)
        bh.setSpacing(6)
        self.badge_trip = Badge("未触发", "neutral")
        self.badge_move = Badge("停止", "neutral")
        self.badge_done = Badge("—", "neutral")
        self.badge_fb = Badge("无位置反馈", "warn")
        for b in (self.badge_trip, self.badge_move, self.badge_done, self.badge_fb):
            bh.addWidget(b)
        bh.addStretch(1)
        state_card.add(self.axis_badges)
        self.pos_tile = StatTile("实际位置", "—", "mm", "编码器 32 位多圈")
        state_card.add(self.pos_tile)
        self.axis_kv = KV([
            ("位置 raw", "—"),
            ("软限位", "未启用"),
            ("计数方向", "+1 伸出"),
            ("越限动作", "刹车"),
        ])
        state_card.add(self.axis_kv)
        buttons = QWidget()
        ch = QHBoxLayout(buttons)
        ch.setContentsMargins(0, 0, 0, 0)
        ch.setSpacing(8)
        hold = Button("保持 / 停止", "ghost", "sm")
        hold.clicked.connect(self.store.axis_hold)
        clear = Button("清除越限", "ghost", "sm")
        clear.clicked.connect(self.store.axis_clear)
        ch.addWidget(hold)
        ch.addWidget(clear)
        ch.addStretch(1)
        state_card.add(buttons)
        grid.addWidget(state_card, 0, 0)

        conv = Card("丝杆换算", "LEAD SCREW")
        self.f_lead = NumField(self.lead, 0.1, 100, 0.1, 2, "mm/转")
        self.f_travel = NumField(self.travel, 1, 2000, 1, 1, "mm")
        self.f_margin = NumField(self.margin, 0, 100, 0.5, 1, "mm")
        self.f_dir = Segmented([("1", "+1 伸出"), ("-1", "-1 伸出")], "1")
        self.f_dir.changed.connect(lambda v: setattr(self, "direction", int(v)))
        for widget in (self.f_lead, self.f_travel, self.f_margin):
            widget.valueChanged.connect(lambda _: self._recompute())
        g = QGridLayout()
        g.setHorizontalSpacing(8)
        g.setVerticalSpacing(8)
        g.addWidget(Field("导程", self.f_lead, "mm/转"), 0, 0)
        g.addWidget(Field("有效行程", self.f_travel, "mm"), 0, 1)
        g.addWidget(Field("安全边距", self.f_margin, "远端"), 0, 2)
        g.addWidget(Field("计数方向", self.f_dir, "+1 伸出"), 0, 3)
        conv.add_layout(g)
        self.conv_label = QLabel("")
        self.conv_label.setObjectName("tiny")
        conv.add(self.conv_label)
        self.apply_limits_btn = Button("写入软限位", "primary", "sm")
        self.apply_limits_btn.clicked.connect(self._apply_limits)
        conv.add(self.apply_limits_btn)
        conv.add(Notice("丝杆撞到机械限位会顶坏丝母或丢步。接入位置反馈后芯片每收到一帧位置就检查一次，越界立即写 0 目标并清积分器。"))
        grid.addWidget(conv, 0, 1)

        guard = Card("行程保护", "SOFT LIMIT")
        self.feedback_ch = SelectField([(i, f"RTMI CH{i}") for i in range(7)], 0)
        self.action = Segmented([("loose", "保持"), ("brake", "刹车（PWM_OFF）")], "loose")
        gg = QGridLayout()
        gg.setHorizontalSpacing(8)
        gg.setVerticalSpacing(8)
        gg.addWidget(Field("反馈通道", self.feedback_ch, "RTMI 位置"), 0, 0)
        gg.addWidget(Field("越限动作", self.action, "触发后"), 0, 1)
        guard.add_layout(gg)
        grow = QWidget()
        gr = QHBoxLayout(grow)
        gr.setContentsMargins(0, 0, 0, 0)
        gr.setSpacing(8)
        hook = Button("接入位置反馈 0x155", "ghost", "sm")
        hook.clicked.connect(self._hook_feedback)
        apply_guard = Button("应用保护", "primary", "sm")
        apply_guard.clicked.connect(self._apply_limits)
        gr.addWidget(hook)
        gr.addWidget(apply_guard)
        gr.addStretch(1)
        guard.add(grow)
        self.fb_badge = Badge("反馈未就绪", "warn")
        guard.add(self.fb_badge)
        grid.addWidget(guard, 1, 0)

        motion = Card("受控运动", "GUARDED MOTION")
        self.jog_rpm = NumField(30, 1, 500, 5, 0, "RPM")
        self.target_mm = NumField(10, -2000, 2000, 1, 1, "mm")
        self.max_rpm = NumField(120, 1, 3000, 10, 0, "RPM")
        self.accel = NumField(200000, 1000, 10000000, 1000, 0, "counts/s²")
        mg = QGridLayout()
        mg.setHorizontalSpacing(8)
        mg.setVerticalSpacing(8)
        mg.addWidget(Field("点动速度", self.jog_rpm), 0, 0)
        mg.addWidget(Field("目标", self.target_mm), 0, 1)
        mg.addWidget(Field("速度上限", self.max_rpm), 0, 2)
        mg.addWidget(Field("加速度", self.accel), 0, 3)
        motion.add_layout(mg)
        mrow = QWidget()
        mr = QHBoxLayout(mrow)
        mr.setContentsMargins(0, 0, 0, 0)
        mr.setSpacing(8)
        neg = Button("− 点动")
        neg.pressed.connect(lambda: self._jog(-1))
        neg.released.connect(self.store.axis_hold)
        pos = Button("+ 点动")
        pos.pressed.connect(lambda: self._jog(1))
        pos.released.connect(self.store.axis_hold)
        stop = Button("停止", "danger")
        stop.clicked.connect(self.store.axis_hold)
        move = Button("按 mm 定位", "primary")
        move.clicked.connect(self._move)
        mr.addWidget(neg)
        mr.addWidget(pos)
        mr.addWidget(stop)
        mr.addWidget(move)
        mr.addStretch(1)
        motion.add(mrow)
        motion.add(Notice("所有运动都要 ARM + 勾选确认，越界目标在下发前就被拒绝。梯形速度曲线 v = min(v_max, √(2·a·Δ))，永远来得及刹车。", "warn"))
        grid.addWidget(motion, 1, 1)

        home = Card("回零向导", "FIND STOP")
        home.add(QLabel(
            "正式找零由主控固件执行（撞限位 + 电流判据），请用「电机控制与找零」。本卡是固件未实现找零时的手动兜底："
        ))
        self.home_steps = QLabel(
            "① 临时关软限位 → ② 低速缩回顶住机械限位 → ③ 停止 → ④ 「设为原点」 → ⑤ 重新写入软限位。"
        )
        self.home_steps.setObjectName("tiny")
        self.home_steps.setWordWrap(True)
        home.add(self.home_steps)
        hb = QWidget()
        hh = QHBoxLayout(hb)
        hh.setContentsMargins(0, 0, 0, 0)
        hh.setSpacing(8)
        off = Button("① 关闭软限位", "ghost", "sm")
        off.clicked.connect(self._disable_limits)
        back = Button("② 低速缩回", "ghost", "sm")
        back.pressed.connect(lambda: self._jog(-1, 5))
        back.released.connect(self.store.axis_hold)
        setzero = Button("④ 设为原点", "ghost", "sm")
        setzero.clicked.connect(self._set_zero)
        reapply = Button("⑤ 重新写入软限位", "ghost", "sm")
        reapply.clicked.connect(self._apply_limits)
        for b in (off, back, setzero, reapply):
            hh.addWidget(b)
        hh.addStretch(1)
        home.add(hb)
        self.home_badge = Badge("等待操作", "neutral")
        home.add(self.home_badge)
        grid.addWidget(home, 2, 0, 1, 2)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        self.add(host)
        self._recompute()

    # --------------------------------------------------------------- math
    def _counts_per_mm(self) -> float:
        return self.store.cal.cpr * 4 / max(0.001, self.lead)

    def _recompute(self) -> None:
        self.lead = self.f_lead.value()
        self.travel = self.f_travel.value()
        self.margin = self.f_margin.value()
        cpm = self._counts_per_mm()
        span = int((self.travel - self.margin) * cpm)
        self.limits_min = 0
        self.limits_max = span
        self.conv_label.setText(
            f"{cpm:.0f} counts/mm · 行程 {self.travel:.1f} mm → {int(self.travel * cpm)} counts · "
            f"远端安全边距 {self.margin:.1f} mm → 限位 0…{span}"
        )
        self.axis_kv.set_rows([
            ("位置 raw", str(self.store.axis.pos)),
            ("软限位", f"{0}…{span}" if self.store.axis.limits.enabled else "未启用"),
            ("计数方向", "+1 伸出" if self.direction > 0 else "-1 伸出"),
            ("越限动作", "刹车" if self.action.buttons.get("brake") and self.action.buttons["brake"].isChecked() else "保持"),
        ])

    def _pos_mm(self) -> float:
        return (self.store.axis.pos - self.zero) / self._counts_per_mm()

    # ------------------------------------------------------------- actions
    def _apply_limits(self) -> None:
        if not self.store.connected:
            self.store.toast("warn", "串口未连接")
            return
        self._recompute()
        if self.store.mode == "direct":
            def work():
                if not self.store.streaming or "pos_act" not in [s for s in self.store.channels if s]:
                    raise RuntimeError("请先接入位置反馈 0x155（RTMI 通道采实际位置）")
                self.store.link.write_verified(regs.FOC_PID_POSITION_LIMITS, self.limits_min & 0x7FFFFFFF, 0x7FFFFFFF)
                self.store.link.write_verified(0x14D, self.limits_max & 0x7FFFFFFF, 0x7FFFFFFF)
                return True

            self.store.spawn(work, lambda _: self.store.toast("ok", "软限位已写入"), lambda e: self.store.toast("error", str(e)))
        limits = AxisLimits(
            enabled=True,
            ch=int(self.feedback_ch.value() or 0),
            min=self.limits_min,
            max=self.limits_max,
            action="brake" if self.action.buttons["brake"].isChecked() else "loose",
        )
        self.store.set_axis_limits(limits)
        self.home_badge.set_text("软限位已启用")
        self.home_badge.set_tone("ok")
        self.store.toast("ok", f"软件护栏已启用：{limits.min}…{limits.max} counts")
        self._recompute()

    def _disable_limits(self) -> None:
        limits = self.store.axis.limits
        limits.enabled = False
        self.store.axis.limits = limits
        self.home_badge.set_text("软限位已关闭")
        self.home_badge.set_tone("warn")
        self.store.axisChanged.emit()

    def _hook_feedback(self) -> None:
        ch = int(self.feedback_ch.value() or 0)
        self.store.set_channel(ch, "pos_act")
        self.store.start_stream((ch, "pos_act"))
        self.fb_badge.set_text("反馈已就绪")
        self.fb_badge.set_tone("ok")

    def _jog(self, sign: int, rpm_override: float | None = None) -> None:
        if not self.store.connected:
            return
        self.store.axis_jog(sign * (rpm_override or self.jog_rpm.value()))

    def _move(self) -> None:
        if not self.store.connected:
            return
        self._recompute()
        target_mm = self.target_mm.value()
        if target_mm < 0 or target_mm > self.travel - self.margin:
            self.store.toast("warn", f"目标超出安全行程 0…{self.travel - self.margin:.1f} mm")
            return
        target = self.zero + int(target_mm * self._counts_per_mm())
        if target < self.limits_min or target > self.limits_max:
            self.store.toast("warn", "目标在软限位之外，已拒绝")
            return

        def work():
            if self.store.mode_gateway and self.store.semantic_session:
                reply = self.store.semantic_session.move(target)
                return reply
            self.store.link.write_verified(
                regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_POSITION, self.store.cal.poles), 0xFFFF
            )
            self.store.link.write_reg(regs.FOC_PID_POSITION_TARGET, target & 0xFFFFFFFF)
            return None

        self.store.toast("ok", f"定位到 {target_mm:.1f} mm（{target} counts）")
        self.store.axis.moving = True
        self.store.spawn(
            work,
            lambda r: self.store._apply_semantic(r) if r is not None else None,
            lambda e: self.store.toast("error", str(e)),
        )

    def _set_zero(self) -> None:
        self.zero = self.store.axis.pos
        if self.store.mode == "direct" and self.store.connected:
            self.store.write_reg(regs.FOC_PID_POSITION_TARGET, self.store.axis.pos & 0xFFFFFFFF)
        self.home_badge.set_text("已设原点")
        self.home_badge.set_tone("ok")
        self.store.toast("ok", f"当前位置设为原点（{self.zero} counts）")

    # -------------------------------------------------------------- render
    def _render_state(self) -> None:
        state = self.store.axis
        self.pos_tile.set_value(f"{self._pos_mm():.2f}", f"{state.pos} counts")
        self.badge_trip.set_text("已触发" if state.tripped else "未触发")
        self.badge_trip.set_tone("danger" if state.tripped else "neutral")
        self.badge_move.set_text("运行中" if state.moving else "停止")
        self.badge_move.set_tone("warn" if state.moving else "neutral")
        self.badge_done.set_text("到位" if state.done else "—")
        self.badge_done.set_tone("ok" if state.done else "neutral")
        self.badge_fb.set_text("无位置反馈" if not self.store.streaming else "反馈已就绪")
        self.badge_fb.set_tone("warn" if not self.store.streaming else "ok")
        self.axis_kv.set_rows([
            ("位置 raw", str(state.pos)),
            ("软限位", f"{state.limits.min}…{state.limits.max}" if state.limits.enabled else "未启用"),
            ("计数方向", "+1 伸出" if self.direction > 0 else "-1 伸出"),
            ("越限动作", "刹车" if state.limits.action == "brake" else "保持"),
        ])

    def refresh(self) -> None:
        self._recompute()
        self._render_state()

    def on_show(self) -> None:
        self.refresh()
