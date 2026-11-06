"""16-motor fleet overview (gateway mode), ported from FleetOverview.tsx."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ..core.fleet import MAX_CHIPS
from ..core.units import fmt, temp_c
from ..theme import Theme, mono_font
from ..widgets.primitives import Badge, Button, Card, StatusDot, Toggle
from .base import BasePage

MODES = ["位置直通", "位置插补", "速度直通", "速度斜坡"]
CHANNEL_FAULTS = [(1, "堵转"), (2, "过温"), (4, "过流"), (8, "电机异常"), (16, "存储异常")]


def _volt(mv):
    return "—" if mv is None else f"{mv / 1000:.2f} V"


def _amp(ma):
    return "—" if ma is None else f"{ma:.0f} mA"


class MetricBox(QWidget):
    def __init__(self, title: str, theme: Theme) -> None:
        super().__init__()
        self.setStyleSheet(f"background:{theme.inset};border:1px solid {theme.line_soft};border-radius:9px;")
        col = QVBoxLayout(self)
        col.setContentsMargins(10, 7, 10, 7)
        col.setSpacing(1)
        label = QLabel(title)
        label.setObjectName("mutedTiny")
        self.value = QLabel("—")
        self.value.setFont(mono_font(12, 500))
        col.addWidget(label)
        col.addWidget(self.value)


class MotorCard(QWidget):
    def __init__(self, motor_id: int, page: "FleetOverview") -> None:
        super().__init__()
        self.motor_id = motor_id
        self.page = page
        self.theme = page.theme
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setStyleSheet(
            f"MotorCard{{background:{self.theme.surface};border:1px solid {self.theme.line};border-radius:12px;}}"
            f"MotorCard:hover{{border-color:{self.theme.text_3};}}"
        )
        col = QVBoxLayout(self)
        col.setContentsMargins(14, 12, 14, 12)
        col.setSpacing(8)
        head = QWidget()
        h = QHBoxLayout(head)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(7)
        name = QLabel(f"M{motor_id:02d}")
        name.setFont(mono_font(15, 600))
        self.tmc = QLabel("TMC · 未确认")
        self.tmc.setObjectName("mutedTiny")
        self.dot = StatusDot(self.theme.text_4)
        h.addWidget(name)
        h.addWidget(self.tmc)
        h.addStretch(1)
        h.addWidget(self.dot)
        col.addWidget(head)
        supply = QWidget()
        sr = QHBoxLayout(supply)
        sr.setContentsMargins(0, 0, 0, 0)
        sr.setSpacing(7)
        self.supply_dot = StatusDot(self.theme.text_4, 6)
        self.supply_label = QLabel("供电未知")
        self.supply_label.setObjectName("mutedTiny")
        self.toggle = Toggle(False)
        self.toggle.setFixedSize(30, 16)
        self.toggle.toggled.connect(lambda on: self.page.store.set_power(self.motor_id, on))
        sr.addWidget(self.supply_dot)
        sr.addWidget(self.supply_label)
        sr.addStretch(1)
        sr.addWidget(self.toggle)
        col.addWidget(supply)
        metrics = QWidget()
        mg = QGridLayout(metrics)
        mg.setContentsMargins(0, 0, 0, 0)
        mg.setHorizontalSpacing(7)
        mg.setVerticalSpacing(5)
        self.metrics = {}
        for i, (key, title) in enumerate((("temp", "温度"), ("iq", "力矩电流"), ("cur", "输入电流"), ("volt", "输入电压"))):
            box = MetricBox(title, self.theme)
            self.metrics[key] = box
            mg.addWidget(box, i // 2, i % 2)
        col.addWidget(metrics)
        self.dl = QWidget()
        dl = QVBoxLayout(self.dl)
        dl.setContentsMargins(0, 0, 0, 0)
        dl.setSpacing(3)
        self.dl_labels = {}
        for key, title in (("enc", "编码器"), ("home", "找零"), ("mode", "运动模式")):
            row = QWidget()
            r = QHBoxLayout(row)
            r.setContentsMargins(0, 0, 0, 0)
            t = QLabel(title)
            t.setObjectName("mutedTiny")
            v = QLabel("未确认")
            v.setObjectName("mutedTiny")
            v.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            r.addWidget(t)
            r.addStretch(1)
            r.addWidget(v)
            dl.addWidget(row)
            self.dl_labels[key] = v
        col.addWidget(self.dl)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        self.page.store.set_motor(self.motor_id)
        super().mousePressEvent(event)

    def refresh(self, power, state) -> None:
        online = bool(power and power.tmc_online)
        enabled = power.enabled if power else None
        self.tmc.setText("TMC · 在线" if online else ("TMC · 掉线" if enabled else "TMC · 未确认"))
        self.tmc.setStyleSheet(
            f"font-size:10.5px;color:{self.theme.ok if online else self.theme.danger if enabled else self.theme.text_3};"
        )
        self.dot.set_color(self.theme.ok if online else self.theme.warn if enabled else self.theme.text_4)
        if power is None or power.enabled is None:
            supply_text, color = "供电未知", self.theme.text_3
        elif not power.enabled:
            supply_text, color = "输入未使能", self.theme.text_3
        elif power.fault:
            supply_text, color = power.fault, self.theme.danger
        else:
            supply_text, color = "输入已使能", self.theme.ok
        self.supply_label.setText(supply_text)
        self.supply_label.setStyleSheet(f"font-size:10.5px;color:{color};")
        self.supply_dot.set_color(color)
        if power is not None:
            self.toggle.blockSignals(True)
            self.toggle.setChecked(bool(power.enabled))
            self.toggle.blockSignals(False)
        live = bool(state)
        self.metrics["temp"].value.setText(
            f"{temp_c(state.temperature_raw * 65536, self.page.store.cal.temp_offset):.1f} °C"
            if live and state.temperature_raw is not None else "—"
        )
        self.metrics["iq"].value.setText(
            f"{state.iq_raw * self.page.store.cal.ma_per_count:.0f} mA" if live else "—"
        )
        self.metrics["cur"].value.setText(_amp(power.current_ma) if power and power.voltage_mv is not None else "—")
        self.metrics["volt"].value.setText(_volt(power.voltage_mv) if power else "—")
        self.dl_labels["enc"].setText("有效" if live and state.align_valid else ("待标定" if live else "未确认"))
        self.dl_labels["home"].setText("有效" if live and state.span_valid else ("待找零" if live else "未确认"))
        self.dl_labels["mode"].setText(MODES[state.mode] if live and 0 <= state.mode < len(MODES) else ("未知" if live else "—"))
        selected = self.page.store.motor == self.motor_id
        self.setStyleSheet(
            f"MotorCard{{background:{self.theme.surface};border:1px solid {self.theme.accent if selected else self.theme.line};"
            f"border-radius:12px;}}"
        )


class FleetOverview(BasePage):
    def __init__(self, store, theme, shell=None) -> None:
        super().__init__(store, theme, shell)
        self._build()
        self.store.fleetChanged.connect(self.refresh)
        self.store.changed.connect(self.refresh)

    def _build(self) -> None:
        summary = QWidget()
        grid = QGridLayout(summary)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(12)
        self.summary_values: dict[str, QLabel] = {}
        for i, (key, title, sub) in enumerate((
            ("main", "主控", ""), ("fw", "固件版本", "主控只读快照"),
            ("online", "在线电机", "TMC 应答计数"), ("faults", "设备告警", "未读取的设备不计为正常"),
        )):
            box = QWidget()
            box.setStyleSheet(f"background:{self.theme.surface};border:1px solid {self.theme.line};border-radius:12px;")
            col = QVBoxLayout(box)
            col.setContentsMargins(16, 14, 16, 14)
            col.setSpacing(4)
            t = QLabel(title)
            t.setObjectName("mutedTiny")
            value = QLabel("—")
            value.setFont(mono_font(19, 500))
            sublabel = QLabel(sub)
            sublabel.setObjectName("mutedTiny")
            self.summary_values[key] = value
            self.summary_values[key + "_sub"] = sublabel
            col.addWidget(t)
            col.addWidget(value)
            col.addWidget(sublabel)
            grid.addWidget(box, 0, i)
        self.add(summary)

        max_row = QWidget()
        mg = QHBoxLayout(max_row)
        mg.setContentsMargins(0, 0, 0, 0)
        mg.setSpacing(12)
        self.max_cards: list[dict] = []
        for name in MAX_CHIPS:
            card = QWidget()
            card.setStyleSheet(f"background:{self.theme.surface};border:1px solid {self.theme.line};border-radius:12px;")
            col = QVBoxLayout(card)
            col.setContentsMargins(14, 12, 14, 12)
            col.setSpacing(6)
            head = QWidget()
            h = QHBoxLayout(head)
            h.setContentsMargins(0, 0, 0, 0)
            title = QLabel(f"MAX · {name}")
            title.setFont(mono_font(11, 600))
            state = QLabel("未确认")
            state.setObjectName("mutedTiny")
            dot = StatusDot(self.theme.text_4, 6)
            h.addWidget(title)
            h.addStretch(1)
            h.addWidget(state)
            h.addWidget(dot)
            col.addWidget(head)
            info = QWidget()
            ig = QGridLayout(info)
            ig.setContentsMargins(0, 0, 0, 0)
            ig.setHorizontalSpacing(10)
            ig.setVerticalSpacing(3)
            labels = {}
            for i, key in enumerate(("id", "config", "enabled", "vin", "vdd", "limit")):
                t = QLabel(key)
                t.setObjectName("mutedTiny")
                v = QLabel("—")
                v.setObjectName("kvValue")
                ig.addWidget(t, i // 2, (i % 2) * 2)
                ig.addWidget(v, i // 2, (i % 2) * 2 + 1)
                labels[key] = v
            col.addWidget(info)
            channels = QWidget()
            ch = QVBoxLayout(channels)
            ch.setContentsMargins(0, 0, 0, 0)
            ch.setSpacing(2)
            ch_labels = []
            for o in range(4):
                row = QWidget()
                r = QHBoxLayout(row)
                r.setContentsMargins(0, 0, 0, 0)
                r.setSpacing(6)
                d = StatusDot(self.theme.text_4, 5)
                name_label = QLabel(f"OUT{o + 1}")
                name_label.setObjectName("mutedTiny")
                value = QLabel("—")
                value.setObjectName("mutedTiny")
                value.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
                r.addWidget(d)
                r.addWidget(name_label)
                r.addStretch(1)
                r.addWidget(value)
                ch.addWidget(row)
                ch_labels.append((name_label, value, d))
            col.addWidget(channels)
            self.max_cards.append({"state": state, "dot": dot, "labels": labels, "channels": ch_labels})
            mg.addWidget(card, 1)
        self.add(max_row)

        self.array_card = Card("运动阵列", "", Badge("5 电缸 · 16 电机", "neutral"))
        self.cylinders = QWidget()
        self.cyl_layout = QHBoxLayout(self.cylinders)
        self.cyl_layout.setContentsMargins(0, 0, 0, 0)
        self.cyl_layout.setSpacing(8)
        self.cyl_values = []
        for i in range(5):
            chip = QWidget()
            chip.setStyleSheet(f"background:{self.theme.inset};border:1px solid {self.theme.line_soft};border-radius:9px;")
            c = QVBoxLayout(chip)
            c.setContentsMargins(10, 7, 10, 7)
            c.setSpacing(1)
            head = QLabel(f"C{i + 1}")
            head.setFont(mono_font(11, 600))
            value = QLabel("—")
            value.setObjectName("mutedTiny")
            c.addWidget(head)
            c.addWidget(value)
            self.cyl_layout.addWidget(chip, 1)
            self.cyl_values.append(value)
        self.array_card.add(self.cylinders)
        self.motor_grid_host = QWidget()
        self.motor_grid = QGridLayout(self.motor_grid_host)
        self.motor_grid.setContentsMargins(0, 0, 0, 0)
        self.motor_grid.setHorizontalSpacing(12)
        self.motor_grid.setVerticalSpacing(12)
        self.motor_cards: dict[int, MotorCard] = {}
        for i in range(16):
            mid = i + 1
            card = MotorCard(mid, self)
            self.motor_cards[mid] = card
            self.motor_grid.addWidget(card, i // 4, i % 4)
        self.array_card.add(self.motor_grid_host)
        self.add(self.array_card)

    def _power(self, mid: int):
        return self.store.fleet_power[mid - 1] if len(self.store.fleet_power) >= mid else None

    def refresh(self) -> None:
        store = self.store
        now = __import__("time").time()
        online = sum(1 for p in store.fleet_power if p and p.tmc_online)
        faults = sum(
            1 for i, p in enumerate(store.fleet_power)
            if p and p.enabled and (p.fault or (store.fleet_motors.get(i + 1, {}).get("state") and store.fleet_motors[i + 1]["state"].fault))
        )
        self.summary_values["main"].setText("已连接" if store.connected else "未连接")
        self.summary_values["main_sub"].setText(f"{store.port} · 1.5 Mbps")
        self.summary_values["fw"].setText(store.fw_version or "—")
        self.summary_values["online"].setText(f"{online} / 16")
        self.summary_values["online_sub"].setText("采集优先 · 概览暂停刷新" if store.streaming else "TMC 应答计数")
        self.summary_values["faults"].setText(f"{faults} 路")
        self.summary_values["faults"].setStyleSheet(f"color:{self.theme.danger};" if faults else "")
        supply_fresh = bool(store.fleet_power_at and now - store.fleet_power_at < 8)
        for i, widget in enumerate(self.max_cards):
            chip = store.fleet_chips[i] if i < len(store.fleet_chips) else None
            if chip is None or not chip.valid:
                widget["state"].setText("未确认")
                widget["dot"].set_color(self.theme.danger if not supply_fresh else self.theme.text_4)
                for label in widget["labels"].values():
                    label.setText("—")
            else:
                widget["state"].setText("告警" if chip.fault else "输出中" if chip.diagnostics_live else "已关闭")
                widget["dot"].set_color(self.theme.warn if chip.fault else self.theme.ok)
                widget["labels"]["id"].setText(f"0x{chip.id:02X}")
                widget["labels"]["config"].setText(f"0x{chip.config:02X}")
                enabled_bits = "".join("1" if chip.config & (1 << o) else "·" for o in range(4))
                widget["labels"]["enabled"].setText(f"OUT {enabled_bits}")
                widget["labels"]["vin"].setText(_volt(chip.vin_mv))
                widget["labels"]["vdd"].setText(_volt(chip.vdd_mv))
                widget["labels"]["limit"].setText(_amp(chip.current_limit_ma))
            for o, (name_label, value, dot) in enumerate(widget["channels"]):
                channel = chip.channels[o] if chip and o < len(chip.channels) else None
                if channel is None:
                    dot.set_color(self.theme.text_4)
                    value.setText("—")
                    continue
                name_label.setText(f"M{channel.motor:02d}" if channel.motor else f"OUT{o + 1}")
                dot.set_color(self.theme.warn if channel.fault else self.theme.ok if channel.enabled else self.theme.text_4)
                value.setText(f"{channel.current_ma or 0} mA" if channel.enabled else "—")
        for i, label in enumerate(self.cyl_values):
            snap = store.fleet_cylinders[i] if i < len(store.fleet_cylinders) else None
            if snap and snap.online:
                label.setText(f"{snap.position} 步 · {snap.current_ma} mA")
            else:
                label.setText("—")
        for mid, card in self.motor_cards.items():
            entry = store.fleet_motors.get(mid)
            fresh = bool(entry and now - entry["at"] < 8)
            card.refresh(self._power(mid), entry["state"] if fresh else None)

    def apply_theme(self, theme: Theme) -> None:
        super().apply_theme(theme)
