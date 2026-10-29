#!/usr/bin/env python3
"""
TMC6460 TORQUE 电流环诊断 — I_D=200mA, I_Q=0, 电角度=0, 保持10s
每 0.5s 读: I_D_actual, I_Q_actual, RAMP_PHI_E, 编码器

用法:
  python torque_diag.py COM10
"""

import sys, os, time, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

# ==== 寄存器 ====
REG_MOTOR_MOTION = 0x100
REG_PWM_PERIOD   = 0x103
REG_CSA_GAIN     = 0x0C3
REG_FLUX_COEFF   = 0x142   # D轴 PI
REG_TORQUE_COEFF = 0x143   # Q轴 PI
REG_TF_LIMITS    = 0x14A
REG_TF_TARGET    = 0x14E   # [31:16]=TORQUE [15:0]=FLUX
REG_TF_ACTUAL    = 0x153   # [31:16]=I_Q_actual [15:0]=I_D_actual
REG_VEL_TARGET   = 0x150
REG_RAMP_PHI_E   = 0x1C3
REG_RAMP_V_MAX   = 0x1CE
REG_RAMP_V_START = 0x1CA
REG_RAMP_A1      = 0x1C4
REG_RAMP_A_MAX   = 0x1C6
REG_PHI_EXT_A    = 0x24D


def main():
    parser = argparse.ArgumentParser(description="TMC6460 电流环诊断")
    parser.add_argument("port")
    parser.add_argument("--flux-ma", type=float, default=200)
    parser.add_argument("--tp", type=int, default=64)
    parser.add_argument("--ti", type=int, default=48)
    parser.add_argument("--poles", type=int, default=1)
    args = parser.parse_args()

    tmc = TMC6460Serial(port=args.port, baudrate=115200)
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {args.port} OK")

    try:
        # Phase 1: 编码器
        print("Phase 1: 编码器配置...")
        ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=args.poles)
        print(f"  {msg}")
        if not ok:
            print("[FAIL]"); return
        tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
        time.sleep(0.05)
        enc0 = tmc.read_register(REG_PHI_EXT_A)
        print(f"  编码器初始: 0x{enc0:08X}" if enc0 else "  编码器: FAIL")

        # Phase 2: 电流环
        print("\nPhase 2: TORQUE 电流环配置")

        tmc.write_register(REG_CSA_GAIN, 3)   # 4x

        tp, ti = args.tp, args.ti
        tmc.write_register(REG_TORQUE_COEFF, (tp << 16) | (ti & 0xFFFF))
        tmc.write_register(REG_FLUX_COEFF,   (tp << 16) | (ti & 0xFFFF))
        # LS_RES_ON=3, CSA=4x, Table 20: 1LSb=0.00164/8*4/4*0.982=0.2013mA
        MAX_RAW = 8192  # 2^15 / gain=4
        MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0/4.0 * 0.982  # 0.20131 mA/LSB
        COUNT_PER_MA = 1.0 / (0.00164 / 8.0 * 0.982)  # ~4967
        tmc.write_register(REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

        # 驱动使能
        gdrv = tmc.read_register(0x101)
        if gdrv is None:
            print("[FAIL] GDRV"); return
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(0x101, gdrv)
        time.sleep(0.05)

        # MOTOR_MOTION: TORQUE + RAMP_USE_PHI_E + RAMP_EN + RAMP_MODE_VEL
        motion = (1 << 15) | (1 << 14) | (1 << 13) | (2 << 9) | (3 << 7) | (args.poles & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)

        # Ramp 参数 + 静止
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        tmc.write_register(REG_VEL_TARGET, 0)

        flux_target = min(int(args.flux_ma / MA_PER_COUNT), MAX_RAW)
        tmc.write_register(REG_TF_TARGET, flux_target)
        time.sleep(0.3)

        print(f"  MOTOR_MOTION=0x{motion:08X}")
        print(f"  TORQUE_P={tp}({tp/256:.3f})  TORQUE_I={ti}({ti/256:.3f})")
        print(f"  FLUX_P={tp}({tp/256:.3f})  FLUX_I={ti}({ti/256:.3f})")
        print(f"  TORQUE_LIMIT={MAX_RAW}  FLUX_LIMIT={MAX_RAW}")
        print(f"  FLUX_TARGET={flux_target}(≈{flux_target*MA_PER_COUNT:.0f}mA)  TORQUE_TARGET=0")
        print(f"  VEL_TARGET=0(静止)  CSA=4x  CP+DRV=ON")

        # Phase 3: 10s 采样
        print("\nPhase 3: 采样 10s (间隔 0.5s)")
        print(f"  {'t(s)':>5s} {'I_D_raw':>8s} {'I_D~mA':>8s} {'I_Q_raw':>8s} {'I_Q~mA':>8s} {'PHI_E':>14s} {'编码器':>10s}")
        print(f"  {'-'*5} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*14} {'-'*10}")

        for i in range(21):  # 0~20, 共21次
            tf = tmc.read_register(REG_TF_ACTUAL)    # 0x153
            time.sleep(0.05)
            pe = tmc.read_register(REG_RAMP_PHI_E)   # 0x1C3
            time.sleep(0.05)
            enc = tmc.read_register(REG_PHI_EXT_A)   # 0x24D

            # 注意: 手册 p156 — TF_ACTUAL = [31:16]=I_Q, [15:0]=I_D
            id_raw = tf & 0xFFFF if tf is not None else None
            iq_raw = ((tf >> 16) & 0xFFFF) if tf is not None else None
            # signed int16 → mA (Table 20: LS_RES_ON=3, CSA=4x)
            def s16(v):
                return v - 65536 if v > 32767 else v
            def raw2ma(v):
                return s16(v) * MA_PER_COUNT
            id_ma = f"{raw2ma(id_raw):.0f}" if id_raw is not None else "---"
            iq_ma = f"{raw2ma(iq_raw):.0f}" if iq_raw is not None else "---"

            pe_str = f"0x{pe:08X}" if pe is not None else "-"
            enc_str = f"{enc & 0x3FFF}" if enc is not None else "-"

            t = i * 0.5
            print(f"  {t:5.1f} {str(id_raw):>8s} {id_ma:>8s} {str(iq_raw):>8s} {iq_ma:>8s} {pe_str:>14s} {enc_str:>10s}")

            time.sleep(0.5)

    except KeyboardInterrupt:
        print("\n[中断]")
    finally:
        try:
            tmc.write_register(REG_VEL_TARGET, 0)
            tmc.write_register(REG_TF_TARGET, 0)
            tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (args.poles & 0x7F))
        except:
            pass
        tmc.disconnect()
        print("\n已断开")


if __name__ == "__main__":
    main()
