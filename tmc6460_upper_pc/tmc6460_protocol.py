"""
TMC6460 UART 通信协议模块
来源：G:/project/hand/Tesla_hand/tmc6460.pdf Page 31-40


- CRC 不校验(NORMAL_CRC_EN=0, RTMI_CRC_EN=0?- 写响应需 CH_7_EN=1 才发?
读请?(2 bytes):
  Byte 0: [sync:010][WnR:0][addr9:8]
  Byte 1: [addr7:0]

读响?(5 bytes, 手册?字节但实?字节):
  Byte 0: status (0xA1=芯片/ADC/反馈寄存? 0xA9=FOC/控制寄存? 0xB9=UART寄存?
  Byte 1-4: 32-bit data (big-endian)

写请?(6 bytes):
  Byte 0: [sync:010][WnR:1][addr9:8]
  Byte 1: [addr7:0]
  Byte 2-5: 32-bit data (big-endian)

写响?(4 bytes, 手册?字节但实?字节, 仅CH_7_EN=1时发?:
  Byte 0: write_count (递增计数?
  Byte 1-3: echo data (?字节)
"""

import struct
import time
import threading
import collections
import serial


def make_read_request(addr: int) -> bytes:
    """
    构造读请求 datagram (2 bytes, no CRC)
    来源: tmc6460.pdf Page 32, Figure 11
    
    Bit layout (byte 0, LSB first on wire):
      bit[2:0] = sync = 010b
      bit[3]   = WnR = 0 (read)
      bit[5:4] = addr[9:8] (bit4=addr[8], bit5=addr[9])
      bit[7:6] = sync = 10b (bit6=1, bit7=0)
    Byte 1: addr[7:0]
    
    验证: ?0x140 -> 0x52 0x40, ?0x14E -> byte0=0x5A, ?0x344 -> byte0=0x7A
    """
    if addr < 0 or addr > 0x3FF:
        raise ValueError(f"Address out of range: 0x{addr:X} (max 0x3FF)")
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    byte1 = addr & 0xFF
    return bytes([byte0, byte1])


def make_write_request(addr: int, data: int) -> bytes:
    """
    构造写请求 datagram (6 bytes, no CRC)
    来源: tmc6460.pdf Page 34, Figure 16
    
    Bit layout (byte 0, LSB first on wire):
      bit[2:0] = sync = 010b
      bit[3]   = WnR = 1 (write)
      bit[5:4] = addr[9:8]
      bit[7:6] = sync = 10b
    Byte 1: addr[7:0]
    Bytes 2-5: 32-bit data (little-endian, LSB first)
    
    验证: ?0x14E=0x01000100 -> 0x5A 0x4E 0x01 0x00 0x01 0x00
    验证: ?0x344=0x00010082 -> 0x7A 0x44 0x82 0x00 0x01 0x00
    ?0x01000100 验证对大? 0x00010082 验证对小??矛盾, 需上硬件确?    """
    if addr < 0 or addr > 0x3FF:
        raise ValueError(f"Address out of range: 0x{addr:X} (max 0x3FF)")
    byte0 = 0x4A | (((addr >> 8) & 0x03) << 4)
    byte1 = addr & 0xFF
    # big-endian data
    data_bytes = struct.pack('>I', data & 0xFFFFFFFF)
    return bytes([byte0, byte1]) + data_bytes


def parse_read_response(resp: bytes, expected_addr: int = -1) -> int | None:
    """See code"""




    if len(resp) < 6:
        return None
    data = struct.unpack('>I', resp[2:6])[0]
    return data


def parse_write_response(resp: bytes) -> tuple[int, int] | None:
    """See code"""




    if len(resp) < 4:
        return None
    status = resp[0]
    # echo data 只有?字节,补0作高字节
    data = (resp[1] << 16) | (resp[2] << 8) | resp[3]
    return status, data


def parse_rtmi_frame(data: bytes, check_crc: bool = True) -> tuple[int, int] | None:
    """Parse RTMI frame. With CRC: 6 bytes, without: 5 bytes."""












    # Frame size depends on CRC mode
    frame_size = 6 if check_crc else 5
    if len(data) < frame_size:
        return None
    byte0 = data[0]
    # 严格同步：bit0=1, bit7=0, ch<=6
    # 不预设 bits[6:4]，因为 CRC 模式会改变这些位
    if (byte0 & 0x01) != 1 or (byte0 & 0x80) != 0:
        return None
    channel_id = (byte0 >> 1) & 0x07
    if channel_id > 6:
        return None
    if check_crc:
        expected_crc = rtmi_crc8(data[:5])
        if data[5] != expected_crc:
            return None
    raw_data = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]
    return channel_id, raw_data


def detect_frame_type(data: bytes) -> str | None:
    """See code"""






    if len(data) < 2:
        return None
    byte0 = data[0]
    # RTMI frame: bit0=1, bit7=0, ch<=6
    if (byte0 & 0x01) == 1 and (byte0 & 0x80) == 0 and ((byte0 >> 1) & 0x07) <= 6:
        return 'rtmi'
    # 读响? status=0xA1/0xA9, 5字节
    if byte0 in (0xA1, 0xA9) and len(data) >= 5:
        return 'read_resp'
    # 写响? 4字节
    if len(data) >= 4:
        return 'write_resp'
    return None


# RTMI 配置常量 (来源: tmc6460.pdf Page 183-185)
RTMI_REGS = {
    'UART_CONTROL':     0x340,  # [31:24]=SAMPLING, [22]=RTMI_EN, [21]=CRC_EN, [20]=NORMAL_CRC
    'UART_RTMI_CH_0':   0x344,  # [16]=CH0_EN, [9:0]=CH0_ADDR
    'UART_RTMI_CH_BASE': 0x344,
    'BIT_RTMI_EN':      22,
    'BIT_RTMI_SAMPLING': 24,
    'BIT_CH_EN':        16,
    'CH_EN_MASK':       0x00010000,
    'CH_ADDR_MASK':     0x000003FF,
}


def build_rtmi_channel_config(ch_en: bool, register_addr: int) -> int:
    """Build RTMI channel config"""
    val = (register_addr & 0x3FF)
    if ch_en:
        val |= (1 << 16)
    return val


def build_rtmi_control(enable: bool, sampling: int, crc_en: bool = False) -> int:
    """Build UART.CONTROL RTMI config
    bit 22: RTMI_EN, bit 21: RTMI_CRC_EN, bit 20: NORMAL_CRC_EN
    bit 18: must keep (default hardware setting)
    """
    val = 0x00040000  # bit18 default, CRC off
    if enable:
        val |= (1 << 22)
    if crc_en:
        val |= (1 << 21)
    val |= ((sampling & 0xFF) << 24)
    return val


def rtmi_crc8(data: bytes) -> int:
    """CRC-8 for RTMI frame validation
    Poly=0x1D (CRC-8), init=0x00, refin=True, refout=False
    Source: calc_crc.py verified against TMC6460 datasheet
    """
    crc = 0x00
    for b in data:
        b = int(format(b, '08b')[::-1], 2)  # reflect byte
        crc ^= b
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0x1D) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc


class TMC6460Serial:
    """TMC6460 serial with RTMI"""

    def __init__(self, port: str = 'COM1', baudrate: int = 115200, timeout: float = 0.1):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.ser: serial.Serial | None = None
        self.lock = threading.Lock()
        self.connected = False
        
        # RTMI state
        self._rtmi_running = False
        self._rtmi_paused = False
        self._rtmi_thread = None
        self._rtmi_channels = {}  # ch_id -> register_addr
        self._rtmi_callbacks = []  # list of callable(ch_id, data)
        self._rtmi_sampling = 49
        self._rtmi_frame_size = 5  # 5 (no CRC) or 6 (with CRC)

    def connect(self) -> bool:
        try:
            self.ser = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=self.timeout
            )
            self.connected = True
            return True
        except Exception as e:
            print(f"Connection failed: {e}")
            self.connected = False
            return False

    def disconnect(self):
        # 先停 RTMI,防止线程残留和芯片继续发帧
        if self._rtmi_running:
            self.stop_rtmi()
        if self.ser and self.ser.is_open:
            self.ser.close()
        self.connected = False

    def read_register(self, addr: int) -> int | None:
        """Read register, return 32-bit value"""
        if self._rtmi_running:
            self._rtmi_paused = True
            time.sleep(0.003)
        with self.lock:
            if not self.ser or not self.ser.is_open:
                if self._rtmi_running:
                    self._rtmi_paused = False
                return None
            try:
                # 清掉 RTMI 残留数据
                self.ser.reset_input_buffer()
                time.sleep(0.001)
                self.ser.reset_input_buffer()
                req = make_read_request(addr)
                self.ser.write(req)
                resp = self.ser.read(6)
                if self._rtmi_running:
                    self._rtmi_paused = False
                if len(resp) < 6:
                    return None
                return parse_read_response(resp, addr)
            except Exception as e:
                if self._rtmi_running:
                    self._rtmi_paused = False
                print(f"Read error: {e}")
                return None

    def write_register(self, addr: int, data: int) -> bool:
        """Write register, returns success"""
        if self._rtmi_running:
            self._rtmi_paused = True
            time.sleep(0.003)  # 多等一点让 RTMI 线程完全停
        with self.lock:
            if not self.ser or not self.ser.is_open:
                if self._rtmi_running:
                    self._rtmi_paused = False
                return False
            try:
                # 清掉 RTMI 残留数据
                self.ser.reset_input_buffer()
                time.sleep(0.001)
                self.ser.reset_input_buffer()
                req = make_write_request(addr, data)
                self.ser.write(req)
                resp = self.ser.read(4)
                if self._rtmi_running:
                    self._rtmi_paused = False
                if len(resp) < 4:
                    return False
                result = parse_write_response(resp)
                return result is not None
            except Exception as e:
                if self._rtmi_running:
                    self._rtmi_paused = False
                print(f"Write error: {e}")
                return False

    def start_rtmi(self, channels: dict, sampling: int = 49,
                   callback: callable = None) -> bool:
        """Start RTMI monitoring
        
        Args:
            channels: {channel_id: register_addr} e.g. {0: 0x155, 1: 0x154, 2: 0x153}
            sampling: RTMI_SAMPLING (0-255), f_RTMI = f_PWM / (sampling+1)
            callback: optional callable(channel_id, data) for frame dispatch
        
        f_PWM=50kHz, sampling=49 -> f_RTMI=1kHz
        """
        self._rtmi_channels = dict(channels)
        self._rtmi_sampling = sampling
        self._rtmi_paused = False
        # Clear old callbacks
        self._rtmi_callbacks.clear()
        self._rtmi_callbacks.clear()
        if callback:
            self._rtmi_callbacks.append(callback)
        
        # Step 0: 重置 UART.CONTROL（清除残留的 CRC_EN / RTMI_EN）
        default_ctrl = 0x00040000  # bit18 default
        for attempt in range(5):
            if self.write_register(RTMI_REGS['UART_CONTROL'], default_ctrl):
                break
            time.sleep(0.05)
        time.sleep(0.1)  # 等芯片处理完重置

        # 在 RTMI 启动前读回 UART.CONTROL，确认 CRC 状态（此时无 RTMI 干扰）
        rb = self.read_register(RTMI_REGS['UART_CONTROL'])
        if rb is not None:
            crc_before = bool(rb & ((1 << 21) | (1 << 20)))
            print(f"RTMI: 重置后 UART.CONTROL=0x{rb:08X} CRC={'ON' if crc_before else 'OFF'}")
        else:
            print("RTMI: 重置后 UART.CONTROL 读回失败")

        # Step 1: 配置每个 RTMI 通道
        configured = []
        for ch_id, reg_addr in channels.items():
            if ch_id < 0 or ch_id > 7:
                continue
            reg = RTMI_REGS['UART_RTMI_CH_BASE'] + ch_id
            val = build_rtmi_channel_config(True, reg_addr)
            ok = self.write_register(reg, val)
            print(f"RTMI CH{ch_id} -> 0x{reg_addr:03X}: {'OK' if ok else 'FAIL'} (reg 0x{reg:03X}=0x{val:08X})")
            if not ok:
                return False
            configured.append(ch_id)
            time.sleep(0.01)  # 通道间延迟
        
        # Step 2: 使能 RTMI
        ctrl_val = build_rtmi_control(True, sampling)
        print(f"RTMI enable: UART.CONTROL = 0x{ctrl_val:08X} ({len(configured)} channels)")
        if not self.write_register(RTMI_REGS['UART_CONTROL'], ctrl_val):
            print("RTMI: Failed to write UART.CONTROL")
            return False
        
        # 帧大小：基于重置后的读回结果（Step 0 之后读的，此时无 RTMI 干扰）
        # 不在 RTMI 启动后读回，因为 RTMI 数据流会干扰 read_register
        if rb is not None:
            crc_enabled = bool(rb & ((1 << 21) | (1 << 20)))
            self._rtmi_frame_size = 6 if crc_enabled else 5
            print(f"RTMI: 帧大小={self._rtmi_frame_size} (基于重置后读回 CRC={'ON' if crc_enabled else 'OFF'})")
        else:
            self._rtmi_frame_size = 6  # 读回失败，默认6（安全侧）
            print(f"RTMI: 读回失败，默认帧大小=6")
        
        print("RTMI: Started OK")
        
        # Step 3: 启动接收线程
        self._rtmi_running = True
        self._rtmi_thread = threading.Thread(target=self._rtmi_loop, daemon=True)
        self._rtmi_thread.start()
        return True
    
    def stop_rtmi(self):
        """Stop RTMI"""
        # Step 1: 禁用芯片?RTMI_EN(此时_rtmi_running 仍为 True,write 会暂停线程)
        if self.connected:
            self.write_register(RTMI_REGS['UART_CONTROL'],
                              build_rtmi_control(False, 0))
        # Step 2: 停止接收线程
        self._rtmi_running = False
        self._rtmi_paused = False
    
    def add_rtmi_callback(self, callback: callable):
        """Add RTMI callback"""
        self._rtmi_callbacks.append(callback)
    
    @property
    def rtmi_running(self):
        return self._rtmi_running
    
    def _rtmi_loop(self):
        """RTMI receiver loop"""
        buf = b''
        skipped_since_sync = 0
        MAX_SKIP = 128
        frame_size = self._rtmi_frame_size  # 由 start_rtmi 设置
        while self._rtmi_running and self.ser and self.ser.is_open:
            try:
                if self._rtmi_paused:
                    time.sleep(0.0001)
                    continue
                
                with self.lock:
                    if self.ser and self.ser.is_open and self.ser.in_waiting > 0:
                        chunk = self.ser.read(min(self.ser.in_waiting, 256))
                    else:
                        chunk = b''

                if chunk:
                    buf += chunk

                while len(buf) >= frame_size:
                    byte0 = buf[0]
                    if (byte0 & 0x01) == 1 and (byte0 & 0x80) == 0:
                        ch = (byte0 >> 1) & 0x07
                        if ch > 6:
                            buf = buf[1:]
                            skipped_since_sync += 1
                            continue
                        frame = buf[:frame_size]
                        # RAW DEBUG: 打印原始帧字节
                        hex_str = ' '.join(f'{b:02X}' for b in frame)
                        print(f'[RTMI-RAW] {hex_str}')
                        use_crc = (frame_size == 6)
                        result = parse_rtmi_frame(frame, check_crc=use_crc)
                        if result:
                            ch_id, data = result
                            for cb in self._rtmi_callbacks:
                                try:
                                    cb(ch_id, data)
                                except Exception:
                                    pass
                        buf = buf[frame_size:]
                        skipped_since_sync = 0
                    else:
                        buf = buf[1:]
                        skipped_since_sync += 1
                        if skipped_since_sync > MAX_SKIP:
                            resync = None
                            for i in range(min(len(buf), 256)):
                                b = buf[i]
                                if (b & 0x01) == 1 and (b & 0x80) == 0 and ((b >> 1) & 0x07) <= 6:
                                    resync = i
                                    break
                            if resync is not None and resync > 0:
                                buf = buf[resync:]
                            skipped_since_sync = 0

                if not chunk:
                    time.sleep(0.001)

            except Exception as e:
                print(f"RTMI receiver error: {e}")
                time.sleep(0.01)
    
    def read_register_raw(self, addr: int) -> tuple[bytes, bytes] | None:
        """Read register, return raw (request, response) bytes"""
        if self._rtmi_running:
            self._rtmi_paused = True
            time.sleep(0.002)
        with self.lock:
            if not self.ser or not self.ser.is_open:
                if self._rtmi_running:
                    self._rtmi_paused = False
                return None
            try:
                self.ser.reset_input_buffer()
                req = make_read_request(addr)
                self.ser.write(req)
                resp = self.ser.read(6)  # 5字节: [status][D3:D0]
                if self._rtmi_running:
                    self._rtmi_paused = False
                return req, resp
            except Exception as e:
                if self._rtmi_running:
                    self._rtmi_paused = False
                print(f"Read error: {e}")
                return None


# TMC6460 寄存器地址定义 (来源: tmc6460.pdf Register Map)
# 格式: (地址, 名称, 描述, 字段列表)
TMC6460_REGISTERS = {
    # --- CHIP ---
    0x000: ("CHIP.VERSION", "芯片版本", [        ("VERSION", "芯片版本"),
    ]),
    0x001: ("CHIP.IO_CONFIG", "IO 配置", [        ("ANA_DIV_VCCIO", "VCCIO 模拟分压"),
        ("ANA_DIV_VCCIOF", "VCCIOF 模拟分压"),
        ("ENC_FLT", "enc_filter"),
        ("HALL_FLT", "hall_filter"),
        ("REF_FLT", "ref_filter"),
    ]),
    0x002: ("CHIP.IO_MATRIX", "IO 矩阵 (引脚复用)", [        ("PIN_ENC_A", "ENC_A 引脚功能"),
        ("PIN_ENC_B", "ENC_B 引脚功能"),
        ("PIN_ENC_N", "ENC_N 引脚功能"),
        ("PIN_HALL_U", "HALL_U 引脚功能"),
        ("PIN_HALL_V", "HALL_V 引脚功能"),
        ("PIN_HALL_W", "HALL_W 引脚功能"),
    ]),
    0x003: ("CHIP.IO_PU_PD", "pull_config", []),
    0x004: ("CHIP.INPUTS_RAW", "原始输入状", []),
    0x005: ("CHIP.OUTPUTS_RAW", "原始输出状", []),
    0x006: ("CHIP.STATUS_FLAGS", "状态标", [        ("UART_FAIL_STATUS", "UART 故障状"),
        ("SPI_FAIL_STATUS", "SPI 故障状"),
        ("DRV_STATUS", "驱动状"),
    ]),
    0x007: ("CHIP.EVENTS", "事件标志", []),
    0x008: ("CHIP.SAFETY", "安全配置", []),
    0x009: ("CHIP.IO_CTRL", "IO 控制", []),

    # --- UART (0x340-0x34B, 来源: tmc6460.pdf Page 183-185) ---
    0x340: ("UART.CONTROL", "UART 控制", [        ("AUTOBAUD_EN", "自动波特率使"),
        ("NORMAL_CRC_EN", "普?CRC 使能"),
        ("RTMI_CRC_EN", "RTMI_CRC_EN"),
        ("RTMI_EN", "RTMI 总开"),
        ("RX_FILTER_EN", "RX_FILTER_EN"),
        ("TIMEOUT_PRE_DIVIDER_EN", "超时预分频使"),
        ("MANTISSA_LIMIT", "波特率分频"),
        ("RTMI_SAMPLING", "RTMI 降采"),
    ]),
    0x341: ("UART.STATUS", "UART 状", []),
    0x342: ("UART.EVENTS", "UART 事件", [        ("UART_SYNC_FAIL_EVENT", "同步失败"),
        ("RX_IDLE_TIMEOUT_EVENT", "接收超时"),
        ("INVALID_START_BIT_EVENT", "无效起始"),
        ("INVALID_STOP_BIT_EVENT", "无效停止"),
        ("INVALID_CRC_BIT_EVENT", "CRC 错误"),
        ("NOISY_DATA_EVENT", "噪声数据"),
        ("RTMI_INTERRUPT_EVENT", "RTMI 中断"),
    ]),
    0x343: ("UART.TIMEOUT", "UART 超时", [        ("LIMIT", "超时限制"),
    ]),
    0x344: ("UART.RTMI_CH_0", "RTMI 通道 0", [        ("CH_0_EN", "通道 0 使能"),
        ("CH_0_ADDR", "通道 0 映射地址"),
    ]),
    0x345: ("UART.RTMI_CH_1", "RTMI 通道 1", [        ("CH_1_EN", "通道 1 使能"),
        ("CH_1_ADDR", "通道 1 映射地址"),
    ]),
    0x346: ("UART.RTMI_CH_2", "RTMI 通道 2", []),
    0x347: ("UART.RTMI_CH_3", "RTMI 通道 3", []),
    0x348: ("UART.RTMI_CH_4", "RTMI 通道 4", []),
    0x349: ("UART.RTMI_CH_5", "RTMI 通道 5", []),
    0x34A: ("UART.RTMI_CH_6", "RTMI 通道 6", []),
    0x34B: ("UART.RTMI_CH_7", "RTMI ch7", [
        ("CH_7_EN", "ch7_en"),
        ("CH_7_ADDR", "ch7_addr"),
    ]),

    # --- DEPRECATED: ?UART 地址 (0x030-0x03B) 已移?0x340-0x34B ---
    # 这些旧键保留以防?KeyError,但指向错误地址；请使用 0x340+ 条目

    # --- ADC ---
    0x040: ("ADC.I_RAW", "ADC 原始电流", []),
    0x041: ("ADC.I0_RAW", "ADC I0 原始", []),
    0x042: ("ADC.I1_RAW", "ADC I1 原始", []),
    0x043: ("ADC.I2_RAW", "ADC I2 原始", []),
    0x044: ("ADC.I0_I1_RAW", "ADC I0+I1 原始", []),
    0x045: ("ADC.I2_I1_RAW", "ADC I2+I1 原始", []),
    0x046: ("ADC.AIN_RAW", "ADC 模拟输入原始", []),
    0x047: ("ADC.VSUPPLY_RAW", "ADC 电源电压原始", []),
    0x048: ("ADC.TEMP_RAW", "ADC 温度原始", []),

    # --- FOC ---
    0x080: ("FOC.STATUS", "FOC 状", []),
    0x081: ("FOC.EVENTS", "FOC 事件", []),
    0x082: ("FOC.DRV_STATUS", "驱动状", []),
    0x083: ("FOC.PWM_SWITCHING", "PWM 开关配", []),
    0x084: ("FOC.PWM_SV", "SVPWM 配置", []),
    0x085: ("FOC.PWM_MAXCNT", "PWM 最大计", []),
    0x086: ("FOC.PWM_DEADTIME", "PWM 死区时间", []),
    0x087: ("FOC.PWM_POLARITY", "PWM 极", []),

    # --- FOC 控制 (0x100-0x109) ---
    0x100: ("MCC_CONFIG.MOTOR_MOTION", "电机/运动模式", [        ("MOTION_MODE", "运动模式 (0=力矩,1=速度,2=位置,4=开环速度,...)"),
        ("N_POLE_PAIRS", "电机极对"),
    ]),
    0x101: ("MCC_CONFIG.GDRV", "栅极驱动配置", []),
    0x102: ("MCC_CONFIG.PWM", "PWM 配置", []),
    0x105: ("MCC_CONFIG.MCC_STATUS", "MCC 状", []),

    # --- FOC PID 系数 (0x140-0x149) ---
    0x140: ("FOC.PID_CONFIG", "PID 配置", [        ("OVERWRITE_TARGET", "目标覆盖使能"),
        ("KEEP_POS_TARGET", "保持位置目标"),
    ]),
    0x141: ("FOC.PID_U_S_MAX", "电压控制器最大", []),
    0x142: ("FOC.PID_FLUX_COEFF", "磁?PID 系数", []),
    0x143: ("FOC.PID_TORQUE_COEFF", "力矩 PID 系数", []),
    0x144: ("FOC.PID_FIELDWEAK_COEFF", "弱磁 PID 系数", []),
    0x145: ("FOC.PID_VELOCITY_COEFF", "速度 PID 系数", []),
    0x146: ("FOC.PID_POSITION_COEFF", "位置 PID 系数", []),
    0x147: ("FOC.PID_POSITION_TOLERANCE", "位置容差", []),
    0x148: ("FOC.PID_POSITION_TOLERANCE_DELAY", "位置容差延迟", []),
    0x149: ("FOC.PID_UQ_UD_LIMITS", "电压控制器限", []),

    # --- FOC PID 限制/目标 (0x14A-0x152) ---
    0x14A: ("FOC.PID_TORQUE_FLUX_LIMITS", "力矩/磁通限", [        ("PID_TORQUE_LIMIT", "力矩限制"),
        ("PID_FLUX_LIMIT", "磁通限"),
    ]),
    0x14B: ("FOC.PID_VELOCITY_LIMIT", "速度限制", []),
    0x14C: ("FOC.PID_POSITION_LIMIT_LOW", "位置下限", []),
    0x14D: ("FOC.PID_POSITION_LIMIT_HIGH", "位置上限", []),
    0x14E: ("FOC.PID_TORQUE_FLUX_TARGET", "力矩/磁通目", [        ("PID_TORQUE_TARGET", "力矩目标 [31:16]"),
        ("PID_FLUX_TARGET", "磁通目?[15:0]"),
    ]),
    0x14F: ("FOC.PID_TORQUE_FLUX_OFFSET", "力矩/磁通偏", []),
    0x150: ("FOC.PID_VELOCITY_TARGET", "速度目标值", []),
    0x151: ("FOC.PID_VELOCITY_OFFSET", "速度偏移", []),
    0x152: ("FOC.PID_POSITION_TARGET", "位置目标值", []),

    # --- FOC PID 实际?(0x153-0x160) ---
    0x153: ("FOC.PID_TORQUE_FLUX_ACTUAL", "力矩/磁通实际", [        ("PID_TORQUE_ACTUAL", "力矩实际?[31:16]"),
        ("PID_FLUX_ACTUAL", "磁通实际?[15:0]"),
    ]),
    0x154: ("FOC.PID_VELOCITY_ACTUAL", "速度实际", []),
    0x155: ("FOC.PID_POSITION_ACTUAL", "位置实际", []),
    0x156: ("FOC.PID_POSITION_ACTUAL_OFFSET", "位置实际偏移", []),
    0x157: ("FOC.PID_TORQUE_ERROR", "力矩误差", []),
    0x158: ("FOC.PID_FLUX_ERROR", "磁通误", []),
    0x159: ("FOC.PID_VELOCITY_ERROR", "速度误差", []),
    0x15A: ("FOC.PID_VELOCITY_ERROR_MAX", "速度误差最大", []),
    0x15B: ("FOC.PID_POSITION_ERROR", "位置误差", []),
    0x15C: ("FOC.PID_POSITION_ERROR_MAX", "位置误差最大", []),
    0x15D: ("FOC.PID_TORQUE_INTEGRATOR", "力矩积分", []),
    0x15E: ("FOC.PID_FLUX_INTEGRATOR", "磁通积分器", []),
    0x15F: ("FOC.PID_VELOCITY_INTEGRATOR", "速度积分", []),
    0x160: ("FOC.PID_POSITION_INTEGRATOR", "位置积分", []),

    # --- PRBS ---
    0x174: ("FOC.PRBS_AMPLITUDE", "PRBS 幅度", []),
    0x175: ("FOC.PRBS_DOWN_SAMPLING_RATIO", "PRBS 降采样率", []),

    # --- BIQUAD 滤波?(0x180-0x18A) ---
    0x180: ("BIQUAD.BIQUAD_EN", "BIQUAD 使能", []),
    0x181: ("BIQUAD.VELOCITY_A1", "速度滤波?A1", []),
    0x182: ("BIQUAD.VELOCITY_A2", "速度滤波?A2", []),
    0x183: ("BIQUAD.VELOCITY_B0", "速度滤波?B0", []),
    0x184: ("BIQUAD.VELOCITY_B1", "速度滤波?B1", []),
    0x185: ("BIQUAD.VELOCITY_B2", "速度滤波?B2", []),
    0x186: ("BIQUAD.TORQUE_A1", "力矩滤波?A1", []),
    0x187: ("BIQUAD.TORQUE_A2", "力矩滤波?A2", []),
    0x188: ("BIQUAD.TORQUE_B0", "力矩滤波?B0", []),
    0x189: ("BIQUAD.TORQUE_B1", "力矩滤波?B1", []),
    0x18A: ("BIQUAD.TORQUE_B2", "力矩滤波?B2", []),

    # --- RAMPER (0x1C0-0x1D5) ---
    0x1C0: ("RAMPER.TIME_CONFIG", "斜坡时间配置", []),
    0x1C1: ("RAMPER.SWITCH_MODE", "参考开关模", []),
    0x1C3: ("RAMPER.PHI_E", "电角", []),
    0x1C4: ("RAMPER.A1", "加速度 A1", []),
    0x1C5: ("RAMPER.A2", "加速度 A2", []),
    0x1C6: ("RAMPER.A_MAX", "最大加速度", []),
    0x1C7: ("RAMPER.D1", "减速度 D1", []),
    0x1C8: ("RAMPER.D2", "减速度 D2", []),
    0x1CF: ("RAMPER.ACCELERATION", "当前加速度", []),
    0x1D0: ("RAMPER.V_ACTUAL", "当前速度", []),
    0x1D1: ("RAMPER.POSITION", "当前位置", []),
    0x1D2: ("RAMPER.POSITION_LATCH", "位置锁存", []),
    0x1D4: ("RAMPER.STATUS", "斜坡状", []),
    0x1D5: ("RAMPER.EVENTS", "斜坡事件", []),

    # --- 编码?---
    0x200: ("ENC.CONFIG", "编码器配", []),
    0x201: ("ENC.STATUS", "编码器状", []),
    0x202: ("ENC.POSITION", "编码器位", []),
    0x203: ("ENC.VELOCITY", "编码器速度", []),
    0x204: ("ENC.RESOLUTION", "编码器分辨率", []),

    # --- Ramp ---
    0x210: ("RAMP.MODE", "斜坡模式", []),
    0x211: ("RAMP.VELOCITY_MAX", "最大速度", []),
    0x212: ("RAMP.ACCELERATION_MAX", "最大加速度", []),
    0x213: ("RAMP.DECELERATION_MAX", "最大减速度", []),
    0x214: ("RAMP.POSITION", "斜坡位置", []),
    0x215: ("RAMP.VELOCITY", "斜坡速度", []),
    0x216: ("RAMP.TARGET_POSITION", "目标位置", []),
    0x217: ("RAMP.TARGET_VELOCITY", "目标速度", []),

    # --- I/O Controller ---
    0x300: ("IO_CTRL.CONFIG0", "IO 控制器配?0", []),
    0x301: ("IO_CTRL.CONFIG1", "IO 控制器配?1", []),
    0x302: ("IO_CTRL.STATUS", "IO 控制器状", []),
    0x303: ("IO_CTRL.INPUT", "IO 控制器输", []),
    0x304: ("IO_CTRL.OUTPUT", "IO 控制器输", []),
    0x305: ("IO_CTRL.DIRECT_OUT", "直接输出", []),
    0x306: ("IO_CTRL.DIRECT_IN", "直接输入", []),
    0x307: ("IO_CTRL.RESPONSE_0", "IO 控制器响?0", []),
    0x308: ("IO_CTRL.RESPONSE_1", "IO 控制器响?1", []),
    0x309: ("IO_CTRL.RESPONSE_2", "IO 控制器响?2 (SSI 掩码)", []),
    0x30A: ("IO_CTRL.RESPONSE_3", "IO 控制器响?3", []),

    # --- Feedback ---
    0x060: ("FEEDBACK.PHI_EXT_A", "外部角度 A", []),
    0x061: ("FEEDBACK.PHI_EXT_B", "外部角度 B", []),
    0x062: ("FEEDBACK.PHI_E_OFFSET", "电角度偏", []),
    0x063: ("FEEDBACK.PHI_E", "电角", []),
    0x064: ("FEEDBACK.PHI_E_FOC", "FOC 电角", []),
    0x065: ("FEEDBACK.OUTPUT_CONF", "反馈输出配置", []),
    0x066: ("FEEDBACK.ENCODER_CONF", "编码器配", []),
}

# SSI 编码?IO 矩阵配置
# 来源: tmc6460.pdf Page 44, 108-111 (Table 53, 54)
#
# SSI 编码器需?3 个信?

#   SCK (时钟) -> DIRECT_OUT[0]
#   SDO (数据) -> DIRECT_IN[0]
#
# 引脚映射 (CHIP.IO_MATRIX):
#   ENC_A (Pin 14) -> 可? DIRECT_OUT[1] ?DIRECT_IN[0]
#   ENC_B (Pin 15) -> 可? DIRECT_IN[0]
#   ENC_N (Pin 16) -> 可? DIRECT_OUT[0]
#   HALL_W (Pin 19) -> 可? DIRECT_OUT[2]
#
# 典型 SSI 配置 (ENC_A=数据, ENC_B=未用, ENC_N=时钟, HALL_W=片?:
#   PIN_ENC_A = 00b (默认, 保留给反馈引?
#   PIN_ENC_B = 00b (默认)
#   PIN_ENC_N = 00b (默认)
#   PIN_HALL_W = 100b (Alt.Func 4 = DIRECT_OUT[2])
#   实际接线: ENC_A -> SSI DO, ENC_N -> SSI CLK, HALL_W -> SSI CSN
#
# 或者用 I/O Controller 默认映射:
#   DIRECT_OUT[0] = ENC_N (SSI CLK)
#   DIRECT_OUT[2] = HALL_W (SSI CSN)
#   DIRECT_IN[0] = ENC_B (SSI DO)
#   此时接线: ENC_B -> SSI DO, ENC_N -> SSI CLK, HALL_W -> SSI CSN

# SPI_ENC 命令参数
# 来源: tmc6460.pdf Page 108-111
#
# IO_CONTROLLER.COMMAND = 0x00SS0000 | (SPI_ENC_OPCODE)
#   SS = SPI settings:
#     bit[7] = u[7]: pin mapping (0=Table54 option 0, 1=option 1)
#     bit[6:4] = SPI mode (000=mode0, 011=mode3)
#     bit[3:0] = SPI_BIT_CNT (number of bits per transfer)
#
# IO_CONTROLLER.RESPONSE_2 = bit mask for extracting angle data
#
# 连续读取: IO_CONTROLLER.COMMAND = 0x00SS0000 | SPI_ENC (repeated)
# 停止: IO_CONTROLLER.COMMAND = 0x00000000

SSI_PRESETS = {
    "MT6701 (SSI, 14-bit)": {
        "description": "MT6701 SSI, 14-bit, bench verified",
        "spi_bus_mode": 1,  # CPOL=0, CPHA=1
        "spi_frequency_hz": 2_000_000,
        "spi_bits": 14,
        "spi_data_mask": 0x00003FFF,
        "spi_send_data": 0x00000000,
        "spi_idle_time": 16,
        "encoder_steps": 16384,
        "phi_e_offset": 48000,
    },
    "MT6701 (SSI, 24-bit)": {
        "description": "MT6701 SSI, 24-bit complete frame",
        "spi_bus_mode": 1,
        "spi_frequency_hz": 2_000_000,
        "spi_bits": 24,
        "spi_data_mask": 0x00FFFFFF,
        "spi_send_data": 0x00000000,
        "spi_idle_time": 48,
        "encoder_steps": 16384,
        "phi_e_offset": 48000,
    },
    "AS5047 (SPI)": {
        "description": "AS5047 SPI, 14-bit",
        "spi_bus_mode": 1,
        "spi_frequency_hz": 3_000_000,
        "spi_bits": 14,
        "spi_data_mask": 0x00003FFF,
        "spi_send_data": 0xFFFFFFFF,
        "spi_idle_time": 16,
        "encoder_steps": 16384,
        "phi_e_offset": 0,
    },
}

# 常用寄存器分组
REGISTER_GROUPS = [
    ("CHIP (芯片)", [0x000, 0x001, 0x002, 0x004, 0x005, 0x006, 0x007, 0x008, 0x009]),
    ("UART (通信)", [0x340, 0x341, 0x342, 0x343, 0x344, 0x345, 0x346, 0x347, 0x348, 0x349, 0x34A, 0x34B]),
    ("ADC (采样)", [0x040, 0x041, 0x042, 0x043, 0x044, 0x045, 0x046, 0x047, 0x048]),
    ("FOC 状", [0x080, 0x081, 0x082, 0x083, 0x084, 0x085, 0x086, 0x087]),
    ("FOC 模式/控制", [0x100, 0x101, 0x102, 0x105]),
    ("FOC PID 系数", [0x140, 0x141, 0x142, 0x143, 0x144, 0x145, 0x146, 0x147, 0x148, 0x149]),
    ("FOC PID 限制/目标", [0x14A, 0x14B, 0x14C, 0x14D, 0x14E, 0x14F, 0x150, 0x151, 0x152]),
    ("FOC PID 实际", [0x153, 0x154, 0x155, 0x156, 0x157, 0x158, 0x159, 0x15A, 0x15B, 0x15C, 0x15D, 0x15E, 0x15F, 0x160]),
    ("PRBS", [0x174, 0x175]),
    ("BIQUAD 滤波", [0x180, 0x181, 0x182, 0x183, 0x184, 0x185, 0x186, 0x187, 0x188, 0x189, 0x18A]),
    ("斜坡发生", [0x1C0, 0x1C1, 0x1C3, 0x1C4, 0x1C5, 0x1C6, 0x1C7, 0x1C8, 0x1CF, 0x1D0, 0x1D1, 0x1D4, 0x1D5]),
    ("编码", [0x200, 0x201, 0x202, 0x203, 0x204]),
]

# 波形监控默认通道(RTMI 映射的常用寄存器?# 地址来源: tmc6460.pdf Register Detail Pages 153-157
WAVEFORM_CHANNELS = [
    # RTMI CH 0-2: 默认监控核心三通道
    ("FOC.PID_TORQUE_FLUX_ACTUAL", 0x153, "力矩/磁通实际"),
    ("FOC.PID_VELOCITY_ACTUAL", 0x154, "速度实际"),
    ("FOC.PID_POSITION_ACTUAL", 0x155, "位置实际"),
    # RTMI CH 3-6: 扩展通道
    ("FOC.PID_TORQUE_FLUX_TARGET", 0x14E, "力矩/磁通目标"),
    ("FOC.PID_VELOCITY_TARGET", 0x150, "速度目标"),
    ("FOC.PID_POSITION_TARGET", 0x152, "位置目标"),
    ("ADC.I0_I1_RAW", 0x044, "ADC current (I0+I1)"),
    # RTMI CH 7: 编码器 (地址 0x24D, QTimer 轮询而非 RTMI)
    ("FEEDBACK.PHI_EXT_A", 0x24D, "编码器角度"),
]


# ==================== I2C EEPROM ====================
# IO_CONTROLLER register addresses (source: tmc6460.pdf Page 186)
IO_CONTROLLER_CONTROL   = 0x380
IO_CONTROLLER_COMMAND   = 0x381
IO_CONTROLLER_RESPONSE0 = 0x382
IO_CONTROLLER_RESPONSE1 = 0x383
IO_CONTROLLER_RESPONSE2 = 0x384
IO_CONTROLLER_RESPONSE3 = 0x385

# M24C02 I2C address (7-bit = 0x50, with R/W bit: W=0xA0, R=0xA1)
EEPROM_I2C_ADDR_W = 0xA0
EEPROM_I2C_ADDR_R = 0xA1
EEPROM_SIZE = 256  # bytes
EEPROM_PAGE_SIZE = 8

# I2C baud rate: fSYS=60MHz, 100kHz -> yyyy = 60M/4/100k - 1 = 149 = 0x95
I2C_BAUD_100K = 0x0095

# EEPROM data layout: [magic(2) + version(1) + count(1) + entries...]
# Each entry: [addr_hi(1) + addr_lo(1) + data(4)] = 6 bytes
EEPROM_MAGIC = 0x544D  # "TM"
EEPROM_VERSION = 0x01
EEPROM_HEADER_SIZE = 4  # magic(2) + version(1) + count(1)
EEPROM_ENTRY_SIZE = 6   # addr(2) + data(4)

# Configuration registers to save to EEPROM
# (register_addr, name) - only RW config registers, not status/target/actual
EEPROM_CONFIG_REGS = [
    # CHIP
    (0x008, "CHIP.IO_CONFIG"),
    (0x006, "CHIP.IO_MATRIX"),
    # FOC mode
    (0x100, "FOC.MOTOR_CONFIG"),
    (0x101, "FOC.MOTOR_MOTION"),
    # PID coefficients
    (0x140, "FOC.PID_CONFIG"),
    (0x141, "FOC.PID_TORQUE_COEFF"),
    (0x142, "FOC.PID_FLUX_COEFF"),
    (0x143, "FOC.PID_VELOCITY_COEFF"),
    (0x144, "FOC.PID_VELOCITY_I_COEFF"),
    (0x145, "FOC.PID_VELOCITY_COEFF_2"),
    (0x146, "FOC.PID_POSITION_COEFF"),
    # PID limits
    (0x14A, "FOC.PID_TORQUE_FLUX_LIMITS"),
    (0x14B, "FOC.PID_VELOCITY_LIMIT"),
    (0x14C, "FOC.PID_POSITION_LIMIT_LOW"),
    (0x14D, "FOC.PID_POSITION_LIMIT_HIGH"),
    # Ramp
    (0x1C0, "RAMPER.RAMP_AMAX"),
    (0x1C1, "RAMPER.RAMP_VMAX"),
    (0x1C3, "RAMPER.RAMP_VSTART"),
    (0x1C4, "RAMPER.RAMP_VSTOP"),
    (0x1C5, "RAMPER.RAMP_DMAX"),
    (0x1C6, "RAMPER.RAMP_V1"),
    (0x1C7, "RAMPER.D1"),
    (0x1C8, "RAMPER.VMAX"),
    # Encoder
    (0x200, "FEEDBACK.PHI_0"),
    (0x201, "FEEDBACK.PHI_1"),
    (0x204, "FEEDBACK.PHI_E_OFFSET"),
    # Biquad filters
    (0x180, "BIQUAD.X1"),
    (0x181, "BIQUAD.X2"),
    (0x182, "BIQUAD.Y1"),
    (0x183, "BIQUAD.Y2"),
    (0x184, "BIQUAD.B0"),
    (0x185, "BIQUAD.B1"),
    (0x186, "BIQUAD.B2"),
    (0x187, "BIQUAD.A1"),
    (0x188, "BIQUAD.A2"),
]


def eeprom_i2c_init(tmc: 'TMC6460Serial') -> bool:
    """Initialize I2C interface on TMC6460 (push-pull mode, 100kHz)"""
    # 1. Configure HALL pins for I2C
    io_val = tmc.read_register(0x006)
    if io_val is None:
        return False
    hall_mask = (0x7 << 9) | (0x7 << 6)
    hall_val = (3 << 9) | (3 << 6)
    new_io = (io_val & ~hall_mask) | hall_val
    if not tmc.write_register(0x006, new_io):
        return False
    time.sleep(0.01)
    
    # 2. Reset IO Controller once
    tmc.write_register(IO_CONTROLLER_CONTROL, 0x00000001)
    time.sleep(0.03)
    tmc.write_register(IO_CONTROLLER_CONTROL, 0x00000000)
    time.sleep(0.2)
    
    # 3. Init I2C
    cmd = 0xAA010000 | I2C_BAUD_100K
    if not _io_cmd(tmc, cmd, timeout=0.2):
        return False
    
    # 4. Test: I2C_EEPROM read + RAM_READ
    print("[EEPROM] Testing I2C_EEPROM + RAM_READ...")
    if not _io_cmd(tmc, 0xAA030000, timeout=0.5):
        print("[EEPROM] I2C_EEPROM failed")
        return False
    # Read RAM[0]
    if not _io_cmd(tmc, 0xC0000000, timeout=0.2):
        print("[EEPROM] RAM_READ[0] failed")
        return False
    resp1 = tmc.read_register(IO_CONTROLLER_RESPONSE1)
    print(f"[EEPROM] RAM[0] = 0x{resp1:04X}" if resp1 is not None else "[EEPROM] RAM[0] read failed")
    # Read RAM[1]
    if not _io_cmd(tmc, 0xC0010000, timeout=0.2):
        print("[EEPROM] RAM_READ[1] failed")
        return False
    resp1 = tmc.read_register(IO_CONTROLLER_RESPONSE1)
    print(f"[EEPROM] RAM[1] = 0x{resp1:04X}" if resp1 is not None else "[EEPROM] RAM[1] read failed")
    
    return True


def _io_cmd(tmc, cmd, timeout=0.5):
    """Send IO Controller command and wait for RESPONSE_0 == cmd.
    
    Strategy: Write RESPONSE_0=0 first, then write COMMAND=cmd.
    Since cmd != 0, this guarantees COMMAND != RESPONSE_0, triggering execution.
    No reset between commands (reset causes startup sequence that overwrites RESPONSE_0).
    """
    # Ensure RESPONSE_0 != cmd by writing 0x00000000
    tmc.write_register(IO_CONTROLLER_RESPONSE0, 0x00000000)
    time.sleep(0.005)
    
    # Send the command
    if not tmc.write_register(IO_CONTROLLER_COMMAND, cmd):
        return False
    
    # Poll RESPONSE_0 until it matches (command completed)
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp0 = tmc.read_register(IO_CONTROLLER_RESPONSE0)
        if resp0 == cmd:
            return True
        time.sleep(0.01)
    resp0 = tmc.read_register(IO_CONTROLLER_RESPONSE0)
    print(f"[EEPROM] _io_cmd 0x{cmd:08X}: timeout, RESP0=0x{resp0:08X}" if resp0 is not None else f"[EEPROM] _io_cmd 0x{cmd:08X}: timeout, RESP0=None")
    return False


def eeprom_write_byte(tmc: 'TMC6460Serial', mem_addr: int, data: int) -> bool:
    """Write one byte to M24C02 EEPROM via I2C_WRITE command
    
    I2C_WRITE: 0xEyyyzzzz
    zzzz is sent on I2C bus. Try both byte orders:
      big-endian:    zzzz = (mem_addr << 8) | data  -> sends [mem_addr, data]
      little-endian: zzzz = (data << 8) | mem_addr  -> sends [data, mem_addr]
    """
    i2c_addr = EEPROM_I2C_ADDR_W  # 0xA0
    # Try little-endian: data in high byte, mem_addr in low byte
    data16 = ((data & 0xFF) << 8) | (mem_addr & 0xFF)
    cmd = 0xE0000000 | ((i2c_addr & 0xFFF) << 16) | (data16 & 0xFFFF)
    if not _io_cmd(tmc, cmd, timeout=0.1):
        return False
    time.sleep(0.01)  # M24C02 write cycle
    return True


def eeprom_read_byte(tmc: 'TMC6460Serial', mem_addr: int) -> int | None:
    """Read one byte from M24C02 EEPROM via I2C_READ command"""
    # Step 1: Set memory address via dummy write
    # Use little-endian: data=0 in high byte, mem_addr in low byte
    cmd_set = 0xE0000000 | ((EEPROM_I2C_ADDR_W & 0xFFF) << 16) | ((mem_addr & 0xFF) << 0)
    if not _io_cmd(tmc, cmd_set, timeout=0.1):
        return None
    # Step 2: Read
    cmd_read = 0xD0000000 | ((EEPROM_I2C_ADDR_R & 0xFFF) << 16)
    if not _io_cmd(tmc, cmd_read, timeout=0.1):
        return None
    resp1 = tmc.read_register(IO_CONTROLLER_RESPONSE1)
    if resp1 is None:
        return None
    return resp1 & 0xFF


def eeprom_save_config(tmc: 'TMC6460Serial') -> tuple[bool, str]:
    """Save current TMC6460 configuration to M24C02 EEPROM.
    
    Data format:
      [0x00] magic: 2 bytes (0x544D = "TM")
      [0x02] version: 1 byte
      [0x03] count: 1 byte (number of register entries)
      [0x04+] entries: each 6 bytes = [addr_hi, addr_lo, data_b3, data_b2, data_b1, data_b0]
    
    Returns: (success, message)
    """
    # Read current config from chip
    config_data = []
    for reg_addr, reg_name in EEPROM_CONFIG_REGS:
        val = tmc.read_register(reg_addr)
        if val is None:
            return False, f"读取 {reg_name}(0x{reg_addr:03X}) 失败"
        config_data.append((reg_addr, val))
    
    # Build EEPROM image
    image = bytearray(EEPROM_SIZE)
    image[0] = (EEPROM_MAGIC >> 8) & 0xFF
    image[1] = EEPROM_MAGIC & 0xFF
    image[2] = EEPROM_VERSION
    image[3] = len(config_data)
    
    offset = EEPROM_HEADER_SIZE
    for addr, val in config_data:
        if offset + EEPROM_ENTRY_SIZE > EEPROM_SIZE:
            return False, f"EEPROM 空间不足 (需要 {offset + EEPROM_ENTRY_SIZE} 字节, 共 {EEPROM_SIZE} 字节)"
        image[offset] = (addr >> 8) & 0xFF
        image[offset + 1] = addr & 0xFF
        image[offset + 2] = (val >> 24) & 0xFF
        image[offset + 3] = (val >> 16) & 0xFF
        image[offset + 4] = (val >> 8) & 0xFF
        image[offset + 5] = val & 0xFF
        offset += EEPROM_ENTRY_SIZE
    
    total_bytes = offset
    
    # Init I2C
    if not eeprom_i2c_init(tmc):
        return False, "I2C 初始化失败"
    
    # Write to EEPROM (byte by byte for reliability)
    for i in range(total_bytes):
        if not eeprom_write_byte(tmc, i, image[i]):
            return False, f"写入 EEPROM 地址 0x{i:02X} 失败"
    
    # Verify: read back and compare
    for i in range(total_bytes):
        rb = eeprom_read_byte(tmc, i)
        if rb != image[i]:
            return False, f"校验失败: 地址 0x{i:02X} 期望 0x{image[i]:02X} 实际 0x{(rb if rb is not None else 0):02X}"
    
    return True, f"保存成功! {len(config_data)} 个寄存器, {total_bytes} 字节已写入并校验通过"


def eeprom_save_config_custom(tmc: 'TMC6460Serial', config: list) -> tuple[bool, str]:
    """Save custom config list to M24C02 EEPROM.
    
    Args:
        config: list of (register_addr, value) tuples
    
    Returns: (success, message)
    """
    # Build EEPROM image
    image = bytearray(EEPROM_SIZE)
    image[0] = (EEPROM_MAGIC >> 8) & 0xFF
    image[1] = EEPROM_MAGIC & 0xFF
    image[2] = EEPROM_VERSION
    image[3] = len(config)
    
    offset = EEPROM_HEADER_SIZE
    for addr, val in config:
        if offset + EEPROM_ENTRY_SIZE > EEPROM_SIZE:
            return False, f"EEPROM 空间不足"
        image[offset] = (addr >> 8) & 0xFF
        image[offset + 1] = addr & 0xFF
        image[offset + 2] = (val >> 24) & 0xFF
        image[offset + 3] = (val >> 16) & 0xFF
        image[offset + 4] = (val >> 8) & 0xFF
        image[offset + 5] = val & 0xFF
        offset += EEPROM_ENTRY_SIZE
    
    total_bytes = offset
    
    # Init I2C
    if not eeprom_i2c_init(tmc):
        return False, "I2C 初始化失败"
    
    # Write to EEPROM
    for i in range(total_bytes):
        if not eeprom_write_byte(tmc, i, image[i]):
            return False, f"写入 EEPROM 地址 0x{i:02X} 失败"
    
    # Verify
    for i in range(total_bytes):
        rb = eeprom_read_byte(tmc, i)
        if rb != image[i]:
            return False, f"校验失败: 地址 0x{i:02X} 期望 0x{image[i]:02X} 实际 0x{(rb if rb is not None else 0):02X}"
    
    return True, f"保存成功! {len(config)} 个寄存器, {total_bytes} 字节已写入并校验通过"


def eeprom_load_config(tmc: 'TMC6460Serial', apply: bool = True) -> tuple[bool, str, list | None]:
    """Load configuration from M24C02 EEPROM.
    
    Args:
        apply: If True, write loaded values to TMC6460 registers.
    
    Returns: (success, message, config_list) where config_list = [(addr, value), ...]
    """
    # Init I2C
    if not eeprom_i2c_init(tmc):
        return False, "I2C 初始化失败", None
    
    # Read header
    magic_h = eeprom_read_byte(tmc, 0)
    magic_l = eeprom_read_byte(tmc, 1)
    version = eeprom_read_byte(tmc, 2)
    count = eeprom_read_byte(tmc, 3)
    
    if magic_h is None or magic_l is None or version is None or count is None:
        return False, "读取 EEPROM 头部失败", None
    
    magic = (magic_h << 8) | magic_l
    if magic != EEPROM_MAGIC:
        return False, f"EEPROM 数据无效 (magic=0x{magic:04X}, 期望 0x{EEPROM_MAGIC:04X})", None
    
    if version != EEPROM_VERSION:
        return False, f"EEPROM 版本不匹配 (v{version}, 期望 v{EEPROM_VERSION})", None
    
    if count == 0 or count > 60:
        return False, f"EEPROM 数据异常 (count={count})", None
    
    # Read entries
    config = []
    offset = EEPROM_HEADER_SIZE
    for _ in range(count):
        if offset + EEPROM_ENTRY_SIZE > EEPROM_SIZE:
            return False, "EEPROM 数据截断", None
        addr_h = eeprom_read_byte(tmc, offset)
        addr_l = eeprom_read_byte(tmc, offset + 1)
        d3 = eeprom_read_byte(tmc, offset + 2)
        d2 = eeprom_read_byte(tmc, offset + 3)
        d1 = eeprom_read_byte(tmc, offset + 4)
        d0 = eeprom_read_byte(tmc, offset + 5)
        if any(b is None for b in [addr_h, addr_l, d3, d2, d1, d0]):
            return False, f"读取条目失败 (offset=0x{offset:02X})", None
        reg_addr = (addr_h << 8) | addr_l
        reg_val = (d3 << 24) | (d2 << 16) | (d1 << 8) | d0
        config.append((reg_addr, reg_val))
        offset += EEPROM_ENTRY_SIZE
    
    msg = f"读取成功: {count} 个寄存器配置"
    
    if apply:
        ok_count = 0
        fail_count = 0
        for reg_addr, reg_val in config:
            if tmc.write_register(reg_addr, reg_val):
                ok_count += 1
            else:
                fail_count += 1
        if fail_count > 0:
            msg += f" (写入: {ok_count} 成功, {fail_count} 失败)"
        else:
            msg += f" (全部 {ok_count} 个寄存器已写入)"
    
    return True, msg, config

