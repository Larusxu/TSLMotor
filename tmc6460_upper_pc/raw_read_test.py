#!/usr/bin/env python3
"""诊断：原始串口读 0x1C3 — 看 TMC6460 到底回了几字节"""

import sys, os, time, struct, serial
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial, make_read_request
from tmc6460_encoder import setup_encoder

def main():
    if len(sys.argv) < 2:
        print("用法: python raw_read_test.py COM10"); return

    tmc = TMC6460Serial(port=sys.argv[1], baudrate=115200)
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {sys.argv[1]} OK")

    try:
        setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=1)
        tmc.write_register(0x103, 0xFFFF12C0)
        time.sleep(0.05)

        gdrv = tmc.read_register(0x101)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(0x101, gdrv)

        # TORQUE + RAMP_EN + RAMP_USE_PHI_E + RAMP_MODE_VEL
        motion = (1 << 15) | (1 << 14) | (1 << 13) | (2 << 9) | (3 << 7) | 1
        tmc.write_register(0x100, motion)
        tmc.write_register(0x150, 0)
        tmc.write_register(0x142, (64 << 16) | 48)
        tmc.write_register(0x143, (64 << 16) | 48)
        tmc.write_register(0x14E, 4000)
        time.sleep(0.3)

        ser = tmc.ser
        print("\n直接用串口读 (不走 read_register):")

        for i in range(5):
            # 读 0x153 对比
            req = make_read_request(0x153)
            ser.reset_input_buffer()
            ser.write(req)
            time.sleep(0.05)
            if ser.in_waiting:
                raw = ser.read(ser.in_waiting)
                print(f"  0x153 → {len(raw)} bytes: {raw.hex(' ')}")
            else:
                print(f"  0x153 → 0 bytes (timeout)")

            # 读 0x1C3
            req = make_read_request(0x1C3)
            ser.reset_input_buffer()
            ser.write(req)
            time.sleep(0.05)
            if ser.in_waiting:
                raw = ser.read(ser.in_waiting)
                print(f"  0x1C3 → {len(raw)} bytes: {raw.hex(' ')}")
            else:
                print(f"  0x1C3 → 0 bytes (timeout)")

            print()

        # 关电流环再试
        tmc.write_register(0x14E, 0)
        time.sleep(0.3)
        print("=== 关电流后 ===")
        for addr in [0x153, 0x1C3]:
            req = make_read_request(addr)
            ser.reset_input_buffer()
            ser.write(req)
            time.sleep(0.05)
            if ser.in_waiting:
                raw = ser.read(ser.in_waiting)
                print(f"  0x{addr:04X} → {len(raw)} bytes: {raw.hex(' ')}")
            else:
                print(f"  0x{addr:04X} → 0 bytes (timeout)")

    finally:
        tmc.disconnect()
        print("\n已断开")

if __name__ == "__main__":
    main()
