#!/usr/bin/env python3
"""
TMC6460 开环速度测试脚本 v2
=============================
PC 端通过 USB-RS485 直连 TMC6460，EXT_CTRL.VOLTAGE (0x200) 电压驱动开环。

用法:
    python openloop_test.py COM10                     # 默认参数
    python openloop_test.py COM10 --speed 100000      # 高速
    python openloop_test.py COM10 --voltage 5000      # 低电压
    python openloop_test.py COM10 --list              # 列出串口

验证配置 (2026-05-20):
    OPENLOOP_VEL mode=2 + RAMP_USE_PHI_E + RAMP_EN + RAMP_MODE(VEL)
    + EXT_CTRL.VOLTAGE UD 直接电压驱动 — 电机可转 ✅
"""

import argparse
import struct
import sys
import time

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
REG_STATUS           = 0x009
REG_EVENTS           = 0x00A
REG_MOTOR_MOTION     = 0x100
REG_GDRV             = 0x101
REG_TF_LIMITS        = 0x14A
REG_TF_TARGET        = 0x14E
REG_VEL_TARGET       = 0x150
REG_TF_ACTUAL        = 0x153
REG_VEL_ACTUAL       = 0x154
REG_POS_ACTUAL       = 0x155
REG_EXT_CTRL_VOLTAGE = 0x200  # 直接电压控制 UD

# Ramp 寄存器
REG_V_MAX  = 0x1CE
REG_V_START = 0x1CA
REG_A1     = 0x1C4
REG_A_MAX  = 0x1CC
REG_RAMP_STATUS = 0x1D4

# ============================================================
#  TMC6460 UART 协议 (无 CRC, 自动方向 RS485)
#  读: 2字节请求 → 6字节响应 (2 echo + 4 data)
#  写: 6字节请求 → 5字节响应 (2 echo + 3 data)
# ============================================================

def make_read_req(addr: int) -> bytes:
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    return bytes([byte0, addr & 0xFF])

def make_write_req(addr: int, data: int) -> bytes:
    byte0 = 0x4A | (((addr >> 8) & 0x03) << 4)
    return bytes([byte0, addr & 0xFF]) + struct.pack('>I', data & 0xFFFFFFFF)

def parse_read_resp(resp: bytes) -> int | None:
    """读响应: 6字节 (2 echo + 4 data, 无CRC模式)"""
    if len(resp) >= 6:
        return struct.unpack('>I', resp[2:6])[0]
    return None


# ============================================================
#  TMC6460 电机控制类
# ============================================================

class TMC6460Motor:
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
        for attempt in range(retries):
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
        for attempt in range(retries):
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
        return False

    def clear_events(self):
        self.write_reg(REG_EVENTS, 0xFFFFFFFF)
        self.write_reg(0x081, 0xFFFFFFFF)  # MCC events

    def enable_driver(self, enable: bool = True):
        """GDRV: CP_EN(bit31) + DRV_EN(bit16)"""
        current = self.read_reg(REG_GDRV)
        if current is None:
            return False
        val = (current | (1<<31) | (1<<16)) if enable else (current & ~((1<<31)|(1<<16)))
        return self.write_reg(REG_GDRV, val)

    def set_openloop_mode(self, pole_pairs: int = 1):
        """设置开环速度模式: RAMP_USE_PHI_E + RAMP_EN + RAMP_MODE(VEL) + OPENLOOP_VEL + BLDC + poles"""
        # bit15=RAMP_USE_PHI_E bit14=RAMP_EN bit13=RAMP_MODE(vel)
        # bits[12:9]=2(OPENLOOP_VEL) bits[8:7]=3(BLDC) bits[6:0]=poles
        val = (1<<15) | (1<<14) | (1<<13) | (2<<9) | (3<<7) | (pole_pairs & 0x7F)
        return self.write_reg(REG_MOTOR_MOTION, val)

    def set_ramp_params(self, v_max=200000, v_start=1000, a_max=10000):
        """配置斜坡发生器 (匹配已验证参数)"""
        self.write_reg(REG_V_MAX, v_max)
        self.write_reg(REG_V_START, v_start)
        self.write_reg(REG_A_MAX, a_max)
        self.write_reg(REG_A1, 0x00020000)  # 已验证值

    def set_velocity_target(self, vel: int):
        self.write_reg(REG_VEL_TARGET, vel)

    def set_torque_limit(self, limit: int):
        val = (limit & 0x7FFF) << 16
        self.write_reg(REG_TF_LIMITS, val)

    def set_voltage(self, ud: int):
        """设置直接电压 (0x200, EXT_CTRL.VOLTAGE)"""
        self.write_reg(REG_EXT_CTRL_VOLTAGE, ud & 0xFFFF)

    def read_torque_actual(self) -> int | None:
        val = self.read_reg(REG_TF_ACTUAL)
        if val is None:
            return None
        t = (val >> 16) & 0xFFFF
        if t > 0x7FFF:
            t -= 0x10000
        return t

    def read_velocity_actual(self) -> int | None:
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

    def read_status(self) -> int | None:
        return self.read_reg(REG_STATUS)

    def read_events(self) -> int | None:
        return self.read_reg(REG_EVENTS)


# ============================================================
#  开环速度测试
# ============================================================

def run_openloop_test(
    motor: TMC6460Motor,
    speed: int = 50000,
    voltage: int = 5000,
    ramp_up_s: float = 2.0,
    hold_s: float = 3.0,
    ramp_down_s: float = 2.0,
    sample_interval: float = 0.1,
):
    print("\n" + "=" * 60)
    print("  TMC6460 开环速度测试 v2 (EXT_CTRL.VOLTAGE)")
    print("=" * 60)
    print(f"  速度目标:      {speed}")
    print(f"  UD 电压:       {voltage}")
    print(f"  加速时间:      {ramp_up_s}s")
    print(f"  保持时间:      {hold_s}s")
    print(f"  减速时间:      {ramp_down_s}s")
    print(f"  采样间隔:      {sample_interval}s")
    print("-" * 60)

    # Phase 0: 保存当前配置
    print("\n[Phase 0] 保存当前配置...")
    saved_motion = motor.read_reg(REG_MOTOR_MOTION)
    saved_gdrv = motor.read_reg(REG_GDRV)
    saved_vel_tgt = motor.read_reg(REG_VEL_TARGET)
    saved_tf_lim = motor.read_reg(REG_TF_LIMITS)

    print(f"  MOTOR_MOTION = 0x{saved_motion:08X}" if saved_motion else "  MOTOR_MOTION = FAIL")
    print(f"  GDRV         = 0x{saved_gdrv:08X}" if saved_gdrv else "  GDRV = FAIL")

    # Phase 1: 配置
    print("\n[Phase 1] 配置开环...")

    motor.clear_events()

    if not motor.enable_driver(True):
        print("[ERROR] DRV 使能失败")
        return False
    print("  CP_EN + DRV_EN = 1 ✓")

    if not motor.set_openloop_mode(pole_pairs=1):
        print("[ERROR] 模式设置失败")
        return False
    print("  OPENLOOP_VEL + RAMP_USE_PHI_E + RAMP_EN ✓")

    motor.set_ramp_params(v_max=speed*2, v_start=1000, a_max=20000)  # 保守加速度
    print(f"  Ramp: V_MAX={speed*2} V_START=1000 A_MAX=20000 A1=0x00020000")

    motor.set_velocity_target(speed)
    print(f"  VEL_TARGET = {speed}")

    motor.set_torque_limit(max(voltage, 1000))
    print(f"  TF_LIMIT = {max(voltage, 1000)}")

    motor.set_voltage(0)
    print("  UD = 0 (初始化)")

    time.sleep(0.1)

    # Phase 2: 运行 + 采样
    print(f"\n[Phase 2] 开环运行 (UD ramp {voltage})...")
    print("-" * 60)
    print(f"{'时间':>6s}  {'UD':>6s}  {'力矩':>8s}  {'速度':>10s}  {'位置':>10s}  {'Δ位置':>10s}")
    print("-" * 60)

    start_pos = motor.read_position()
    prev_pos = start_pos if start_pos is not None else 0
    pos_max = pos_min = prev_pos
    start_time = time.time()

    total_samples = int((ramp_up_s + hold_s + ramp_down_s) / sample_interval) + 2
    results = []

    try:
        for i in range(total_samples):
            elapsed = time.time() - start_time

            # UD 电压梯形曲线
            if elapsed < ramp_up_s:
                ud = int(voltage * elapsed / ramp_up_s)
                phase = "RAMP_UP"
            elif elapsed < ramp_up_s + hold_s:
                ud = voltage
                phase = "HOLD"
            elif elapsed < ramp_up_s + hold_s + ramp_down_s:
                frac = (elapsed - ramp_up_s - hold_s) / ramp_down_s
                ud = int(voltage * (1.0 - frac))
                phase = "RAMP_DN"
            else:
                ud = 0
                phase = "STOP"

            motor.set_voltage(ud)
            time.sleep(0.002)

            # 等待采样时刻
            wait = start_time + i * sample_interval - time.time()
            if wait > 0:
                time.sleep(wait)

            torque_act = motor.read_torque_actual()
            vel_act = motor.read_velocity_actual()
            pos_act = motor.read_position()

            delta = 0
            if pos_act is not None:
                delta = pos_act - prev_pos
                prev_pos = pos_act
                pos_max = max(pos_max, pos_act)
                pos_min = min(pos_min, pos_act)

            t_now = time.time() - start_time
            print(f"{t_now:5.1f}s  {ud:>6d}  {torque_act if torque_act is not None else '---':>8}  "
                  f"{vel_act if vel_act is not None else '---':>10}  "
                  f"{pos_act if pos_act is not None else '---':>10}  "
                  f"{delta:>10}")

            results.append({
                'time': t_now, 'ud': ud,
                'torque': torque_act, 'velocity': vel_act,
                'position': pos_act, 'delta': delta, 'phase': phase,
            })

            if phase == "STOP":
                break

    except KeyboardInterrupt:
        print("\n\n[USER] 中断, 安全停止...")

    # Phase 3: 恢复
    print("\n[Phase 3] 恢复配置...")
    motor.set_voltage(0)   # UD 归零
    time.sleep(0.1)

    if saved_motion is not None:
        motor.write_reg(REG_MOTOR_MOTION, 0)  # 关模式
    if saved_gdrv is not None:
        motor.write_reg(REG_GDRV, saved_gdrv)
    print("  已恢复")

    # 测试报告
    print("\n" + "=" * 60)
    print("  测试报告")
    print("=" * 60)

    valid = [r for r in results if r['position'] is not None]
    if valid and len(valid) >= 2:
        total_delta = valid[-1]['position'] - valid[0]['position']
        max_delta = max(abs(r['delta']) for r in valid)
        torque_max = max(
            (r['torque'] for r in valid if r['torque'] is not None), default=0
        )
        vel_max = max(
            (abs(r['velocity']) for r in valid if r['velocity'] is not None), default=0
        )

        print(f"  总位置变化:    {total_delta}")
        print(f"  最大单步变化:  {max_delta}")
        print(f"  峰值力矩:      {torque_max}")
        print(f"  峰值速度:      {vel_max}")
        print(f"  位置范围:      [{pos_min}, {pos_max}]")
        print(f"  有效采样:      {len(valid)}")

        if abs(total_delta) > 10 or pos_max != pos_min:
            print(f"\n  ✅ 电机转动正常")
        else:
            print(f"\n  ⚠️ 电机未检测到转动")
            print(f"  尝试: --voltage 8000 或 --speed 150000")
    else:
        print("  ⚠️ 位势数据不足")

    return True


# ============================================================
#  列串口
# ============================================================

def list_ports():
    ports = serial.tools.list_ports.comports()
    if not ports:
        print("未找到串口")
        return
    print("可用串口:")
    for p in ports:
        print(f"  {p.device} - {p.description}")


# ============================================================
#  main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="TMC6460 开环速度测试 v2 — EXT_CTRL.VOLTAGE 电压驱动",
        epilog="""
示例:
  python openloop_test.py COM10                        # 默认
  python openloop_test.py COM10 --speed 150000         # 高速
  python openloop_test.py COM10 --voltage 8000         # 大电压
  python openloop_test.py COM10 --list                 # 列串口
        """,
    )
    parser.add_argument("port", nargs="?", help="串口 (如 COM10)")
    parser.add_argument("--speed", type=int, default=50000, help="速度目标 (默认:50000)")
    parser.add_argument("--voltage", type=int, default=5000, help="UD 电压 (默认:5000)")
    parser.add_argument("--ramp-up", type=float, default=2.0, help="加速时间秒 (默认:2.0)")
    parser.add_argument("--hold", type=float, default=3.0, help="保持时间秒 (默认:3.0)")
    parser.add_argument("--ramp-down", type=float, default=2.0, help="减速时间秒 (默认:2.0)")
    parser.add_argument("--sample", type=float, default=0.1, help="采样间隔秒 (默认:0.1)")
    parser.add_argument("--list", action="store_true", help="列出串口")
    parser.add_argument("--baud", type=int, default=115200, help="波特率 (默认:115200)")

    args = parser.parse_args()

    if args.list or not args.port:
        list_ports()
        if not args.port:
            return

    motor = TMC6460Motor(args.port, baudrate=args.baud)
    print(f"连接 {args.port} @ {args.baud}...")

    if not motor.connect():
        print("连接失败")
        list_ports()
        return

    try:
        if not motor.verify_chip():
            print("[ERROR] 无法与 TMC6460 通信")
            return

        run_openloop_test(
            motor,
            speed=args.speed,
            voltage=args.voltage,
            ramp_up_s=args.ramp_up,
            hold_s=args.hold,
            ramp_down_s=args.ramp_down,
            sample_interval=args.sample,
        )

    except KeyboardInterrupt:
        print("\n中断")
    finally:
        try:
            motor.set_voltage(0)
            time.sleep(0.05)
        except Exception:
            pass
        motor.close()
        print(f"{args.port} 已关闭")


if __name__ == "__main__":
    main()
