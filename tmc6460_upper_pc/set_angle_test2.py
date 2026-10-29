#!/usr/bin/env python3
"""试 0x152 写电角度 — 不锁 VEL_TARGET"""

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

def main():
    if len(sys.argv) < 2:
        print("用法: python set_angle_test2.py COM10"); return
    tmc = TMC6460Serial(port=sys.argv[1])
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {sys.argv[1]} OK\n")

    try:
        setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=1)
        tmc.write_register(0x103, 0xFFFF12C0)
        time.sleep(0.05)

        tmc.write_register(0x0C3, 3)
        tmc.write_register(0x142, (64 << 16) | 48)
        tmc.write_register(0x143, (64 << 16) | 48)
        tmc.write_register(0x14A, 0x27102710)
        gdrv = tmc.read_register(0x101)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(0x101, gdrv)

        # RAMP_MODE_POS (bit13=0), 不写 VEL_TARGET
        motion = (1<<15) | (1<<14) | (0<<13) | (2<<9) | (3<<7) | 1
        tmc.write_register(0x100, motion)
        tmc.write_register(0x1CE, 0x10000)
        tmc.write_register(0x1CA, 0)
        tmc.write_register(0x1C4, 0x00020000)
        tmc.write_register(0x1C6, 0x40000)
        # ⚠️ 不写 0x150!

        tmc.write_register(0x14E, int(200/0.05) & 0xFFFF)
        time.sleep(0.5)

        def read():
            tf = tmc.read_register(0x153); time.sleep(0.05)
            pe = tmc.read_register(0x1C3); time.sleep(0.05)
            enc = tmc.read_register(0x24D)
            return tf, pe, enc

        tf, pe, enc = read()
        print(f"初始: PHI_E=0x{pe:08X}  enc={enc&0x3FFF}")

        targets = [(0, 0x00000000), (90, 0x40000000), (180, 0x80000000), (270, 0xC0000000)]
        for deg, target in targets:
            print(f"\n>>> 设 {deg}° → 写 0x152=0x{target:08X}")
            tmc.write_register(0x152, target)

            for wait in [0.5, 1.0, 1.5]:
                time.sleep(0.5)
                tf, pe, enc = read()
                print(f"   +{wait:.1f}s: PHI_E=0x{pe:08X}  enc={enc&0x3FFF}")

            # 看看 VEL_TARGET 当前是多少
            vt = tmc.read_register(0x150)
            print(f"   VEL_TARGET=0x{vt:08X}" if vt else "   VEL_TARGET=None")

    finally:
        tmc.disconnect(); print("\n已断开")

if __name__ == "__main__":
    main()
