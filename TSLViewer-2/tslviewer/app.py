"""TSL Viewer · PyQt6 shell."""

from __future__ import annotations

import sys

from PyQt6.QtCore import QPointF, QRectF, QSize, Qt, QTimer
from PyQt6.QtGui import QColor, QFont, QLinearGradient, QPainter, QRadialGradient
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from . import icons
from .core.presets import BAUD_RATES, TESLA_PROFILE
from .core.store import AppStore
from .theme import THEMES, Theme, qss, ui_font
from .widgets.primitives import Badge, Button, Card, IconButton, Notice, SelectField, ToastHost, divider
from .widgets.scope import ScopeWidget

PAGES = [
    ("overview", "运行概览", "RUN", "gauge", "工作区"),
    ("cylinders", "电缸控制", "LA", "ruler", "工作区"),
    ("encoder", "编码器与对齐", "SSI", "encoder", "工作区"),
    ("homing", "电机控制与找零", "MOTION", "target", "工作区"),
    ("axis", "机械行程", "AXIS", "ruler", "工作区"),
    ("tuning", "PID 与限幅", "TUNE", "tuning", "调校"),
    ("autotuning", "参数整定", "IDENT", "tuning", "调校"),
    ("looptest", "环路测试", "LOOP", "gauge", "调校"),
    ("storage", "板载存储", "W25 / M24", "save", "调校"),
    ("registers", "寄存器", "MAP", "registers", "调校"),
    ("sequence", "自动测试", "QA", "sequence", "生产"),
    ("logs", "运行日志", "LOG", "logs", "生产"),
]

TITLES = {
    "cylinders": ("电缸控制", "五路独立电缸的行程、保护参数与实时状态。", "LINEAR ACTUATORS"),
    "overview": ("运行概览", "实时遥测、驱动状态与手动运行。所有数值来自芯片寄存器，不经过任何估算。", "OVERVIEW"),
    "encoder": ("编码器与对齐", "MT6701 SSI 的引脚复用与反馈通道配置，随后做开环电角度对齐，最后用编码器闭环验证。", "ENCODER · ALIGN"),
    "homing": ("机械找零", "撞限位建立行程零点。上位机下发方向、步进与工艺参数并显示状态；推进与判据在主控固件。", "HOMING"),
    "axis": ("机械行程", "丝杆导程换算、软限位保护与受控运动。撞机械限位之前，先让软件把闸拉下来。", "TRAVEL GUARD"),
    "tuning": ("PID 与限幅", "三级级联参数、单位换算与阶跃响应实测。电流归一化选错会让增益差 256 倍。", "TUNING"),
    "autotuning": ("参数整定", "TMC PRBS 系统辨识、PI计算与实机参数试用。", "PARAMETER IDENTIFICATION"),
    "looptest": ("环路测试", "在受保护的行程内做恒 Iq / 恒速度探测、速度 PI 自动辨识与位置环跟随测试，并看波形。", "LOOP TEST"),
    "storage": ("板载存储", "主控 W25 保存完整配置，电机 M24C02 保存编号与电角度偏移备份；保存后由主控读回校验。", "W25 / M24"),
    "registers": ("寄存器", "TMC6460 全部 189 个寄存器的读取、位编辑与快照对比。", "REGISTER MAP"),
    "sequence": ("自动测试", "按档位运行并记录转速、电流、温度，导出 CSV 到报告目录。", "SEQUENCE"),
    "logs": ("运行日志", "串口与任务的完整记录，排障从这里开始。", "LOGS"),
}

OP_ONLY = {"encoder", "homing", "axis", "tuning", "autotuning", "looptest", "storage", "registers"}


class SettingsDialog(QDialog):
    def __init__(self, store: AppStore, parent: QWidget, on_theme) -> None:
        super().__init__(parent)
        self.store = store
        self.on_theme = on_theme
        self.setWindowTitle("设置")
        self.setFixedWidth(420)
        self.setStyleSheet(parent.styleSheet())
        col = QVBoxLayout(self)
        col.setContentsMargins(20, 20, 20, 20)
        col.setSpacing(14)
        title = QLabel("设置")
        title.setObjectName("pageTitle")
        col.addWidget(title)
        desc = QLabel("工作模式决定左侧导航显示的范围；主题立即生效并写入本地设置。")
        desc.setObjectName("tiny")
        desc.setWordWrap(True)
        col.addWidget(desc)
        from .widgets.primitives import Segmented

        col.addWidget(QLabel("工作模式"))
        mode = Segmented(
            [("op", "调试模式"), ("production", "生产模式")],
            "production" if store.production_mode else "op",
        )
        mode.changed.connect(self._set_mode)
        col.addWidget(mode)
        col.addWidget(QLabel("界面主题"))
        theme = Segmented([("dark", "深色"), ("light", "浅色")], store.theme_name)
        theme.changed.connect(self._set_theme)
        col.addWidget(theme)
        col.addWidget(Notice("生产模式隐藏编码器、找零、行程、调校、存储与寄存器页面，只保留概览、电缸、自动测试与日志。"))
        row = QHBoxLayout()
        row.addStretch(1)
        close = Button("关闭", "primary")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        col.addLayout(row)

    def _set_mode(self, mode: str) -> None:
        self.store.production_mode = mode == "production"
        self.store.save_settings()
        self.store.changed.emit()

    def _set_theme(self, name: str) -> None:
        self.store.theme_name = name
        self.store.save_settings()
        self.on_theme(name)


class BrandMark(QWidget):
    def __init__(self, theme: Theme, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.theme = theme
        self.setObjectName("brandMark")
        self.setFixedSize(34, 34)

    def paintEvent(self, event) -> None:  # noqa: N802
        from PyQt6.QtGui import QPainterPath, QPen

        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.scale(self.width() / 24.0, self.height() / 24.0)
        pen = QColor(self.theme.accent)
        pen.setAlpha(140)
        p.setPen(QPen(pen, 1.6))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(QRectF(3.4, 3.4, 17.2, 17.2))
        p.setPen(QPen(QColor(self.theme.warn), 1.9, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        wave = QPainterPath()
        wave.moveTo(4, 12)
        wave.cubicTo(6.2, 7.4, 9.1, 7.4, 12, 12)
        wave.cubicTo(14.9, 16.6, 17.8, 16.6, 20, 12)
        p.drawPath(wave)
        p.end()


class NavButton(QPushButton):
    """Rail item: icon + title on the left, technical hint on the right."""

    def __init__(self, page_id: str, title: str, hint: str, icon_name: str, theme: Theme, parent=None) -> None:
        super().__init__(parent)
        self.page_id = page_id
        self.title = title
        self.hint = hint
        self.icon_name = icon_name
        self.theme = theme
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedHeight(34)
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setText("")

    def paintEvent(self, event) -> None:  # noqa: N802
        from PyQt6.QtGui import QPen

        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        t = self.theme
        rect = QRectF(0, 0, self.width(), self.height())
        if self.isChecked():
            grad = QLinearGradient(0, 0, self.width(), 0)
            accent = QColor(t.accent)
            accent.setAlpha(33)
            grad.setColorAt(0, accent)
            clear = QColor(t.accent)
            clear.setAlpha(5)
            grad.setColorAt(1, clear)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(grad)
            p.drawRoundedRect(rect, 9, 9)
            p.setBrush(QColor(t.accent))
            p.drawRoundedRect(QRectF(-2, 8, 2, self.height() - 16), 1, 1)
        elif self.underMouse():
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(255, 255, 255, 10))
            p.drawRoundedRect(rect, 9, 9)
        color = QColor(t.accent if self.isChecked() else t.text_2)
        p.drawPixmap(10, (self.height() - 16) // 2, icons.pixmap(self.icon_name, color, 16))
        p.setPen(QColor(t.text if self.isChecked() else t.text_2))
        p.setFont(ui_font(12, 500))
        p.drawText(QRectF(34, 0, self.width() - 100, self.height()), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, self.title)
        p.setPen(QColor(t.text_4))
        p.setFont(ui_font(9))
        p.drawText(QRectF(0, 0, self.width() - 10, self.height()), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, self.hint)
        p.end()


class Rail(QWidget):
    def __init__(self, shell: "Shell") -> None:
        super().__init__(shell)
        self.shell = shell
        self.setObjectName("rail")
        self.setFixedWidth(236)
        col = QVBoxLayout(self)
        col.setContentsMargins(14, 18, 14, 14)
        col.setSpacing(4)

        brand = QWidget()
        brow = QHBoxLayout(brand)
        brow.setContentsMargins(8, 4, 8, 16)
        brow.setSpacing(10)
        mark = BrandMark(self.shell.theme)
        brow.addWidget(mark)
        text = QVBoxLayout()
        text.setContentsMargins(0, 0, 0, 0)
        text.setSpacing(0)
        name = QLabel("TSL Viewer")
        name.setObjectName("brandName")
        sub = QLabel("TMC6460 STUDIO")
        sub.setObjectName("brandSub")
        text.addWidget(name)
        text.addWidget(sub)
        brow.addLayout(text)
        brow.addStretch(1)
        col.addWidget(brand)

        self.nav_buttons: dict[str, QPushButton] = {}
        self.group_labels: list[QLabel] = []
        last_group = None
        for page_id, title, hint, icon_name, group in PAGES:
            if group != last_group:
                lab = QLabel(group)
                lab.setObjectName("railGroup")
                col.addWidget(lab)
                self.group_labels.append(lab)
                last_group = group
            btn = NavButton(page_id, title, hint, icon_name, self.shell.theme)
            btn.clicked.connect(lambda _=False, p=page_id: self.shell.navigate(p))
            col.addWidget(btn)
            self.nav_buttons[page_id] = btn

        col.addStretch(1)
        foot = QWidget()
        fcol = QVBoxLayout(foot)
        fcol.setContentsMargins(0, 12, 0, 0)
        fcol.setSpacing(7)
        line = divider(self.shell.theme)
        fcol.addWidget(line)
        self.meta: dict[str, QLabel] = {}
        for key, label_text in (
            ("fw", "FW_Version"),
            ("hand", "HandID"),
            ("enc", "编码器"),
            ("home", "找零"),
            ("link", "链路"),
            ("fps", "帧率"),
            ("pwm", "PWM"),
        ):
            row = QWidget()
            h = QHBoxLayout(row)
            h.setContentsMargins(2, 0, 2, 0)
            k = QLabel(label_text)
            k.setStyleSheet(f"font-size:10.5px;color:{self.shell.theme.text_3};font-family:'Cascadia Code',Consolas;")
            v = QLabel("—")
            v.setStyleSheet(f"font-size:10.5px;color:{self.shell.theme.text_2};font-family:'Cascadia Code',Consolas;")
            v.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            h.addWidget(k)
            h.addStretch(1)
            h.addWidget(v)
            fcol.addWidget(row)
            self.meta[key] = v
        col.addWidget(foot)
        self.refresh()

    def _paint_mark(self, widget: QWidget) -> None:
        p = QPainter(widget)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.scale(widget.width() / 24.0, widget.height() / 24.0)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(0, 0, 0, 0))
        p.drawRect(widget.rect())
        pen = QColor("#2ee6e6")
        pen.setAlpha(140)
        from PyQt6.QtGui import QPen

        p.setPen(QPen(pen, 1.6))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(QRectF(3.4, 3.4, 17.2, 17.2))
        p.setPen(QPen(QColor("#f5b544"), 1.9, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        path = p.path()
        from PyQt6.QtGui import QPainterPath

        wave = QPainterPath()
        wave.moveTo(4, 12)
        wave.cubicTo(6.2, 7.4, 9.1, 7.4, 12, 12)
        wave.cubicTo(14.9, 16.6, 17.8, 16.6, 20, 12)
        p.drawPath(wave)
        p.end()

    def refresh(self) -> None:
        store = self.shell.store
        production = store.production_mode
        for page_id, btn in self.nav_buttons.items():
            visible = not (production and page_id in OP_ONLY)
            btn.setVisible(visible)
            btn.theme = self.shell.theme
            btn.update()
        for page_id in OP_ONLY:
            self.nav_buttons[page_id].setVisible(not production)
        t = self.shell.theme
        self.meta["fw"].setText(store.fw_version or "—")
        self.meta["hand"].setText(str(store.hand_id) if store.hand_id is not None else "—")
        state = store.semantic.get("state")
        if store.mode_gateway:
            self.meta["enc"].setText("有效" if state and state.align_valid else "待标定")
            self.meta["home"].setText("有效" if state and state.span_valid and state.home_neg_valid and state.home_pos_valid else "待找零")
        else:
            self.meta["enc"].parentWidget().setVisible(False)
            self.meta["home"].parentWidget().setVisible(False)
        self.meta["link"].setText(store.stats.port if store.connected else "离线")
        self.meta["link"].setStyleSheet(
            f"font-size:10.5px;color:{t.ok if store.connected else t.text_3};font-family:'Cascadia Code',Consolas;"
        )
        self.meta["fps"].setText(f"{store.stats.frame_rate:.0f}/s" if store.streaming else "—")
        self.meta["pwm"].setText(f"{120000000 / max(1, store.cal.pwm_max_count) / 1000:.2f} kHz")

    def _nav_text(self, page_id: str) -> str:
        for pid, title, hint, *_ in PAGES:
            if pid == page_id:
                return f"  {title}        {hint}"
        return ""

    def _icon(self, page_id: str) -> str:
        for pid, _, _, icon_name, _ in PAGES:
            if pid == page_id:
                return icon_name
        return "gauge"


class Shell(QWidget):
    def __init__(self, window: "MainWindow") -> None:
        super().__init__(window)
        self.window = window
        self.store = window.store
        self.theme: Theme = window.theme
        self.page_id = "overview"
        self.pages: dict[str, QWidget] = {}
        self.tuning_visited = False

        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.rail = Rail(self)
        root.addWidget(self.rail)

        main = QWidget()
        main.setObjectName("main")
        mcol = QVBoxLayout(main)
        mcol.setContentsMargins(0, 0, 0, 0)
        mcol.setSpacing(0)

        # ------------------------------------------------------------ topbar
        topbar = QWidget()
        topbar.setObjectName("topbar")
        topbar.setFixedHeight(58)
        top = QHBoxLayout(topbar)
        top.setContentsMargins(20, 0, 20, 0)
        top.setSpacing(12)
        crumbs = QWidget()
        crow = QHBoxLayout(crumbs)
        crow.setContentsMargins(0, 0, 0, 0)
        crow.setSpacing(8)
        pre = QLabel("TSL")
        pre.setObjectName("crumb")
        slash = QLabel("/")
        slash.setStyleSheet(f"color:{self.theme.text_4};font-size:11px;")
        self.crumb_page = QLabel("OVERVIEW")
        self.crumb_page.setObjectName("crumbBold")
        crow.addWidget(pre)
        crow.addWidget(slash)
        crow.addWidget(self.crumb_page)
        top.addWidget(crumbs)
        top.addStretch(1)

        self.conn_badge = Badge("离线", "neutral")
        top.addWidget(self.conn_badge)
        self.mode_select = SelectField(
            [("direct", "直连电机板"), ("main485", "主控 · RS485"), ("maincan", "主控 · USB-CAN-A")],
            self.store.mode,
            width=168,
        )
        self.mode_select.currentIndexChanged.connect(
            lambda: self.store.set_mode(self.mode_select.value())
        )
        top.addWidget(self.mode_select)
        self.port_select = SelectField(width=124)
        self.port_select.currentIndexChanged.connect(self._port_changed)
        top.addWidget(self.port_select)
        self.baud_select = SelectField(
            [(b, f"{b:,} bit/s") for b in BAUD_RATES], self.store.baud, width=140
        )
        self.baud_select.currentIndexChanged.connect(
            lambda: setattr(self.store, "baud", int(self.baud_select.value()))
        )
        top.addWidget(self.baud_select)
        refresh = IconButton("refresh", "刷新串口列表")
        refresh.clicked.connect(self.store.refresh_ports)
        top.addWidget(refresh)
        self.connect_btn = Button("连接", "primary")
        self.connect_btn.clicked.connect(self._connect_clicked)
        top.addWidget(self.connect_btn)
        line = divider(self.theme, vertical=True)
        line.setFixedHeight(22)
        top.addWidget(line)
        gear = IconButton("gear", "设置（工作模式 / 主题）")
        gear.clicked.connect(self.window.open_settings)
        top.addWidget(gear)
        mcol.addWidget(topbar)

        # ------------------------------------------------------------- subbar
        subbar = QWidget()
        subbar.setObjectName("subbar")
        srow = QHBoxLayout(subbar)
        srow.setContentsMargins(22, 13, 22, 12)
        srow.setSpacing(18)
        self.page_title = QLabel("运行概览")
        self.page_title.setObjectName("pageTitle")
        self.page_desc = QLabel("")
        self.page_desc.setObjectName("pageDesc")
        self.page_desc.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        srow.addWidget(self.page_title)
        srow.addWidget(self.page_desc, 1)
        mcol.addWidget(subbar)

        # ------------------------------------------------------------ toolbar
        toolbar = QWidget()
        toolbar.setObjectName("toolbar")
        toolbar.setFixedHeight(58)
        trow = QHBoxLayout(toolbar)
        trow.setContentsMargins(22, 9, 22, 9)
        trow.setSpacing(10)
        motor_label = QLabel("当前电机")
        motor_label.setStyleSheet(f"font-size:12px;color:{self.theme.text_2};")
        trow.addWidget(motor_label)
        self.motor_select = SelectField([(i, f"M{i}") for i in range(1, 17)], self.store.motor, width=92)
        self.motor_select.currentIndexChanged.connect(lambda: self.store.set_motor(int(self.motor_select.value())))
        trow.addWidget(self.motor_select)
        self.enable_btn = Button("使能 / 上电")
        self.enable_btn.clicked.connect(self._enable_clicked)
        trow.addWidget(self.enable_btn)
        self.permit_btn = Button("开启运动授权")
        self.permit_btn.clicked.connect(self._permit_clicked)
        trow.addWidget(self.permit_btn)
        stop = Button("停止运行", icon_name="stop")
        stop.clicked.connect(self.store.stop_motion)
        trow.addWidget(stop)
        trow.addStretch(1)
        self.toolbar_status = QLabel("待命")
        self.toolbar_status.setStyleSheet(f"font-size:12px;color:{self.theme.text_3};")
        trow.addWidget(self.toolbar_status)
        estop = Button("急停", "danger", icon_name="stop")
        estop.clicked.connect(self.store.emergency)
        trow.addWidget(estop)
        self.toolbar = toolbar
        mcol.addWidget(toolbar)

        # ------------------------------------------------------------- content
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.content_host = QWidget()
        self.content_col = QVBoxLayout(self.content_host)
        self.content_col.setContentsMargins(22, 20, 22, 44)
        self.content_col.setSpacing(16)
        self.content_col.addStretch(1)
        self.scroll.setWidget(self.content_host)
        mcol.addWidget(self.scroll, 1)
        root.addWidget(main, 1)

        self.toast_host = ToastHost(self)
        self.toast_host.setGeometry(0, 0, 420, 300)
        self.toast_host.raise_()

        self._build_pages()
        self.navigate("overview")

        self.store.changed.connect(self.refresh_chrome)
        self.store.streamChanged.connect(self.refresh_chrome)
        self.store.jobChanged.connect(self.refresh_chrome)
        self.store.semanticChanged.connect(self.refresh_chrome)
        self.store.toastRequested.connect(self._toast)
        self.store.rtmiTick.connect(self._tick)

    # --------------------------------------------------------------- pages
    def _make_page(self, page_id: str) -> QWidget:
        from .pages import (
            axis_page,
            cylinders,
            encoder,
            homing,
            logs,
            loop_test,
            overview,
            parameter_tuning,
            registers,
            sequence,
            storage,
            tuning,
        )

        mapping = {
            "overview": overview.OverviewPage,
            "cylinders": cylinders.CylindersPage,
            "encoder": encoder.EncoderPage,
            "homing": homing.HomingPage,
            "axis": axis_page.AxisPage,
            "tuning": tuning.TuningPage,
            "autotuning": parameter_tuning.ParameterTuningPage,
            "looptest": loop_test.LoopTestPage,
            "storage": storage.StoragePage,
            "registers": registers.RegistersPage,
            "sequence": sequence.SequencePage,
            "logs": logs.LogsPage,
        }
        cls = mapping[page_id]
        return cls(self.store, self.theme, self)

    def _build_pages(self) -> None:
        for page_id, *_ in PAGES:
            page = self._make_page(page_id)
            self.pages[page_id] = page

    def navigate(self, page_id: str) -> None:
        if self.store.production_mode and page_id in OP_ONLY:
            return
        page = self.pages.get(page_id)
        if page is None:
            return
        while self.content_col.count() > 1:
            item = self.content_col.takeAt(0)
            if item.widget():
                item.widget().setParent(None)
        self.page_id = page_id
        title, desc, crumb = TITLES[page_id]
        self.page_title.setText(title)
        self.page_desc.setText(desc)
        self.crumb_page.setText(crumb)
        self.content_col.insertWidget(0, page)
        page.setVisible(True)
        self.scroll.verticalScrollBar().setValue(0)
        self.scroll.setFocus(Qt.FocusReason.OtherFocusReason)
        for pid, btn in self.rail.nav_buttons.items():
            btn.setChecked(pid == page_id)
        self.rail.refresh()
        self.toolbar.setVisible(page_id != "cylinders")
        if hasattr(page, "on_show"):
            page.on_show()
        self.refresh_chrome()

    # -------------------------------------------------------------- chrome
    def _port_changed(self) -> None:
        value = self.port_select.value()
        if value:
            self.store.port = value
            self.store.save_settings()

    def _connect_clicked(self) -> None:
        if self.store.connected:
            self.store.disconnect()
        else:
            self.store.connect()

    def _enable_clicked(self) -> None:
        if self.store.mode_gateway and self.store.motor_tmc == "online":
            self.store.disable_motor()
        else:
            self.store.enable_motor()

    def _permit_clicked(self) -> None:
        state = self.store.semantic.get("state")
        self.store.set_permit(not (state and state.permit))

    def refresh_chrome(self) -> None:
        store = self.store
        connected = store.connected
        self.conn_badge.set_text("已连接" if connected else "离线")
        self.conn_badge.set_tone("ok" if connected else "neutral")
        if self.conn_badge.dot:
            self.conn_badge.dot.setStyleSheet("font-size:8px;color:" + ("#3ddc84" if connected else "#6d7b8e") + ";")
        self.connect_btn.setText("断开" if connected else ("连接中…" if store.busy else "连接"))
        self.connect_btn.setEnabled(not store.busy and not store.job_running)
        self.connect_btn.setProperty("variant", "ghost" if connected else "primary")
        self.connect_btn.style().unpolish(self.connect_btn)
        self.connect_btn.style().polish(self.connect_btn)
        self.mode_select.setEnabled(not connected and not store.busy)
        self.mode_select.blockSignals(True)
        index = self.mode_select.findData(store.mode)
        if index >= 0:
            self.mode_select.setCurrentIndex(index)
        self.mode_select.blockSignals(False)
        ports = [(p[0], p[0]) for p in store.ports] or [(store.port, store.port)]
        if [self.port_select.itemData(i) for i in range(self.port_select.count())] != [p[0] for p in ports]:
            self.port_select.blockSignals(True)
            self.port_select.set_options(ports, store.port)
            self.port_select.blockSignals(False)
        self.port_select.setEnabled(not connected)
        self.baud_select.setEnabled(not connected and store.mode == "direct")
        self.motor_select.blockSignals(True)
        idx = self.motor_select.findData(store.motor)
        if idx >= 0:
            self.motor_select.setCurrentIndex(idx)
        self.motor_select.blockSignals(False)
        self.motor_select.setEnabled(not (store.busy or store.job_running or store.motion_active))
        online = store.motor_tmc == "online"
        self.enable_btn.setText(("关闭逻辑电源" if store.mode_gateway else "重新探测") if online else "使能 / 上电")
        state = store.semantic.get("state")
        self.permit_btn.setVisible(store.mode_gateway)
        self.permit_btn.setText("取消运动授权" if state and state.permit else "开启运动授权")
        self.permit_btn.setEnabled(connected and bool(state and state.config_verified))
        self.toolbar_status.setText(
            "参数整定中 · 切页继续执行" if store.acquiring else "运动中" if store.motion_active else "待命"
        )
        self.rail.refresh()

    def _tick(self) -> None:
        pass

    def _toast(self, tone: str, text: str) -> None:
        key = int(__import__("time").time() * 1000)
        self.toast_host.push(key, tone, text)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self.toast_host.setGeometry(self.width() - 444, self.height() - 330, 420, 300)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        t = self.theme
        p.fillRect(self.rect(), QColor(t.bg))
        g1 = QRadialGradient(QPointF(self.width() * 0.78, -40), 900)
        accent = QColor(t.accent)
        accent.setAlpha(18)
        g1.setColorAt(0, accent)
        accent2 = QColor(t.accent)
        accent2.setAlpha(0)
        g1.setColorAt(1, accent2)
        p.fillRect(self.rect(), g1)
        g2 = QRadialGradient(QPointF(self.width() * 0.1, self.height() * 1.05), 700)
        blue = QColor(t.blue)
        blue.setAlpha(14)
        g2.setColorAt(0, blue)
        blue2 = QColor(t.blue)
        blue2.setAlpha(0)
        g2.setColorAt(1, blue2)
        p.fillRect(self.rect(), g2)
        p.end()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.store = AppStore()
        self.theme: Theme = THEMES.get(self.store.theme_name, THEMES["dark"])
        self.setWindowTitle("TSL Viewer · TMC6460 Studio")
        self.resize(1600, 980)
        self.setMinimumSize(1280, 800)
        self.shell = Shell(self)
        self.setCentralWidget(self.shell)
        self.apply_theme(self.store.theme_name)

    def apply_theme(self, name: str) -> None:
        from .theme import set_active

        self.theme = THEMES.get(name, THEMES["dark"])
        set_active(self.theme)
        self.setStyleSheet(qss(self.theme))
        if hasattr(self, "shell") and self.shell is not None:
            self.shell.theme = self.theme
            for page in self.shell.pages.values():
                page.theme = self.theme
                if hasattr(page, "apply_theme"):
                    page.apply_theme(self.theme)
            self.shell.rail.refresh()
            self.shell.refresh_chrome()

    def open_settings(self) -> None:
        dialog = SettingsDialog(self.store, self, self.apply_theme)
        dialog.exec()


def run(demo: bool = False) -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("TSL Viewer")
    app.setOrganizationName("TSLViewer")
    app.setFont(ui_font(13))
    window = MainWindow()
    if demo:
        from .demo import install_demo

        install_demo(window.store)
    window.show()
    return app.exec()
