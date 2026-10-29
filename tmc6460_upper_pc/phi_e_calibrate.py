#!/usr/bin/env python3
"""
TMC6460 电角度标定 v6 — 14-bit 周期映射, 无解缠绕

原理:
  14-bit 绝对值编码器: 每 360° 电角度 = 编码器回同一位置
  无需跨圈跟踪, 所有点投影到 deg%360 → enc_raw
  正反转统一取平均, 4 点线性拟合

用法:
  python phi_e_calibrate.py COM10
"""

import sys, os, time, argparse
from collections import defaultdict
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
REG_POS_TARGET   = 0x152
REG_RAMP_PHI_E   = 0x1C3
REG_RAMP_V_MAX   = 0x1CE
REG_RAMP_V_START = 0x1CA
REG_RAMP_A1      = 0x1C4
REG_RAMP_A_MAX   = 0x1C6
REG_PHI_EXT_A    = 0x24D
REG_MUL_FACTOR   = 0x24C

ANGLE_TARGETS = {0:0, 90:0x4000, 180:0x8000, 270:0xC000}


def read_enc(tmc):
    val = tmc.read_register(REG_PHI_EXT_A)
    return None if val is None else (val & 0x3FFF)


def wait_arrival(tmc, target16, timeout_s=3.0):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(0.05)
        pe = tmc.read_register(REG_RAMP_PHI_E)
        if pe is not None and abs(pe - target16) < 0x800:
            return pe
    return tmc.read_register(REG_RAMP_PHI_E)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("port")
    parser.add_argument("--flux-ma", type=float, default=200)
    parser.add_argument("--poles", type=int, default=1)
    parser.add_argument("--settle", type=float, default=1.0)
    args = parser.parse_args()

    tmc = TMC6460Serial(port=args.port, baudrate=115200)
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {args.port} OK\n")

    try:
        tmc.write_register(REG_MOTOR_MOTION, (3<<7)|args.poles)
        tmc.write_register(REG_TF_TARGET, 0)
        time.sleep(0.3)

        # Phase 1
        print("Phase 1: 编码器")
        ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=args.poles)
        print(f"  {msg}")
        if not ok: return
        tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
        time.sleep(0.05)

        mul = tmc.read_register(REG_MUL_FACTOR) or 4
        print(f"  PHI_E_MUL_FACTOR = {mul}")

        # Phase 2
        print("\nPhase 2: TORQUE + RAMP_POS")
        tmc.write_register(REG_CSA_GAIN, 3)
        tmc.write_register(REG_TORQUE_COEFF, (64<<16)|48)
        tmc.write_register(REG_FLUX_COEFF, (64<<16)|48)
        MAX_RAW = 8192  # 4x CSA: 32768/4
        # LS_RES_ON=3, Table 20: 1LSb=0.00164/8*4/4*0.982=0.2013mA
        MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0/4.0 * 0.982
        COUNT_PER_MA = 1.0 / (0.00164 / 8.0 * 0.982)
        tmc.write_register(REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

        gdrv = tmc.read_register(0x101)
        gdrv |= (1<<31)|(1<<16)
        tmc.write_register(0x101, gdrv)

        motion = (1<<15)|(1<<14)|(0<<13)|(2<<9)|(3<<7)|(args.poles&0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        tmc.write_register(REG_TF_TARGET, min(int(args.flux_ma / MA_PER_COUNT), MAX_RAW))
        time.sleep(0.3)

        # ===== 扫描 =====
        DEGS = list(range(0, 721, 90))
        all_data = []  # [(deg, enc_raw), ...]

        def scan(label, order):
            print(f"\n{'='*55}")
            print(f"  {label}")
            print(f"  {'步':>3s}  {'deg':>5s}  {'target':>10s}  {'PHI_E':>10s}  {'enc_raw':>8s}")
            print(f"  {'-'*3}  {'-'*5}  {'-'*10}  {'-'*10}  {'-'*8}")

            for i, deg in enumerate(order):
                tgt = ANGLE_TARGETS[deg % 360]
                tmc.write_register(REG_POS_TARGET, tgt)
                wait_arrival(tmc, tgt)
                time.sleep(args.settle)

                pe = tmc.read_register(REG_RAMP_PHI_E)
                time.sleep(0.05)
                enc = read_enc(tmc)

                pe_s = f"0x{pe:08X}" if pe is not None else "None"
                enc_s = f"{enc}" if enc is not None else "-"
                print(f"  {i:3d}  {deg:5d}  0x{tgt:08X}  {pe_s:>10s}  {enc_s:>8s}")

                if pe is not None and enc is not None:
                    all_data.append((deg, enc))
                time.sleep(0.1)

        scan("Phase 3: 正转 0°→720°", DEGS)
        scan("Phase 4: 反转 720°→0°", DEGS[::-1])

        # ===== Phase 5: 周期映射拟合 =====
        print(f"\n{'='*55}")
        print("Phase 5: 14-bit 周期映射")

        if len(all_data) < 8:
            print("  数据不足"); return

        # 按 deg%360 分组
        groups = defaultdict(list)
        for deg, enc in all_data:
            groups[deg % 360].append(enc)

        angles = [0, 90, 180, 270]
        avg_enc = {a: sum(groups[a])/len(groups[a]) for a in angles}

        print(f"\n  deg  n  平均 enc_raw")
        for a in angles:
            vals = [f"{v}" for v in groups[a]]
            print(f"  {a:3d}  {len(groups[a])}  {avg_enc[a]:.1f}  ({', '.join(vals)})")

        # 4 点解缠绕 (跨 0 点检测)
        uw = [avg_enc[0]]
        for i in range(1, 4):
            delta = avg_enc[angles[i]] - avg_enc[angles[i-1]]
            if delta < -8192:
                delta += 16384   # 正向跨圈
            elif delta > 8192:
                delta -= 16384   # 负向跨圈
            uw.append(uw[-1] + delta)

        # 线性拟合: enc_unwrapped = k × deg + b
        pts = [(angles[i], uw[i]) for i in range(4)]
        n = 4
        sx = sum(d for d, _ in pts)
        sy = sum(e for _, e in pts)
        sxy = sum(d*e for d, e in pts)
        sx2 = sum(d*d for d, _ in pts)
        k = (n*sxy - sx*sy) / (n*sx2 - sx*sx)
        b = (sy - k*sx) / n

        # R²
        ss_res = sum((e - (k*d+b))**2 for d, e in pts)
        ss_tot = sum((e - sy/n)**2 for _, e in pts)
        r2 = 1 - ss_res/ss_tot if ss_tot > 0 else 0

        # OFFSET: 0°电角度时 encoder_14bit = b mod 16384
        b14 = b % 16384
        offset = int(-b14 * mul) & 0xFFFFFFFF

        print(f"\n  (解缠绕后)")
        for i in range(4):
            print(f"  {angles[i]:3d}°: avg={avg_enc[angles[i]]:.1f} → uw={uw[i]:.1f}")

        print(f"\n  enc_uw = {k:.4f} × deg + {b:.2f}")
        print(f"  0°电角度时 enc_14bit = {b % 16384:.1f}")
        print(f"  R² = {r2:.5f}")
        print(f"  PHI_E_MUL_FACTOR = {mul}")
        print(f"  PHI_E_OFFSET = -({b14:.1f}) × {mul} = {offset}")
        print(f"               = 0x{offset:08X}")

        # 全数据残差 (投影到 14-bit)
        print(f"\n  {'deg':>4s}  {'enc_raw':>8s}  {'uw预测%14bit':>12s}  {'残差':>8s}")
        for deg, enc in sorted(set(all_data)):
            pred_uw = k * deg + b
            pred_14 = pred_uw % 16384
            res = enc - pred_14
            # wrap residual to [-8192, 8192]
            if res > 8192: res -= 16384
            elif res < -8192: res += 16384
            print(f"  {deg:4d}  {enc:8d}  {pred_14:12.1f}  {res:+8.1f}")

        print(f"\n  >>> write 0x242 {offset}")

    except KeyboardInterrupt:
        print("\n[中断]")
    finally:
        try:
            tmc.write_register(0x100, (3<<7)|(args.poles&0x7F))
            tmc.write_register(0x14E, 0)
        except: pass
        tmc.disconnect()
        print("\n已断开")


if __name__ == "__main__":
    main()
