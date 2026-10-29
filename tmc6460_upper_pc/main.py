"""
TMC6460 上位机 v2 - 高速波形 + PRBS 系统辨识
通信链路: PC --USB转485--> TMC6460 (UART 460800 8N1)
"""

import sys
import os
import time
import math
import collections
import threading
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGridLayout, QGroupBox, QLabel, QComboBox, QPushButton, QLineEdit,
    QSpinBox, QCheckBox, QTabWidget, QTreeWidget, QTreeWidgetItem,
    QStatusBar, QMessageBox, QTableWidget, QTableWidgetItem,
    QHeaderView, QDoubleSpinBox
)
from PyQt5.QtCore import QTimer, Qt, pyqtSignal, QObject, QThread
from PyQt5.QtGui import QFont, QColor, QPalette
import pyqtgraph as pg

from tmc6460_protocol import (
    TMC6460Serial, TMC6460_REGISTERS, REGISTER_GROUPS,
    WAVEFORM_CHANNELS, make_read_request, parse_read_response,
    SSI_PRESETS, eeprom_save_config, eeprom_save_config_custom, eeprom_load_config
)
from collections import defaultdict
from tmc6460_encoder import (
    ENCODER_PRESETS, setup_encoder,
    IO_CMD as IO_CONTROLLER_COMMAND,
    IO_RESP0 as IO_CONTROLLER_RESPONSE0,
    IO_RESP3 as IO_CONTROLLER_RESPONSE3,
    ENCODER_ANGLE_ADDR
)
from autotune_worker import AutotuneWorker


# ==================== RTMI 数据桥接 ====================
class RTMIDataBridge(QObject):
    """将 TMC6460Serial RTMI 后台接收线程的数据桥接到 Qt 主线程信号"""
    data_ready = pyqtSignal(int, float, float)  # ch_idx, timestamp, value

    def __init__(self):
        super().__init__()
        self._ch_map = {}  # RTMI ch_id → waveform ch_idx
        self._map_lock = threading.Lock()

    def set_channel_map(self, ch_map: dict):
        with self._map_lock:
            self._ch_map = dict(ch_map)

    def __call__(self, ch_id: int, data: int):
        """RTMI 回调入口（RTMI 线程调用）"""
        with self._map_lock:
            ch_idx = self._ch_map.get(ch_id)
        if ch_idx is not None:
            if data > 0x7FFFFFFF:
                data = data - 0x100000000
            self.data_ready.emit(ch_idx, time.time(), float(data))


# ==================== PID 整定后台线程 ====================
class TMC6460MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("TMC6460 FOC 调试上位机 v2")
        self.setMinimumSize(1400, 900)

        self.tmc = TMC6460Serial()
        self.rtmi_bridge = RTMIDataBridge()
        self.rtmi_bridge.data_ready.connect(self._on_waveform_data)
        self._fps_counter = 0
        self._fps_last = time.time()

        # 波形数据
        self.BUF_SIZE = 3000
        self.waveform_buffers = {}
        self.waveform_times = {}
        self.waveform_curves = {}
        self.start_time = 0

        self._build_ui()
        self._refresh_ports()

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)

        # === 连接栏 ===
        conn_group = QGroupBox("串口连接")
        conn_layout = QHBoxLayout()
        conn_layout.addWidget(QLabel("端口:"))
        self.port_combo = QComboBox()
        self.port_combo.setMinimumWidth(120)
        conn_layout.addWidget(self.port_combo)
        self.refresh_btn = QPushButton("刷新")
        self.refresh_btn.clicked.connect(self._refresh_ports)
        conn_layout.addWidget(self.refresh_btn)
        conn_layout.addWidget(QLabel("波特率:"))
        self.baud_combo = QComboBox()
        self.baud_combo.addItems(["9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600", "2000000"])
        self.baud_combo.setCurrentText("115200")
        conn_layout.addWidget(self.baud_combo)
        self.connect_btn = QPushButton("连接")
        self.connect_btn.clicked.connect(self._toggle_connection)
        conn_layout.addWidget(self.connect_btn)
        conn_layout.addStretch()
        self.status_label = QLabel("未连接")
        self.status_label.setStyleSheet("color: gray; font-weight: bold;")
        conn_layout.addWidget(self.status_label)
        conn_group.setLayout(conn_layout)
        main_layout.addWidget(conn_group)

        # === Tab ===
        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_register_tab(), "寄存器读写")
        self.tabs.addTab(self._build_waveform_tab(), "实时波形")
        self.tabs.addTab(self._build_pid_autotune_tab(), "PID 整定")
        self.tabs.addTab(self._build_closedloop_tab(), "闭环测试")
        self.tabs.addTab(self._build_prbs_tab(), "PRBS 辨识")
        self.tabs.addTab(self._build_ssi_tab(), "SSI 编码器")
        self.tabs.addTab(self._build_openloop_tab(), "开环测试")
        self.tabs.addTab(self._build_calib_tab(), "电角度标定")
        self.tabs.addTab(self._build_eeprom_tab(), "EEPROM 配置")
        main_layout.addWidget(self.tabs)

        self.statusBar().showMessage("就绪")

    # ---------- 寄存器 Tab ----------
    def _build_register_tab(self) -> QWidget:
        widget = QWidget()
        layout = QHBoxLayout(widget)
        left = QGroupBox("寄存器列表")
        left_layout = QVBoxLayout()
        self.reg_tree = QTreeWidget()
        self.reg_tree.setHeaderLabels(["名称", "地址", "描述"])
        self.reg_tree.setColumnWidth(0, 220)
        self.reg_tree.setColumnWidth(1, 80)
        for group_name, addrs in REGISTER_GROUPS:
            group_item = QTreeWidgetItem([group_name, "", ""])
            group_item.setExpanded(True)
            for addr in addrs:
                if addr in TMC6460_REGISTERS:
                    name, desc, _ = TMC6460_REGISTERS[addr]
                    child = QTreeWidgetItem([name, f"0x{addr:03X}", desc])
                    child.setData(0, Qt.UserRole, addr)
                    group_item.addChild(child)
            self.reg_tree.addTopLevelItem(group_item)
        self.reg_tree.currentItemChanged.connect(self._on_reg_selected)
        left_layout.addWidget(self.reg_tree)
        left.setLayout(left_layout)
        layout.addWidget(left, stretch=1)

        right = QGroupBox("操作")
        right_layout = QVBoxLayout()
        addr_row = QHBoxLayout()
        addr_row.addWidget(QLabel("地址: 0x"))
        self.addr_input = QLineEdit("000")
        self.addr_input.setMaximumWidth(80)
        self.addr_input.setFont(QFont("Consolas", 11))
        addr_row.addWidget(self.addr_input)
        addr_row.addStretch()
        right_layout.addLayout(addr_row)

        read_row = QHBoxLayout()
        self.read_btn = QPushButton("📖 读取")
        self.read_btn.clicked.connect(self._read_register)
        read_row.addWidget(self.read_btn)
        self.read_result = QLineEdit()
        self.read_result.setReadOnly(True)
        self.read_result.setFont(QFont("Consolas", 11))
        read_row.addWidget(self.read_result)
        right_layout.addLayout(read_row)

        write_row = QHBoxLayout()
        write_row.addWidget(QLabel("数据: 0x"))
        self.data_input = QLineEdit("00000000")
        self.data_input.setMaximumWidth(120)
        self.data_input.setFont(QFont("Consolas", 11))
        write_row.addWidget(self.data_input)
        self.write_btn = QPushButton("✏️ 写入")
        self.write_btn.clicked.connect(self._write_register)
        write_row.addWidget(self.write_btn)
        write_row.addStretch()
        right_layout.addLayout(write_row)

        raw_group = QGroupBox("原始数据")
        raw_layout = QVBoxLayout()
        self.raw_req_label = QLabel("请求: --")
        self.raw_req_label.setFont(QFont("Consolas", 10))
        self.raw_resp_label = QLabel("响应: --")
        self.raw_resp_label.setFont(QFont("Consolas", 10))
        raw_layout.addWidget(self.raw_req_label)
        raw_layout.addWidget(self.raw_resp_label)
        raw_group.setLayout(raw_layout)
        right_layout.addWidget(raw_group)
        self.sel_reg_label = QLabel("选中: --")
        right_layout.addWidget(self.sel_reg_label)
        right_layout.addStretch()
        right.setLayout(right_layout)
        layout.addWidget(right, stretch=1)
        return widget

    # ---------- 波形 Tab ----------
    def _build_waveform_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        ctrl = QHBoxLayout()
        self.monitor_btn = QPushButton("▶ 启动 RTMI 监控")
        self.monitor_btn.clicked.connect(self._toggle_monitoring)
        ctrl.addWidget(self.monitor_btn)
        ctrl.addWidget(QLabel("RTMI 降采样:"))
        self.sampling_spin = QSpinBox()
        self.sampling_spin.setRange(0, 255)
        self.sampling_spin.setValue(49)
        self.sampling_spin.setToolTip("f_RTMI = f_PWM / (降采样+1)\n49 → 1kHz (f_PWM=50kHz)")
        ctrl.addWidget(self.sampling_spin)
        self.freq_label = QLabel("≈ 1.0 kHz")
        self.freq_label.setStyleSheet("color: #4fc3f7;")
        self.sampling_spin.valueChanged.connect(self._update_rtmi_freq_label)
        ctrl.addWidget(self.freq_label)
        self.clear_btn = QPushButton("🗑 清除")
        self.clear_btn.clicked.connect(self._clear_waveform)
        ctrl.addWidget(self.clear_btn)
        ctrl.addStretch()
        self.fps_label = QLabel("实际刷新率: -- Hz")
        self.fps_label.setStyleSheet("color: #4fc3f7; font-weight: bold;")
        ctrl.addWidget(self.fps_label)
        layout.addLayout(ctrl)

        # 通道选择
        ch_row = QHBoxLayout()
        self.waveform_checkboxes = {}
        for i, (name, addr, desc) in enumerate(WAVEFORM_CHANNELS):
            cb = QCheckBox(desc)
            cb.setChecked(i < 3)
            cb.setProperty("ch_idx", i)
            cb.toggled.connect(self._on_channel_toggled)
            self.waveform_checkboxes[i] = cb
            ch_row.addWidget(cb)
        layout.addLayout(ch_row)

        pg.setConfigOptions(antialias=True)
        self.plot_widget = pg.PlotWidget(title="TMC6460 实时监控")
        self.plot_widget.setLabel('left', '值')
        self.plot_widget.setLabel('bottom', '时间', units='s')
        self.plot_widget.addLegend()
        self.plot_widget.showGrid(x=True, y=True, alpha=0.3)
        colors = ['#00bcd4', '#ff5722', '#4caf50', '#ffeb3b', '#9c27b0', '#2196f3', '#ff9800', '#e91e63']
        for i, (name, addr, desc) in enumerate(WAVEFORM_CHANNELS):
            self.waveform_buffers[i] = collections.deque(maxlen=self.BUF_SIZE)
            self.waveform_times[i] = collections.deque(maxlen=self.BUF_SIZE)
            curve = self.plot_widget.plot([], [], pen=pg.mkPen(colors[i], width=2), name=desc)
            self.waveform_curves[i] = curve
        layout.addWidget(self.plot_widget)

        # 数值表
        self.value_table = QTableWidget(len(WAVEFORM_CHANNELS), 3)
        self.value_table.setHorizontalHeaderLabels(["通道", "地址", "当前值"])
        self.value_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        for i, (name, addr, desc) in enumerate(WAVEFORM_CHANNELS):
            self.value_table.setItem(i, 0, QTableWidgetItem(desc))
            self.value_table.setItem(i, 1, QTableWidgetItem(f"0x{addr:03X}"))
            self.value_table.setItem(i, 2, QTableWidgetItem("--"))
        self.value_table.setMaximumHeight(180)
        layout.addWidget(self.value_table)

        # 显示定时器：每 30ms 批量刷新波形曲线
        self._display_timer = QTimer()
        self._display_timer.timeout.connect(self._refresh_display)
        self._display_timer.start(33)  # ~30fps 绘图刷新
        self._fps_timer = QTimer()
        self._fps_timer.timeout.connect(self._update_fps)
        self._fps_timer.start(1000)

        return widget

    # ---------- PID 调参 Tab ----------
    def _build_pid_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # PID 参数
        pid_group = QGroupBox("PID 参数配置")
        pid_layout = QGridLayout()
        headers = ["参数", "地址", "当前值", "新值", "", ""]
        for col, h in enumerate(headers):
            pid_layout.addWidget(QLabel(h), 0, col)

        self.pid_rows = []
        pid_params = [
            ("PID 配置", 0x140),
            ("力矩 PID 系数", 0x143),
            ("磁通 PID 系数", 0x142),
            ("速度 PID 系数", 0x145),
            ("位置 PID 系数", 0x146),
            ("力矩/磁通限制", 0x14A),
            ("速度限制", 0x14B),
            ("位置下限", 0x14C),
            ("位置上限", 0x14D),
            ("位置容差", 0x147),
            ("位置容差延迟", 0x148),
        ]
        for row, (name, addr) in enumerate(pid_params, 1):
            pid_layout.addWidget(QLabel(name), row, 0)
            pid_layout.addWidget(QLabel(f"0x{addr:03X}"), row, 1)
            val_label = QLabel("--")
            val_label.setFont(QFont("Consolas", 10))
            pid_layout.addWidget(val_label, row, 2)
            new_val = QLineEdit()
            new_val.setMaximumWidth(120)
            new_val.setFont(QFont("Consolas", 10))
            new_val.setPlaceholderText("0x...")
            pid_layout.addWidget(new_val, row, 3)
            r_btn = QPushButton("R")
            r_btn.setMaximumWidth(30)
            r_btn.clicked.connect(lambda _, a=addr, v=val_label: self._read_to_label(a, v))
            pid_layout.addWidget(r_btn, row, 4)
            w_btn = QPushButton("W")
            w_btn.setMaximumWidth(30)
            w_btn.clicked.connect(lambda _, a=addr, w=new_val: self._write_from_input(a, w))
            pid_layout.addWidget(w_btn, row, 5)
            self.pid_rows.append((addr, val_label, new_val))

        # 批量读取
        batch_btn = QPushButton("📖 全部读取")
        batch_btn.clicked.connect(self._read_all_pid)
        pid_layout.addWidget(batch_btn, len(pid_params) + 1, 0, 1, 6)

        pid_group.setLayout(pid_layout)
        layout.addWidget(pid_group)

        # 目标值
        target_group = QGroupBox("目标值控制")
        target_layout = QGridLayout()
        targets = [
            ("力矩/磁通目标", 0x14E),
            ("速度目标", 0x150),
            ("位置目标", 0x152),
        ]
        self.target_spins = {}
        for row, (name, addr) in enumerate(targets):
            target_layout.addWidget(QLabel(name), row, 0)
            target_layout.addWidget(QLabel(f"0x{addr:03X}"), row, 1)
            spin = QDoubleSpinBox()
            spin.setRange(-2147483648, 2147483647)
            spin.setDecimals(0)
            spin.setFont(QFont("Consolas", 10))
            target_layout.addWidget(spin, row, 2)
            btn = QPushButton("发送")
            btn.clicked.connect(lambda _, a=addr, s=spin: self._write_from_spinbox(a, s))
            target_layout.addWidget(btn, row, 3)
            self.target_spins[name] = spin

        target_group.setLayout(target_layout)
        layout.addWidget(target_group)
        layout.addStretch()
        return widget

    # ---------- PID 整定 Tab ----------
    def _build_pid_autotune_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 说明
        info = QLabel(
            "PID 自动整定 - 阶跃响应法\n"
            "选择环路类型 → 设置参数 → 点击执行 → 查看响应曲线"
        )
        info.setStyleSheet("color: #90a4ae; padding: 8px;")
        layout.addWidget(info)

        # 参数配置
        param_group = QGroupBox("整定参数")
        param_layout = QGridLayout()

        # 环路类型
        param_layout.addWidget(QLabel("环路类型:"), 0, 0)
        self.autotune_loop_combo = QComboBox()
        self.autotune_loop_combo.addItem("电流环 (iD)", "current")
        self.autotune_loop_combo.addItem("速度环", "velocity")
        self.autotune_loop_combo.addItem("位置环", "position")
        self.autotune_loop_combo.currentTextChanged.connect(self._on_autotune_loop_changed)
        param_layout.addWidget(self.autotune_loop_combo, 0, 1)

        # Offset
        param_layout.addWidget(QLabel("Phi_e Offset:"), 1, 0)
        self.autotune_offset_edit = QLineEdit("0xFFFF962B")
        self.autotune_offset_edit.setFont(QFont("Consolas", 10))
        self.autotune_offset_edit.setMaximumWidth(150)
        param_layout.addWidget(self.autotune_offset_edit, 1, 1)

        # 极对数
        param_layout.addWidget(QLabel("极对数:"), 1, 2)
        self.autotune_poles_spin = QSpinBox()
        self.autotune_poles_spin.setRange(1, 127)
        self.autotune_poles_spin.setValue(1)
        param_layout.addWidget(self.autotune_poles_spin, 1, 3)

        # Kp
        param_layout.addWidget(QLabel("P (比例):"), 2, 0)
        self.autotune_kp_spin = QSpinBox()
        self.autotune_kp_spin.setRange(0, 65535)
        self.autotune_kp_spin.setValue(359)
        self.autotune_kp_spin.setFont(QFont("Consolas", 10))
        param_layout.addWidget(self.autotune_kp_spin, 2, 1)
        self.autotune_calc_label = QLabel("")
        self.autotune_calc_label.setStyleSheet("color: #4fc3f7; font-size: 11px;")
        param_layout.addWidget(self.autotune_calc_label, 2, 2, 1, 2)

        # Ki
        param_layout.addWidget(QLabel("I (积分):"), 3, 0)
        self.autotune_ki_spin = QSpinBox()
        self.autotune_ki_spin.setRange(0, 65535)
        self.autotune_ki_spin.setValue(129)
        self.autotune_ki_spin.setFont(QFont("Consolas", 10))
        param_layout.addWidget(self.autotune_ki_spin, 3, 1)

        # 阶跃幅度
        param_layout.addWidget(QLabel("阶跃幅度:"), 4, 0)
        self.autotune_step_spin = QSpinBox()
        self.autotune_step_spin.setRange(1, 5000)
        self.autotune_step_spin.setValue(500)
        self.autotune_step_spin.setFont(QFont("Consolas", 10))
        param_layout.addWidget(self.autotune_step_spin, 4, 1)
        self.autotune_step_unit_label = QLabel("mA")
        self.autotune_step_unit_label.setStyleSheet("color: #4fc3f7;")
        param_layout.addWidget(self.autotune_step_unit_label, 4, 2)

        # R
        param_layout.addWidget(QLabel("R (Ω):"), 5, 0)
        self.autotune_r_edit = QLineEdit("2.01")
        self.autotune_r_edit.setFont(QFont("Consolas", 10))
        self.autotune_r_edit.setMaximumWidth(100)
        self.autotune_r_edit.textChanged.connect(self._autotune_calc_pi)
        param_layout.addWidget(self.autotune_r_edit, 5, 1)

        # L
        param_layout.addWidget(QLabel("L (µH):"), 5, 2)
        self.autotune_l_edit = QLineEdit("111.8")
        self.autotune_l_edit.setFont(QFont("Consolas", 10))
        self.autotune_l_edit.setMaximumWidth(100)
        self.autotune_l_edit.textChanged.connect(self._autotune_calc_pi)
        param_layout.addWidget(self.autotune_l_edit, 5, 3)

        # 带宽
        param_layout.addWidget(QLabel("目标带宽 (Hz):"), 6, 0)
        self.autotune_bw_spin = QSpinBox()
        self.autotune_bw_spin.setRange(100, 20000)
        self.autotune_bw_spin.setValue(2000)
        self.autotune_bw_spin.setFont(QFont("Consolas", 10))
        self.autotune_bw_spin.valueChanged.connect(self._autotune_calc_pi)
        param_layout.addWidget(self.autotune_bw_spin, 6, 1)

        # 采集时长
        param_layout.addWidget(QLabel("采集时长 (s):"), 6, 2)
        self.autotune_duration_spin = QDoubleSpinBox()
        self.autotune_duration_spin.setRange(0.5, 10.0)
        self.autotune_duration_spin.setValue(2.0)
        self.autotune_duration_spin.setSingleStep(0.5)
        param_layout.addWidget(self.autotune_duration_spin, 6, 3)

        param_group.setLayout(param_layout)
        layout.addWidget(param_group)

        # 按钮 + 状态
        btn_layout = QHBoxLayout()
        self.autotune_exec_btn = QPushButton("▶ 执行")
        self.autotune_exec_btn.setStyleSheet("font-size: 14px; padding: 8px 24px;")
        self.autotune_exec_btn.clicked.connect(self._execute_autotune)
        btn_layout.addWidget(self.autotune_exec_btn)
        self.autotune_status_label = QLabel("")
        self.autotune_status_label.setStyleSheet("color: #4fc3f7;")
        btn_layout.addWidget(self.autotune_status_label)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 图片显示
        self.autotune_img_label = QLabel("执行后此处显示响应曲线")
        self.autotune_img_label.setAlignment(Qt.AlignCenter)
        self.autotune_img_label.setStyleSheet("color: #546e7a; border: 1px dashed #444; font-size: 14px;")
        layout.addWidget(self.autotune_img_label, stretch=1)

        # 速度/位置环禁用（暂未实现）
        self._autotune_current_widgets = [
            self.autotune_step_spin, self.autotune_r_edit,
            self.autotune_l_edit, self.autotune_bw_spin,
            self.autotune_kp_spin, self.autotune_ki_spin
        ]

        # 初始计算一次 PI
        self._autotune_calc_pi()

        return widget

    def _on_autotune_loop_changed(self, text):
        is_current = "电流" in text
        is_velocity = "速度" in text
        # 电流环专用字段
        for w in [self.autotune_r_edit, self.autotune_l_edit, self.autotune_bw_spin]:
            w.setEnabled(is_current)
        # 通用字段
        self.autotune_step_spin.setEnabled(is_current or is_velocity)
        self.autotune_kp_spin.setEnabled(True)
        self.autotune_ki_spin.setEnabled(True)
        if is_current:
            self.autotune_step_unit_label.setText("mA")
            self.autotune_step_spin.setRange(1, 5000)
            self.autotune_calc_label.setText("")
            self._autotune_calc_pi()
        elif is_velocity:
            self.autotune_step_unit_label.setText("rpm")
            self.autotune_step_spin.setRange(1, 10000)
            self.autotune_step_spin.setValue(300)
            self.autotune_calc_label.setText("PI手动 | 1RPM=305内部单位 | iq限幅1000mA")
            self.autotune_kp_spin.setValue(100)
            self.autotune_ki_spin.setValue(10)
        else:
            self.autotune_step_unit_label.setText("")
            self.autotune_status_label.setText("位置环暂未实现")
            self.autotune_status_label.setStyleSheet("color: #ff9800;")

    def _autotune_calc_pi(self):
        """R/L/带宽变化时自动计算 P 和 I"""
        import math
        try:
            R = float(self.autotune_r_edit.text())
            L_uH = float(self.autotune_l_edit.text())
            L = L_uH * 1e-6
            f_bw = self.autotune_bw_spin.value()
            f_pwm = 50000

            kp = 2 * math.pi * f_bw * L
            ki = 2 * math.pi * f_bw * R
            dt = 1.0 / f_pwm
            p_reg = max(1, min(65535, int(kp * 256)))
            i_reg = max(0, min(65535, int(ki * dt * 256)))

            # 更新 spinbox（不触发信号）
            self.autotune_kp_spin.blockSignals(True)
            self.autotune_ki_spin.blockSignals(True)
            self.autotune_kp_spin.setValue(p_reg)
            self.autotune_ki_spin.setValue(i_reg)
            self.autotune_kp_spin.blockSignals(False)
            self.autotune_ki_spin.blockSignals(False)

            self.autotune_calc_label.setText(
                f"Kp={kp:.4f} Ki={ki:.1f}  "
                f"(P={p_reg} I={i_reg} = 0x{(p_reg<<16|i_reg):08X})"
            )
        except (ValueError, ZeroDivisionError):
            pass

    def _execute_autotune(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "错误", "请先连接串口")
            return
        if not hasattr(self, '_autotune_worker') or self._autotune_worker is None or not self._autotune_worker.isRunning():
            pass
        else:
            QMessageBox.warning(self, "提示", "正在执行中，请等待完成")
            return

        loop_type = self.autotune_loop_combo.currentData()

        # 解析参数
        offset_str = self.autotune_offset_edit.text().strip()
        offset = int(offset_str, 16) if offset_str.startswith('0x') else int(offset_str)
        target_val = self.autotune_step_spin.value()
        duration = self.autotune_duration_spin.value()
        poles = self.autotune_poles_spin.value()
        p_reg = self.autotune_kp_spin.value()
        i_reg = self.autotune_ki_spin.value()

        import os
        plot_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'autotune_result.png')

        if loop_type == "current":
            R = float(self.autotune_r_edit.text())
            L_uH = float(self.autotune_l_edit.text())
            L = L_uH * 1e-6
            f_bw = self.autotune_bw_spin.value()
            params = {
                'loop_type': 'current',
                'offset': offset, 'poles': poles, 'target_ma': target_val,
                'f_bw': f_bw, 'duration': duration, 'R': R, 'L': L,
                'p_reg': p_reg, 'i_reg': i_reg, 'plot_path': plot_path,
            }
        elif loop_type == "velocity":
            params = {
                'loop_type': 'velocity',
                'offset': offset, 'poles': poles, 'target_rpm': target_val,
                'duration': duration,
                'vel_p_reg': p_reg, 'vel_i_reg': i_reg,
                'cur_p_reg': self.autotune_cur_p if hasattr(self, 'autotune_cur_p') else 179,
                'cur_i_reg': self.autotune_cur_i if hasattr(self, 'autotune_cur_i') else 64,
                'plot_path': plot_path,
            }
        else:
            QMessageBox.information(self, "提示", "暂未实现")
            return

        self.autotune_exec_btn.setEnabled(False)
        self.autotune_status_label.setText("执行中...")
        self.autotune_status_label.setStyleSheet("color: #ffeb3b;")

        self._autotune_worker = AutotuneWorker(self.tmc, params)
        self._autotune_worker.progress.connect(self._on_autotune_progress)
        self._autotune_worker.finished.connect(self._on_autotune_finished)
        self._autotune_worker.start()

    def _on_autotune_progress(self, msg):
        self.autotune_status_label.setText(msg)

    def _on_autotune_finished(self, result):
        self.autotune_exec_btn.setEnabled(True)
        if result['success']:
            self.autotune_status_label.setText(result['message'])
            self.autotune_status_label.setStyleSheet("color: #4caf50;")
            # 显示图片
            img_path = result.get('image_path', '')
            if img_path and os.path.exists(img_path):
                from PyQt5.QtGui import QPixmap
                pixmap = QPixmap(img_path)
                scaled = pixmap.scaled(
                    self.autotune_img_label.size(),
                    Qt.KeepAspectRatio, Qt.SmoothTransformation
                )
                self.autotune_img_label.setPixmap(scaled)
        else:
            self.autotune_status_label.setText(result['message'])
            self.autotune_status_label.setStyleSheet("color: #f44336;")

    # ==================== 单位换算常量 ====================
    # 来源：TMC6460 datasheet Page 71 Table 18 + MEMORY.md
    # 电流：CSA_GAIN=3, 10V/V
    CL_MA_PER_COUNT = 0.20131     # mA/count
    # 速度：MT6701 SSI 14-bit, CPR_INV=1024, f_SYS=60MHz
    CL_K_VEL = 305.4              # internal units/RPM
    # 位置：CPREXT=16384, CPR_INV=1024 → 65536 internal = 1 rev
    # 用户交互单位：0.01° (36000 = 1 rev)
    CL_POS_PER_REV = 65536        # internal position units/revolution
    CL_USER_PER_REV = 36000       # user units/revolution (0.01° × 36000 = 360°)
    CL_POS_TO_USER = CL_USER_PER_REV / CL_POS_PER_REV   # 36000/65536 ≈ 0.5493
    CL_USER_TO_POS = CL_POS_PER_REV / CL_USER_PER_REV   # 65536/36000 ≈ 1.8204

    # ---------- 闭环测试 Tab ----------
    def _build_closedloop_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 控制面板
        ctrl_group = QGroupBox("闭环控制")
        ctrl_layout = QGridLayout()

        # 模式选择
        ctrl_layout.addWidget(QLabel("控制模式:"), 0, 0)
        self.cl_mode_combo = QComboBox()
        self.cl_mode_combo.addItem("iD (磁通电流)", "id")
        self.cl_mode_combo.addItem("iQ (力矩电流)", "iq")
        self.cl_mode_combo.addItem("速度", "velocity")
        self.cl_mode_combo.addItem("位置", "position")
        self.cl_mode_combo.currentTextChanged.connect(self._on_cl_mode_changed)
        ctrl_layout.addWidget(self.cl_mode_combo, 0, 1)

        # 目标值
        ctrl_layout.addWidget(QLabel("目标值:"), 1, 0)
        self.cl_target_spin = QDoubleSpinBox()
        self.cl_target_spin.setRange(-100000000, 100000000)
        self.cl_target_spin.setDecimals(1)
        self.cl_target_spin.setValue(0)
        self.cl_target_spin.setFont(QFont("Consolas", 11))
        self.cl_target_spin.setStyleSheet("font-size: 14px;")
        ctrl_layout.addWidget(self.cl_target_spin, 1, 1)
        self.cl_unit_label = QLabel("mA")
        self.cl_unit_label.setStyleSheet("color: #4fc3f7; font-size: 13px;")
        ctrl_layout.addWidget(self.cl_unit_label, 1, 2)
        self.cl_set_btn = QPushButton("设定")
        self.cl_set_btn.setStyleSheet("font-size: 13px; padding: 4px 12px;")
        self.cl_set_btn.setToolTip("运行中点击可更新目标值")
        self.cl_set_btn.clicked.connect(self._cl_set_target)
        ctrl_layout.addWidget(self.cl_set_btn, 1, 3)

        # 启动/停止
        self.cl_start_btn = QPushButton("▶ 启动")
        self.cl_start_btn.setStyleSheet("font-size: 14px; padding: 8px 24px; background-color: #4caf50;")
        self.cl_start_btn.clicked.connect(self._cl_toggle)
        ctrl_layout.addWidget(self.cl_start_btn, 0, 4, 2, 1)

        # 状态
        self.cl_status_label = QLabel("")
        self.cl_status_label.setStyleSheet("color: #90a4ae;")
        ctrl_layout.addWidget(self.cl_status_label, 2, 0, 1, 6)

        ctrl_group.setLayout(ctrl_layout)
        layout.addWidget(ctrl_group)

        # === PID 参数配置 ===
        pid_group = QGroupBox("PID 参数 (闭环)")
        pid_layout = QGridLayout()

        # 电流环 PI
        pid_layout.addWidget(QLabel("── 电流环 PI (0x142/0x143) ──"), 0, 0, 1, 4)
        pid_layout.addWidget(QLabel("P:"), 1, 0)
        self.cl_cur_p_spin = QSpinBox()
        self.cl_cur_p_spin.setRange(0, 65535)
        self.cl_cur_p_spin.setValue(179)
        self.cl_cur_p_spin.setFont(QFont("Consolas", 10))
        self.cl_cur_p_spin.setToolTip("电流环比例系数 (寄存器值)")
        pid_layout.addWidget(self.cl_cur_p_spin, 1, 1)
        pid_layout.addWidget(QLabel("I:"), 1, 2)
        self.cl_cur_i_spin = QSpinBox()
        self.cl_cur_i_spin.setRange(0, 65535)
        self.cl_cur_i_spin.setValue(64)
        self.cl_cur_i_spin.setFont(QFont("Consolas", 10))
        self.cl_cur_i_spin.setToolTip("电流环积分系数 (寄存器值)")
        pid_layout.addWidget(self.cl_cur_i_spin, 1, 3)

        # 速度环 PI
        pid_layout.addWidget(QLabel("── 速度环 PI (0x145) ──"), 2, 0, 1, 4)
        pid_layout.addWidget(QLabel("P:"), 3, 0)
        self.cl_vel_p_spin = QSpinBox()
        self.cl_vel_p_spin.setRange(0, 65535)
        self.cl_vel_p_spin.setValue(500)
        self.cl_vel_p_spin.setFont(QFont("Consolas", 10))
        self.cl_vel_p_spin.setToolTip("速度环比例系数 (寄存器值)")
        pid_layout.addWidget(self.cl_vel_p_spin, 3, 1)
        pid_layout.addWidget(QLabel("I:"), 3, 2)
        self.cl_vel_i_spin = QSpinBox()
        self.cl_vel_i_spin.setRange(0, 65535)
        self.cl_vel_i_spin.setValue(250)
        self.cl_vel_i_spin.setFont(QFont("Consolas", 10))
        self.cl_vel_i_spin.setToolTip("速度环积分系数 (寄存器值)")
        pid_layout.addWidget(self.cl_vel_i_spin, 3, 3)

        # 位置环 Kp
        pid_layout.addWidget(QLabel("── 位置环 Kp (0x146) ──"), 4, 0, 1, 4)
        pid_layout.addWidget(QLabel("Kp:"), 5, 0)
        self.cl_pos_kp_spin = QSpinBox()
        self.cl_pos_kp_spin.setRange(0, 65535)
        self.cl_pos_kp_spin.setValue(800)
        self.cl_pos_kp_spin.setFont(QFont("Consolas", 10))
        self.cl_pos_kp_spin.setToolTip("位置环比例系数 (寄存器值，Ki=0)")
        pid_layout.addWidget(self.cl_pos_kp_spin, 5, 1)
        self.cl_pos_ki_label = QLabel("Ki: 0 (固定)")
        self.cl_pos_ki_label.setStyleSheet("color: #789090;")
        pid_layout.addWidget(self.cl_pos_ki_label, 5, 2, 1, 2)

        # 限幅 (可编辑)
        pid_layout.addWidget(QLabel("── 限幅 ──"), 6, 0, 1, 4)
        pid_layout.addWidget(QLabel("电流限幅:"), 7, 0)
        self.cl_cur_limit_spin = QDoubleSpinBox()
        self.cl_cur_limit_spin.setRange(0, 1650)
        self.cl_cur_limit_spin.setValue(1000)
        self.cl_cur_limit_spin.setDecimals(0)
        self.cl_cur_limit_spin.setSuffix(" mA")
        self.cl_cur_limit_spin.setFont(QFont("Consolas", 10))
        self.cl_cur_limit_spin.setToolTip("电流限幅 (mA)，写入 0x14A")
        pid_layout.addWidget(self.cl_cur_limit_spin, 7, 1)
        pid_layout.addWidget(QLabel("速度限幅:"), 7, 2)
        self.cl_vel_limit_spin = QDoubleSpinBox()
        self.cl_vel_limit_spin.setRange(0, 100000)
        self.cl_vel_limit_spin.setValue(10000)
        self.cl_vel_limit_spin.setDecimals(0)
        self.cl_vel_limit_spin.setSuffix(" rpm")
        self.cl_vel_limit_spin.setFont(QFont("Consolas", 10))
        self.cl_vel_limit_spin.setToolTip("速度限幅 (RPM)，写入 0x14B")
        pid_layout.addWidget(self.cl_vel_limit_spin, 7, 3)

        # 写入按钮
        self.cl_write_pid_btn = QPushButton("✏ 写入全部 PID 参数")
        self.cl_write_pid_btn.setStyleSheet("font-size: 13px; padding: 6px; background-color: #1b5e20;")
        self.cl_write_pid_btn.clicked.connect(self._cl_write_pid_params)
        pid_layout.addWidget(self.cl_write_pid_btn, 8, 0, 1, 4)

        pid_group.setLayout(pid_layout)
        layout.addWidget(pid_group)

        # 波形
        self.cl_plot_widget = pg.PlotWidget()
        self.cl_plot_widget.setLabel('left', '值')
        self.cl_plot_widget.setLabel('bottom', '时间 (ms)')
        self.cl_plot_widget.addLegend()
        self.cl_plot_widget.showGrid(x=True, y=True, alpha=0.3)
        self.cl_target_curve = self.cl_plot_widget.plot(pen=pg.mkPen('b', width=1.5), name='目标')
        self.cl_actual_curve = self.cl_plot_widget.plot(pen=pg.mkPen('r', width=1.5), name='实际')
        layout.addWidget(self.cl_plot_widget, stretch=1)

        # RTMI 回调（电流/速度模式仍用 RTMI）
        self.cl_rtmi_data = {0: [], 1: []}  # ch -> [(t, raw)]
        self.cl_rtmi_lock = threading.Lock()

        # 轮询数据（位置模式用 QTimer 轮询）
        self.cl_poll_data = {0: [], 1: []}  # 0=target, 1=actual, [(t_ms, val_deg)]

        # 显示刷新定时器
        self.cl_timer = QTimer()
        self.cl_timer.setInterval(10)  # 100Hz 轮询/刷新
        self.cl_timer.timeout.connect(self._cl_update_waveform)
        self.cl_running = False
        self.cl_start_time = 0
        self.cl_poll_mode = False  # True=QTimer轮询(位置模式), False=RTMI
        self.CL_BUF = 2000

        return widget

    def _on_cl_mode_changed(self, text):
        units = {"iD": "mA", "iQ": "mA", "速度": "rpm", "位置": "0.01° (36000=1圈)"}
        for key, unit in units.items():
            if key in text:
                self.cl_unit_label.setText(unit)
                break
        if "位置" in text:
            self.cl_target_spin.setDecimals(0)
            self.cl_target_spin.setRange(-100000000, 100000000)
            self.cl_target_spin.setToolTip("位置目标 (0.01°)\n36000 = 1圈 = 360°\n18000 = 半圈 = 180°")
        elif "速度" in text:
            self.cl_target_spin.setDecimals(1)
            self.cl_target_spin.setToolTip("速度目标 (RPM)")
        else:
            self.cl_target_spin.setDecimals(1)
            self.cl_target_spin.setToolTip("")

    def _cl_set_target(self):
        """运行中更新目标值"""
        if not self.cl_running or not self.tmc.connected:
            return
        mode = self.cl_mode_combo.currentData()
        target_val = self.cl_target_spin.value()

        if mode == "id":
            raw = max(-8192, min(8192, int(target_val / 0.2013)))
            self.tmc.write_register(0x14E, raw & 0xFFFF)
        elif mode == "iq":
            raw = max(-8192, min(8192, int(target_val / 0.2013)))
            self.tmc.write_register(0x14E, (raw << 16) & 0xFFFFFFFF)
        elif mode == "velocity":
            raw = int(target_val * self.CL_K_VEL)
            self.tmc.write_register(0x150, raw & 0xFFFFFFFF)
        elif mode == "position":
            raw = int(target_val * self.CL_USER_TO_POS)
            self.tmc.write_register(0x152, raw & 0xFFFFFFFF)

        self.cl_status_label.setText(f"目标已更新: {target_val}")

    def _cl_toggle(self):
        if self.cl_running:
            self._cl_stop()
        else:
            self._cl_start()

    def _cl_write_pid_params(self):
        """写入全部 PID 参数和限幅（不启动闭环）"""
        if not self.tmc.connected:
            QMessageBox.warning(self, "错误", "请先连接串口")
            return

        cur_pi = (self.cl_cur_p_spin.value() << 16) | (self.cl_cur_i_spin.value() & 0xFFFF)
        vel_pi = (self.cl_vel_p_spin.value() << 16) | (self.cl_vel_i_spin.value() & 0xFFFF)
        pos_pi = (self.cl_pos_kp_spin.value() << 16) | 0  # Ki=0

        torque_limit_raw = int(self.cl_cur_limit_spin.value() / self.CL_MA_PER_COUNT)
        vel_limit_raw = int(self.cl_vel_limit_spin.value() * self.CL_K_VEL)
        tf_limits = (torque_limit_raw << 16) | torque_limit_raw

        writes = [
            (0x142, cur_pi, "电流环 FLUX_COEFF"),
            (0x143, cur_pi, "电流环 TORQUE_COEFF"),
            (0x145, vel_pi, "速度环 VELOCITY_COEFF"),
            (0x146, pos_pi, "位置环 POSITION_COEFF"),
            (0x14A, tf_limits, f"力矩/磁通限幅 ({self.cl_cur_limit_spin.value():.0f}mA)"),
            (0x14B, vel_limit_raw, f"速度限幅 ({self.cl_vel_limit_spin.value():.0f}rpm)"),
        ]

        ok_count = 0
        for addr, val, desc in writes:
            if self.tmc.write_register(addr, val):
                ok_count += 1
                print(f"[CL-PID] 写入 0x{addr:03X} = 0x{val:08X} ({desc})")
            else:
                print(f"[CL-PID] 写入失败 0x{addr:03X} ({desc})")

        self.cl_status_label.setText(
            f"PID 写入 {ok_count}/{len(writes)} 成功 | "
            f"电流PI=({self.cl_cur_p_spin.value()},{self.cl_cur_i_spin.value()}) "
            f"速度PI=({self.cl_vel_p_spin.value()},{self.cl_vel_i_spin.value()}) "
            f"位置Kp={self.cl_pos_kp_spin.value()}"
        )

    def _cl_start(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "错误", "请先连接串口")
            return

        mode = self.cl_mode_combo.currentData()
        target_val = self.cl_target_spin.value()

        # 配置编码器
        from tmc6460_encoder import setup_encoder
        poles = self.autotune_poles_spin.value()
        self.cl_status_label.setText(f"配置编码器 (poles={poles})...")
        QApplication.processEvents()
        # 使用标定得到的 offset，若未标定则用默认值
        calib_offset = getattr(self, '_calib_offset', None)
        ok, msg = setup_encoder(self.tmc, "MT6701 (SSI, 14-bit)", pole_pairs=poles, phi_e_offset=calib_offset)
        if not ok:
            QMessageBox.critical(self, "错误", f"编码器配置失败: {msg}")
            return

        # 写入 PID 参数
        cur_pi = (self.cl_cur_p_spin.value() << 16) | (self.cl_cur_i_spin.value() & 0xFFFF)
        vel_pi = (self.cl_vel_p_spin.value() << 16) | (self.cl_vel_i_spin.value() & 0xFFFF)
        pos_pi = (self.cl_pos_kp_spin.value() << 16) | 0  # Ki=0

        # 基础配置
        self.tmc.write_register(0x103, 0xFFFF12C0)  # PWM
        self.tmc.write_register(0x0C3, 3)            # CSA_GAIN
        torque_limit_raw = int(self.cl_cur_limit_spin.value() / self.CL_MA_PER_COUNT)
        vel_limit_raw = int(self.cl_vel_limit_spin.value() * self.CL_K_VEL)
        self.tmc.write_register(0x14A, (torque_limit_raw << 16) | torque_limit_raw)  # TF_LIMITS
        self.tmc.write_register(0x14B, vel_limit_raw)                                 # VEL_LIMIT
        # offset 由 setup_encoder 写入（优先用标定值）
        gdrv = self.tmc.read_register(0x101)
        if gdrv:
            gdrv |= (1 << 31) | (1 << 16)
            self.tmc.write_register(0x101, gdrv)

        # 根据模式配置 MOTION、PI 和写入目标
        self._cl_is_32bit = False
        self.cl_poll_mode = False
        if mode == "id":
            motion = (0 << 15) | (0 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (poles & 0x7F)
            self.tmc.write_register(0x142, cur_pi)
            self.tmc.write_register(0x143, cur_pi)
            raw = max(-8192, min(8192, int(target_val / 0.2013)))
            target_reg = raw & 0xFFFF
            self._cl_target_reg = 0x14E
            self._cl_actual_reg = 0x153
            self._cl_target_factor = 0.2013
            self._cl_actual_factor = 0.2013
            self._cl_target_shift = 0
            self._cl_actual_shift = 0
        elif mode == "iq":
            motion = (0 << 15) | (0 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (poles & 0x7F)
            self.tmc.write_register(0x142, cur_pi)
            self.tmc.write_register(0x143, cur_pi)
            raw = max(-8192, min(8192, int(target_val / 0.2013)))
            target_reg = (raw << 16) & 0xFFFFFFFF
            self._cl_target_reg = 0x14E
            self._cl_actual_reg = 0x153
            self._cl_target_factor = 0.2013
            self._cl_actual_factor = 0.2013
            self._cl_target_shift = 16
            self._cl_actual_shift = 16
        elif mode == "velocity":
            motion = (0 << 15) | (0 << 14) | (0 << 13) | (3 << 9) | (3 << 7) | (poles & 0x7F)
            self.tmc.write_register(0x142, cur_pi)
            self.tmc.write_register(0x143, cur_pi)
            self.tmc.write_register(0x145, vel_pi)
            target_reg = int(target_val * self.CL_K_VEL)
            self._cl_target_reg = 0x150
            self._cl_actual_reg = 0x154
            self._cl_target_factor = self.CL_K_VEL
            self._cl_actual_factor = self.CL_K_VEL
            self._cl_target_shift = 0
            self._cl_actual_shift = 0
            self._cl_is_32bit = True
        elif mode == "position":
            motion = (0 << 15) | (0 << 14) | (0 << 13) | (4 << 9) | (3 << 7) | (poles & 0x7F)
            # 写入三环 PID
            self.tmc.write_register(0x142, cur_pi)   # 电流环
            self.tmc.write_register(0x143, cur_pi)
            self.tmc.write_register(0x145, vel_pi)   # 速度环
            self.tmc.write_register(0x146, pos_pi)   # 位置环
            # 目标：用户单位(0.01°) → 内部单位(65536/圈)
            # raw = user_input × 65536 / 360000
            target_reg = int(target_val * self.CL_USER_TO_POS)
            self._cl_target_reg = 0x152
            self._cl_actual_reg = 0x155
            self._cl_is_32bit = True
            self.cl_poll_mode = True  # 位置模式用 QTimer 轮询
            # 轮询数据清空
            for ch in self.cl_poll_data:
                self.cl_poll_data[ch].clear()
        else:
            return

        # 写 MOTION
        self.tmc.write_register(0x100, motion)
        time.sleep(0.01)
        # 写目标
        raw_hex = f"0x{target_reg & 0xFFFFFFFF:08X}"
        raw_dec = target_reg & 0xFFFFFFFF
        self.tmc.write_register(self._cl_target_reg, target_reg & 0xFFFFFFFF)
        print(f"[CL] 写入 0x{self._cl_target_reg:03X} = 0x{target_reg & 0xFFFFFFFF:08X} ({target_reg & 0xFFFFFFFF})")

        # 清数据
        with self.cl_rtmi_lock:
            for ch in self.cl_rtmi_data:
                self.cl_rtmi_data[ch].clear()
        self.cl_start_time = time.time()

        if not self.cl_poll_mode:
            # 电流/速度模式：用 RTMI
            self.tmc.stop_rtmi()
            time.sleep(0.3)
            if self.tmc.ser and self.tmc.ser.is_open:
                self.tmc.ser.reset_input_buffer()
                time.sleep(0.05)
                self.tmc.ser.reset_input_buffer()
            rtmi_channels = {
                0: self._cl_target_reg,
                1: self._cl_actual_reg,
            }
            self.tmc.start_rtmi(rtmi_channels, sampling=49, callback=self._cl_rtmi_callback)

        # 启动波形刷新
        self.cl_running = True
        self.cl_start_btn.setText("⏹ 停止")
        self.cl_start_btn.setStyleSheet("font-size: 14px; padding: 8px 24px; background-color: #f44336;")
        poll_info = " | 轮询100Hz" if self.cl_poll_mode else " | RTMI"
        # 更新波形 Y 轴标签
        y_labels = {"id": "电流 (mA)", "iq": "电流 (mA)", "velocity": "速度 (RPM)", "position": "位置 (0.01°)"}
        self.cl_plot_widget.setLabel('left', y_labels.get(mode, '值'))
        self.cl_status_label.setText(
            f"运行中: {self.cl_mode_combo.currentText()} 目标={target_val}{poll_info}"
        )
        self.cl_timer.start()

    def _cl_stop(self):
        self.cl_timer.stop()
        self.cl_running = False
        # 停 RTMI（如果运行），清积分器，目标归零，切 PWM_OFF
        if self.tmc.connected:
            if not self.cl_poll_mode:
                self.tmc.stop_rtmi()
                time.sleep(0.1)
            self.tmc.write_register(0x15D, 0)  # 清 iQ 积分器
            self.tmc.write_register(0x15E, 0)  # 清 iD 积分器
            self.tmc.write_register(self._cl_target_reg, 0)  # 目标归零
            self.tmc.write_register(0x100, (3 << 7) | 1)  # PWM_OFF
        self.cl_poll_mode = False
        self.cl_start_btn.setText("▶ 启动")
        self.cl_start_btn.setStyleSheet("font-size: 14px; padding: 8px 24px; background-color: #4caf50;")
        self.cl_status_label.setText("已停止")

    def _cl_rtmi_callback(self, ch_id, raw):
        """RTMI 回调（RTMI 线程调用）"""
        if ch_id not in (0, 1):
            return
        # 速度/位置模式: 过滤明显异常的 RTMI 数据（帧同步丢失产生的垃圾）
        if self._cl_is_32bit:
            # 32位有符号，合理范围 ±10M 内部单位（约 ±32700 RPM）
            signed = raw if raw <= 0x7FFFFFFF else raw - 0x100000000
            if abs(signed) > 10_000_000:
                return  # 丢弃
        t = time.time()
        with self.cl_rtmi_lock:
            self.cl_rtmi_data[ch_id].append((t, raw))

    def _cl_update_waveform(self):
        """定时刷新波形（主线程）- 支持 RTMI 和 QTimer 轮询两种模式"""
        if not self.cl_running:
            return

        if self.cl_poll_mode:
            # QTimer 轮询模式（位置环）：读寄存器并更新波形
            self._cl_poll_position()
            # 更新波形曲线
            t0 = self.cl_start_time
            for ch, curve in [(0, self.cl_target_curve), (1, self.cl_actual_curve)]:
                pts = self.cl_poll_data[ch][-self.CL_BUF:]
                if pts:
                    curve.setData([p[0] for p in pts], [p[1] for p in pts])
        else:
            # RTMI 模式（电流/速度）
            with self.cl_rtmi_lock:
                tgt = list(self.cl_rtmi_data.get(0, []))
                act = list(self.cl_rtmi_data.get(1, []))

            if not tgt and not act:
                return

            t0 = self.cl_start_time
            shift = self._cl_target_shift
            factor = self._cl_target_factor

            def unpack(raw_list):
                out = []
                for i, (t, raw) in enumerate(raw_list):
                    if self._cl_is_32bit:
                        val = raw
                        if val > 0x7FFFFFFF:
                            val -= 0x100000000
                        out.append(((t - t0) * 1000, val / factor))
                    else:
                        if shift == 16:
                            val = (raw >> 16) & 0xFFFF
                        else:
                            val = raw & 0xFFFF
                        if val > 32767: val -= 65536
                        out.append(((t - t0) * 1000, val * factor))
                return out

            tgt_pts = unpack(tgt)[-self.CL_BUF:]
            act_pts = unpack(act)[-self.CL_BUF:]

            if tgt_pts:
                self.cl_target_curve.setData([p[0] for p in tgt_pts], [p[1] for p in tgt_pts])
            if act_pts:
                self.cl_actual_curve.setData([p[0] for p in act_pts], [p[1] for p in act_pts])

    def _cl_poll_position(self):
        """QTimer 轮询位置目标和实际值（100Hz）
        显示单位：0.01° (36000 = 1圈)
        """
        if not self.tmc.connected:
            return
        t_ms = (time.time() - self.cl_start_time) * 1000
        target_raw = self.tmc.read_register(0x152)   # POSITION_TARGET
        actual_raw = self.tmc.read_register(0x155)   # POSITION_ACTUAL
        if target_raw is not None:
            # 32-bit signed → 用户单位 (0.01°)
            if target_raw > 0x7FFFFFFF:
                target_raw -= 0x100000000
            target_user = target_raw * self.CL_POS_TO_USER  # × (360000/65536)
            self.cl_poll_data[0].append((t_ms, target_user))
        if actual_raw is not None:
            if actual_raw > 0x7FFFFFFF:
                actual_raw -= 0x100000000
            actual_user = actual_raw * self.CL_POS_TO_USER
            self.cl_poll_data[1].append((t_ms, actual_user))

    # ---------- PRBS 辨识 Tab ----------
    def _build_prbs_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 说明
        info = QLabel(
            "PRBS (伪随机二进制序列) 系统辨识\n"
            "向控制器注入 PRBS 信号，通过波形观察系统响应，辅助 PID 调参。\n"
            "流程: 选模式 → 设幅度和频率 → 启动 → 观察波形 → 停止 → 分析响应"
        )
        info.setStyleSheet("color: #90a4ae; padding: 8px;")
        layout.addWidget(info)

        # 模式选择
        mode_group = QGroupBox("辨识模式")
        mode_layout = QGridLayout()

        mode_layout.addWidget(QLabel("MOTION_MODE:"), 0, 0)
        self.prbs_mode_combo = QComboBox()
        prbs_modes = [
            ("PRBS_UD (磁通 plant)", 0x85),
            ("PRBS_FLUX (磁通带宽)", 0x86),
            ("PRBS_TORQUE (力矩带宽)", 0x87),
            ("PRBS_VELOCITY (速度带宽)", 0x88),
            ("PRBS_POSITION (位置带宽)", 0x89),
        ]
        for name, val in prbs_modes:
            self.prbs_mode_combo.addItem(name, val)
        mode_layout.addWidget(self.prbs_mode_combo, 0, 1, 1, 2)

        mode_layout.addWidget(QLabel("PRBS 幅度:"), 1, 0)
        self.prbs_amplitude_spin = QSpinBox()
        self.prbs_amplitude_spin.setRange(0, 2147483647)
        self.prbs_amplitude_spin.setValue(1000)
        self.prbs_amplitude_spin.setToolTip("PRBS 信号幅度 (越大响应越明显，但别太大以免过流)")
        mode_layout.addWidget(self.prbs_amplitude_spin, 1, 1)

        mode_layout.addWidget(QLabel("降采样率:"), 2, 0)
        self.prbs_downsample_spin = QSpinBox()
        self.prbs_downsample_spin.setRange(0, 255)
        self.prbs_downsample_spin.setValue(9)
        self.prbs_downsample_spin.setToolTip(
            "PRBS 频率 = fPWM / (降采样率 + 1)\n"
            "fPWM=50kHz 时，降采样率=9 → PRBS 频率=5kHz"
        )
        mode_layout.addWidget(self.prbs_downsample_spin, 2, 1)

        # 计算显示
        self.prbs_freq_label = QLabel("PRBS 频率: ~5000 Hz (假设 fPWM=50kHz)")
        self.prbs_freq_label.setStyleSheet("color: #4fc3f7;")
        self.prbs_downsample_spin.valueChanged.connect(self._update_prbs_freq)
        mode_layout.addWidget(self.prbs_freq_label, 3, 0, 1, 3)

        mode_group.setLayout(mode_layout)
        layout.addWidget(mode_group)

        # 操作
        btn_layout = QHBoxLayout()
        self.prbs_start_btn = QPushButton("▶ 启动 PRBS 辨识")
        self.prbs_start_btn.clicked.connect(self._start_prbs)
        btn_layout.addWidget(self.prbs_start_btn)
        self.prbs_stop_btn = QPushButton("⏹ 停止")
        self.prbs_stop_btn.clicked.connect(self._stop_prbs)
        btn_layout.addWidget(self.prbs_stop_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 提示
        tips = QLabel(
            "使用提示:\n"
            "1. 先在「实时波形」Tab 启动监控，观察目标寄存器的响应\n"
            "2. 幅度从小开始 (如 500)，逐步增大\n"
            "3. PRBS 频率应覆盖你关心的带宽范围\n"
            "4. 力矩模式 PRBS_TORQUE 最常用，用来测电流环带宽\n"
            "5. 辨识完成后务必停止 PRBS，否则电机持续抖动"
        )
        tips.setStyleSheet("color: #ff9800; padding: 8px;")
        layout.addWidget(tips)

        layout.addStretch()
        return widget

    # ---------- SSI Tab ----------
    def _build_ssi_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 接线图
        wiring_group = QGroupBox("SSI 编码器接线 (MT6701)")
        wiring_layout = QVBoxLayout()
        wiring_text = QLabel(
            "TMC6460 引脚    →  MT6701 引脚     功能\n"
            "─────────────────────────────────────────\n"
            "ENC_A (Pin 14)  →  CLK/B (Pin 7)  时钟  (IO: DIRECT_OUT0)\n"
            "ENC_B (Pin 15)  →  DO/A  (Pin 6)  数据  (IO: DIRECT_IN0)\n"
            "ENC_N (Pin 16)  →  CSN/Z (Pin 5)  片选  (IO: DIRECT_IN_OUT1, u[7]=1)\n"
            "GND             →  GND   (Pin 4)\n"
            "VCC_IO (4.5V)   →  VDD   (Pin 1)\n"
        )
        wiring_text.setFont(QFont("Consolas", 10))
        wiring_text.setStyleSheet("color: #4fc3f7;")
        wiring_layout.addWidget(wiring_text)
        wiring_group.setLayout(wiring_layout)
        layout.addWidget(wiring_group)

        # 预设
        preset_group = QGroupBox("编码器配置")
        preset_layout = QGridLayout()
        preset_layout.addWidget(QLabel("编码器型号:"), 0, 0)
        self.ssi_preset_combo = QComboBox()
        for name in ENCODER_PRESETS:
            self.ssi_preset_combo.addItem(name)
        self.ssi_preset_combo.currentTextChanged.connect(self._on_ssi_preset_changed)
        preset_layout.addWidget(self.ssi_preset_combo, 0, 1, 1, 2)
        self.ssi_desc_label = QLabel("")
        self.ssi_desc_label.setStyleSheet("color: #90a4ae;")
        preset_layout.addWidget(self.ssi_desc_label, 1, 0, 1, 3)
        preset_layout.addWidget(QLabel("极对数:"), 2, 0)
        self.ssi_pp_spin = QSpinBox()
        self.ssi_pp_spin.setRange(1, 127)
        self.ssi_pp_spin.setValue(2)
        preset_layout.addWidget(self.ssi_pp_spin, 2, 1)
        preset_group.setLayout(preset_layout)
        layout.addWidget(preset_group)

        # 按钮
        btn_layout = QHBoxLayout()
        self.ssi_init_btn = QPushButton("\u2699 \u4e00\u952e\u914d\u7f6e\u7f16\u7801\u5668")
        self.ssi_init_btn.setStyleSheet("font-size: 14px; padding: 8px;")
        self.ssi_init_btn.clicked.connect(self._init_ssi_encoder)
        btn_layout.addWidget(self.ssi_init_btn)
        self.ssi_stop_btn = QPushButton("\u23f9 \u505c\u6b62")
        self.ssi_stop_btn.clicked.connect(self._stop_ssi_encoder)
        btn_layout.addWidget(self.ssi_stop_btn)
        self.ssi_status_label = QLabel("")
        self.ssi_status_label.setStyleSheet("color: #90a4ae;")
        btn_layout.addWidget(self.ssi_status_label)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        # 寄存器读取
        read_group = QGroupBox("SSI \u5bc4\u5b58\u5668")
        read_layout = QGridLayout()
        ssi_regs = [
            ("IO_MATRIX (0x006)", 0x006, "\u5f15\u811a\u590d\u7528"),
            ("IO_CMD (0x381)", IO_CONTROLLER_COMMAND, "IO \u547d\u4ee4"),
            ("IO_RESP0 (0x382)", IO_CONTROLLER_RESPONSE0, "\u547d\u4ee4\u54cd\u5e94"),
            ("IO_RESP3 (0x385)", IO_CONTROLLER_RESPONSE3, "\u6570\u636e\u54cd\u5e94"),
            ("PHI_EXT_A (0x24D)", ENCODER_ANGLE_ADDR, "\u5916\u90e8\u89d2\u5ea6 A"),
        ]
        for row, (name, addr, desc) in enumerate(ssi_regs):
            read_layout.addWidget(QLabel(name), row, 0)
            val_label = QLabel("--")
            val_label.setFont(QFont("Consolas", 10))
            read_layout.addWidget(val_label, row, 1)
            btn = QPushButton("R")
            btn.setMaximumWidth(30)
            btn.clicked.connect(lambda _, a=addr, v=val_label: self._read_to_label(a, v))
            read_layout.addWidget(btn, row, 2)
            read_layout.addWidget(QLabel(desc), row, 3)
        read_group.setLayout(read_layout)
        layout.addWidget(read_group)

        # 编码器实时波形
        wave_group = QGroupBox("\u5b9e\u65f6\u89d2\u5ea6\u6ce2\u5f62")
        wave_layout = QVBoxLayout(wave_group)
        self.enc_plot = pg.PlotWidget(title="\u7f16\u7801\u5668\u89d2\u5ea6")
        self.enc_plot.setLabel('left', '\u89d2\u5ea6', units='deg')
        self.enc_plot.setLabel('bottom', '\u65f6\u95f4', units='s')
        self.enc_plot.showGrid(x=True, y=True, alpha=0.3)
        self.enc_plot.setYRange(0, 360)
        self.enc_curve = self.enc_plot.plot([], [], pen=pg.mkPen('#00bcd4', width=2), name='\u89d2\u5ea6')
        self.enc_buf = collections.deque(maxlen=1000)
        self.enc_time_buf = collections.deque(maxlen=1000)
        self.enc_start_time = 0
        self.enc_angle_label = QLabel("\u89d2\u5ea6: -- deg")
        self.enc_angle_label.setFont(QFont("Consolas", 14))
        self.enc_angle_label.setStyleSheet("color: #00bcd4; font-weight: bold;")
        wave_layout.addWidget(self.enc_angle_label)
        wave_layout.addWidget(self.enc_plot)
        # 发送到实时波形按钮
        enc_to_rtmi_btn = QPushButton("📊 发送到实时波形 (RTMI)")
        enc_to_rtmi_btn.setStyleSheet("font-size: 13px; padding: 6px; background-color: #1a237e;")
        enc_to_rtmi_btn.setToolTip("将编码器角度 (PHI_EXT_A) 加入 RTMI 通道，切换到实时波形页")
        enc_to_rtmi_btn.clicked.connect(self._send_encoder_to_waveform)
        wave_layout.addWidget(enc_to_rtmi_btn)
        layout.addWidget(wave_group)

        # 编码器轮询定时器
        self._enc_poll_timer = QTimer()
        self._enc_poll_timer.timeout.connect(self._poll_encoder)
        self._on_ssi_preset_changed(self.ssi_preset_combo.currentText())
        return widget

    # ---------- 开环测试 Tab ----------
    def _build_openloop_tab(self) -> QWidget:
        """External Voltage Open Loop Mode
        只负责配置，不轮询 — 用 RTMI 波形 Tab 观察编码器数据
        写死: UD=1000, poles=1, VOLTAGE_EXT mode
        """
        widget = QWidget()
        layout = QVBoxLayout(widget)

        info = QLabel(
            "UD=1000, 极对数=1 (写死), VOLTAGE_EXT 模式\n"
            "设置速度后点启动, 切到「实时波形」Tab 通过 RTMI 观察编码器"
        )
        info.setStyleSheet("color: #90a4ae; padding: 8px;")
        layout.addWidget(info)

        ctrl_group = QGroupBox("开环控制")
        ctrl_layout = QHBoxLayout()

        ctrl_layout.addWidget(QLabel("速度目标:"))
        self.openloop_speed = QSpinBox()
        self.openloop_speed.setRange(-200000, 200000)
        self.openloop_speed.setValue(50000)
        self.openloop_speed.setSingleStep(1000)
        self.openloop_speed.setFont(QFont("Consolas", 12))
        ctrl_layout.addWidget(self.openloop_speed)

        ctrl_layout.addSpacing(20)

        self.openloop_start_btn = QPushButton("启动开环")
        self.openloop_start_btn.setStyleSheet("font-size: 16px; padding: 10px 24px; background-color: #1b5e20;")
        self.openloop_start_btn.clicked.connect(self._openloop_start)
        ctrl_layout.addWidget(self.openloop_start_btn)

        self.openloop_stop_btn = QPushButton("停止")
        self.openloop_stop_btn.setStyleSheet("font-size: 16px; padding: 10px 24px; background-color: #b71c1c;")
        self.openloop_stop_btn.clicked.connect(self._openloop_stop)
        self.openloop_stop_btn.setEnabled(False)
        ctrl_layout.addWidget(self.openloop_stop_btn)

        ctrl_layout.addStretch()
        ctrl_group.setLayout(ctrl_layout)
        layout.addWidget(ctrl_group)

        self.openloop_status = QLabel("就绪")
        self.openloop_status.setFont(QFont("Consolas", 11))
        self.openloop_status.setStyleSheet("color: #90a4ae;")
        layout.addWidget(self.openloop_status)

        layout.addStretch()
        return widget

    def _openloop_start(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return

        speed = self.openloop_speed.value()
        UD = 1000
        poles = 1

        # 1. 使能 DRV + Charge Pump
        gdrv = self.tmc.read_register(0x101)
        if gdrv is None:
            self.openloop_status.setText("失败: 读 GDRV")
            return
        gdrv |= (1 << 31) | (1 << 16)
        if not self.tmc.write_register(0x101, gdrv):
            self.openloop_status.setText("失败: 写 GDRV")
            return

        # 2. VOLTAGE_EXT + RAMP_USE_PHI_E + RAMP_EN + RAMP_MODE_VEL + BLDC
        mm = (1 << 15) | (1 << 14) | (1 << 13) | (11 << 9) | (3 << 7) | poles
        if not self.tmc.write_register(0x100, mm):
            self.openloop_status.setText("失败: 写 MOTOR_MOTION")
            return

        # 3. Ramp
        self.tmc.write_register(0x1CE, speed * 2)  # V_MAX
        self.tmc.write_register(0x1CA, 1000)        # V_START
        self.tmc.write_register(0x1CC, 20000)       # A_MAX
        self.tmc.write_register(0x1C4, 0x00020000)  # A1

        # 4. 速度目标
        self.tmc.write_register(0x150, speed)

        # 5. UD
        self.tmc.write_register(0x200, UD)

        self.openloop_start_btn.setEnabled(False)
        self.openloop_stop_btn.setEnabled(True)
        self.openloop_status.setText(f"运行中 | UD={UD} speed={speed}")
        self.openloop_status.setStyleSheet("color: #4caf50; font-weight: bold;")

    def _openloop_stop(self):
        self.tmc.write_register(0x200, 0)   # UD=0
        time.sleep(0.05)
        self.tmc.write_register(0x100, 0)   # MOTOR_MOTION=0
        time.sleep(0.05)
        gdrv = self.tmc.read_register(0x101)
        if gdrv is not None:
            gdrv &= ~((1 << 31) | (1 << 16))
            self.tmc.write_register(0x101, gdrv)

        self.openloop_start_btn.setEnabled(True)
        self.openloop_stop_btn.setEnabled(False)
        self.openloop_status.setText("已停止")
        self.openloop_status.setStyleSheet("color: #90a4ae;")
    # ---------- 电角度标定 Tab ----------
    def _build_calib_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # 控制区
        ctrl_group = QGroupBox("标定控制")
        ctrl_layout = QGridLayout()
        ctrl_layout.addWidget(QLabel("I_D 电流 (mA):"), 0, 0)
        self.calib_current_spin = QDoubleSpinBox()
        self.calib_current_spin.setRange(0, 1650)
        self.calib_current_spin.setValue(500)
        self.calib_current_spin.setDecimals(1)
        self.calib_current_spin.setFont(QFont("Consolas", 11))
        ctrl_layout.addWidget(self.calib_current_spin, 0, 1)
        self.calib_start_btn = QPushButton("▶ 开始标定")
        self.calib_start_btn.setStyleSheet("font-size: 14px; padding: 8px;")
        self.calib_start_btn.clicked.connect(self._start_calibration)
        ctrl_layout.addWidget(self.calib_start_btn, 0, 2)
        self.calib_status_label = QLabel("就绪")
        self.calib_status_label.setFont(QFont("Consolas", 11))
        self.calib_status_label.setStyleSheet("color: #90a4ae;")
        ctrl_layout.addWidget(self.calib_status_label, 1, 0, 1, 3)
        ctrl_group.setLayout(ctrl_layout)
        layout.addWidget(ctrl_group)

        # 结果区
        result_group = QGroupBox("标定结果")
        result_layout = QVBoxLayout()

        # 数据表格
        self.calib_table = QTableWidget(0, 5)
        self.calib_table.setHorizontalHeaderLabels(["deg", "enc_raw", "unwrap", "预测值", "残差"])
        self.calib_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.calib_table.setMaximumHeight(200)
        result_layout.addWidget(self.calib_table)

        # 拟合结果
        fit_layout = QGridLayout()
        self.calib_r2_label = QLabel("R²: --")
        self.calib_r2_label.setFont(QFont("Consolas", 11))
        fit_layout.addWidget(self.calib_r2_label, 0, 0)
        self.calib_k_label = QLabel("k: --")
        self.calib_k_label.setFont(QFont("Consolas", 11))
        fit_layout.addWidget(self.calib_k_label, 0, 1)
        self.calib_b_label = QLabel("b: --")
        self.calib_b_label.setFont(QFont("Consolas", 11))
        fit_layout.addWidget(self.calib_b_label, 0, 2)
        self.calib_b14_label = QLabel("b14: --")
        self.calib_b14_label.setFont(QFont("Consolas", 11))
        fit_layout.addWidget(self.calib_b14_label, 1, 0)
        self.calib_mulfactor_label = QLabel("MUL_FACTOR: --")
        self.calib_mulfactor_label.setFont(QFont("Consolas", 11))
        fit_layout.addWidget(self.calib_mulfactor_label, 1, 1)
        self.calib_offset_label = QLabel("PHI_E_OFFSET: --")
        self.calib_offset_label.setFont(QFont("Consolas", 14))
        self.calib_offset_label.setStyleSheet("color: #ff9800; font-weight: bold;")
        fit_layout.addWidget(self.calib_offset_label, 2, 0, 1, 3)
        result_layout.addLayout(fit_layout)

        # 写入按钮
        self.calib_write_btn = QPushButton("✏ 写入芯片 (0x242)")
        self.calib_write_btn.setStyleSheet("font-size: 13px; padding: 6px; background-color: #1b5e20;")
        self.calib_write_btn.setEnabled(False)
        self.calib_write_btn.clicked.connect(self._write_calib_offset)
        result_layout.addWidget(self.calib_write_btn)

        result_group.setLayout(result_layout)
        layout.addWidget(result_group)

        # 温度读取
        temp_group = QGroupBox("温度监测")
        temp_layout = QGridLayout()
        temp_layout.addWidget(QLabel("芯片温度:"), 0, 0)
        self.temp_int_label = QLabel("-- °C")
        self.temp_int_label.setFont(QFont("Consolas", 12))
        self.temp_int_label.setStyleSheet("color: #4caf50;")
        temp_layout.addWidget(self.temp_int_label, 0, 1)
        temp_layout.addWidget(QLabel("NTC 温度:"), 1, 0)
        self.temp_ext_label = QLabel("-- °C")
        self.temp_ext_label.setFont(QFont("Consolas", 12))
        self.temp_ext_label.setStyleSheet("color: #2196f3;")
        temp_layout.addWidget(self.temp_ext_label, 1, 1)
        self.temp_read_btn = QPushButton("读取温度")
        self.temp_read_btn.clicked.connect(self._read_temperature)
        temp_layout.addWidget(self.temp_read_btn, 0, 2, 2, 1)
        temp_group.setLayout(temp_layout)
        layout.addWidget(temp_group)

        layout.addStretch()
        return widget

    # ---------- EEPROM Tab ----------
    def _build_eeprom_tab(self):
        """EEPROM 配置 Tab - 先编辑参数，再保存到 EEPROM"""
        widget = QWidget()
        outer = QVBoxLayout(widget)

        # 提示
        tip = QLabel("配置 TMC6460 参数 → 保存到 M24C02 EEPROM。\n"
                      "电角度偏置(0x242)每电机不同，请先完成标定再填入。")
        tip.setStyleSheet("color: #aaa; margin-bottom: 6px;")
        outer.addWidget(tip)

        # 滚动区域
        scroll = QWidget()
        grid = QGridLayout(scroll)
        row = 0

        # === 电机基本参数 ===
        grp_motor = QGroupBox("电机基本参数")
        ml = QGridLayout()
        ml.addWidget(QLabel("运动模式:"), 0, 0)
        self.ee_mode_combo = QComboBox()
        self.ee_mode_combo.addItems(["速度模式 (VELOCITY)", "力矩模式 (TORQUE)", "位置模式 (POSITION)"])
        self.ee_mode_combo.setCurrentIndex(0)  # 默认速度模式
        ml.addWidget(self.ee_mode_combo, 0, 1)
        ml.addWidget(QLabel("极对数:"), 0, 2)
        self.ee_poles_spin = QSpinBox()
        self.ee_poles_spin.setRange(1, 50)
        self.ee_poles_spin.setValue(1)
        ml.addWidget(self.ee_poles_spin, 0, 3)
        grp_motor.setLayout(ml)
        grid.addWidget(grp_motor, row, 0, 1, 4)
        row += 1

        # === 电流/力矩限制 ===
        grp_limit = QGroupBox("力矩 / 限制")
        ll = QGridLayout()
        ll.addWidget(QLabel("力矩限制 (mA):"), 0, 0)
        self.ee_torque_limit = QSpinBox()
        self.ee_torque_limit.setRange(0, 10000)
        self.ee_torque_limit.setValue(600)
        self.ee_torque_limit.setToolTip("PID_TORQUE_FLUX_LIMITS - torque 分量")
        ll.addWidget(self.ee_torque_limit, 0, 1)
        ll.addWidget(QLabel("磁通限制 (mA):"), 0, 2)
        self.ee_flux_limit = QSpinBox()
        self.ee_flux_limit.setRange(0, 10000)
        self.ee_flux_limit.setValue(0)
        self.ee_flux_limit.setToolTip("PID_TORQUE_FLUX_LIMITS - flux 分量，一般为 0")
        ll.addWidget(self.ee_flux_limit, 0, 3)
        ll.addWidget(QLabel("速度限制 (RPM):"), 1, 0)
        self.ee_vel_limit = QSpinBox()
        self.ee_vel_limit.setRange(0, 100000)
        self.ee_vel_limit.setValue(25000)
        self.ee_vel_limit.setToolTip("PID_VELOCITY_LIMIT，0=不限")
        ll.addWidget(self.ee_vel_limit, 1, 1)
        grp_limit.setLayout(ll)
        grid.addWidget(grp_limit, row, 0, 1, 4)
        row += 1

        # === PID 参数 ===
        grp_pid = QGroupBox("PID 参数")
        pl = QGridLayout()
        headers = ["", "Kp", "Ki"]
        for c, h in enumerate(headers):
            pl.addWidget(QLabel(h), 0, c * 2, Qt.AlignCenter)
        # 电流环
        pl.addWidget(QLabel("电流环 (0x142/0x143):"), 1, 0)
        self.ee_cur_kp = QSpinBox()
        self.ee_cur_kp.setRange(0, 0xFFFF)
        self.ee_cur_kp.setValue(64)
        pl.addWidget(self.ee_cur_kp, 1, 1)
        self.ee_cur_ki = QSpinBox()
        self.ee_cur_ki.setRange(0, 0xFFFF)
        self.ee_cur_ki.setValue(48)
        pl.addWidget(self.ee_cur_ki, 1, 2)
        # 速度环
        pl.addWidget(QLabel("速度环 (0x145):"), 2, 0)
        self.ee_vel_kp = QSpinBox()
        self.ee_vel_kp.setRange(0, 0xFFFF)
        self.ee_vel_kp.setValue(500)
        pl.addWidget(self.ee_vel_kp, 2, 1)
        self.ee_vel_ki = QSpinBox()
        self.ee_vel_ki.setRange(0, 0xFFFF)
        self.ee_vel_ki.setValue(250)
        pl.addWidget(self.ee_vel_ki, 2, 2)
        # 位置环
        pl.addWidget(QLabel("位置环 (0x146):"), 3, 0)
        self.ee_pos_kp = QSpinBox()
        self.ee_pos_kp.setRange(0, 0xFFFF)
        self.ee_pos_kp.setValue(500)
        pl.addWidget(self.ee_pos_kp, 3, 1)
        self.ee_pos_ki = QSpinBox()
        self.ee_pos_ki.setRange(0, 0xFFFF)
        self.ee_pos_ki.setValue(0)
        pl.addWidget(self.ee_pos_ki, 3, 2)
        grp_pid.setLayout(pl)
        grid.addWidget(grp_pid, row, 0, 1, 4)
        row += 1

        # === 编码器参数 ===
        grp_enc = QGroupBox("编码器 (SSI / MT6701)")
        el = QGridLayout()
        el.addWidget(QLabel("SPI 总线模式:"), 0, 0)
        self.ee_spi_mode = QSpinBox()
        self.ee_spi_mode.setRange(0, 3)
        self.ee_spi_mode.setValue(1)
        el.addWidget(self.ee_spi_mode, 0, 1)
        el.addWidget(QLabel("SPI 频率 (Hz):"), 0, 2)
        self.ee_spi_freq = QSpinBox()
        self.ee_spi_freq.setRange(100000, 10000000)
        self.ee_spi_freq.setValue(2000000)
        self.ee_spi_freq.setSingleStep(100000)
        el.addWidget(self.ee_spi_freq, 0, 3)
        el.addWidget(QLabel("SSI 位数:"), 1, 0)
        self.ee_spi_bits = QSpinBox()
        self.ee_spi_bits.setRange(1, 32)
        self.ee_spi_bits.setValue(14)
        el.addWidget(self.ee_spi_bits, 1, 1)
        el.addWidget(QLabel("SPI 空闲时间:"), 1, 2)
        self.ee_spi_idle = QSpinBox()
        self.ee_spi_idle.setRange(0, 255)
        self.ee_spi_idle.setValue(16)
        el.addWidget(self.ee_spi_idle, 1, 3)
        grp_enc.setLayout(el)
        grid.addWidget(grp_enc, row, 0, 1, 4)
        row += 1

        # === 电角度偏置 ===
        grp_phi = QGroupBox("电角度偏置 (PHI_E_OFFSET, 0x242)")
        phi_l = QGridLayout()
        phi_l.addWidget(QLabel("值 (hex):"), 0, 0)
        self.ee_phi_e_offset = QLineEdit("0x00000000")
        self.ee_phi_e_offset.setToolTip("每电机不同，从「电角度标定」Tab 标定后自动同步，或手动填入")
        self.ee_phi_e_offset.setMinimumWidth(140)
        phi_l.addWidget(self.ee_phi_e_offset, 0, 1)
        grp_phi.setLayout(phi_l)
        grid.addWidget(grp_phi, row, 0, 1, 4)
        row += 1

        grid.setRowStretch(row, 1)
        outer.addWidget(scroll)

        # === 底部按钮 ===
        btn_layout = QHBoxLayout()
        self.ee_read_btn = QPushButton("从芯片读取当前值")
        self.ee_read_btn.setToolTip("连接后，读取芯片寄存器填入上方字段")
        self.ee_read_btn.clicked.connect(self._eeprom_read_from_chip)
        btn_layout.addWidget(self.ee_read_btn)
        self.ee_write_btn = QPushButton("写入芯片（临时）")
        self.ee_write_btn.setToolTip("将上方参数写入芯片 RAM，断电丢失")
        self.ee_write_btn.clicked.connect(self._eeprom_write_to_chip)
        btn_layout.addWidget(self.ee_write_btn)
        btn_layout.addStretch()
        self.ee_save_btn = QPushButton("保存到 EEPROM")
        self.ee_save_btn.setStyleSheet("font-weight: bold; padding: 8px 20px;")
        self.ee_save_btn.setToolTip("将上方参数保存到 M24C02 EEPROM，断电保留")
        self.ee_save_btn.clicked.connect(self._eeprom_save)
        btn_layout.addWidget(self.ee_save_btn)
        self.ee_load_btn = QPushButton("从 EEPROM 读取")
        self.ee_load_btn.setToolTip("从 EEPROM 读取配置并填入上方字段")
        self.ee_load_btn.clicked.connect(self._eeprom_load)
        btn_layout.addWidget(self.ee_load_btn)
        outer.addLayout(btn_layout)

        return widget

    def _get_eeprom_params(self) -> dict:
        """从 UI 控件读取当前参数"""
        mode_map = {0: 0x02, 1: 0x00, 2: 0x01}  # VELOCITY=0x02, TORQUE=0x00, POSITION=0x01
        mode_raw = mode_map.get(self.ee_mode_combo.currentIndex(), 0x02)
        poles = self.ee_poles_spin.value()
        # MOTOR_MOTION: [7:0]=motion_mode, [15:8]=n_pole_pairs
        motor_motion_val = (poles << 8) | (mode_raw & 0xFF)

        # 编码器 SPI 配置 (IO Controller SPI_ENC command)
        spi_bits = self.ee_spi_bits.value()
        spi_idle = self.ee_spi_idle.value()
        spi_mode = self.ee_spi_mode.value()
        spi_freq = self.ee_spi_freq.value()
        # SPI_CFG: [2:0]=bus_mode, [7:3]=freq_div相关, [15:8]=idle_time
        # 实际值参考 tmc6460_encoder.py setup_encoder()
        spi_cfg_val = (spi_mode & 0x07) | ((spi_idle & 0xFF) << 8)
        spi_data_mask = (1 << spi_bits) - 1

        # PHI_E_OFFSET
        try:
            phi_e_str = self.ee_phi_e_offset.text().strip()
            phi_e_offset = int(phi_e_str, 16) if phi_e_str.startswith("0x") else int(phi_e_str)
            phi_e_offset &= 0xFFFFFFFF
        except ValueError:
            phi_e_offset = 0

        return {
            'motor_motion': motor_motion_val,
            'torque_limit': self.ee_torque_limit.value(),
            'flux_limit': self.ee_flux_limit.value(),
            'vel_limit': self.ee_vel_limit.value(),
            'cur_kp': self.ee_cur_kp.value(),
            'cur_ki': self.ee_cur_ki.value(),
            'vel_kp': self.ee_vel_kp.value(),
            'vel_ki': self.ee_vel_ki.value(),
            'pos_kp': self.ee_pos_kp.value(),
            'pos_ki': self.ee_pos_ki.value(),
            'spi_cfg': spi_cfg_val,
            'spi_data_mask': spi_data_mask,
            'phi_e_offset': phi_e_offset,
        }

    def _eeprom_read_from_chip(self):
        """从芯片读取当前寄存器值并填入 UI"""
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "请先连接串口")
            return
        self.statusBar().showMessage("正在从芯片读取配置...")
        QApplication.processEvents()

        try:
            regs = {
                0x100: 'motor_motion',
                0x142: 'flux_coeff',
                0x143: 'torque_coeff',
                0x145: 'vel_coeff',
                0x146: 'pos_coeff',
                0x14A: 'torque_flux_limits',
                0x14B: 'vel_limit',
                0x242: 'phi_e_offset',
            }
            vals = {}
            for addr in regs:
                v = self.tmc.read_register(addr)
                if v is None:
                    QMessageBox.critical(self, "错误", f"读取 0x{addr:03X} 失败")
                    return
                vals[addr] = v

            # 解析填入 UI
            motion = vals[0x100]
            mode_raw = motion & 0xFF
            if mode_raw == 0x02:
                self.ee_mode_combo.setCurrentIndex(0)
            elif mode_raw == 0x00:
                self.ee_mode_combo.setCurrentIndex(1)
            elif mode_raw == 0x01:
                self.ee_mode_combo.setCurrentIndex(2)
            self.ee_poles_spin.setValue((motion >> 8) & 0xFF)

            # 电流环 (0x142 和 0x143 应该相同)
            cur = vals[0x143]  # TORQUE_COEFF
            self.ee_cur_kp.setValue((cur >> 16) & 0xFFFF)
            self.ee_cur_ki.setValue(cur & 0xFFFF)

            # 速度环
            vel = vals[0x145]
            self.ee_vel_kp.setValue((vel >> 16) & 0xFFFF)
            self.ee_vel_ki.setValue(vel & 0xFFFF)

            # 位置环
            pos = vals[0x146]
            self.ee_pos_kp.setValue((pos >> 16) & 0xFFFF)
            self.ee_pos_ki.setValue(pos & 0xFFFF)

            # 力矩限制
            tf_lim = vals[0x14A]
            # [30:16]=torque_limit, [14:0]=flux_limit (内部单位 count)
            # 这里读的是 raw count，转为 mA
            torque_raw = (tf_lim >> 16) & 0x7FFF
            flux_raw = tf_lim & 0x7FFF
            self.ee_torque_limit.setValue(int(torque_raw * 0.20131))  # MA_PER_COUNT
            self.ee_flux_limit.setValue(int(flux_raw * 0.20131))

            # 速度限制
            vel_lim_raw = vals[0x14B] & 0x7FFFFFFF
            self.ee_vel_limit.setValue(int(vel_lim_raw / 305.4))  # K_VEL

            # 电角度偏置
            self.ee_phi_e_offset.setText(f"0x{vals[0x242] & 0xFFFFFFFF:08X}")

            self.statusBar().showMessage("从芯片读取完成")
        except Exception as e:
            self.statusBar().showMessage(f"读取异常: {e}")
            QMessageBox.critical(self, "异常", str(e))

    def _eeprom_write_to_chip(self):
        """将 UI 参数写入芯片（临时，断电丢失）"""
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "请先连接串口")
            return
        p = self._get_eeprom_params()
        self.statusBar().showMessage("正在写入芯片...")
        QApplication.processEvents()

        MA_PER_COUNT = 0.20131
        K_VEL = 305.4
        try:
            writes = [
                (0x100, p['motor_motion']),
                (0x142, ((p['cur_kp'] & 0xFFFF) << 16) | (p['cur_ki'] & 0xFFFF)),  # FLUX_COEFF
                (0x143, ((p['cur_kp'] & 0xFFFF) << 16) | (p['cur_ki'] & 0xFFFF)),  # TORQUE_COEFF
                (0x145, ((p['vel_kp'] & 0xFFFF) << 16) | (p['vel_ki'] & 0xFFFF)),
                (0x146, ((p['pos_kp'] & 0xFFFF) << 16) | (p['pos_ki'] & 0xFFFF)),
                (0x14A, ((int(p['torque_limit'] / MA_PER_COUNT) & 0x7FFF) << 16) |
                        (int(p['flux_limit'] / MA_PER_COUNT) & 0x7FFF)),
                (0x14B, int(p['vel_limit'] * K_VEL) & 0x7FFFFFFF),
                (0x242, p['phi_e_offset']),
            ]
            fail = 0
            for addr, val in writes:
                if not self.tmc.write_register(addr, val):
                    fail += 1
                    print(f"[EEPROM] write 0x{addr:03X} failed")
            if fail:
                self.statusBar().showMessage(f"写入完成，{fail} 个寄存器失败")
                QMessageBox.warning(self, "警告", f"{fail} 个寄存器写入失败")
            else:
                self.statusBar().showMessage("全部写入成功 (断电丢失)")
                QMessageBox.information(self, "成功", "参数已写入芯片 RAM\n注意：断电后会丢失，请保存到 EEPROM")
        except Exception as e:
            self.statusBar().showMessage(f"写入异常: {e}")
            QMessageBox.critical(self, "异常", str(e))

    def _eeprom_save(self):
        """保存 UI 参数到 EEPROM"""
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "请先连接串口")
            return
        reply = QMessageBox.question(
            self, "确认", "将当前参数保存到 M24C02 EEPROM？\n已有数据将被覆盖。",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return

        p = self._get_eeprom_params()
        self.statusBar().showMessage("正在保存到 EEPROM...")
        QApplication.processEvents()

        MA_PER_COUNT = 0.20131
        K_VEL = 305.4
        try:
            # 构建寄存器-值对
            config = [
                (0x100, p['motor_motion']),
                (0x142, ((p['cur_kp'] & 0xFFFF) << 16) | (p['cur_ki'] & 0xFFFF)),
                (0x143, ((p['cur_kp'] & 0xFFFF) << 16) | (p['cur_ki'] & 0xFFFF)),
                (0x145, ((p['vel_kp'] & 0xFFFF) << 16) | (p['vel_ki'] & 0xFFFF)),
                (0x146, ((p['pos_kp'] & 0xFFFF) << 16) | (p['pos_ki'] & 0xFFFF)),
                (0x14A, ((int(p['torque_limit'] / MA_PER_COUNT) & 0x7FFF) << 16) |
                        (int(p['flux_limit'] / MA_PER_COUNT) & 0x7FFF)),
                (0x14B, int(p['vel_limit'] * K_VEL) & 0x7FFFFFFF),
                (0x242, p['phi_e_offset']),
            ]
            ok, msg = eeprom_save_config_custom(self.tmc, config)
            if ok:
                self.statusBar().showMessage(msg)
                QMessageBox.information(self, "成功", msg)
            else:
                self.statusBar().showMessage(f"保存失败: {msg}")
                QMessageBox.critical(self, "失败", msg)
        except Exception as e:
            self.statusBar().showMessage(f"异常: {e}")
            QMessageBox.critical(self, "异常", str(e))

    def _eeprom_load(self):
        """从 EEPROM 读取配置并填入 UI"""
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "请先连接串口")
            return
        self.statusBar().showMessage("正在从 EEPROM 读取...")
        QApplication.processEvents()
        try:
            ok, msg, config = eeprom_load_config(self.tmc, apply=False)
            if not ok:
                self.statusBar().showMessage(f"读取失败: {msg}")
                QMessageBox.critical(self, "失败", msg)
                return
            # 将读到的寄存器值填入 UI
            reg_map = {addr: val for addr, val in config}
            MA_PER_COUNT = 0.20131
            K_VEL = 305.4
            if 0x100 in reg_map:
                motion = reg_map[0x100]
                mode_raw = motion & 0xFF
                if mode_raw == 0x02:
                    self.ee_mode_combo.setCurrentIndex(0)
                elif mode_raw == 0x00:
                    self.ee_mode_combo.setCurrentIndex(1)
                elif mode_raw == 0x01:
                    self.ee_mode_combo.setCurrentIndex(2)
                self.ee_poles_spin.setValue((motion >> 8) & 0xFF)
            if 0x143 in reg_map:
                v = reg_map[0x143]
                self.ee_cur_kp.setValue((v >> 16) & 0xFFFF)
                self.ee_cur_ki.setValue(v & 0xFFFF)
            if 0x145 in reg_map:
                v = reg_map[0x145]
                self.ee_vel_kp.setValue((v >> 16) & 0xFFFF)
                self.ee_vel_ki.setValue(v & 0xFFFF)
            if 0x146 in reg_map:
                v = reg_map[0x146]
                self.ee_pos_kp.setValue((v >> 16) & 0xFFFF)
                self.ee_pos_ki.setValue(v & 0xFFFF)
            if 0x14A in reg_map:
                tf = reg_map[0x14A]
                self.ee_torque_limit.setValue(int(((tf >> 16) & 0x7FFF) * MA_PER_COUNT))
                self.ee_flux_limit.setValue(int((tf & 0x7FFF) * MA_PER_COUNT))
            if 0x14B in reg_map:
                self.ee_vel_limit.setValue(int((reg_map[0x14B] & 0x7FFFFFFF) / K_VEL))
            if 0x242 in reg_map:
                self.ee_phi_e_offset.setText(f"0x{reg_map[0x242] & 0xFFFFFFFF:08X}")
            self.statusBar().showMessage(msg)
            QMessageBox.information(self, "成功", msg + "\n参数已填入上方字段，可编辑后再写入芯片或保存。")
        except Exception as e:
            self.statusBar().showMessage(f"异常: {e}")
            QMessageBox.critical(self, "异常", str(e))

    def _read_temperature(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return
        if self.tmc.rtmi_running:
            QMessageBox.warning(self, "警告", "RTMI 运行中，请先停止")
            return
        try:
            # 使用 read_register_raw 获取原始帧
            result = self.tmc.read_register_raw(0x084)  # ADC.TEMP_RAW
            if result is None:
                QMessageBox.warning(self, "警告", "读取失败")
                return
            req, resp = result
            print(f"[TEMP] 请求: {req.hex(' ')}")
            print(f"[TEMP] 响应: {resp.hex(' ')} ({len(resp)} 字节)")
            from tmc6460_protocol import parse_read_response
            val = parse_read_response(resp, 0x084)
            if val is None:
                QMessageBox.warning(self, "警告", "解析失败")
                return
            print(f"[TEMP] 原始值: 0x{val:08X} ({val})")
            # 解析 TEMP_INT (bits 31:16) 和 TEMP_EXT (bits 15:0)
            temp_int_raw = (val >> 16) & 0xFFFF
            temp_ext_raw = val & 0xFFFF
            # 转换为有符号 16-bit
            if temp_int_raw > 32767:
                temp_int_raw -= 65536
            if temp_ext_raw > 32767:
                temp_ext_raw -= 65536
            # 芯片内部温度: TJ = (TEMP_INT * 1.25 / 32768 - 0.622) * 1250 / 3
            tj = (temp_int_raw * 1.25 / 32768.0 - 0.622) * 1250.0 / 3.0
            # 外部 NTC 温度 (Steinhart-Hart)
            R_ref = 10000.0
            T_ref = 298.15
            B = 3380.0
            VCC_IO = 4.5  # TEMP 引脚供电电压
            adc_f = temp_ext_raw * 5.5 / 32768.0  # ADC 原始值转电压 (满量程 5.5V)
            if adc_f > 0 and adc_f < VCC_IO:
                R_ntc = (10000.0 * adc_f) / (VCC_IO - adc_f)  # 分压电路反推 NTC 电阻
                inv_T = (1.0 / T_ref) + (1.0 / B) * math.log(R_ntc / R_ref)
                t_ntc = 1.0 / inv_T - 273.15 if inv_T != 0 else 0
            else:
                t_ntc = 0
            self.temp_int_label.setText(f"{tj:.1f} °C (raw={temp_int_raw})")
            self.temp_ext_label.setText(f"{t_ntc:.1f} °C (raw={temp_ext_raw})")
        except Exception as e:
            QMessageBox.critical(self, "错误", str(e))

    def _start_calibration(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return
        # 停止 RTMI (如果运行)，断主连接释放串口
        self._calib_was_rtmi = self.tmc.rtmi_running
        if self.tmc.rtmi_running:
            self.tmc.stop_rtmi()
            self.monitor_btn.setText("▶ 启动 RTMI 监控")
            self.monitor_btn.setStyleSheet("")
        port = self.port_combo.currentText()
        self._calib_port = port
        # 恢复原波特率后断开
        if hasattr(self, '_original_baud'):
            try:
                if self.tmc.ser and self.tmc.ser.is_open:
                    self.tmc.ser.baudrate = self._original_baud
            except: pass
        self.tmc.disconnect()
        self.connect_btn.setText("连接")
        self.status_label.setText("标定中...")
        self.status_label.setStyleSheet("color: #ff9800;")

        self.calib_start_btn.setEnabled(False)
        self.calib_write_btn.setEnabled(False)
        self.calib_status_label.setText("标定中...")
        self.calib_status_label.setStyleSheet("color: #ff9800;")
        self._calib_worker = _CalibrationWorker(
            port,
            self.calib_current_spin.value()
        )
        self._calib_worker.status.connect(self._on_calib_status)
        self._calib_worker.finished.connect(self._on_calib_finished)
        self._calib_worker.error.connect(self._on_calib_error)
        self._calib_worker.start()

    def _restore_connection(self):
        """标定完成后恢复主串口连接"""
        port = getattr(self, '_calib_port', self.port_combo.currentText())
        baud = int(self.baud_combo.currentText()) if hasattr(self, 'baud_combo') else 115200
        self.tmc.port = port
        self.tmc.baudrate = baud
        self.tmc.timeout = 0.05
        if self.tmc.connect():
            self.connect_btn.setText("断开")
            self.status_label.setText(f"已连接 {port} @ {baud}")
            self.status_label.setStyleSheet("color: #4caf50; font-weight: bold;")

    def _on_calib_status(self, msg: str):
        self.calib_status_label.setText(msg)

    def _on_calib_error(self, msg: str):
        self.calib_status_label.setText(f"错误: {msg}")
        self.calib_status_label.setStyleSheet("color: #f44336;")
        self.calib_start_btn.setEnabled(True)
        QMessageBox.critical(self, "标定错误", msg)
        self._restore_connection()

    def _on_calib_finished(self, result: dict):
        self.calib_start_btn.setEnabled(True)
        self.calib_status_label.setText("标定完成")
        self.calib_status_label.setStyleSheet("color: #4caf50; font-weight: bold;")

        # 填充表格
        rows = result.get("table_rows", [])
        self.calib_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            for j, val in enumerate(row):
                item = QTableWidgetItem(str(val))
                item.setFont(QFont("Consolas", 10))
                self.calib_table.setItem(i, j, item)

        # 拟合结果
        self.calib_r2_label.setText(f"R²: {result['r2']:.5f}")
        self.calib_k_label.setText(f"k: {result['k']:.4f}")
        self.calib_b_label.setText(f"b: {result['b']:.2f}")
        self.calib_b14_label.setText(f"b14: {result['b14']:.2f}")
        self.calib_mulfactor_label.setText(f"MUL_FACTOR: {result['mul_factor']}")
        offset = result['offset']
        self.calib_offset_label.setText(
            f"PHI_E_OFFSET: {offset}  (0x{offset:08X})"
        )
        print(f"[CALIB] 标定完成: offset={offset} (0x{offset:08X}) R²={result['r2']:.5f}")

        # 保存 offset 供写入
        self._calib_offset = offset
        self.calib_write_btn.setEnabled(True)

        # 自动同步到 EEPROM 配置 Tab
        self.ee_phi_e_offset.setText(f"0x{offset & 0xFFFFFFFF:08X}")

        QMessageBox.information(
            self, "标定完成",
            f"PHI_E_OFFSET = {offset} (0x{offset:08X})\nR² = {result['r2']:.5f}\n\n点击「写入芯片」写入寄存器 0x242"
        )
        self._restore_connection()

    def _write_calib_offset(self):
        if not hasattr(self, '_calib_offset'):
            return
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return
        offset = self._calib_offset
        print(f"[CALIB] 写入 0x242 = {offset} (0x{offset:08X})")
        if self.tmc.write_register(0x242, offset):
            rb = self.tmc.read_register(0x242)
            print(f"[CALIB] 读回 0x242 = {rb} (0x{rb:08X})" if rb else "[CALIB] 读回失败")
            self.statusBar().showMessage(f"PHI_E_OFFSET = 0x{offset:08X} 已写入 0x242")
            QMessageBox.information(self, "写入成功", f"PHI_E_OFFSET = {offset} (0x{offset:08X})\n已写入寄存器 0x242")
        else:
            QMessageBox.critical(self, "写入失败", "写入寄存器 0x242 失败")

    def _refresh_ports(self):
        import serial.tools.list_ports
        self.port_combo.clear()
        for p in serial.tools.list_ports.comports():
            self.port_combo.addItem(p.device)

    def _toggle_connection(self):
        if self.tmc.connected:
            was_rtmi = self.tmc.rtmi_running
            # 恢复波特率再断开
            if hasattr(self, '_original_baud') and self.tmc.ser and self.tmc.ser.is_open:
                try:
                    self.tmc.ser.baudrate = self._original_baud
                except Exception:
                    pass
            self.tmc.disconnect()
            self.connect_btn.setText("连接")
            self.status_label.setText("未连接")
            self.status_label.setStyleSheet("color: gray;")
            if was_rtmi:
                self.monitor_btn.setText("▶ 启动 RTMI 监控")
                self.monitor_btn.setStyleSheet("")
                self.fps_label.setText("实际刷新率: -- Hz")
            return
        port = self.port_combo.currentText()
        baud = int(self.baud_combo.currentText())
        if not port:
            QMessageBox.warning(self, "警告", "请选择串口")
            return
        self.tmc.port = port
        self.tmc.baudrate = baud
        self.tmc.timeout = 0.05
        if self.tmc.connect():
            self.connect_btn.setText("断开")
            self.status_label.setText(f"已连接 {port} @ {baud}")
            self.status_label.setStyleSheet("color: #4caf50; font-weight: bold;")
        else:
            QMessageBox.critical(self, "错误", f"无法打开 {port}")

    def _get_selected_addr(self) -> int | None:
        try:
            addr = int(self.addr_input.text().strip(), 16)
            if 0 <= addr <= 0x3FF:
                return addr
        except ValueError:
            pass
        return None

    def _read_register(self):
        addr = self._get_selected_addr()
        if addr is None or not self.tmc.connected:
            return
        result = self.tmc.read_register_raw(addr)
        if result is None:
            self.read_result.setText("错误")
            return
        req, resp = result
        self.raw_req_label.setText(f"请求: {' '.join(f'{b:02X}' for b in req)}")
        self.raw_resp_label.setText(f"响应: {' '.join(f'{b:02X}' for b in resp)}")
        if len(resp) >= 5:
            data = parse_read_response(resp, addr)
            if data is not None:
                self.read_result.setText(f"0x{data:08X}  ({data})")
                self.read_result.setStyleSheet("color: #4caf50;")

    def _write_register(self):
        addr = self._get_selected_addr()
        if addr is None or not self.tmc.connected:
            return
        try:
            data = int(self.data_input.text().strip(), 16)
        except ValueError:
            return
        if self.tmc.write_register(addr, data):
            self.statusBar().showMessage(f"写入 0x{addr:03X} = 0x{data:08X}")

    def _on_reg_selected(self, current, _):
        if current:
            addr = current.data(0, Qt.UserRole)
            if addr is not None:
                self.addr_input.setText(f"{addr:03X}")
                if addr in TMC6460_REGISTERS:
                    name, desc, fields = TMC6460_REGISTERS[addr]
                    field_str = ", ".join(f[0] for f in fields) if fields else "无"
                    self.sel_reg_label.setText(f"选中: {name} - {desc}\n字段: {field_str}")

    def _read_to_label(self, addr: int, label: QLabel):
        if not self.tmc.connected:
            label.setText("未连接")
            return
        val = self.tmc.read_register(addr)
        if val is not None:
            label.setText(f"0x{val:08X}")
            label.setStyleSheet("color: #4caf50;")
        else:
            label.setText("失败")
            label.setStyleSheet("color: red;")

    def _write_from_input(self, addr: int, widget: QLineEdit):
        if not self.tmc.connected:
            return
        text = widget.text().strip()
        try:
            data = int(text, 16) if text.startswith("0x") else int(text)
        except ValueError:
            return
        self.tmc.write_register(addr, data & 0xFFFFFFFF)
        self.statusBar().showMessage(f"写入 0x{addr:03X} = 0x{data:08X}")

    def _write_from_spinbox(self, addr: int, widget: QDoubleSpinBox):
        if not self.tmc.connected:
            return
        data = int(widget.value())
        self.tmc.write_register(addr, data & 0xFFFFFFFF)
        self.statusBar().showMessage(f"写入 0x{addr:03X} = {data}")

    def _read_all_pid(self):
        for addr, label, _ in self.pid_rows:
            self._read_to_label(addr, label)

    # ---------- 波形 ----------
    def _on_channel_toggled(self, checked: bool):
        sender = self.sender()
        idx = sender.property("ch_idx")
        if idx in self.waveform_curves:
            self.waveform_curves[idx].setVisible(checked)
        # RTMI 运行中切换通道，自动重启 RTMI
        if self.tmc.rtmi_running:
            self._restart_rtmi()

    def _update_rtmi_freq_label(self):
        s = self.sampling_spin.value() + 1
        freq = 50000 / s  # 假设 f_PWM = 50kHz
        self.freq_label.setText(f"≈ {freq/1000:.1f} kHz")

    def _toggle_monitoring(self):
        if self.tmc.rtmi_running:
            self.tmc.stop_rtmi()
            # 恢复原始波特率
            if hasattr(self, '_original_baud') and self.tmc.ser and self.tmc.ser.is_open:
                self.tmc.ser.baudrate = self._original_baud
            self.monitor_btn.setText("▶ 启动 RTMI 监控")
            self.monitor_btn.setStyleSheet("")
            return
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return
        # 获取选中的通道
        active_idxs = [i for i, cb in self.waveform_checkboxes.items() if cb.isChecked()]
        if len(active_idxs) > 8:
            QMessageBox.warning(self, "警告", "最多 8 个 RTMI 通道")
            return
        if not active_idxs:
            QMessageBox.warning(self, "警告", "请至少选一个通道")
            return
        # 构建 RTMI 通道映射
        channels = {}
        ch_map = {}
        for rtmi_id, ch_idx in enumerate(active_idxs):
            name, addr, desc = WAVEFORM_CHANNELS[ch_idx]
            channels[rtmi_id] = addr
            ch_map[rtmi_id] = ch_idx
        self.rtmi_bridge.set_channel_map(ch_map)
        self.start_time = time.time()
        self._fps_counter = 0
        self._fps_last = time.time()
        # RTMI 使用主链路波特率
        self.tmc.ser.reset_input_buffer() if self.tmc.ser and self.tmc.ser.is_open else None
        # 清掉残留数据
        if self.tmc.ser and self.tmc.ser.is_open:
            time.sleep(0.05)
            self.tmc.ser.reset_input_buffer()
        # 启动 RTMI
        if self.tmc.start_rtmi(channels, self.sampling_spin.value(),
                               callback=self.rtmi_bridge):
            self.monitor_btn.setText("⏹ 停止 RTMI")
            self.monitor_btn.setStyleSheet("background-color: #4caf50;")
            s = self.sampling_spin.value() + 1
            freq = 50000 / s
            baud = self.tmc.baudrate if self.tmc.ser and self.tmc.ser.is_open else 0
            self.fps_label.setText(f"f_RTMI ≈ {freq/1000:.1f} kHz @ {baud} | {len(channels)} 通道")
        else:
            QMessageBox.critical(self, "错误", "RTMI 配置失败")

    def _restart_rtmi(self):
        """RTMI 运行中重配通道（停止→重配→启动，不改按钮状态）"""
        self.tmc.stop_rtmi()
        time.sleep(0.05)
        active_idxs = [i for i, cb in self.waveform_checkboxes.items() if cb.isChecked()]
        if not active_idxs or len(active_idxs) > 8:
            if hasattr(self, '_original_baud') and self.tmc.ser and self.tmc.ser.is_open:
                self.tmc.ser.baudrate = self._original_baud
            self.monitor_btn.setText("▶ 启动 RTMI 监控")
            self.monitor_btn.setStyleSheet("")
            return
        channels = {}
        ch_map = {}
        for rtmi_id, ch_idx in enumerate(active_idxs):
            name, addr, desc = WAVEFORM_CHANNELS[ch_idx]
            channels[rtmi_id] = addr
            ch_map[rtmi_id] = ch_idx
        self.rtmi_bridge.set_channel_map(ch_map)
        if self.tmc.ser and self.tmc.ser.is_open:
            time.sleep(0.05)
            self.tmc.ser.reset_input_buffer()
        if self.tmc.start_rtmi(channels, self.sampling_spin.value(),
                               callback=self.rtmi_bridge):
            s = self.sampling_spin.value() + 1
            freq = 50000 / s
            self.fps_label.setText(f"f_RTMI ≈ {freq/1000:.1f} kHz | {len(channels)} 通道")
        else:
            QMessageBox.critical(self, "错误", "RTMI 重配失败")
            self.monitor_btn.setText("▶ 启动 RTMI 监控")
            self.monitor_btn.setStyleSheet("")

    # 通道后处理: raw RTMI 值 → 显示值
    # 编码器 PHI_EXT_A: 低 14 位有效，转角度
    _ENC_CH_IDX = len(WAVEFORM_CHANNELS) - 1  # 编码器通道 index

    def _postprocess(self, ch_idx: int, raw_val: float) -> tuple[float, str]:
        """返回 (显示值, 格式化字符串)"""
        if ch_idx == self._ENC_CH_IDX:
            raw = int(raw_val) & 0xFFFFFFFF  # unsigned 32-bit
            angle = raw & 0xFFFF  # 低 16 位
            deg = angle * 360.0 / 65536.0
            return deg, f"{deg:.2f}° (0x{angle:04X}, raw=0x{raw:08X})"
        return raw_val, f"{raw_val:.0f}"

    def _on_waveform_data(self, ch_idx: int, t: float, val: float):
        """RTMI 数据点到达（从后台线程通过 Qt 信号桥接）"""
        if ch_idx not in self.waveform_buffers:
            return
        display_val, display_str = self._postprocess(ch_idx, val)
        self.waveform_buffers[ch_idx].append(display_val)
        self.waveform_times[ch_idx].append(t - self.start_time)
        self._fps_counter += 1
        # 更新数值表
        item = self.value_table.item(ch_idx, 2)
        if item:
            item.setText(display_str)

    def _refresh_display(self):
        """定时刷新波形曲线（解耦采集与显示）"""
        for ch_idx, curve in self.waveform_curves.items():
            if curve.isVisible() and len(self.waveform_times[ch_idx]) > 0:
                curve.setData(
                    list(self.waveform_times[ch_idx]),
                    list(self.waveform_buffers[ch_idx])
                )

    def _on_batch_data(self, t: float, values: dict):
        pass  # RTMI 模式下不使用

    def _update_fps(self):
        """每秒更新实际数据速率"""
        now = time.time()
        elapsed = now - self._fps_last
        if elapsed >= 1.0 and self.tmc.rtmi_running:
            rate = self._fps_counter / elapsed
            ch_active = sum(1 for cb in self.waveform_checkboxes.values() if cb.isChecked())
            rate_per_ch = rate / ch_active if ch_active > 0 else 0
            sampling_val = self.sampling_spin.value() + 1
            rtmi_freq = 50000.0 / sampling_val
            self.fps_label.setText(
                f"f_RTMI ≈ {rtmi_freq/1000:.1f} kHz "
                f"| 数据: {rate:.0f} pts/s ({rate_per_ch:.0f}/ch · {ch_active}ch active)"
            )
            self._fps_counter = 0
            self._fps_last = now

    def _clear_waveform(self):
        for buf in self.waveform_buffers.values():
            buf.clear()
        for ts in self.waveform_times.values():
            ts.clear()
        for curve in self.waveform_curves.values():
            curve.setData([], [])

    # ---------- PRBS ----------
    def _update_prbs_freq(self):
        ratio = self.prbs_downsample_spin.value() + 1
        # 假设 fPWM = 50kHz
        freq = 50000 / ratio
        self.prbs_freq_label.setText(f"PRBS 频率: ~{freq:.0f} Hz (假设 fPWM=50kHz)")

    def _start_prbs(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return
        mode = self.prbs_mode_combo.currentData()
        amplitude = self.prbs_amplitude_spin.value()
        downsample = self.prbs_downsample_spin.value()

        steps = [
            ("设置 PRBS 幅度", 0x174, amplitude),
            ("设置 PRBS 降采样率", 0x175, downsample),
            ("设置 MOTION_MODE (PRBS)", 0x100, mode),
        ]
        for desc, addr, val in steps:
            if not self.tmc.write_register(addr, val):
                QMessageBox.critical(self, "错误", f"写入 0x{addr:03X} 失败: {desc}")
                return
            time.sleep(0.01)
        self.statusBar().showMessage(f"PRBS 辨识已启动 (模式=0x{mode:02X}, 幅度={amplitude})")
        QMessageBox.information(self, "PRBS", "PRBS 辨识已启动\n\n请切换到「实时波形」Tab 观察系统响应。\n完成后点「停止」恢复正常模式。")

    def _stop_prbs(self):
        if not self.tmc.connected:
            return
        # 停止 PRBS：幅度清零 + 切回力矩模式
        self.tmc.write_register(0x174, 0)       # PRBS 幅度 = 0
        time.sleep(0.01)
        self.tmc.write_register(0x100, 0x02)     # MOTION_MODE = TORQUE
        self.statusBar().showMessage("PRBS 已停止，已切回力矩模式")

    # ---------- SSI ----------
    def _on_ssi_preset_changed(self, name: str):
        if name in ENCODER_PRESETS:
            p = ENCODER_PRESETS[name]
            self.ssi_desc_label.setText(p.get("description", ""))

    def _init_ssi_encoder(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "\u8b66\u544a", "\u672a\u8fde\u63a5")
            return
        preset = self.ssi_preset_combo.currentText()
        pp = self.ssi_pp_spin.value()
        self.ssi_status_label.setText("\u914d\u7f6e\u4e2d...")
        self.ssi_status_label.setStyleSheet("color: #ff9800;")
        QApplication.processEvents()
        ok, msg = setup_encoder(self.tmc, preset_name=preset, pole_pairs=pp,
                                 csn_via_enc_n=True, timeout=1.0)
        if ok:
            self.ssi_status_label.setText("\u2713 " + msg)
            self.ssi_status_label.setStyleSheet("color: #4caf50; font-weight: bold;")
            self.statusBar().showMessage("\u7f16\u7801\u5668\u914d\u7f6e\u6210\u529f")
            # \u542f\u52a8\u8f6e\u8be2
            self.enc_buf.clear()
            self.enc_time_buf.clear()
            self.enc_start_time = time.time()
            self._enc_poll_timer.start(10)  # 100Hz
        else:
            self.ssi_status_label.setText("\u2717 " + msg)
            self.ssi_status_label.setStyleSheet("color: #f44336;")
            QMessageBox.critical(self, "\u9519\u8bef", f"\u914d\u7f6e\u5931\u8d25: {msg}")

    def _stop_ssi_encoder(self):
        if not self.tmc.connected:
            return
        self._enc_poll_timer.stop()
        try:
            self.tmc.write_register(IO_CONTROLLER_COMMAND, 0)
        except Exception:
            pass
        self.ssi_status_label.setText("\u5df2\u505c\u6b62")
        self.ssi_status_label.setStyleSheet("color: #90a4ae;")
        self.statusBar().showMessage("SSI \u5df2\u505c\u6b62")

    def _send_encoder_to_waveform(self):
        """配置完编码器后，将 PHI_EXT_A 加入 RTMI 波形通道并跳转到波形 Tab"""
        if not self.tmc.connected:
            QMessageBox.warning(self, "警告", "未连接")
            return
        # 停止 SSI Tab 的 QTimer 轮询，避免与 RTMI 冲突
        self._enc_poll_timer.stop()
        # 编码器角度是 WAVEFORM_CHANNELS 中最后一个 (index 7)
        enc_ch_idx = len(WAVEFORM_CHANNELS) - 1
        if enc_ch_idx in self.waveform_checkboxes:
            self.waveform_checkboxes[enc_ch_idx].setChecked(True)
        # 切换到实时波形 Tab
        for i in range(self.tabs.count()):
            if self.tabs.tabText(i) == "实时波形":
                self.tabs.setCurrentIndex(i)
                break
        self.statusBar().showMessage("编码器角度 (PHI_EXT_A) 已加入 RTMI 波形，SSI 轮询已停止")

    def _poll_encoder(self):
        if not self.tmc.connected:
            return
        try:
            val = self.tmc.read_register(ENCODER_ANGLE_ADDR)
            if val is not None:
                raw = val & 0x00FFFFFF
                angle_14 = raw & 0x3FFF
                deg = angle_14 * 360.0 / 16384.0
                now = time.time() - self.enc_start_time
                self.enc_buf.append(deg)
                self.enc_time_buf.append(now)
                self.enc_curve.setData(list(self.enc_time_buf), list(self.enc_buf))
                self.enc_angle_label.setText(f"\u89d2\u5ea6: {deg:.2f}\u00b0  (raw=0x{raw:06X}, {angle_14})")
        except Exception:
            pass

    def closeEvent(self, event):
        if self.tmc.rtmi_running:
            self.tmc.stop_rtmi()
            time.sleep(0.1)
        self.tmc.disconnect()
        event.accept()


# ==================== 启动 ====================
# ==================== 标定工作线程 ====================
class _CalibrationWorker(QThread):
    """后台执行电角度标定流程"""
    status = pyqtSignal(str)       # 进度文本
    error = pyqtSignal(str)        # 错误
    finished = pyqtSignal(dict)    # 完成, 携带结果

    # 寄存器地址
    REG_MOTOR_MOTION = 0x100
    REG_GDRV         = 0x101
    REG_CSA_GAIN     = 0x0C3
    REG_TF_LIMITS    = 0x14A
    REG_TF_TARGET    = 0x14E
    REG_POS_TARGET   = 0x152
    REG_POSITION     = 0x1D1  # RAMPER.POSITION (直接写位置)
    REG_RAMP_PHI_E   = 0x1C3
    REG_RAMP_V_MAX   = 0x1CE
    REG_RAMP_V_START = 0x1CA
    REG_RAMP_A1      = 0x1C4
    REG_RAMP_A_MAX   = 0x1C6
    REG_PHI_EXT_A    = 0x24D
    REG_MUL_FACTOR   = 0x24C
    REG_TORQUE_COEFF = 0x143
    REG_FLUX_COEFF   = 0x142
    REG_PWM_PERIOD   = 0x103

    ANGLE_TARGETS = {0: 0, 90: 0x4000, 180: 0x8000, 270: 0xC000}
    # MA_PER_COUNT from Table 20: LS_RES_ON=3, 0.00164*1000/8*4/4*0.982
    MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0 / 4.0 * 0.982  # ≈0.2013 mA/LSB

    def __init__(self, port: str, current_ma: float, poles: int = 1, settle_s: float = 1.0):
        super().__init__()
        self.port = port
        self.current_ma = current_ma
        self.poles = poles
        self.settle_s = settle_s
        self.tmc = None  # created in run()

    def run(self):
        # 创建独立串口 (115200, 标定用, 不与其他线程共用)
        self.tmc = TMC6460Serial(port=self.port, baudrate=115200)
        if not self.tmc.connect():
            self.error.emit(f"标定串口 {self.port} 连接失败")
            return
        try:
            self._do_calibration()
        except Exception as e:
            self.error.emit(str(e))
        finally:
            try:
                self.tmc.disconnect()
            except: pass

    def _read_enc(self):
        val = self.tmc.read_register(self.REG_PHI_EXT_A)
        return None if val is None else (val & 0x3FFF)

    def _wait_arrival(self, target16, timeout_s=3.0):
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            time.sleep(0.05)
            pe = self.tmc.read_register(self.REG_RAMP_PHI_E)
            if pe is not None and abs(pe - target16) < 0x800:
                return pe
        return self.tmc.read_register(self.REG_RAMP_PHI_E)

    def _do_calibration(self):
        tmc = self.tmc
        poles = self.poles
        MAX_RAW = 8192

        # --- 摘抄自 phi_e_calibrate.py main() 顺序 ---
        # 先设 MOTOR_MOTION 为 BLDC_SINE + TF_TARGET=0，避免残留状态
        tmc.write_register(self.REG_MOTOR_MOTION, (3 << 7) | poles)
        tmc.write_register(self.REG_TF_TARGET, 0)
        time.sleep(0.3)

        # Phase 1: 编码器配置
        self.status.emit("Phase 1: 配置编码器...")
        ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=poles)
        if not ok:
            self.error.emit(f"编码器配置失败: {msg}")
            return
        tmc.write_register(self.REG_PWM_PERIOD, 0xFFFF12C0)
        time.sleep(0.05)

        mul = tmc.read_register(self.REG_MUL_FACTOR) or 4
        self.status.emit(f"编码器 OK, MUL_FACTOR={mul}")

        # Phase 2: 电流环 + 运动模式
        self.status.emit("Phase 2: 配置电流环...")
        tmc.write_register(self.REG_CSA_GAIN, 3)
        tmc.write_register(self.REG_TORQUE_COEFF, (64 << 16) | 48)
        tmc.write_register(self.REG_FLUX_COEFF, (64 << 16) | 48)
        tmc.write_register(self.REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

        gdrv = tmc.read_register(self.REG_GDRV)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(self.REG_GDRV, gdrv)

        # RAMP_EN=0, RAMP_USE_PHI_E=1, MOTION_MODE=2(TORQUE), BLDC, poles
        motion = (1 << 15) | (0 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (poles & 0x7F)
        tmc.write_register(self.REG_MOTOR_MOTION, motion)
        tmc.write_register(self.REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(self.REG_RAMP_V_START, 0)
        tmc.write_register(self.REG_RAMP_A1, 0x00020000)
        tmc.write_register(self.REG_RAMP_A_MAX, 0x40000)
        tf_target_val = min(int(self.current_ma / self.MA_PER_COUNT), MAX_RAW)
        print(f"[CALIB] MOTION=0x{motion:08X} RAMP_EN={(motion>>14)&1}")
        print(f"[CALIB] 写入 0x14E(TF_TARGET) = {tf_target_val} (0x{tf_target_val:08X}), current={self.current_ma}mA")
        tmc.write_register(self.REG_TF_TARGET, tf_target_val)
        time.sleep(0.3)

        # Phase 3 & 4: 扫角度
        # 正转: 0°→360°, 每45°一个点，POSITION递增
        # 16位比例: 65536 = 360°，每45° = 8192
        step = 8192  # 45° in 16-bit scale
        fwd_degs = list(range(0, 361, 45))
        fwd_pos = [int(d * 65536 / 360) for d in fwd_degs]
        # 反转: 360°→0°, POSITION递减
        rev_degs = fwd_degs[::-1]
        rev_pos = fwd_pos[::-1]
        all_data = []

        def scan(label, degs, positions):
            self.status.emit(label)
            for i, (deg, pos) in enumerate(zip(degs, positions)):
                tmc.write_register(self.REG_POSITION, pos)
                time.sleep(self.settle_s)
                enc = self._read_enc()
                if enc is not None:
                    all_data.append((deg, enc))
                self.status.emit(f"{label} [{i+1}/{len(degs)}] deg={deg} pos={pos} enc={enc}")
                time.sleep(0.1)

        scan("正转 0°→360°", fwd_degs, fwd_pos)
        scan("反转 360°→0°", rev_degs, rev_pos)

        # Phase 5: 拟合
        self.status.emit("计算拟合...")
        if len(all_data) < 8:
            self.error.emit(f"数据不足 ({len(all_data)} 点)")
            self._release_current(tmc, poles)
            return

        groups = defaultdict(list)
        for deg, enc in all_data:
            groups[deg % 360].append(enc)

        angles = sorted(groups.keys())
        avg_enc = {a: sum(groups[a]) / len(groups[a]) for a in angles}

        # 解缠绕
        uw = [avg_enc[angles[0]]]
        for i in range(1, len(angles)):
            delta = avg_enc[angles[i]] - avg_enc[angles[i - 1]]
            if delta < -8192:
                delta += 16384
            elif delta > 8192:
                delta -= 16384
            uw.append(uw[-1] + delta)

        # 最小二乘直线拟合
        pts = [(angles[i], uw[i]) for i in range(len(angles))]
        n = len(pts)
        sx = sum(d for d, _ in pts)
        sy = sum(e for _, e in pts)
        sxy = sum(d * e for d, e in pts)
        sx2 = sum(d * d for d, _ in pts)
        k = (n * sxy - sx * sy) / (n * sx2 - sx * sx)
        b = (sy - k * sx) / n

        ss_res = sum((e - (k * d + b)) ** 2 for d, e in pts)
        ss_tot = sum((e - sy / n) ** 2 for _, e in pts)
        r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0

        b14 = b % 16384
        offset = int(-b14 * mul) & 0xFFFFFFFF

        # 构建表格数据
        table_rows = []
        all_unique = sorted(set(all_data))
        for deg, enc in all_unique:
            pred_uw = k * deg + b
            pred_14 = pred_uw % 16384
            res = enc - pred_14
            if res > 8192:
                res -= 16384
            elif res < -8192:
                res += 16384
            # 找到对应的 unwrap 值
            enc_uw = enc
            ref_idx = (deg % 360) // 90
            if ref_idx < len(uw):
                base = uw[ref_idx]
                diff = enc - (base % 16384)
                if diff > 8192:
                    diff -= 16384
                elif diff < -8192:
                    diff += 16384
                enc_uw = base + diff
            table_rows.append([
                str(deg), str(enc), f"{enc_uw:.1f}",
                f"{pred_14:.1f}", f"{res:+.1f}"
            ])

        result = {
            "r2": r2,
            "k": k,
            "b": b,
            "b14": b14,
            "mul_factor": mul,
            "offset": offset,
            "table_rows": table_rows,
        }

        self._release_current(tmc, poles)
        self.finished.emit(result)

    def _release_current(self, tmc, poles):
        try:
            tmc.write_register(self.REG_MOTOR_MOTION, (3 << 7) | (poles & 0x7F))
            tmc.write_register(self.REG_TF_TARGET, 0)
        except Exception:
            pass


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    palette = QPalette()
    palette.setColor(QPalette.Window, QColor(30, 30, 40))
    palette.setColor(QPalette.WindowText, QColor(200, 200, 200))
    palette.setColor(QPalette.Base, QColor(40, 40, 55))
    palette.setColor(QPalette.AlternateBase, QColor(50, 50, 65))
    palette.setColor(QPalette.Text, QColor(200, 200, 200))
    palette.setColor(QPalette.Button, QColor(50, 50, 65))
    palette.setColor(QPalette.ButtonText, QColor(200, 200, 200))
    palette.setColor(QPalette.Highlight, QColor(0, 150, 136))
    app.setPalette(palette)

    app.setStyleSheet("""
        QGroupBox { border: 1px solid #555; border-radius: 4px; margin-top: 8px;
                    padding-top: 16px; font-weight: bold; color: #00bcd4; }
        QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 5px; }
        QPushButton { background-color: #37474f; border: 1px solid #546e7a; border-radius: 3px;
                      padding: 5px 12px; color: #b0bec5; min-height: 20px; }
        QPushButton:hover { background-color: #455a64; border-color: #00bcd4; color: #00bcd4; }
        QPushButton:pressed { background-color: #263238; }
        QComboBox, QLineEdit, QSpinBox, QDoubleSpinBox { background-color: #263238;
            border: 1px solid #546e7a; border-radius: 3px; padding: 3px; color: #e0e0e0; }
        QTreeWidget, QTableWidget { background-color: #1e1e2e; alternate-background-color: #252535;
            border: 1px solid #444; color: #e0e0e0; }
        QTreeWidget::item:selected, QTableWidget::item:selected { background-color: #004d40; }
        QTabWidget::pane { border: 1px solid #444; }
        QTabBar::tab { background-color: #263238; border: 1px solid #444;
                       padding: 6px 16px; color: #90a4ae; }
        QTabBar::tab:selected { background-color: #37474f; color: #00bcd4; border-bottom-color: #00bcd4; }
        QHeaderView::section { background-color: #263238; color: #90a4ae; border: 1px solid #444; padding: 4px; }
    """)

    window = TMC6460MainWindow()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
