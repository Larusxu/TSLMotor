#!/usr/bin/env python3
"""
TMC6460 Torque Open Loop Mode 测试脚本
========================================
参考: tmc6460.pdf Page 82 "Torque open loop mode" 章节
      Page 148 MOTOR_MOTION 寄存器定义
      Page 154 PID_TORQUE_COEFF 寄存器定义
      Page 156 PID_TORQUE_FLUX_TARGET 寄存器定义

原理:
  MOTION_MODE=2 (TORQUE) + RAMP_EN + RAMP_USE_PHI_E
  电流环激活，ramp 产生开环电角度。
  设定 PID_TORQUE_TARGET 控制力矩电流，
  设定 ramp 速度让电机旋转。

  与 VOLTAGE_EXT 开环的区别: 电流环在跑，力矩可控，不会失控。

电机参数 (测量值):
  R_AB = 2.1Ω, L_AB = 111.8μH
  → R_s = 1.05Ω, L_s = 55.9μH (Y接法)
  → τ_e = 53.2μs

PI 起步值 (零极点对消, Q8.8):
  TORQUE_P = 64 (0.25), TORQUE_I = 48 (0.1875)
  Ki/Kp = 0.75 = R×Ts/L ✅

用法:
  python torque_openloop_test.py COM6                              # 默认参数
  python torque_openloop_test.py COM6 --torque 2048 --speed 50000  # 自定义
  python torque_openloop_test.py COM6 --torque 1024 --step         # 阶梯测试
  python torque_openloop_test.py --list                             # 列出串口
"""

import argparse
import struct
import sys
import time
import io

# Windows GBK 编码兼容
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True)

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("需要 pyserial: pip install pyserial")
    sys.exit(1)

# ============================================================
#  寄存器地址
# ============================================================
REG_VERSION          = 0x000
REG_STATUS_FLAGS     = 0x009
REG_EVENTS           = 0x00A
REG_MOTOR_MOTION     = 0x100
REG_GDRV             = 0x101
REG_MCC_STATUS       = 0x105
REG_CSA_GAIN         = 0x0C3   # CSA 增益
REG_PID_CONFIG       = 0x140   # 通用 PID 配置
REG_PID_FLUX_COEFF   = 0x142   # 磁通 PI 系数
REG_PID_TORQUE_COEFF = 0x143   # 力矩 PI 系数
REG_TF_LIMITS        = 0x14A   # 力矩/磁通限制
REG_TF_TARGET        = 0x14E   # 力矩/磁通目标
REG_VEL_TARGET       = 0x150   # 速度目标
REG_TF_ACTUAL        = 0x153   # 力矩/磁通实际值
REG_VEL_ACTUAL       = 0x154   # 速度实际值
REG_POS_ACTUAL       = 0x155   # 位置实际值
REG_TORQUE_ERROR     = 0x157   # 力矩误差
REG_TORQUE_INTEGRATOR = 0x15D  # 力矩积分器
REG_FOC_IQ_ID        = 0x168   # I_Q / I_D (实测 dq 电流)
REG_ADC_I2_I1        = 0x082   # I2, I1 原始 ADC 电流

# Ramp 寄存器
REG_V_MAX   = 0x1CE
REG_V_START = 0x1CA
REG_A1      = 0x1C4
REG_A_MAX   = 0x1CC
REG_RAMP_V  = 0x1D0

# ============================================================
#  电机参数 & PI 起步值
# ============================================================
# 电机 (Y接法): R_s=1.05Ω, L_s=55.9μH, PWM 默认 25kHz (Ts=40μs)
# 零极点对消: Ki/Kp = R×Ts/L = 0.75
TORQUE_P_DEFAULT = 64     # Q8.8 = 0.25
TORQUE_I_DEFAULT = 48     # Q8.8 = 0.1875, Ki/Kp=0.75 ✓
CSA_GAIN_4X       = 0x03  # CSA_GAIN = 4x, max 1.65A @ 55mΩ

# MOTOR_MOTION 位域
MOTION_MODE_TORQUE = 2
MOTOR_TYPE_BLDC    = 3

# ============================================================
#  UART 协议 (无 CRC)
# ============================================================

def make_read_req(addr: int) -> bytes:
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    return bytes([byte0, addr & 0xFF])


def make_write_req(addr: int, data: int) -> bytes:
    byte0 = 0x4A | (((addr >> 8) & 0x03) << 4)
    return bytes([byte0, addr & 0xFF]) + struct.pack('>I', data & 0xFFFFFFFF)


def parse_read_resp(resp: bytes) -> int | None:
    if len(resp) >= 6:
        return struct.unpack('>I', resp[2:6])[0]
    return None


# ============================================================
#  TMC6460 控制类
# ============================================================

class TMC6460:
    def __init__(self, port: str, baudrate: int = 115200, timeout: float = 0.3):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.ser = None

    def connect(self) -> bool:
        try:
            self.ser = serial.Serial(
                port=self.port, baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS, parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE, timeout=self.timeout,
                write_timeout=0.2,
            )
            return True
        except Exception as e:
            print(f"[ERROR] 无法打开 {self.port}: {e}")
            return False

    def close(self):
        if self.ser and self.ser.is_open:
            self.ser.close()

    def read_reg(self, addr: int, retries: int = 3) -> int | None:
        for _ in range(retries):
            try:
                self.ser.reset_input_buffer()
                self.ser.write(make_read_req(addr))
                self.ser.flush()
                time.sleep(0.005)
                resp = self.ser.read(10)
                v = parse_read_resp(resp)
                if v is not None:
                    return v
            except Exception:
                pass
            time.sleep(0.02)
        return None

    def write_reg(self, addr: int, data: int, retries: int = 3) -> bool:
        for _ in range(retries):
            try:
                self.ser.reset_input_buffer()
                self.ser.write(make_write_req(addr, data))
                self.ser.flush()
                time.sleep(0.002)
                resp = self.ser.read(10)
                if len(resp) >= 4:
                    return True
            except Exception:
                pass
            time.sleep(0.02)
        return False

    def verify_chip(self) -> bool:
        ver = self.read_reg(REG_VERSION)
        if ver is not None:
            print(f"  芯片版本: 0x{ver:08X}")
            return True
        print("  [ERROR] 无法读取芯片版本!")
        return False

    def clear_events(self):
        self.write_reg(REG_EVENTS, 0xFFFFFFFF)
        self.write_reg(0x081, 0xFFFFFFFF)  # FOC events

    def enable_driver(self) -> bool:
        gdrv = self.read_reg(REG_GDRV)
        if gdrv is None:
            return False
        gdrv |= (1 << 31) | (1 << 16)  # CHARGE_PUMP_EN | DRV_EN_BIT
        return self.write_reg(REG_GDRV, gdrv)

    def disable_driver(self) -> bool:
        gdrv = self.read_reg(REG_GDRV)
        if gdrv is None:
            return False
        gdrv &= ~((1 << 31) | (1 << 16))
        return self.write_reg(REG_GDRV, gdrv)

    def set_csa_gain(self, gain: int = CSA_GAIN_4X):
        """设置 CSA 增益 (0=1x, 1=2x, 2=3x, 3=4x)
        来源: tmc6460.pdf p146 寄存器 0x0C3
        """
        val = gain & 0x03
        return self.write_reg(REG_CSA_GAIN, val)

    def set_pi_coefficients(self, torque_p: int, torque_i: int,
                            flux_p: int = 0, flux_i: int = 0):
        """设置力矩和磁通 PI 系数
        来源: tmc6460.pdf p154
        PID_TORQUE_COEFF (0x143): [31:16]=TORQUE_P, [15:0]=TORQUE_I  (Q8.8)
        PID_FLUX_COEFF   (0x142): [31:16]=FLUX_P,   [15:0]=FLUX_I    (Q8.8)
        """
        # 力矩系数
        torque_val = ((torque_p & 0xFFFF) << 16) | (torque_i & 0xFFFF)
        ok1 = self.write_reg(REG_PID_TORQUE_COEFF, torque_val)
        # 磁通系数
        flux_val = ((flux_p & 0xFFFF) << 16) | (flux_i & 0xFFFF)
        ok2 = self.write_reg(REG_PID_FLUX_COEFF, flux_val)
        return ok1 and ok2

    def set_torque_flux_limits(self, torque_limit: int = 0x1000,
                               flux_limit: int = 0):
        """设置力矩/磁通限制
        来源: tmc6460.pdf p156
        PID_TORQUE_FLUX_LIMITS (0x14A): [30:16]=TORQUE_LIMIT, [14:0]=FLUX_LIMIT
        """
        val = ((torque_limit & 0x7FFF) << 16) | (flux_limit & 0x7FFF)
        return self.write_reg(REG_TF_LIMITS, val)

    def set_torque_openloop_mode(self, pole_pairs: int = 1,
                                 ramp_mode_vel: bool = True):
        """设置 Torque Open Loop 模式
        来源: tmc6460.pdf Page 82, 148

        MOTOR_MOTION 位域:
          bit15 = RAMP_USE_PHI_E = 1  (开环: 使用 ramp 角度)
          bit14 = RAMP_EN         = 1  (使能斜坡发生器)
          bit13 = RAMP_MODE           (0=位置, 1=速度)
          bit12:9 = 2 (TORQUE)        ← 力矩模式
          bit8:7 = 3 (BLDC)
          bit6:0 = N_POLE_PAIRS
        """
        ramp_mode_bit = 1 if ramp_mode_vel else 0
        val = (
            (1 << 15)                          # RAMP_USE_PHI_E
            | (1 << 14)                        # RAMP_EN
            | (ramp_mode_bit << 13)            # RAMP_MODE
            | (MOTION_MODE_TORQUE << 9)        # MOTION_MODE=2 (TORQUE)
            | (MOTOR_TYPE_BLDC << 7)           # MOTOR_TYPE=BLDC
            | (pole_pairs & 0x7F)              # N_POLE_PAIRS
        )
        print(f"  MOTOR_MOTION = 0x{val:08X}")
        print(f"    RAMP_USE_PHI_E=1  RAMP_EN=1  RAMP_MODE={'VEL' if ramp_mode_vel else 'POS'}")
        print(f"    MOTION_MODE=TORQUE(2)  MOTOR_TYPE=BLDC(3)  POLES={pole_pairs}")
        return self.write_reg(REG_MOTOR_MOTION, val)

    def set_torque_target(self, torque: int, flux: int = 0):
        """设置力矩/磁通目标
        来源: tmc6460.pdf p156
        PID_TORQUE_FLUX_TARGET (0x14E): [31:16]=TORQUE_TARGET (signed),
                                         [15:0]=FLUX_TARGET (signed)
        """
        val = ((torque & 0xFFFF) << 16) | (flux & 0xFFFF)
        return self.write_reg(REG_TF_TARGET, val)

    def set_velocity_target(self, vel: int):
        return self.write_reg(REG_VEL_TARGET, vel)

    def set_ramp_params(self, v_max: int, v_start: int = 1000,
                        a_max: int = 10000):
        self.write_reg(REG_V_MAX, v_max)
        self.write_reg(REG_V_START, v_start)
        self.write_reg(REG_A_MAX, a_max)
        self.write_reg(REG_A1, 0x00020000)

    def read_torque_actual(self) -> int | None:
        """读取力矩实际值 (有符号 16-bit)"""
        val = self.read_reg(REG_TF_ACTUAL)
        if val is None:
            return None
        t = (val >> 16) & 0xFFFF
        if t > 0x7FFF:
            t -= 0x10000
        return t

    def read_flux_actual(self) -> int | None:
        """读取磁通实际值 (有符号 16-bit)"""
        val = self.read_reg(REG_TF_ACTUAL)
        if val is None:
            return None
        f = val & 0xFFFF
        if f > 0x7FFF:
            f -= 0x10000
        return f

    def read_velocity(self) -> int | None:
        val = self.read_reg(REG_VEL_ACTUAL)
        if val is None:
            return None
        if val > 0x7FFFFFFF:
            val -= 0x100000000
        return val

    def read_position(self) -> int | None:
        val = self.read_reg(REG_POS_ACTUAL)
        if val is None:
            return None
        if val > 0x7FFFFFFF:
            val -= 0x100000000
        return val

    def read_iq_id(self) -> tuple | None:
        """读取 I_Q (力矩电流) 和 I_D (磁通电流)
        FOC.IQ_ID (0x168): [31:16]=I_Q_ACTUAL, [15:0]=I_D_ACTUAL
        """
        val = self.read_reg(REG_FOC_IQ_ID)
        if val is None:
            return None
        iq = (val >> 16) & 0xFFFF
        id_ = val & 0xFFFF
        if iq > 0x7FFF:
            iq -= 0x10000
        if id_ > 0x7FFF:
            id_ -= 0x10000
        return iq, id_

    def read_torque_error(self) -> int | None:
        val = self.read_reg(REG_TORQUE_ERROR)
        if val is None:
            return None
        if val > 0x7FFFFFFF:
            val -= 0x100000000
        return val

    def read_status(self) -> int | None:
        return self.read_reg(REG_STATUS_FLAGS)

    def stop(self):
        """安全停止"""
        self.set_torque_target(0, 0)
        time.sleep(0.05)
        self.write_reg(REG_MOTOR_MOTION, 0)
        time.sleep(0.05)
        self.disable_driver()


# ============================================================
#  测试流程
# ============================================================

def print_separator(title: str = ""):
    width = 60
    if title:
        pad = (width - len(title) - 2) // 2
        print("\n" + "=" * pad + f" {title} " + "=" * (width - pad - len(title) - 2))
    else:
        print("-" * width)


def run_test(
    tmc: TMC6460,
    torque_start: int = 256,
    torque_step: int = 256,
    torque_max: int = 2000,
    speed: int = 50000,
    step_duration: float = 2.0,
    sample_interval: float = 0.1,
    pole_pairs: int = 1,
    tp: int = TORQUE_P_DEFAULT,
    ti: int = TORQUE_I_DEFAULT,
):
    """主测试流程: 力矩阶梯递增"""

    print_separator("TMC6460 Torque Open Loop Test")
    print(f"  串口:          {tmc.port}")
    print(f"  极对数:        {pole_pairs}")
    print(f"  CSA Gain:      4x (max 1.65A)")
    print(f"  TORQUE_P:      {tp} (Q8.8 = {tp/256:.4f})")
    print(f"  TORQUE_I:      {ti} (Q8.8 = {ti/256:.4f})")
    print(f"  Ki/Kp:         {ti/tp:.3f} (目标: {1.05*40e-6/55.9e-6:.3f})")
    print(f"  力矩起始:      {torque_start} (≈ {torque_start*500/10000:.0f}mA)")
    print(f"  力矩步进:      {torque_step} (≈ {torque_step*500/10000:.0f}mA)")
    print(f"  力矩上限:      {torque_max} (≈ 500mA 封顶)")
    print(f"  Ramp 速度:     {speed}")
    print(f"  每步时长:      {step_duration}s")
    print(f"  采样间隔:      {sample_interval}s")

    # ---- Phase 0: 保存初始状态 ----
    print_separator("Phase 0: 保存初始状态")
    saved_motion = tmc.read_reg(REG_MOTOR_MOTION)
    saved_gdrv = tmc.read_reg(REG_GDRV)
    saved_csa = tmc.read_reg(REG_CSA_GAIN)
    saved_tp = tmc.read_reg(REG_PID_TORQUE_COEFF)
    saved_fp = tmc.read_reg(REG_PID_FLUX_COEFF)
    print(f"  MOTOR_MOTION   = 0x{saved_motion:08X}" if saved_motion else "  MOTOR_MOTION = FAIL")
    print(f"  GDRV           = 0x{saved_gdrv:08X}" if saved_gdrv else "  GDRV = FAIL")
    print(f"  CSA_GAIN       = 0x{saved_csa:08X}" if saved_csa else "  CSA_GAIN = FAIL")
    print(f"  TORQUE_COEFF   = 0x{saved_tp:08X}" if saved_tp else "  TORQUE_COEFF = FAIL")
    print(f"  FLUX_COEFF     = 0x{saved_fp:08X}" if saved_fp else "  FLUX_COEFF = FAIL")

    # ---- Phase 1: 配置 ----
    print_separator("Phase 1: 配置")

    tmc.clear_events()

    # 1.1 CSA Gain = 4x
    if not tmc.set_csa_gain(CSA_GAIN_4X):
        print("[ERROR] CSA_GAIN 设置失败")
        return False
    print(f"  [OK] CSA_GAIN = 4x (0x{CSA_GAIN_4X:02X})")

    # 1.2 PI 系数
    if not tmc.set_pi_coefficients(tp, ti):
        print("[ERROR] PI 系数设置失败")
        return False
    tp_check = tmc.read_reg(REG_PID_TORQUE_COEFF)
    print(f"  [OK] PID_TORQUE_COEFF = 0x{tp_check:08X} "
          f"(P={tp}, I={ti})")

    # 1.3 力矩限制
    tmc.set_torque_flux_limits(torque_limit=torque_max, flux_limit=0)
    print(f"  [OK] TORQUE_LIMIT = {torque_max}, FLUX_LIMIT = 0")

    # 1.4 使能驱动
    if not tmc.enable_driver():
        print("[ERROR] DRV 使能失败")
        return False
    gdrv = tmc.read_reg(REG_GDRV)
    cp = (gdrv >> 31) & 1 if gdrv else 0
    drv = (gdrv >> 16) & 1 if gdrv else 0
    print(f"  [OK] CHARGE_PUMP_EN={cp}  DRV_EN_BIT={drv}")

    # 1.5 力矩目标归零
    tmc.set_torque_target(0, 0)

    # 1.6 设置 TORQUE 开环模式
    if not tmc.set_torque_openloop_mode(pole_pairs, ramp_mode_vel=True):
        print("[ERROR] MOTOR_MOTION 设置失败")
        return False
    print(f"  [OK] TORQUE Open Loop 模式已设置")

    # 1.7 配置 ramp 参数
    tmc.set_ramp_params(v_max=speed * 2, v_start=2000, a_max=20000)
    print(f"  [OK] Ramp: V_MAX={speed*2}  V_START=2000  A_MAX=20000")

    # 1.8 设置速度目标
    tmc.set_velocity_target(speed)
    print(f"  [OK] VEL_TARGET = {speed}")

    time.sleep(0.5)
    print(f"\n  [READY] 开始力矩阶梯测试...\n")

    # ---- Phase 2: 力矩阶梯测试 ----
    print_separator("Phase 2: 力矩阶梯测试")
    print(f"  {'目标':>8s} {'≈mA':>6s}  {'I_Q':>10s} {'≈mA':>6s}  {'I_D':>10s}  {'力矩实际':>10s}  "
          f"{'力矩误差':>10s}  {'速度':>10s}  {'状态':>8s}")
    print(f"  {'-'*8} {'-'*6}  {'-'*10} {'-'*6}  {'-'*10}  {'-'*10}  "
          f"{'-'*10}  {'-'*10}  {'-'*8}")

    prev_pos = tmc.read_position()
    torque = torque_start

    # mA 转换系数: 目标10000 → 500mA
    TARGET_TO_MA = 500.0 / 10000.0
    # I_Q 满量程32767 → 1.65A = 1650mA
    IQ_TO_MA = 1650.0 / 32767.0

    try:
        while torque <= torque_max:
            # 写力矩目标
            tmc.set_torque_target(torque, 0)
            print(f"\n  >>> 力矩目标 = {torque} (≈{torque*TARGET_TO_MA:.0f}mA) <<<")
            time.sleep(0.2)

            # 采样
            start_t = time.time()
            samples = 0
            while time.time() - start_t < step_duration:
                iq_id = tmc.read_iq_id()
                t_actual = tmc.read_torque_actual()
                t_error = tmc.read_torque_error()
                vel = tmc.read_velocity()
                pos = tmc.read_position()

                iq_ma = f"{iq_id[0]*IQ_TO_MA:>5.0f}" if iq_id else "   ---"
                iq_str = f"{iq_id[0]:>10d}" if iq_id else "       ---"
                id_str = f"{iq_id[1]:>10d}" if iq_id else "       ---"
                ta_str = f"{t_actual:>10d}" if t_actual is not None else "       ---"
                te_str = f"{t_error:>10d}" if t_error is not None else "       ---"
                ve_str = f"{vel:>10d}" if vel is not None else "       ---"

                # 判断转动
                delta = 0
                if pos is not None and prev_pos is not None:
                    delta = pos - prev_pos
                prev_pos = pos
                status = "转动中" if abs(delta) > 100 else "静止"

                print(f"  {torque:>8d} {torque*TARGET_TO_MA:>5.0f}mA  {iq_str} {iq_ma}mA  {id_str}  {ta_str}  "
                      f"{te_str}  {ve_str}  {status:>8s}")

                # 检查过流
                st = tmc.read_status()
                if st and (st & 0x00000008):  # I_CLIPPED
                    print(f"  [WARN] 电流削波! 状态=0x{st:08X}")

                samples += 1
                time.sleep(sample_interval)

            torque += torque_step
            if torque == torque_start:
                break  # 防止无限循环

    except KeyboardInterrupt:
        print("\n\n  [中断] 用户取消")
    finally:
        # ---- Phase 3: 安全停止 ----
        print_separator("Phase 3: 安全停止")
        tmc.set_torque_target(0, 0)
        time.sleep(0.1)
        tmc.write_reg(REG_MOTOR_MOTION, 0)
        time.sleep(0.05)
        tmc.disable_driver()
        print(f"  [OK] 力矩归零, 驱动关闭")


def test_step(
    tmc: TMC6460,
    torque: int = 1024,
    speed: int = 50000,
    duration: float = 5.0,
    sample_interval: float = 0.1,
    pole_pairs: int = 1,
    tp: int = TORQUE_P_DEFAULT,
    ti: int = TORQUE_I_DEFAULT,
):
    """单步测试: 固定力矩目标运行一段时间"""

    print_separator("TMC6460 Torque Open Loop - 单步测试")
    print(f"  力矩目标: {torque} (≈{torque*100/2000:.0f}mA)")
    print(f"  Ramp 速度: {speed}")
    print(f"  运行时长: {duration}s")

    # 配置 (同 run_test)
    tmc.clear_events()
    tmc.set_csa_gain(CSA_GAIN_4X)
    tmc.set_pi_coefficients(tp, ti)
    tmc.set_torque_flux_limits(torque_limit=10000, flux_limit=0)  # 500mA 上限
    tmc.enable_driver()
    tmc.set_torque_target(0, 0)
    tmc.set_torque_openloop_mode(pole_pairs, ramp_mode_vel=True)
    tmc.set_ramp_params(v_max=speed * 2, v_start=2000, a_max=20000)
    tmc.set_velocity_target(speed)
    time.sleep(0.5)

    print(f"\n  施加力矩...")
    tmc.set_torque_target(torque, 0)
    time.sleep(0.2)

    print(f"  {'时间':>8s}  {'目标':>8s} {'≈mA':>5s}  {'I_Q':>10s} {'≈mA':>5s}  {'力矩实际':>10s}  "
          f"{'力矩误差':>10s}")
    print(f"  {'-'*8}  {'-'*8} {'-'*5}  {'-'*10} {'-'*5}  {'-'*10}  {'-'*10}")

    TARGET_TO_MA = 500.0 / 10000.0
    IQ_TO_MA = 1650.0 / 32767.0
    prev_pos = tmc.read_position()
    start_t = time.time()

    try:
        while time.time() - start_t < duration:
            elapsed = time.time() - start_t
            iq_id = tmc.read_iq_id()
            t_actual = tmc.read_torque_actual()
            t_error = tmc.read_torque_error()
            vel = tmc.read_velocity()

            iq_ma = f"{iq_id[0]*IQ_TO_MA:>4.0f}" if iq_id else "  ---"
            iq_str = f"{iq_id[0]:>10d}" if iq_id else "       ---"
            ta_str = f"{t_actual:>10d}" if t_actual is not None else "       ---"
            te_str = f"{t_error:>10d}" if t_error is not None else "       ---"

            print(f"  {elapsed:>7.1f}s  {torque:>8d} {torque*TARGET_TO_MA:>4.0f}mA  {iq_str} {iq_ma}mA  {ta_str}  "
                  f"{te_str}")

            time.sleep(sample_interval)

    except KeyboardInterrupt:
        print("\n\n  [中断]")
    finally:
        print(f"\n  [停止] 力矩归零...")
        tmc.set_torque_target(0, 0)
        time.sleep(0.1)
        tmc.write_reg(REG_MOTOR_MOTION, 0)
        time.sleep(0.05)
        tmc.disable_driver()
        print(f"  [OK] 已停止")


# ============================================================
#  Main
# ============================================================

def list_ports():
    ports = serial.tools.list_ports.comports()
    if not ports:
        print("未找到串口")
        return
    print("可用串口:")
    for p in ports:
        print(f"  {p.device} - {p.description}")


def main():
    parser = argparse.ArgumentParser(
        description="TMC6460 Torque Open Loop Mode 测试",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python torque_openloop_test.py COM6                           # 阶梯测试
  python torque_openloop_test.py COM6 --torque 2048 --step       # 单步固定力矩
  python torque_openloop_test.py COM6 --torque 1024 --speed 30000 --step
  python torque_openloop_test.py --list                          # 列出串口

参考: tmc6460.pdf Page 82 "Torque open loop mode"
      电机: R_s=1.05Ω, L_s=55.9μH, PWM=25kHz
        """,
    )
    parser.add_argument("port", nargs="?", help="串口号 (如 COM6)")
    parser.add_argument("--baud", type=int, default=115200, help="波特率 (默认:115200)")

    # 力矩参数 (默认限 500mA: CSA=4x, 1.65A 满量程 → max≈10000)
    parser.add_argument("--torque", type=int, default=None,
                        help="固定力矩目标 (搭配 --step 使用)")
    parser.add_argument("--torque-start", type=int, default=1000,
                        help="起始力矩 (默认:1000 ≈ 50mA)")
    parser.add_argument("--torque-max", type=int, default=10000,
                        help="最大力矩 (默认:10000 ≈ 500mA)")
    parser.add_argument("--torque-step", type=int, default=1000,
                        help="力矩步进 (默认:1000 ≈ 50mA)")

    # 运行参数
    parser.add_argument("--speed", type=int, default=50000, help="Ramp 速度 (默认:50000)")
    parser.add_argument("--step", action="store_true", help="单步固定力矩模式")
    parser.add_argument("--dur", type=float, default=5.0, help="单步运行时长秒 (默认:5.0)")
    parser.add_argument("--step-dur", type=float, default=2.0,
                        help="阶梯每步时长秒 (默认:2.0)")
    parser.add_argument("--sample", type=float, default=0.1, help="采样间隔秒 (默认:0.1)")
    parser.add_argument("--poles", type=int, default=1, help="极对数 (默认:1)")

    # 高级: PI 系数
    parser.add_argument("--tp", type=int, default=TORQUE_P_DEFAULT,
                        help=f"TORQUE_P Q8.8 (默认:{TORQUE_P_DEFAULT})")
    parser.add_argument("--ti", type=int, default=TORQUE_I_DEFAULT,
                        help=f"TORQUE_I Q8.8 (默认:{TORQUE_I_DEFAULT})")

    parser.add_argument("--list", action="store_true", help="列出可用串口")

    args = parser.parse_args()

    if args.list or not args.port:
        list_ports()
        if not args.port:
            return

    # 连接
    tmc = TMC6460(args.port, baudrate=args.baud)
    print(f"连接 {args.port} @ {args.baud}...")

    if not tmc.connect():
        print("连接失败")
        list_ports()
        return

    try:
        if not tmc.verify_chip():
            print("[ERROR] 无法与 TMC6460 通信, 请检查:")
            print("  1. 串口号是否正确")
            print("  2. 电机是否上电 (24V)")
            print("  3. RS485 A/B 线是否接对")
            return

        # 允许命令行覆盖 PI 系数（传给函数，不用 global）
        tp = args.tp
        ti = args.ti

        if args.step:
            torque = args.torque if args.torque else 1024
            test_step(tmc, torque=torque, speed=args.speed,
                      duration=args.dur, sample_interval=args.sample,
                      pole_pairs=args.poles, tp=tp, ti=ti)
        else:
            run_test(
                tmc,
                torque_start=args.torque_start,
                torque_step=args.torque_step,
                torque_max=args.torque_max,
                speed=args.speed,
                step_duration=args.step_dur,
                sample_interval=args.sample,
                pole_pairs=args.poles,
                tp=tp, ti=ti,
            )

    except KeyboardInterrupt:
        print("\n中断")
    finally:
        try:
            tmc.set_torque_target(0, 0)
            time.sleep(0.05)
        except Exception:
            pass
        tmc.close()
        print(f"{args.port} 已关闭")


if __name__ == "__main__":
    main()
