#!/usr/bin/env python3
"""
TMC6460 External Voltage Open Loop Mode 测试脚本
================================================
参考: tmc6460.pdf Page 82 "External voltage open loop mode" 章节
      Page 148 MOTOR_MOTION 寄存器定义
      Page 171 EXT_CTRL.VOLTAGE 寄存器定义

原理:
  VOLTAGE_EXT 模式下，绕过了电流控制环，直接设定 UQ/UD 电压分量。
  配合 ramp generator (RAMP_EN + RAMP_USE_PHI_E) 产生开环电角度，
  UD 电压产生磁场让转子跟随 ramp 角度旋转。

  UQ=0, UD>0 → 纯磁场对齐模式，转子跟随磁场旋转
  UD 越大，跟随越紧，但电流也越大

用法:
  python voltage_ext_openloop.py COM6                           # 默认参数测试
  python voltage_ext_openloop.py COM6 --ud 8000 --speed 100000  # 自定义参数
  python voltage_ext_openloop.py COM6 --ud 500 --test-align     # 转子对齐测试
  python voltage_ext_openloop.py --list                          # 列出串口

验证记录 (2026-05-20):
  VOLTAGE_EXT mode + RAMP_USE_PHI_E + RAMP_EN + RAMP_MODE(VEL) + UD 电压 → 电机可转
"""

import argparse
import struct
import sys
import time
import io

# Windows GBK 编码兼容: 强制 stdout 用 UTF-8
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("需要 pyserial: pip install pyserial")
    sys.exit(1)

# ============================================================
#  寄存器地址 (来源: tmc6460.pdf Register Map)
# ============================================================
REG_VERSION          = 0x000   # 芯片版本
REG_STATUS_FLAGS     = 0x009   # 状态标志
REG_EVENTS           = 0x00A   # 事件标志 (写1清)
REG_MOTOR_MOTION     = 0x100   # 电机/运动模式
REG_GDRV             = 0x101   # 栅极驱动配置
REG_MCC_STATUS       = 0x105   # MCC 状态
REG_TF_LIMITS        = 0x14A   # 力矩/磁通限制
REG_TF_TARGET        = 0x14E   # 力矩/磁通目标
REG_VEL_TARGET       = 0x150   # 速度目标
REG_TF_ACTUAL        = 0x153   # 力矩/磁通实际值
REG_VEL_ACTUAL       = 0x154   # 速度实际值
REG_POS_ACTUAL       = 0x155   # 位置实际值
REG_EXT_VOLTAGE      = 0x200   # EXT_CTRL.VOLTAGE (UQ[31:16], UD[15:0])

# Ramp 寄存器
REG_V_MAX   = 0x1CE   # 最大速度
REG_V_START = 0x1CA   # 起始速度
REG_A1      = 0x1C4   # 加速度 A1
REG_A_MAX   = 0x1CC   # 最大加速度
REG_RAMP_V  = 0x1D0   # 斜坡当前速度
REG_RAMP_POS = 0x1D1  # 斜坡当前位置

# ============================================================
#  MOTOR_MOTION 字段定义 (来源: Page 148)
# ============================================================
# bit[15]    RAMP_USE_PHI_E  开环模式: 用 ramp 角度代替编码器角度
# bit[14]    RAMP_EN         使能斜坡发生器
# bit[13]    RAMP_MODE       0=位置模式, 1=速度模式
# bit[12:9]  MOTION_MODE     11=VOLTAGE_EXT
# bit[8:7]   MOTOR_TYPE      3=BLDC
# bit[6:0]   N_POLE_PAIRS    极对数

MOTION_MODE_VOLTAGE_EXT = 11
MOTOR_TYPE_BLDC         = 3


# ============================================================
#  TMC6460 UART 协议 (无 CRC, 来源: tmc6460.pdf Page 31-40)
#  读请求: 2 bytes  → 读响应: 6 bytes (2 echo + 4 data)
#  写请求: 6 bytes  → 写响应: 4 bytes (echo)
# ============================================================

def make_read_req(addr: int) -> bytes:
    """构造读请求 (2 bytes, 无 CRC)
    Byte0: [sync:010][WnR:0][addr9:8]
    Byte1: [addr7:0]
    """
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    return bytes([byte0, addr & 0xFF])


def make_write_req(addr: int, data: int) -> bytes:
    """构造写请求 (6 bytes, 无 CRC)
    Byte0: [sync:010][WnR:1][addr9:8]
    Byte1: [addr7:0]
    Bytes 2-5: 32-bit data (big-endian)
    """
    byte0 = 0x4A | (((addr >> 8) & 0x03) << 4)
    return bytes([byte0, addr & 0xFF]) + struct.pack('>I', data & 0xFFFFFFFF)


def parse_read_resp(resp: bytes) -> int | None:
    """解析读响应 (6 bytes, 无 CRC 模式)
    返回 32-bit 数据, 或 None
    """
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
        """使能 DRV + Charge Pump
        GDRV 默认值 0x81003431, bit31=CHARGE_PUMP_EN, bit16=DRV_EN
        """
        gdrv = self.read_reg(REG_GDRV)
        if gdrv is None:
            return False
        gdrv |= (1 << 31) | (1 << 16)
        return self.write_reg(REG_GDRV, gdrv)

    def disable_driver(self) -> bool:
        gdrv = self.read_reg(REG_GDRV)
        if gdrv is None:
            return False
        gdrv &= ~((1 << 31) | (1 << 16))
        return self.write_reg(REG_GDRV, gdrv)

    def set_voltage_ext_mode(self, pole_pairs: int = 1, ramp_mode_vel: bool = True):
        """设置 External Voltage Open Loop 模式
        来源: tmc6460.pdf Page 82, 148
        
        MOTOR_MOTION 位域:
          bit15 = RAMP_USE_PHI_E = 1  (开环: 使用 ramp 角度)
          bit14 = RAMP_EN = 1         (使能斜坡发生器)
          bit13 = RAMP_MODE           (0=位置, 1=速度)
          bit12:9 = 11 (VOLTAGE_EXT)
          bit8:7 = 3 (BLDC)
          bit6:0 = N_POLE_PAIRS
        """
        ramp_mode_bit = 1 if ramp_mode_vel else 0
        val = (
            (1 << 15)                    # RAMP_USE_PHI_E
            | (1 << 14)                  # RAMP_EN
            | (ramp_mode_bit << 13)      # RAMP_MODE
            | (MOTION_MODE_VOLTAGE_EXT << 9)  # MOTION_MODE=11
            | (MOTOR_TYPE_BLDC << 7)     # MOTOR_TYPE=BLDC
            | (pole_pairs & 0x7F)        # N_POLE_PAIRS
        )
        print(f"  MOTOR_MOTION = 0x{val:08X}")
        print(f"    RAMP_USE_PHI_E=1  RAMP_EN=1  RAMP_MODE={'VEL' if ramp_mode_vel else 'POS'}")
        print(f"    MOTION_MODE=VOLTAGE_EXT(11)  MOTOR_TYPE=BLDC(3)  POLES={pole_pairs}")
        return self.write_reg(REG_MOTOR_MOTION, val)

    def set_voltage(self, ud: int = 0, uq: int = 0):
        """设置直接电压 EXT_CTRL.VOLTAGE (0x200)
        来源: Page 171
        bits[31:16] = UQ (signed)
        bits[15:0]  = UD (signed)
        
        开环测试: UQ=0, UD>0 产生旋转磁场让转子跟随
        """
        val = ((uq & 0xFFFF) << 16) | (ud & 0xFFFF)
        return self.write_reg(REG_EXT_VOLTAGE, val)

    def set_velocity_target(self, vel: int):
        """设置速度目标值 (PID_VELOCITY_TARGET, 0x150)"""
        return self.write_reg(REG_VEL_TARGET, vel)

    def set_ramp_params(self, v_max: int, v_start: int = 1000, a_max: int = 10000):
        """配置斜坡发生器参数"""
        self.write_reg(REG_V_MAX, v_max)
        self.write_reg(REG_V_START, v_start)
        self.write_reg(REG_A_MAX, a_max)
        self.write_reg(REG_A1, 0x00020000)  # 已验证值

    def read_torque(self) -> int | None:
        """读取力矩实际值 (有符号)"""
        val = self.read_reg(REG_TF_ACTUAL)
        if val is None:
            return None
        t = (val >> 16) & 0xFFFF
        if t > 0x7FFF:
            t -= 0x10000
        return t

    def read_velocity(self) -> int | None:
        """读取速度实际值 (有符号)"""
        val = self.read_reg(REG_VEL_ACTUAL)
        if val is None:
            return None
        if val > 0x7FFFFFFF:
            val -= 0x100000000
        return val

    def read_position(self) -> int | None:
        """读取位置实际值"""
        val = self.read_reg(REG_POS_ACTUAL)
        if val is None:
            return None
        if val > 0x7FFFFFFF:
            val -= 0x100000000
        return val

    def read_status(self) -> int | None:
        return self.read_reg(REG_STATUS_FLAGS)

    def stop(self):
        """安全停止: UD=0, MOTOR_MOTION=0, DRV 关"""
        self.set_voltage(0, 0)
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
    ud_start: int = 500,
    ud_max: int = 5000,
    ud_step: int = 500,
    speed: int = 50000,
    step_duration: float = 1.0,
    ramp_mode_vel: bool = True,
    sample_interval: float = 0.1,
):
    """主测试流程"""

    pole_pairs = 1  # 写死

    print_separator("TMC6460 External Voltage Open Loop Test")
    print(f"  串口:          {tmc.port}")
    print(f"  极对数:        {pole_pairs}")
    print(f"  UD 起始:       {ud_start}")
    print(f"  UD 最大:       {ud_max}")
    print(f"  UD 步进:       {ud_step}")
    print(f"  速度目标:      {speed}")
    print(f"  每步时长:      {step_duration}s")
    print(f"  Ramp 模式:     {'VELOCITY' if ramp_mode_vel else 'POSITION'}")

    # ---- Phase 0: 保存初始状态 ----
    print_separator("Phase 0: 保存初始状态")
    saved_motion = tmc.read_reg(REG_MOTOR_MOTION)
    saved_gdrv = tmc.read_reg(REG_GDRV)
    saved_volt = tmc.read_reg(REG_EXT_VOLTAGE)
    print(f"  MOTOR_MOTION = 0x{saved_motion:08X}" if saved_motion else "  MOTOR_MOTION = FAIL")
    print(f"  GDRV         = 0x{saved_gdrv:08X}" if saved_gdrv else "  GDRV = FAIL")
    print(f"  VOLTAGE      = 0x{saved_volt:08X}" if saved_volt else "  VOLTAGE = FAIL")

    # ---- Phase 1: 配置 ----
    print_separator("Phase 1: 配置")

    tmc.clear_events()

    # 1.1 使能驱动
    if not tmc.enable_driver():
        print("[ERROR] DRV 使能失败")
        return False
    gdrv = tmc.read_reg(REG_GDRV)
    cp = (gdrv >> 31) & 1 if gdrv else 0
    drv = (gdrv >> 16) & 1 if gdrv else 0
    print(f"  [OK] CHARGE_PUMP_EN={cp}  DRV_EN={drv}")

    # 1.2 设置 VOLTAGE_EXT 模式
    if not tmc.set_voltage_ext_mode(pole_pairs, ramp_mode_vel):
        print("[ERROR] MOTOR_MOTION 设置失败")
        return False
    print(f"  [OK] VOLTAGE_EXT 模式已设置")

    # 1.3 配置 ramp 参数
    tmc.set_ramp_params(v_max=speed * 2, v_start=1000, a_max=20000)
    print(f"  [OK] Ramp: V_MAX={speed*2}  V_START=1000  A_MAX=20000")

    # 1.4 设置速度目标
    tmc.set_velocity_target(speed)
    print(f"  [OK] VEL_TARGET = {speed}")

    # 1.5 UD 初始归零
    tmc.set_voltage(0, 0)
    print(f"  [OK] UD=0 UQ=0 (初始化)")
    time.sleep(0.3)

    # ---- Phase 2: UD 阶梯测试 ----
    print_separator("Phase 2: UD 阶梯测试")

    # UD 写死为常数 (按李工要求)
    ud_values = [1000]

    header = f"{'时间':>6s}  {'UD':>6s}  {'速度实际':>12s}  {'位置实际':>12s}  {'Δ位置':>10s}  {'力矩':>8s}"
    print(header)
    print("-" * len(header))

    start_time = time.time()
    prev_pos = tmc.read_position() or 0
    total_pos_delta = 0

    try:
        for step, ud in enumerate(ud_values):
            # 设置 UD
            tmc.set_voltage(ud, 0)

            # 在此阶梯内采样
            n_samples = max(1, int(step_duration / sample_interval))
            for s in range(n_samples):
                # 等待采样时刻
                target_time = start_time + (step * step_duration) + (s * sample_interval)
                wait = target_time - time.time()
                if wait > 0:
                    time.sleep(wait)

                elapsed = time.time() - start_time
                vel = tmc.read_velocity()
                pos = tmc.read_position()
                torque = tmc.read_torque()

                delta = 0
                if pos is not None and prev_pos is not None:
                    delta = pos - prev_pos
                    total_pos_delta += delta
                if pos is not None:
                    prev_pos = pos

                print(f"{elapsed:5.1f}s  {ud:>6d}  "
                      f"{vel if vel is not None else '---':>12}  "
                      f"{pos if pos is not None else '---':>12}  "
                      f"{delta:>10d}  "
                      f"{torque if torque is not None else '---':>8}")

            # 检查状态
            status = tmc.read_status()
            if status and (status & 0x1):  # 简易故障检测
                print(f"\n[WARN] STATUS_FLAGS=0x{status:08X}, 可能有故障")

    except KeyboardInterrupt:
        print("\n\n[USER] 中断")

    # ---- Phase 3: 安全停止 ----
    print_separator("Phase 3: 停止")
    tmc.set_voltage(0, 0)
    time.sleep(0.1)
    tmc.write_reg(REG_MOTOR_MOTION, 0)
    time.sleep(0.05)

    # 恢复 (可选)
    if saved_gdrv is not None:
        tmc.write_reg(REG_GDRV, saved_gdrv)
        print(f"  已恢复 GDRV")

    print(f"  UD=0, MOTOR_MOTION=0 [OK]")

    # ---- 测试报告 ----
    print_separator("测试报告")
    print(f"  总位置变化: {total_pos_delta}")
    print(f"  UD 范围:    [{ud_start}, {ud_max}]")
    print(f"  速度目标:   {speed}")

    if abs(total_pos_delta) > 10:
        print(f"\n  [OK] 电机有转动 (位置变化={total_pos_delta})")
    else:
        print(f"\n  [WARN] 电机未检测到明显转动")
        print(f"  建议: 增大 UD (--ud 8000~20000) 或检查接线/供电")

    return True


def test_align(tmc: TMC6460, ud: int = 500):
    pole_pairs = 1  # 写死
    """转子对齐测试 (手动控制 UD)
    来源: Page 65 的 ABN 编码器对齐流程

    设置 VOLTAGE_EXT + UD > 0，转子会 snap 到电角度 0°
    逐步增大 UD 可精确对齐，但要防止过流
    """
    print_separator("转子对齐测试")

    tmc.clear_events()

    if not tmc.enable_driver():
        print("[ERROR] DRV 使能失败")
        return

    # 位置模式 (ramp 停在原地) + VOLTAGE_EXT
    val = (
        (1 << 15)                         # RAMP_USE_PHI_E
        | (1 << 14)                       # RAMP_EN
        | (0 << 13)                       # RAMP_MODE = POSITION
        | (MOTION_MODE_VOLTAGE_EXT << 9)  # VOLTAGE_EXT
        | (MOTOR_TYPE_BLDC << 7)          # BLDC
        | (pole_pairs & 0x7F)
    )
    tmc.write_reg(REG_MOTOR_MOTION, val)
    print(f"  MOTOR_MOTION = 0x{val:08X} (VOLTAGE_EXT + Position Ramp)")

    # 位置目标 = 0 (停在原地)
    tmc.write_reg(0x152, 0)  # PID_POSITION_TARGET
    print(f"  POS_TARGET = 0")

    print(f"\n  逐步增大 UD 进行转子对齐...")
    print(f"  {'UD':>6s}  {'力矩':>8s}  {'位置':>10s}  {'Δ位置':>8s}  状态")
    print(f"  {'-'*50}")

    prev_pos = tmc.read_position() or 0
    # 从 100 开始，每次 +100，观察转子是否停止移动
    for test_ud in range(100, ud + 100, 100):
        tmc.set_voltage(test_ud, 0)
        time.sleep(0.3)  # 等转子稳定

        pos = tmc.read_position()
        torque = tmc.read_torque()
        delta = (pos - prev_pos) if pos is not None and prev_pos is not None else 0
        prev_pos = pos

        status = "稳定" if abs(delta) < 50 else "移动中"
        print(f"  {test_ud:>6d}  {torque if torque is not None else '---':>8}  "
              f"{pos if pos is not None else '---':>10}  {delta:>8d}  {status}")

    print(f"\n  UD 归零...")
    tmc.set_voltage(0, 0)
    time.sleep(0.1)
    tmc.write_reg(REG_MOTOR_MOTION, 0)
    print(f"  [OK] 对齐测试完成")


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
        description="TMC6460 External Voltage Open Loop Mode 测试",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python voltage_ext_openloop.py COM6
  python voltage_ext_openloop.py COM6 --ud 8000 --speed 150000
  python voltage_ext_openloop.py COM6 --ud 500 --test-align
  python voltage_ext_openloop.py --list

参考: tmc6460.pdf Page 82 "External voltage open loop mode"
        """,
    )
    parser.add_argument("port", nargs="?", help="串口号 (如 COM6)")
    parser.add_argument("--baud", type=int, default=115200, help="波特率 (默认:115200)")

    parser.add_argument("--ud-start", type=int, default=500, help="UD 起始电压 (默认:500)")
    parser.add_argument("--ud-max", type=int, default=5000, help="UD 最大电压 (默认:5000)")
    parser.add_argument("--ud-step", type=int, default=500, help="UD 步进 (默认:500)")
    parser.add_argument("--ud", type=int, default=None,
                        help="固定 UD 值 (覆盖 ud-start/ud-max/ud-step)")
    parser.add_argument("--speed", type=int, default=50000, help="Ramp 速度目标 (默认:50000)")
    parser.add_argument("--step-dur", type=float, default=1.0, help="每步持续时间秒 (默认:1.0)")
    parser.add_argument("--ramp-pos", action="store_true", help="使用位置模式 (默认:速度模式)")
    parser.add_argument("--test-align", action="store_true",
                        help="转子对齐测试模式 (位置 ramp + UD 阶梯)")
    parser.add_argument("--list", action="store_true", help="列出可用串口")
    parser.add_argument("--sample", type=float, default=0.1, help="采样间隔秒 (默认:0.1)")

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

        if args.test_align:
            ud = args.ud if args.ud else 500
            test_align(tmc, ud=ud)
        else:
            ud_max = args.ud_max
            if args.ud is not None:
                # 固定 UD: 只有一档
                ud_max = args.ud
                args.ud_start = args.ud
                args.ud_step = 1  # 不会增加

            run_test(
                tmc,
                ud_start=args.ud_start,
                ud_max=ud_max,
                ud_step=args.ud_step,
                speed=args.speed,
                step_duration=args.step_dur,
                ramp_mode_vel=not args.ramp_pos,
                sample_interval=args.sample,
            )

    except KeyboardInterrupt:
        print("\n中断")
    finally:
        try:
            tmc.set_voltage(0, 0)
            time.sleep(0.05)
        except Exception:
            pass
        tmc.close()
        print(f"{args.port} 已关闭")


if __name__ == "__main__":
    main()
