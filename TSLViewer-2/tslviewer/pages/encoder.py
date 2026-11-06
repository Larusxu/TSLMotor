"""编码器与对齐 — MT6701 SSI configuration and phi_e alignment."""

from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
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

from ..core import procedures
from ..core.presets import ENCODER_PRESETS, PHI_E_OFFSETS, STORAGE_PRESETS
from ..core.units import (
    fmt,
    hexs,
    spi_half_period,
    spi_hz_from_half,
    ssi_frame_seconds,
)
from ..theme import mono_font
from ..widgets.charts import AngleGauge
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
    TextField,
    Toggle,
    divider,
)
from .base import BasePage


class EncoderPage(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self.snapshot: dict[int, int] = {}
        self.live_raw = 0
        self.live_phi = 0
        self.live_on = False
        self._build()
        self._live_timer = QTimer(self)
        self._live_timer.setInterval(300)
        self._live_timer.timeout.connect(self._read_live)
        self.store.stepsChanged.connect(self._steps_changed)

    # ------------------------------------------------------------------ UI
    def _build(self) -> None:
        self.gateway_card = self._gateway_card()
        self.add(self.gateway_card)

        self.direct_host = QWidget()
        grid = QGridLayout(self.direct_host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(14)

        preset = ENCODER_PRESETS[0]
        self.preset_select = SelectField([(p.id, p.label) for p in ENCODER_PRESETS], preset.id)
        self.preset_select.currentIndexChanged.connect(self._apply_preset)
        self.storage_select = SelectField([(s.id, s.label) for s in STORAGE_PRESETS], STORAGE_PRESETS[0].id)
        self.poles = NumField(self.store.cal.poles, 1, 127, 1, 0)
        self.cpr = NumField(self.store.cal.cpr, 16, 1 << 22, 1, 0)
        self.offset = NumField(48000, 0, 65535, 1, 0)
        self.offset_src = SelectField(
            [("__calib", "初次电角度偏置标定"), ("", "— 手动 —")]
            + [(name, f"{name} · {value}") for name, value in PHI_E_OFFSETS],
            "__calib",
        )
        self.offset_src.currentIndexChanged.connect(self._offset_source_changed)
        self.frame_bits = SelectField([(14, "14 bit · 角度"), (24, "24 bit · 全帧")], 14)
        self.frame_bits.currentIndexChanged.connect(lambda: self._refresh_derived())
        self.spi_mode = SelectField([(v, f"模式 {v}") for v in range(4)], 1)
        self.spi_hz = NumField(preset.spi_hz, 117_188, 3_000_000, 100_000, 0, "Hz")
        self.spi_hz.valueChanged.connect(lambda _: self._refresh_derived())
        self.idle = NumField(preset.idle_cycles, 0, 255, 1, 0)
        self.idle.valueChanged.connect(lambda _: self._refresh_derived())
        self.mask = TextField("0x00003FFF")
        self.mask.setReadOnly(True)
        self.send_data = TextField("0x00000000")
        self.pwm_count = NumField(self.store.cal.pwm_max_count, 600, 20000, 10, 0)
        self.csa = SelectField([(v, f"{label} · {full}") for v, label, full in (
            (0, "1×", "6.60 A"), (1, "2×", "3.30 A"), (2, "3×", "2.20 A"), (3, "4×", "1.65 A")
        )], self.store.cal.csa_gain)
        self.write_vel = QCheckBox("同时写入测速配置")
        self.vel_frq = TextField("0x000DA71E")
        self.vel_per = TextField("0xFFF00001")
        self.first_calib = QCheckBox("电角度偏置待标定（本次不写 0x242）")
        self.first_calib.setChecked(True)
        self.first_calib.toggled.connect(lambda checked: self.offset.setEnabled(not checked))
        self.offset.setEnabled(False)
        self.confirm = QCheckBox("确认写入 IO_MATRIX / IO Controller / FEEDBACK（会立即改变换相行为）")

        self.preset_badge = Badge(preset.label, "neutral")
        card = Card("编码器参数", "MT6701 · SSI", self.preset_badge)
        top = QWidget()
        tg = QGridLayout(top)
        tg.setContentsMargins(0, 0, 0, 0)
        tg.setHorizontalSpacing(10)
        tg.setVerticalSpacing(10)
        tg.addWidget(Field("编码器", self.preset_select, "选择后自动填充"), 0, 0)
        tg.addWidget(Field("板上存储", self.storage_select, STORAGE_PRESETS[0].spec), 0, 1)
        tg.addWidget(Field("极对数", self.poles, "PHI_E_MUL_FACTOR"), 1, 0)
        tg.addWidget(Field("编码器步数 CPR", self.cpr), 1, 1)
        tg.addWidget(Field("电角度偏置", self.offset, "0x242"), 1, 2)
        tg.addWidget(Field("写入已知偏移", self.offset_src, "预设偏移"), 1, 3)
        tg.addWidget(Field("帧长度", self.frame_bits, "SPI_BIT_CNT"), 2, 0)
        tg.addWidget(Field("SPI 模式", self.spi_mode, "CPOL/CPHA"), 2, 1)
        tg.addWidget(Field("SCK 频率", self.spi_hz, "half 自动"), 2, 2)
        tg.addWidget(Field("CSN 高电平", self.idle, "空闲周期"), 2, 3)
        tg.addWidget(Field("数据掩码", self.mask, "RESPONSE_2"), 3, 0)
        tg.addWidget(Field("发送数据", self.send_data, "RESPONSE_1"), 3, 1)
        tg.addWidget(Field("PWM MAX_COUNT", self.pwm_count, "fPWM = 120 MHz / n"), 3, 2)
        tg.addWidget(Field("CSA 增益", self.csa, f"{self.store.cal.ma_per_count:.3f} mA/LSB"), 3, 3)
        card.add(top)
        self.derived_label = QLabel("")
        self.derived_label.setObjectName("tiny")
        card.add(self.derived_label)
        opts = QWidget()
        oh = QHBoxLayout(opts)
        oh.setContentsMargins(0, 0, 0, 0)
        oh.setSpacing(14)
        oh.addWidget(self.write_vel)
        oh.addWidget(self.first_calib)
        m9 = Button("载入 M9 实测测速配置", "ghost", "sm")
        m9.clicked.connect(self._load_m9)
        oh.addWidget(m9)
        oh.addStretch(1)
        card.add(opts)
        self.vel_row = QWidget()
        vr = QHBoxLayout(self.vel_row)
        vr.setContentsMargins(0, 0, 0, 0)
        vr.setSpacing(10)
        vr.addWidget(Field("0x244 VELOCITY_FRQ_CONF", self.vel_frq), 1)
        vr.addWidget(Field("0x245 VELOCITY_PER_CONF", self.vel_per), 1)
        card.add(self.vel_row)
        self.write_vel.toggled.connect(self.vel_row.setVisible)
        self.vel_row.setVisible(False)
        card.add(Notice("测速配置用于芯片的速度反馈与速度环更新，不是设置电机转速。不勾选会保留当前 0x244/0x245；首次配置或复位后，请按该电机已验证的参数显式写入。"))
        card.add(divider(self.theme))
        card.add(self.confirm)
        buttons = QWidget()
        bh = QHBoxLayout(buttons)
        bh.setContentsMargins(0, 0, 0, 0)
        bh.setSpacing(8)
        self.write_btn = Button("写入并回读", "primary", icon_name="save")
        self.write_btn.clicked.connect(self._write)
        live = Button("读取实时角度", "ghost")
        live.clicked.connect(self._read_live)
        self.live_toggle = Toggle(False)
        self.live_toggle.toggled.connect(self._toggle_live)
        live_label = QLabel("连续回读（260 ms）")
        live_label.setObjectName("tiny")
        bh.addWidget(self.write_btn)
        bh.addWidget(live)
        bh.addWidget(live_label)
        bh.addWidget(self.live_toggle)
        bh.addStretch(1)
        card.add(buttons)
        grid.addWidget(card, 0, 0)

        side = QWidget()
        sc = QVBoxLayout(side)
        sc.setContentsMargins(0, 0, 0, 0)
        sc.setSpacing(14)
        self.flow_card = Card("配置流程", "WRITE · ALIGN", Badge("空闲", "neutral"))
        self.write_steps = StepList()
        self.write_steps.setMinimumHeight(150)
        self.flow_card.add(self.write_steps)
        align_title = QLabel("电角度对齐")
        align_title.setObjectName("fieldLabel")
        self.flow_card.add(align_title)
        self.align_steps = StepList()
        self.align_steps.setMinimumHeight(150)
        self.flow_card.add(self.align_steps)
        sc.addWidget(self.flow_card)
        sc.addStretch(1)
        grid.addWidget(side, 0, 1)
        grid.setColumnStretch(0, 3)
        grid.setColumnStretch(1, 2)

        check_card = Card("写入校验", "EXPECTED vs ACTUAL")
        self.check_table = QTableWidget(0, 3)
        self.check_table.setHorizontalHeaderLabels(["寄存器", "期望", "实际"])
        self.check_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.check_table.verticalHeader().setVisible(False)
        self.check_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.check_table.setMinimumHeight(180)
        check_card.add(self.check_table)
        grid.addWidget(check_card, 1, 0)

        angle_card = Card("角度回读", "PHI_EXT_A / PHI_E")
        gauges = QWidget()
        gh = QHBoxLayout(gauges)
        gh.setContentsMargins(0, 0, 0, 0)
        gh.setSpacing(8)
        self.gauge_mech = AngleGauge(self.theme, "MECHANICAL")
        self.gauge_elec = AngleGauge(self.theme, "ELECTRICAL")
        gh.addWidget(self.gauge_mech)
        gh.addWidget(self.gauge_elec)
        gh.addStretch(1)
        angle_card.add(gauges)
        self.angle_kv = KV([
            ("PHI_EXT_A", "—"),
            ("PHI_CONVERTED", "—"),
            ("PHI_E", "—"),
            ("角度", "0.0°"),
        ])
        angle_card.add(self.angle_kv)
        self.angle_notice = Notice("PHI_EXT_A 为 0：检查 SCK/SDO/CSN 接线与预置数据。", "warn")
        angle_card.add(self.angle_notice)
        grid.addWidget(angle_card, 1, 1)

        align_card = Card("电角度对齐（开环拖动）", "PHI_E ALIGN", Badge("拟合后写回 0x242", "neutral"))
        self.align_flux = NumField(300, 20, 2000, 10, 0, "mA")
        self.align_settle = NumField(700, 100, 3000, 50, 0, "ms")
        self.align_step = NumField(90, 10, 180, 5, 0, "°")
        self.align_end = NumField(720, 180, 1440, 30, 0, "°")
        ag = QGridLayout()
        ag.setHorizontalSpacing(8)
        ag.setVerticalSpacing(8)
        ag.addWidget(Field("对齐电流", self.align_flux, "Tesla 限幅 800 mA"), 0, 0)
        ag.addWidget(Field("稳定时间", self.align_settle), 0, 1)
        ag.addWidget(Field("步进角度", self.align_step), 0, 2)
        ag.addWidget(Field("扫描终点", self.align_end, "≥ 2 个电周期"), 0, 3)
        align_card.add_layout(ag)
        self.write_back = QCheckBox("拟合 R² > 0.9 时写回 0x242")
        self.write_back.setChecked(True)
        self.dry_run = QCheckBox("干跑（不扫描、不写回）")
        align_card.add(self.write_back)
        align_card.add(self.dry_run)
        align_actions = QWidget()
        aah = QHBoxLayout(align_actions)
        aah.setContentsMargins(0, 0, 0, 0)
        aah.setSpacing(8)
        self.align_btn = Button("开始对齐", "primary", icon_name="play")
        self.align_btn.clicked.connect(self._align)
        self.align_badge = Badge("未对齐", "neutral")
        aah.addWidget(self.align_btn)
        aah.addWidget(self.align_badge)
        aah.addStretch(1)
        align_card.add(align_actions)
        self.align_result = QLabel("—")
        self.align_result.setObjectName("tiny")
        align_card.add(self.align_result)
        align_card.add(Notice("开环电流拖动电角度，步进 90° 扫描 2 个电周期，取 4 点做拟合，回写 0x242。对齐电流默认 300 mA；Tesla 电机限幅仅 800 mA。", "warn"))
        grid.addWidget(align_card, 2, 0, 1, 2)

        self.direct_host.layout().setRowStretch(0, 0)
        self.add(self.direct_host)
        self._refresh_derived()

    def _gateway_card(self) -> Card:
        self.gw_align = Card("主控电角度对齐", "MCU ALIGNMENT", Badge("主控执行", "neutral"))
        self.gw_align.add(Notice("主控模式下对齐由 MCU 固件执行：扫描、拟合、写回与校验都在主控完成，上位机只下发工艺参数。"))
        self.gw_scan = NumField(720, 360, 1080, 30, 0, "°")
        self.gw_step = NumField(90, 15, 180, 15, 0, "°")
        self.gw_settle = NumField(700, 100, 1000, 50, 0, "ms")
        self.gw_current = NumField(300, 50, 500, 10, 0, "mA")
        g = QGridLayout()
        g.setHorizontalSpacing(8)
        g.setVerticalSpacing(8)
        g.addWidget(Field("扫描范围", self.gw_scan), 0, 0)
        g.addWidget(Field("步进", self.gw_step), 0, 1)
        g.addWidget(Field("稳定时间", self.gw_settle), 0, 2)
        g.addWidget(Field("对齐电流", self.gw_current), 0, 3)
        self.gw_align.add_layout(g)
        run = Button("开始主控对齐", "primary", icon_name="play")
        run.clicked.connect(self._gateway_align)
        self.gw_align.add(run)
        self.gw_result = QLabel("等待操作")
        self.gw_result.setObjectName("tiny")
        self.gw_align.add(self.gw_result)
        self.gw_steps = StepList()
        self.gw_steps.setMinimumHeight(180)
        self.gw_align.add(self.gw_steps)
        return self.gw_align

    # -------------------------------------------------------------- helpers
    def _apply_preset(self) -> None:
        preset = next((p for p in ENCODER_PRESETS if p.id == self.preset_select.value()), ENCODER_PRESETS[0])
        self.frame_bits.setCurrentIndex(0 if preset.frame_bits == 14 else 1)
        self.spi_mode.setCurrentIndex(preset.spi_mode)
        self.spi_hz.setValue(preset.spi_hz)
        self.idle.setValue(preset.idle_cycles)
        self.send_data.setText(f"0x{preset.send_data:08X}")
        self.cpr.setValue(preset.cpr)
        self.store.cal.cpr = preset.cpr
        self.preset_badge.set_text(preset.label)
        self._refresh_derived()

    def _offset_source_changed(self) -> None:
        source = self.offset_src.value()
        first = source == "__calib"
        self.first_calib.setChecked(first)
        self.offset.setEnabled(not first)
        row = dict(PHI_E_OFFSETS).get(source)
        if row is not None:
            self.offset.setValue(row)

    def _load_m9(self) -> None:
        self.vel_frq.setText("0x0002BB12")
        self.vel_per.setText("0xFFF00001")
        self.write_vel.setChecked(True)

    def _refresh_derived(self) -> None:
        bits = int(self.frame_bits.value() or 14)
        mask = 0x00FFFFFF if bits > 14 else 0x3FFF
        self.mask.setText(f"0x{mask:08X}")
        half = spi_half_period(self.spi_hz.value())
        actual = spi_hz_from_half(half)
        frame_hz = 1.0 / max(1e-9, ssi_frame_seconds(bits, half, int(self.idle.value())))
        rate = f"{frame_hz / 1e6:.2f} MHz" if frame_hz >= 1e6 else f"{frame_hz / 1e3:.1f} kHz"
        self.derived_label.setText(
            f"half={half} → SCK {actual / 1e6:.2f} MHz · 帧率 ≈ {rate} · CPR_INV={16777216 // max(1, int(self.cpr.value()))}"
        )

    def _cfg(self) -> procedures.EncoderCfg:
        bits = int(self.frame_bits.value() or 14)
        return procedures.EncoderCfg(
            poles=int(self.poles.value()),
            cpr=int(self.cpr.value()),
            csn_via_enc_n=True,
            frame_bits=bits,
            spi_mode=int(self.spi_mode.value() or 0),
            spi_hz=int(self.spi_hz.value()),
            idle_cycles=int(self.idle.value()),
            data_mask=0x00FFFFFF if bits > 14 else 0x3FFF,
            send_data=int(self.send_data.text().replace("0x", ""), 16) if self.send_data.text() else 0,
            pwm_max_count=int(self.pwm_count.value()),
            csa_gain=int(self.csa.value() or 0),
            write_velocity_cfg=self.write_vel.isChecked(),
            vel_frq_conf=int(self.vel_frq.text().replace("0x", ""), 16) if self.vel_frq.text() else 0,
            vel_per_conf=int(self.vel_per.text().replace("0x", ""), 16) if self.vel_per.text() else 0,
            write_phi_e_offset=not self.first_calib.isChecked(),
            phi_e_offset=int(self.offset.value()),
        )

    # -------------------------------------------------------------- actions
    def _write(self) -> None:
        if not self.confirm.isChecked():
            self.store.toast("warn", "请先勾选确认写入项")
            return
        cfg = self._cfg()
        self.store.cal.poles = cfg.poles
        self.store.cal.cpr = cfg.cpr
        self.store.cal.pwm_max_count = cfg.pwm_max_count
        self.store.cal.csa_gain = cfg.csa_gain
        self.store.save_settings()
        self.store.run_job("encoder", {}, lambda ctx: procedures.setup_encoder(ctx, cfg))

    def _align(self) -> None:
        cfg = procedures.CalibCfg(
            flux_ma=self.align_flux.value(),
            poles=int(self.poles.value()),
            settle_ms=int(self.align_settle.value()),
            step_deg=int(self.align_step.value()),
            end_deg=int(self.align_end.value()),
            write_back=self.write_back.isChecked(),
            dry_run=self.dry_run.isChecked(),
            cpr=int(self.cpr.value()),
            ma_per_count=self.store.cal.ma_per_count,
        )
        frame_bits = int(self.frame_bits.value() or 14)
        self.store.run_job("calibrate", {}, lambda ctx: procedures.calibrate_phi_e(ctx, cfg, frame_bits))

    def _gateway_align(self) -> None:
        if not self.store.connected or self.store.semantic_session is None:
            self.store.toast("warn", "请先连接主控")
            return

        def work():
            session = self.store.semantic_session
            session.command(0, "get_state")
            session.command(0, "open")
            return session.command(
                self.store.motor,
                "alignment",
                scan_degrees=int(self.gw_scan.value()),
                step_degrees=int(self.gw_step.value()),
                settle_ms=int(self.gw_settle.value()),
                current_ma=int(self.gw_current.value()),
                clearance=False,
            )

        def done(reply) -> None:
            self.gw_result.setText(f"主控结果：{reply.result_name}")
            self.gw_result.setStyleSheet(
                f"color:{self.theme.ok if reply.result == 0 else self.theme.danger};font-size:11px;"
            )
            if reply.result == 0:
                self.store.toast("ok", "主控对齐完成")
            else:
                self.store.toast("error", f"主控对齐失败：{reply.result_name}")

        self.store.spawn(work, done, lambda e: self.store.toast("error", str(e)))

    def _toggle_live(self, on: bool) -> None:
        self.live_on = on
        if on:
            self._live_timer.start()
        else:
            self._live_timer.stop()

    def _read_live(self) -> None:
        if not self.store.connected or self.store.mode_gateway:
            return

        def done(values: dict) -> None:
            self.snapshot.update(values)
            raw = values.get(0x24D, self.live_raw)
            phi = values.get(0x251, self.live_phi) & 0xFFFF
            self.live_raw = raw
            self.live_phi = phi
            word = raw & (0x00FFFFFF if int(self.frame_bits.value() or 14) > 14 else 0x3FFF)
            mechanical = word / (1 << 24 if int(self.frame_bits.value() or 14) > 14 else 16384) * 360
            self.gauge_mech.set_angle(mechanical, f"PHI_EXT_A = 0x{raw:06X}")
            self.gauge_elec.set_angle(phi / 65536 * 360, f"PHI_E = {phi}")
            self.angle_kv.set_rows([
                ("PHI_EXT_A", hexs(raw, 8)),
                ("PHI_CONVERTED", hexs(values.get(0x247, 0), 8)),
                ("PHI_E", str(phi)),
                ("角度", f"{mechanical:.1f}°"),
            ])
            self.angle_notice.setVisible(raw == 0)
            self._render_checks(values)

        self.store.read_many([0x24D, 0x247, 0x251, 0x240, 0x250, 0x242, 0x0C3, 0x103, 0x244, 0x245], done)

    def _render_checks(self, values: dict) -> None:
        bits = int(self.frame_bits.value() or 14)
        cpr = max(1, int(self.cpr.value()))
        cpr_inv = 16777216 // cpr
        offset = None if self.first_calib.isChecked() else int(self.offset.value()) & 0xFFFF
        rows = [
            (0x240, "CONF_CH_A", 0x07000000 | cpr_inv, 0x0FFFFFFF),
            (0x250, "OUTPUT_CONF", 0x00400000 | int(self.poles.value()), 0x00FFFFFF),
            (0x242, "PHI_E_OFFSET", offset, 0xFFFF),
            (0x0C3, "CSA_GAIN (lo2)", int(self.csa.value() or 0), 0x03),
            (0x103, "PWM_PERIOD (lo16)", int(self.pwm_count.value()), 0xFFFF),
        ]
        self.check_table.setRowCount(len(rows))
        for i, (addr, name, expected, mask) in enumerate(rows):
            actual = values.get(addr)
            cells = [f"0x{addr:03X} {name}", "—" if expected is None else f"0x{expected:08X}", "—" if actual is None else f"0x{actual:08X}"]
            for j, text in enumerate(cells):
                item = QTableWidgetItem(text)
                item.setFont(mono_font(10))
                if j == 2 and actual is not None and expected is not None:
                    ok = (actual & mask) == (expected & mask)
                    item.setForeground(Qt.GlobalColor.green if ok else Qt.GlobalColor.yellow)
                self.check_table.setItem(i, j, item)

    def _steps_changed(self, kind: str) -> None:
        if kind == "encoder":
            self.write_steps.set_steps(self.store.steps_by_kind.get("encoder", []))
            self.flow_card.title_label.setText("配置流程")
        elif kind == "calibrate":
            self.align_steps.set_steps(self.store.steps_by_kind.get("calibrate", []))
        running = self.store.job_running
        badge = self.flow_card.findChild(Badge)
        if badge:
            badge.set_text("执行中" if running else "空闲")
            badge.set_tone("accent" if running else "neutral")

    def refresh(self) -> None:
        gateway = self.store.mode_gateway
        self.gateway_card.setVisible(gateway)
        self.direct_host.setVisible(not gateway)
        self.write_btn.setEnabled(self.store.connected and not self.store.job_running)
        self.align_btn.setEnabled(self.store.connected and not self.store.job_running)
        self.write_btn.setText("写入中…" if self.store.job_running else "写入并回读")
        self._refresh_derived()
        alignment = self.store.alignments.get(self.store.motor)
        if alignment:
            self.align_badge.set_text(f"偏移 0x{alignment.offset:04X}")
            self.align_badge.set_tone("ok" if alignment.written else "warn")
            self.align_result.setText(
                f"偏移 {alignment.offset} · R²={alignment.r2:.5f} · 斜率 {alignment.slope:.4f} LSB/° · {len(alignment.points)} 点 · "
                + ("已写回" if alignment.written else "未写回")
            )

    def on_show(self) -> None:
        self.flow_card.title_label.setText("配置流程")
        self.write_steps.set_steps(self.store.steps_by_kind.get("encoder", []))
        self.align_steps.set_steps(self.store.steps_by_kind.get("calibrate", []))
        if self.store.connected and self.store.mode == "direct":
            self._read_live()

    def apply_theme(self, theme) -> None:
        super().apply_theme(theme)
        self.gauge_mech.theme = theme
        self.gauge_elec.theme = theme
        self.gauge_mech.update()
        self.gauge_elec.update()
