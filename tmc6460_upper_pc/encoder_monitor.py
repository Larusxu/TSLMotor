# -*- coding: utf-8 -*-
"""TMC6460 Encoder GUI - standalone, no broken protocol module needed"""
import sys, time, collections
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
                              QHBoxLayout, QGroupBox, QLabel, QPushButton,
                              QComboBox, QSpinBox, QStatusBar, QMessageBox)
from PyQt5.QtCore import QTimer, Qt
from PyQt5.QtGui import QFont, QColor, QPalette
import pyqtgraph as pg

sys.path.insert(0, r'G:\project\hand\Tesla_hand\tmc6460_upper_pc')
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import ENCODER_PRESETS, setup_encoder, ENCODER_ANGLE_ADDR


class EncoderWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("TMC6460 Encoder Monitor")
        self.setMinimumSize(800, 600)
        self.tmc = TMC6460Serial()
        self._poll_timer = QTimer()
        self._poll_timer.timeout.connect(self._poll)
        self.enc_buf = collections.deque(maxlen=2000)
        self.enc_time_buf = collections.deque(maxlen=2000)
        self.t0 = 0
        self._build_ui()
        self._refresh_ports()

    def _build_ui(self):
        w = QWidget()
        self.setCentralWidget(w)
        layout = QVBoxLayout(w)

        # Connection bar
        conn = QHBoxLayout()
        conn.addWidget(QLabel("Port:"))
        self.port_cb = QComboBox()
        self.port_cb.setMinimumWidth(100)
        conn.addWidget(self.port_cb)
        btn_ref = QPushButton("Refresh")
        btn_ref.clicked.connect(self._refresh_ports)
        conn.addWidget(btn_ref)
        conn.addWidget(QLabel("Baud:"))
        self.baud_cb = QComboBox()
        self.baud_cb.addItems(["115200", "460800", "921600"])
        self.baud_cb.setCurrentText("460800")
        conn.addWidget(self.baud_cb)
        self.conn_btn = QPushButton("Connect")
        self.conn_btn.clicked.connect(self._toggle_conn)
        conn.addWidget(self.conn_btn)
        self.conn_label = QLabel("Disconnected")
        self.conn_label.setStyleSheet("color:gray;font-weight:bold;")
        conn.addWidget(self.conn_label)
        conn.addStretch()
        layout.addLayout(conn)

        # Encoder config
        cfg = QGroupBox("Encoder")
        cl = QHBoxLayout()
        cl.addWidget(QLabel("Preset:"))
        self.preset_cb = QComboBox()
        for n in ENCODER_PRESETS:
            self.preset_cb.addItem(n)
        cl.addWidget(self.preset_cb)
        cl.addWidget(QLabel("Pole pairs:"))
        self.pp_spin = QSpinBox()
        self.pp_spin.setRange(1, 127)
        self.pp_spin.setValue(2)
        cl.addWidget(self.pp_spin)
        self.setup_btn = QPushButton("One-Click Setup")
        self.setup_btn.setStyleSheet("font-size:13px;padding:6px;")
        self.setup_btn.clicked.connect(self._setup)
        cl.addWidget(self.setup_btn)
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.clicked.connect(self._stop)
        cl.addWidget(self.stop_btn)
        self.setup_label = QLabel("")
        cl.addWidget(self.setup_label)
        cl.addStretch()
        cfg.setLayout(cl)
        layout.addWidget(cfg)

        # Angle display
        self.angle_label = QLabel("Angle: -- deg")
        self.angle_label.setFont(QFont("Consolas", 18))
        self.angle_label.setStyleSheet("color:#00bcd4;font-weight:bold;")
        self.angle_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.angle_label)

        # Waveform
        pg.setConfigOptions(antialias=True)
        self.plot = pg.PlotWidget(title="Encoder Angle")
        self.plot.setLabel('left', 'Angle', units='deg')
        self.plot.setLabel('bottom', 'Time', units='s')
        self.plot.setYRange(0, 360)
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.curve = self.plot.plot([], [], pen=pg.mkPen('#00bcd4', width=2))
        layout.addWidget(self.plot)

        self.statusBar().showMessage("Ready")

    def _refresh_ports(self):
        import serial.tools.list_ports
        self.port_cb.clear()
        for p in serial.tools.list_ports.comports():
            self.port_cb.addItem(p.device)

    def _toggle_conn(self):
        if self.tmc.connected:
            self._poll_timer.stop()
            self.tmc.disconnect()
            self.conn_btn.setText("Connect")
            self.conn_label.setText("Disconnected")
            self.conn_label.setStyleSheet("color:gray;font-weight:bold;")
            return
        port = self.port_cb.currentText()
        baud = int(self.baud_cb.currentText())
        self.tmc.port = port
        self.tmc.baudrate = baud
        self.tmc.timeout = 0.1
        if self.tmc.connect():
            self.conn_btn.setText("Disconnect")
            self.conn_label.setText(f"Connected {port} @{baud}")
            self.conn_label.setStyleSheet("color:#4caf50;font-weight:bold;")
            ver = self.tmc.read_register(0x000)
            self.statusBar().showMessage(f"VERSION = 0x{ver:08X}" if ver else "No response")
        else:
            QMessageBox.critical(self, "Error", f"Cannot open {port}")

    def _setup(self):
        if not self.tmc.connected:
            QMessageBox.warning(self, "Warning", "Not connected")
            return
        preset = self.preset_cb.currentText()
        pp = self.pp_spin.value()
        self.setup_label.setText("Configuring...")
        self.setup_label.setStyleSheet("color:#ff9800;")
        QApplication.processEvents()
        ok, msg = setup_encoder(self.tmc, preset, pp)
        if ok:
            self.setup_label.setText(f"[OK] {msg}")
            self.setup_label.setStyleSheet("color:#4caf50;font-weight:bold;")
            self.enc_buf.clear()
            self.enc_time_buf.clear()
            self.t0 = time.time()
            self._poll_timer.start(10)
        else:
            self.setup_label.setText(f"[FAIL] {msg}")
            self.setup_label.setStyleSheet("color:#f44336;")

    def _stop(self):
        self._poll_timer.stop()
        try:
            self.tmc.write_register(0x381, 0)
        except:
            pass
        self.setup_label.setText("Stopped")

    def _poll(self):
        if not self.tmc.connected:
            return
        try:
            val = self.tmc.read_register(ENCODER_ANGLE_ADDR)
            if val is not None:
                raw = val & 0x00FFFFFF
                angle = raw & 0x3FFF
                deg = angle * 360.0 / 16384.0
                now = time.time() - self.t0
                self.enc_buf.append(deg)
                self.enc_time_buf.append(now)
                self.curve.setData(list(self.enc_time_buf), list(self.enc_buf))
                self.angle_label.setText(f"{deg:.2f} deg  (raw=0x{raw:06X})")
        except:
            pass

    def closeEvent(self, e):
        self._poll_timer.stop()
        self.tmc.disconnect()
        e.accept()


if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    pal = QPalette()
    pal.setColor(QPalette.Window, QColor(30, 30, 40))
    pal.setColor(QPalette.WindowText, QColor(200, 200, 200))
    pal.setColor(QPalette.Base, QColor(40, 40, 55))
    pal.setColor(QPalette.Text, QColor(200, 200, 200))
    pal.setColor(QPalette.Button, QColor(50, 50, 65))
    pal.setColor(QPalette.ButtonText, QColor(200, 200, 200))
    app.setPalette(pal)
    win = EncoderWindow()
    win.show()
    sys.exit(app.exec_())
