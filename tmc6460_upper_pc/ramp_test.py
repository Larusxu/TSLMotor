#!/usr/bin/env python3
"""RAMP 寄存器可读性测试 — 验证 0x1C0~0x1D5 哪些能读"""

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

def main():
    if len(sys.argv) < 2:
        print("用法: python ramp_test.py COM10")
        return

    tmc = TMC6460Serial(port=sys.argv[1], baudrate=115200)
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {sys.argv[1]} OK")

    try:
        # 编码器 (确保芯片正常)
        print("编码器配置...")
        setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=1)
        tmc.write_register(0x103, 0xFFFF12C0)
        time.sleep(0.1)

        # GDRV 使能
        gdrv = tmc.read_register(0x101)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(0x101, gdrv)
        time.sleep(0.1)

        # MOTOR_MOTION: TORQUE + RAMP_EN + RAMP_USE_PHI_E + RAMP_MODE_VEL
        motion = (1 << 15) | (1 << 14) | (1 << 13) | (2 << 9) | (3 << 7) | 1
        tmc.write_register(0x100, motion)
        # Ramp 参数
        tmc.write_register(0x1CE, 0x10000)  # V_MAX
        tmc.write_register(0x1CA, 0)        # V_START
        tmc.write_register(0x1C4, 0x00020000)  # A1
        tmc.write_register(0x1C6, 0x40000)  # A_MAX
        tmc.write_register(0x150, 0)        # VEL_TARGET=0 (静止)
        print(f"MOTOR_MOTION=0x{motion:08X}  VEL_TARGET=0")

        # 试读 ramp 寄存器
        test_addrs = [0x1C0, 0x1C1, 0x1C3, 0x1C4, 0x1C6, 0x1CE, 0x1D0, 0x1D1, 0x1D4]

        print(f"\n{'地址':>8s} {'值':>14s} {'状态'}")
        print(f"{'---':>8} {'---':>14} {'---'}")
        for addr in test_addrs:
            val = tmc.read_register(addr)
            if val is not None:
                print(f"0x{addr:04X}   0x{val:08X}    OK")
            else:
                print(f"0x{addr:04X}   {'---':>14}    FAIL")

    finally:
        tmc.disconnect()
        print("\n已断开")

if __name__ == "__main__":
    main()
