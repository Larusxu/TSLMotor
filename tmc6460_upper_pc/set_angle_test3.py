#!/usr/bin/env python3
"""设 16-bit 电角度: 0°=0x0000, 90°=0x4000, 180°=0x8000, 270°=0xC000"""

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

DEG_0   = 0x00000000
DEG_90  = 0x00004000
DEG_180 = 0x00008000
DEG_270 = 0x0000C000

def main():
    if len(sys.argv) < 2:
        print("用法: python set_angle_test3.py COM10"); return
    tmc = TMC6460Serial(port=sys.argv[1])
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {sys.argv[1]}\n")

    try:
        # 先停机
        print("停机...")
        tmc.write_register(0x100, (3 << 7) | 1)
        tmc.write_register(0x14E, 0)
        time.sleep(0.3)

        # 配置
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

        # RAMP_MODE_POS, 不锁 VEL_TARGET
        motion = (1<<15) | (1<<14) | (0<<13) | (2<<9) | (3<<7) | 1
        tmc.write_register(0x100, motion)
        tmc.write_register(0x1CE, 0x10000)
        tmc.write_register(0x1CA, 0)
        tmc.write_register(0x1C4, 0x00020000)
        tmc.write_register(0x1C6, 0x40000)

        tmc.write_register(0x14E, int(200/0.05) & 0xFFFF)
        time.sleep(0.3)

        def read():
            time.sleep(0.08)
            pe = tmc.read_register(0x1C3); time.sleep(0.05)
            enc = tmc.read_register(0x24D)
            return pe, enc

        pe, enc = read()
        print(f"初始: PHI_E=0x{pe:08X}  enc={enc&0x3FFF}")

        for deg, target in [(0, DEG_0), (90, DEG_90), (180, DEG_180), (270, DEG_270)]:
            print(f"\n>>> 设 {deg}° → 0x152=0x{target:08X}")
            tmc.write_register(0x152, target)
            for w in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]:
                time.sleep(0.5)
                pe, enc = read()
                print(f"  +{w:.1f}s: PHI_E=0x{pe:08X}  enc={enc&0x3FFF}")
                # 到了就跳出
                if pe is not None and abs(pe - target) < 0x1000:
                    break

    finally:
        tmc.write_register(0x100, (3<<7)|1)  # 停机
        tmc.disconnect()
        print("\n已断开")

if __name__ == "__main__":
    main()
