#!/usr/bin/env python3
"""设电角度=90° → 观察 PHI_E, I_D, I_Q, 编码器"""

import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

REG_MOTOR_MOTION = 0x100
REG_PWM_PERIOD   = 0x103
REG_CSA_GAIN     = 0x0C3
REG_FLUX_COEFF   = 0x142
REG_TORQUE_COEFF = 0x143
REG_TF_LIMITS    = 0x14A
REG_TF_TARGET    = 0x14E
REG_TF_ACTUAL    = 0x153
REG_VEL_TARGET   = 0x150
REG_RAMP_POS     = 0x1D1   # RAMPER.POSITION
REG_RAMP_PHI_E   = 0x1C3
REG_RAMP_V_MAX   = 0x1CE
REG_RAMP_V_START = 0x1CA
REG_RAMP_A1      = 0x1C4
REG_RAMP_A_MAX   = 0x1C6
REG_PHI_EXT_A    = 0x24D

DEG_0   = 0x00000000
DEG_90  = 0x40000000
DEG_180 = 0x80000000
DEG_270 = 0xC0000000

def main():
    if len(sys.argv) < 2:
        print("用法: python set_angle_test.py COM10"); return

    tmc = TMC6460Serial(port=sys.argv[1])
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {sys.argv[1]} OK\n")

    try:
        # Phase 1: 编码器
        setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=1)
        tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
        time.sleep(0.05)

        # Phase 2: 电流环
        tmc.write_register(REG_CSA_GAIN, 3)
        tmc.write_register(REG_TORQUE_COEFF, (64 << 16) | 48)
        tmc.write_register(REG_FLUX_COEFF, (64 << 16) | 48)
        tmc.write_register(REG_TF_LIMITS, 0x27102710)

        gdrv = tmc.read_register(0x101)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(0x101, gdrv)
        time.sleep(0.05)

        # MOTOR_MOTION: TORQUE + RAMP_EN + RAMP_USE_PHI_E + RAMP_MODE_POS
        motion = (1 << 15) | (1 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | 1
        tmc.write_register(REG_MOTOR_MOTION, motion)

        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        tmc.write_register(REG_VEL_TARGET, 0)

        flux_target = int(200 / 0.05)
        tmc.write_register(REG_TF_TARGET, flux_target & 0xFFFF)
        time.sleep(0.5)
        print("TORQUE 电流环已启动, RAMP_MODE_POS\n")

        def read_all():
            tf = tmc.read_register(REG_TF_ACTUAL)
            pe = tmc.read_register(REG_RAMP_PHI_E)
            pos = tmc.read_register(REG_RAMP_POS)
            enc = tmc.read_register(REG_PHI_EXT_A)
            time.sleep(0.05)
            return tf, pe, pos, enc

        def show(tf, pe, pos, enc, label=""):
            id_raw = (tf & 0xFFFF) if tf else 0
            iq_raw = ((tf >> 16) & 0xFFFF) if tf else 0
            pe_str = f"0x{pe:08X}" if pe is not None else "None"
            pos_str = f"0x{pos:08X}" if pos is not None else "None"
            enc_str = f"{enc & 0x3FFF}" if enc else "None"
            print(f"  {label:>10s}  PHI_E={pe_str}  RAMP_POS={pos_str}  I_D={id_raw*0.05:.0f}mA  I_Q={iq_raw*0.05:.0f}mA  enc={enc_str}")

        # 先看初始
        tf, pe, pos, enc = read_all()
        show(tf, pe, pos, enc, "初始")

        # 写 PHI_E_OFFSET (0x242) 也不能直接改电角度... 
        # 试试直接写 RAMP_POS (0x1D1)
        print("\n--- 写 RAMP_POS(0x1D1) = 0x40000000 (90°) ---")
        tmc.write_register(REG_RAMP_POS, DEG_90)
        time.sleep(0.5)
        tf, pe, pos, enc = read_all()
        show(tf, pe, pos, enc, "写入后")

        # 再读一次确认
        time.sleep(1.0)
        tf, pe, pos, enc = read_all()
        show(tf, pe, pos, enc, "+1s")

        # 试写 0x152 (PID_POSITION_TARGET)
        print("\n--- 写 PID_POS_TARGET(0x152) = 0x40000000 (90°) ---")
        tmc.write_register(0x152, DEG_90)
        time.sleep(0.5)
        tf, pe, pos, enc = read_all()
        show(tf, pe, pos, enc, "写入后")

        time.sleep(1.0)
        tf, pe, pos, enc = read_all()
        show(tf, pe, pos, enc, "+1s")

    finally:
        tmc.disconnect()
        print("\n已断开")

if __name__ == "__main__":
    main()
