#!/usr/bin/env python3
"""
TMC6460 PRBS 数据采集脚本（仅采集 + 绘图，不做分析）

配置：
  - 波特率: 2M
  - RTMI 采样率: ~16.7kHz (sampling=2, 2M+2ch 上限)
  - PRBS 频率: ~8.3kHz (ratio=5)
  - 采集时长: 2s
  - 采集信号: PIDIN_FLUX_TARGET_LIMITED(0x164) + PID_FLUX_ACTUAL(0x153)

用法：
  python prbs_capture.py COM10 --R 2.01 --L 0.0001118 --plot
"""

import sys, os, time, argparse, threading, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

# ── 寄存器地址 ──
REG_MOTOR_MOTION   = 0x100
REG_PWM_PERIOD     = 0x103
REG_CSA_GAIN       = 0x0C3
REG_FLUX_COEFF     = 0x142
REG_TORQUE_COEFF   = 0x143
REG_TF_LIMITS      = 0x14A
REG_TF_TARGET      = 0x14E
REG_TF_ACTUAL      = 0x153      # [31:16]=flux_actual, [15:0]=torque_actual
REG_PIDIN_TF_LIMIT = 0x164      # [31:16]=flux_target_limited, [15:0]=torque_target_limited
REG_RAMP_V_MAX     = 0x1CE
REG_RAMP_V_START   = 0x1CA
REG_RAMP_A1        = 0x1C4
REG_RAMP_A_MAX     = 0x1C6
REG_PHI_E_OFFSET   = 0x242
REG_GDRV           = 0x101
REG_PRBS_AMPLITUDE = 0x174
REG_PRBS_DOWN_SAMPLING_RATIO = 0x175

# ── 常量 ──
MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0 / 4.0 * 0.982
MAX_RAW = 8192
PWM_FREQ = 50000
RTMI_BAUD = 2000000
RTMI_SAMPLING = 2          # f_RTMI = 50000/3 ≈ 16667 Hz (2M baud + 2ch 上限)
PRBS_RATIO = 5             # f_PRBS = 50000/6 ≈ 8333 Hz


def raw_to_ma(raw):
    if raw > 32767:
        raw -= 65536
    return raw * MA_PER_COUNT


def ma_to_raw(ma):
    return max(-MAX_RAW, min(MAX_RAW, int(ma / MA_PER_COUNT)))


# ── 数据采集器 ──
class Collector:
    """双通道采集器: ch0=target(0x164), ch1=actual(0x153)"""
    def __init__(self):
        self.target_raw = []   # [(t, raw)]
        self.actual_raw = []
        self._lock = threading.Lock()
        self._on = False

    def start(self):
        with self._lock:
            self.target_raw.clear()
            self.actual_raw.clear()
            self._on = True

    def stop(self):
        with self._lock:
            self._on = False

    def cb(self, ch_id, raw):
        if not self._on:
            return
        with self._lock:
            if ch_id == 0:
                self.target_raw.append((time.time(), raw & 0xFFFF))
            elif ch_id == 1:
                self.actual_raw.append((time.time(), raw & 0xFFFF))

    def unpack(self):
        """解包: 0x164→flux_target, 0x153→flux_actual (高16位)"""
        with self._lock:
            tgt = list(self.target_raw)
            act = list(self.actual_raw)

        def extract_flux(raw_list):
            """从 32-bit RTMI 数据中提取 flux (高16位 signed)"""
            out = []
            for t, val in raw_list:
                hi = (val >> 16) & 0xFFFF
                if hi > 32767:
                    hi -= 65536
                out.append((t, hi * MA_PER_COUNT))
            return out

        return extract_flux(tgt), extract_flux(act)


# ── PI 计算 ──
def compute_pi(R, L, f_pwm=PWM_FREQ, bw_ratio=10):
    f_bw = f_pwm / bw_ratio
    kp = 2 * math.pi * f_bw * L
    ki = 2 * math.pi * f_bw * R
    dt = 1.0 / f_pwm
    p_reg = max(1, min(65535, int(kp * 256)))
    i_reg = max(0, min(65535, int(ki * dt * 256)))
    return p_reg, i_reg, kp, ki, f_bw


def verify_write(tmc, addr, expected, retries=5):
    for i in range(retries):
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
            time.sleep(0.01)
            tmc.ser.reset_input_buffer()
        tmc.write_register(addr, expected)
        time.sleep(0.01)
        rb = tmc.read_register(addr)
        if rb == expected:
            return True, rb
        time.sleep(0.05)
    return False, rb


def write_pi_reliable(tmc, p_reg, i_reg):
    was_running = tmc._rtmi_running
    if was_running:
        tmc.stop_rtmi()
        time.sleep(0.1)
    target = (p_reg << 16) | (i_reg & 0xFFFF)
    ok, rb = verify_write(tmc, REG_FLUX_COEFF, target)
    if ok:
        tmc.write_register(REG_TORQUE_COEFF, target)
    if was_running:
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        tmc.start_rtmi({0: REG_PIDIN_TF_LIMIT, 1: REG_TF_ACTUAL},
                       sampling=RTMI_SAMPLING, callback=lambda c, d: None)
        time.sleep(0.3)
    return ok, rb


def write_reg_reliable(tmc, addr, data):
    was_running = tmc._rtmi_running
    if was_running:
        tmc.stop_rtmi()
        time.sleep(0.1)
    if tmc.ser and tmc.ser.is_open:
        tmc.ser.reset_input_buffer()
    tmc.write_register(addr, data)
    rb = tmc.read_register(addr)
    if was_running:
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        tmc.start_rtmi({0: REG_PIDIN_TF_LIMIT, 1: REG_TF_ACTUAL},
                       sampling=RTMI_SAMPLING, callback=lambda c, d: None)
        time.sleep(0.3)
    return rb


# ── 主流程 ──
def main():
    parser = argparse.ArgumentParser(description="TMC6460 PRBS capture (no analysis)")
    parser.add_argument("port", help="COM port")
    parser.add_argument("--R", type=float, required=True, help="Motor resistance (ohm)")
    parser.add_argument("--L", type=float, required=True, help="Motor inductance (H)")
    parser.add_argument("--offset", default="0xFFFF962B", help="Phi_e offset")
    parser.add_argument("--poles", type=int, default=1, help="Pole pairs")
    parser.add_argument("--prbs-amplitude", type=float, default=200, help="PRBS amplitude (mA)")
    parser.add_argument("--duration", type=float, default=2.0, help="Capture duration (s)")
    parser.add_argument("--bw-ratio", type=int, default=10, help="f_PWM/bandwidth ratio for PI calc")
    parser.add_argument("--plot", action="store_true", help="Save plot image")
    parser.add_argument("--plot-dir", default=".", help="Plot output directory")
    args = parser.parse_args()

    offset = int(args.offset, 16) if args.offset.startswith("0x") else int(args.offset)

    # ── 连接 ──
    # 先用低波特率唤醒芯片，停掉可能残留的 RTMI
    tmc_wake = TMC6460Serial(port=args.port, baudrate=460800)
    if tmc_wake.connect():
        try:
            tmc_wake.write_register(0x340, 0x00000000)  # 停 RTMI
            tmc_wake.write_register(0x174, 0x00000000)  # 停 PRBS
            tmc_wake.write_register(0x14E, 0x00000000)  # 目标归零
            time.sleep(0.1)
        except:
            pass
        tmc_wake.disconnect()
        time.sleep(0.2)

    tmc = TMC6460Serial(port=args.port, baudrate=RTMI_BAUD)
    if not tmc.connect():
        print("FAIL: connect")
        return
    print(f"Connected {args.port} @ {RTMI_BAUD}")
    # 清空 UART 缓冲区
    if tmc.ser and tmc.ser.is_open:
        tmc.ser.reset_input_buffer()
        time.sleep(0.1)
        tmc.ser.reset_input_buffer()

    coll = Collector()

    try:
        # ═══════════════════════════════════════════
        # Phase 1: 硬件配置
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print("Phase 1: Hardware config")
        # 编码器初始化（重试3次）
        for enc_try in range(3):
            ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=args.poles)
            if ok:
                break
            print(f"  Encoder attempt {enc_try+1}: {msg}, retrying...")
            # 复位 IO Controller
            tmc.write_register(0x381, 0x00000000)
            tmc.write_register(0x382, 0x00000000)
            time.sleep(0.5)
        print(f"  Encoder: {msg}")
        if not ok:
            return

        tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
        tmc.write_register(REG_PHI_E_OFFSET, offset)
        rb = tmc.read_register(REG_PHI_E_OFFSET)
        print(f"  OFFSET 0x{offset:08X} -> 0x{rb:08X}" if rb else "  OFFSET FAIL")
        tmc.write_register(REG_CSA_GAIN, 3)
        tmc.write_register(REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

        gdrv = tmc.read_register(REG_GDRV)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(REG_GDRV, gdrv)

        # MOTION_MODE=2 (TORQUE), RAMP_EN=0
        motion = (1 << 15) | (1 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (args.poles & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        print(f"  GDRV=0x{gdrv:08X} MOTION=0x{motion:08X}")

        # ═══════════════════════════════════════════
        # Phase 2: 设置 PI
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print(f"Phase 2: PI (R={args.R}, L={args.L*1e6:.1f}uH, bw_ratio={args.bw_ratio})")
        p0, i0, kp, ki, f_bw = compute_pi(args.R, args.L, PWM_FREQ, args.bw_ratio)
        print(f"  f_bw={f_bw:.0f}Hz Kp={kp:.4f} Ki={ki:.2f}")
        print(f"  P={p0} I={i0} -> 0x{(p0<<16|i0):08X}")
        ok, rb = write_pi_reliable(tmc, p0, i0)
        print(f"  Write: {'OK' if ok else 'FAIL'} (0x{rb:08X})" if rb else "  Write FAIL")

        # ═══════════════════════════════════════════
        # Phase 3: PRBS 采集
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        f_prbs = PWM_FREQ / (PRBS_RATIO + 1)
        f_rtmi = PWM_FREQ / (RTMI_SAMPLING + 1)
        print(f"Phase 3: PRBS capture")
        print(f"  PRBS amp={args.prbs_amplitude}mA  f_PRBS={f_prbs:.0f}Hz  (ratio={PRBS_RATIO})")
        print(f"  RTMI f={f_rtmi:.0f}Hz  (sampling={RTMI_SAMPLING})")
        print(f"  Duration={args.duration}s  Baud={RTMI_BAUD}")

        # 切换到 PRBS_FLUX 模式
        motion_prbs = (1 << 15) | (1 << 14) | (6 << 9) | (3 << 7) | (args.poles & 0x7F)
        rb_motion = write_reg_reliable(tmc, REG_MOTOR_MOTION, motion_prbs)
        print(f"  MOTION=0x{motion_prbs:08X} (PRBS_FLUX) rb=0x{rb_motion:08X}" if rb_motion else "  MOTION FAIL")

        rb_amp = write_reg_reliable(tmc, REG_PRBS_AMPLITUDE, ma_to_raw(args.prbs_amplitude) & 0xFFFF)
        print(f"  PRBS_AMP={ma_to_raw(args.prbs_amplitude)} rb=0x{rb_amp:08X}" if rb_amp else "  PRBS_AMP FAIL")

        rb_ratio = write_reg_reliable(tmc, REG_PRBS_DOWN_SAMPLING_RATIO, PRBS_RATIO)
        print(f"  PRBS_RATIO={PRBS_RATIO} rb=0x{rb_ratio:08X}" if rb_ratio else "  PRBS_RATIO FAIL")

        # 启动 RTMI 采集
        tmc.stop_rtmi()
        time.sleep(0.3)  # 等芯片完全停止 RTMI
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
            time.sleep(0.05)
            tmc.ser.reset_input_buffer()

        coll.start()
        tmc.start_rtmi(
            {0: REG_PIDIN_TF_LIMIT, 1: REG_TF_ACTUAL},
            sampling=RTMI_SAMPLING,
            callback=coll.cb
        )
        time.sleep(0.3)  # 稳定一下

        # ── 采集 ──
        print(f"  Collecting... ", end="", flush=True)
        time.sleep(args.duration)
        coll.stop()
        print("done")

        # Debug: 原始数据检查
        print(f"  [DBG] target_raw count={len(coll.target_raw)}, actual_raw count={len(coll.actual_raw)}")
        if coll.target_raw:
            print(f"  [DBG] target_raw[0:5] = {[(hex(v), f'{t:.6f}') for t,v in coll.target_raw[:5]]}")
        if coll.actual_raw:
            print(f"  [DBG] actual_raw[0:5] = {[(hex(v), f'{t:.6f}') for t,v in coll.actual_raw[:5]]}")

        # ═══════════════════════════════════════════
        # Phase 4: 停 PRBS、停 RTMI
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print("Phase 4: Stop PRBS & RTMI")

        tmc.stop_rtmi()
        time.sleep(0.1)

        # 停 PRBS：PRBS_AMPLITUDE 写 0 → PRBS_REG 复位全 1，输出归零
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        tmc.write_register(REG_PRBS_AMPLITUDE, 0)

        # 恢复 TORQUE 模式
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_TF_TARGET, 0)
        print(f"  Restored MOTION=0x{motion:08X} (TORQUE)")

        # ═══════════════════════════════════════════
        # Phase 5: 解包数据
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print("Phase 5: Data summary")
        tgt, act = coll.unpack()
        print(f"  Target (flux): {len(tgt)} points")
        print(f"  Actual (flux): {len(act)} points")

        if tgt:
            t0 = tgt[0][0]
            tgt_ms = [(t - t0) * 1000 for t, v in tgt]
            tgt_ma = [v for t, v in tgt]
            print(f"  Target: [{min(tgt_ma):.0f}, {max(tgt_ma):.0f}] mA")
        if act:
            act_ms = [(t - act[0][0]) * 1000 for t, v in act]
            act_ma = [v for t, v in act]
            print(f"  Actual: [{min(act_ma):.0f}, {max(act_ma):.0f}] mA")

        # ═══════════════════════════════════════════
        # Phase 6: 绘图
        # ═══════════════════════════════════════════
        if args.plot and tgt and act:
            try:
                import matplotlib
                matplotlib.use('Agg')
                import matplotlib.pyplot as plt

                fig, axes = plt.subplots(2, 1, figsize=(14, 8), sharex=True)
                fig.suptitle(
                    f'TMC6460 PRBS Capture\n'
                    f'R={args.R}Ω L={args.L*1e6:.1f}uH  '
                    f'f_PRBS={f_prbs:.0f}Hz  f_RTMI={f_rtmi:.0f}Hz  '
                    f'amp={args.prbs_amplitude}mA  {args.duration}s',
                    fontsize=12
                )

                # 上图: target + actual
                ax1 = axes[0]
                ax1.plot(tgt_ms, tgt_ma, 'b-', lw=0.5, alpha=0.8, label='Target (flux)')
                ax1.plot(act_ms, act_ma, 'r-', lw=0.5, alpha=0.8, label='Actual (flux)')
                ax1.set_ylabel('Current (mA)')
                ax1.legend(loc='upper right')
                ax1.grid(True, alpha=0.3)
                ax1.set_title(f'Flux Target vs Actual  ({len(tgt)} / {len(act)} pts)')

                # 下图: 误差
                ax2 = axes[1]
                # 对齐时间轴（用最近点插值）
                if len(tgt_ms) == len(act_ms):
                    err_ma = [a - t for t, a in zip(tgt_ma, act_ma)]
                    ax2.plot(tgt_ms, err_ma, 'g-', lw=0.5, alpha=0.8)
                else:
                    # 长度不一致时简单画 actual
                    ax2.plot(act_ms, act_ma, 'g-', lw=0.5, alpha=0.8, label='Actual (raw)')
                    ax2.legend(loc='upper right')
                ax2.set_ylabel('Error (mA)')
                ax2.set_xlabel('Time (ms)')
                ax2.grid(True, alpha=0.3)
                ax2.set_title('Tracking Error')

                plt.tight_layout()
                p = os.path.join(args.plot_dir, 'prbs_capture.png')
                plt.savefig(p, dpi=150)
                print(f"\n  Plot saved: {p}")
                plt.close()
            except Exception as e:
                print(f"\n  Plot fail: {e}")

        # ── 清理 ──
        tmc.stop_rtmi()

    except KeyboardInterrupt:
        print("\nInterrupted")
    finally:
        try:
            tmc.write_register(REG_TF_TARGET, 0)
            tmc.write_register(REG_PRBS_AMPLITUDE, 0)
            tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (args.poles & 0x7F))
        except:
            pass
        tmc.disconnect()
        print("Disconnected")


if __name__ == "__main__":
    main()
