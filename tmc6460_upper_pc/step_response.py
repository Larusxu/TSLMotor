#!/usr/bin/env python3
"""
TMC6460 电流环阶跃响应采集

流程：
  1. R/L 计算 PI (2kHz 带宽)
  2. 写入 iQ 和 iD 控制器
  3. 波特率 2M，RTMI 采样率 1kHz
  4. iD 给 500mA 阶跃
  5. 采集 2s 目标值 + 实际值
  6. 停 RTMI，输出图片

用法：
  python step_response.py COM10 --plot
"""

import sys, os, time, argparse, threading, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

# ── 寄存器 ──
REG_MOTOR_MOTION   = 0x100
REG_PWM_PERIOD     = 0x103
REG_CSA_GAIN       = 0x0C3
REG_FLUX_COEFF     = 0x142
REG_TORQUE_COEFF   = 0x143
REG_TF_LIMITS      = 0x14A
REG_TF_TARGET      = 0x14E   # [31:16]=flux_target, [15:0]=torque_target
REG_TF_ACTUAL      = 0x153   # [31:16]=flux_actual, [15:0]=torque_actual
REG_RAMP_V_MAX     = 0x1CE
REG_RAMP_V_START   = 0x1CA
REG_RAMP_A1        = 0x1C4
REG_RAMP_A_MAX     = 0x1C6
REG_PHI_E_OFFSET   = 0x242
REG_GDRV           = 0x101
REG_PRBS_AMPLITUDE = 0x174

# ── 常量 ──
MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0 / 4.0 * 0.982
MAX_RAW = 8192
PWM_FREQ = 50000
BAUD = 2000000
RTMI_SAMPLING = 49   # f_RTMI = 50000/50 = 1000 Hz


def raw_to_ma(raw):
    if raw > 32767:
        raw -= 65536
    return raw * MA_PER_COUNT


def ma_to_raw(ma):
    return max(-MAX_RAW, min(MAX_RAW, int(ma / MA_PER_COUNT)))


def compute_pi(R, L, f_pwm=PWM_FREQ, f_bw=2000):
    """从 R/L/f_bw 计算 PI 寄存器值"""
    kp = 2 * math.pi * f_bw * L
    ki = 2 * math.pi * f_bw * R
    dt = 1.0 / f_pwm
    p_reg = max(1, min(65535, int(kp * 256)))
    i_reg = max(0, min(65535, int(ki * dt * 256)))
    return p_reg, i_reg, kp, ki


# ── 采集器 ──
class Collector:
    def __init__(self):
        self.target = []  # [(t, flux_raw)]
        self.actual = []  # [(t, flux_raw)]
        self._lock = threading.Lock()
        self._on = False

    def start(self):
        with self._lock:
            self.target.clear()
            self.actual.clear()
            self._on = True

    def stop(self):
        with self._lock:
            self._on = False

    def cb(self, ch_id, raw):
        if not self._on:
            return
        if ch_id not in (0, 1):
            return  # 丢弃未配置通道
        with self._lock:
            if ch_id == 0:
                self.target.append((time.time(), raw))
            elif ch_id == 1:
                self.actual.append((time.time(), raw))

    def unpack_flux(self):
        """从 32-bit RTMI 数据提取 flux (高16位 signed) → mA"""
        with self._lock:
            tgt = list(self.target)
            act = list(self.actual)

        # 解包: 0x14E/0x153 布局: [31:16]=torque(iQ), [15:0]=flux(iD)
        # step_response 测试 iD (flux)，读低16位
        def extract(raw_list):
            out = []
            for t, val in raw_list:
                lo = val & 0xFFFF
                if lo > 32767: lo -= 65536
                out.append((t, lo * MA_PER_COUNT))
            return out

        return extract(tgt), extract(act)

    def unpack_raw(self):
        """返回原始32位有符号整数，不转换单位（用于速度/位置环）"""
        with self._lock:
            tgt = list(self.target)
            act = list(self.actual)

        def extract(raw_list):
            out = []
            for t, val in raw_list:
                if val > 0x7FFFFFFF:
                    val -= 0x100000000
                out.append((t, val))
            return out

        return extract(tgt), extract(act)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("port")
    parser.add_argument("--R", type=float, default=2.01)
    parser.add_argument("--L", type=float, default=0.0001118)
    parser.add_argument("--offset", default="0xFFFF962B")
    parser.add_argument("--poles", type=int, default=1)
    parser.add_argument("--target-ma", type=float, default=500, help="iD step target (mA)")
    parser.add_argument("--f-bw", type=int, default=2000, help="Current loop bandwidth (Hz)")
    parser.add_argument("--duration", type=float, default=2.0)
    parser.add_argument("--plot", action="store_true")
    parser.add_argument("--plot-dir", default=".")
    args = parser.parse_args()

    offset = int(args.offset, 16) if args.offset.startswith("0x") else int(args.offset)

    # ── 连接 ──
    tmc = TMC6460Serial(port=args.port, baudrate=BAUD)
    if not tmc.connect():
        print("FAIL: connect")
        return
    print(f"Connected {args.port} @ {BAUD}")

    coll = Collector()

    try:
        # ═══════════════════════════════════════════
        # Phase 1: 硬件配置
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print("Phase 1: Hardware config")
        for enc_try in range(3):
            ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=args.poles)
            if ok:
                break
            print(f"  Encoder attempt {enc_try+1}: {msg}, retrying...")
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

        # MOTION_MODE=2 (TORQUE), RAMP_EN=0, RAMP_USE_PHI_E=0 (use encoder)
        motion = (0 << 15) | (0 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (args.poles & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)
        rb_motion = tmc.read_register(REG_MOTOR_MOTION)
        print(f"  MOTION=0x{motion:08X} readback=0x{rb_motion:08X} {'OK' if rb_motion == motion else 'MISMATCH!'}" if rb_motion else "  MOTION readback FAIL")
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        # 停 PRBS
        tmc.write_register(REG_PRBS_AMPLITUDE, 0)
        print(f"  MOTION=0x{motion:08X} (TORQUE, RAMP_EN=0)")

        # ═══════════════════════════════════════════
        # Phase 2: 计算并写入 PI
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print(f"Phase 2: PI (R={args.R}, L={args.L*1e6:.1f}uH, f_bw={args.f_bw}Hz)")
        p_reg, i_reg, kp, ki = compute_pi(args.R, args.L, PWM_FREQ, args.f_bw)
        print(f"  Kp={kp:.4f} Ki={ki:.2f}")
        print(f"  P={p_reg} I={i_reg} -> 0x{(p_reg<<16|i_reg):08X}")

        # 写 iD (flux)
        pi_val = (p_reg << 16) | (i_reg & 0xFFFF)
        for attempt in range(5):
            tmc.write_register(REG_FLUX_COEFF, pi_val)
            time.sleep(0.01)
            rb = tmc.read_register(REG_FLUX_COEFF)
            if rb == pi_val:
                break
            time.sleep(0.05)
        print(f"  FLUX_COEFF:   write 0x{pi_val:08X} readback 0x{rb:08X} {'OK' if rb==pi_val else 'FAIL'}")

        # 写 iT (torque)
        for attempt in range(5):
            tmc.write_register(REG_TORQUE_COEFF, pi_val)
            time.sleep(0.01)
            rb = tmc.read_register(REG_TORQUE_COEFF)
            if rb == pi_val:
                break
            time.sleep(0.05)
        print(f"  TORQUE_COEFF: write 0x{pi_val:08X} readback 0x{rb:08X} {'OK' if rb==pi_val else 'FAIL'}")

        # 再写一次 MOTION，确保 RAMP_EN=0 生效
        tmc.write_register(REG_MOTOR_MOTION, motion)
        rb_motion = tmc.read_register(REG_MOTOR_MOTION)
        print(f"  MOTION verify: 0x{rb_motion:08X} {'OK' if rb_motion == motion else 'MISMATCH!'}" if rb_motion else "  MOTION verify FAIL")

        # ═══════════════════════════════════════════
        # Phase 3: 阶跃响应采集
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print(f"Phase 3: Step response (iD={args.target_ma}mA, {args.duration}s)")

        # 最后确认 MOTION
        rb_m = tmc.read_register(REG_MOTOR_MOTION)
        ramp_en = (rb_m >> 14) & 1 if rb_m else -1
        print(f"  *** MOTION=0x{rb_m:08X} RAMP_EN={ramp_en} ***" if rb_m else "  *** MOTION readback FAIL ***")

        # 目标归零
        tmc.write_register(REG_TF_TARGET, 0)
        time.sleep(0.3)

        # 启动 RTMI: ch0=目标(0x14E), ch1=实际(0x153)
        tmc.stop_rtmi()
        time.sleep(0.3)
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
            time.sleep(0.05)
            tmc.ser.reset_input_buffer()

        coll.start()
        tmc.start_rtmi(
            {0: REG_TF_TARGET, 1: REG_TF_ACTUAL},
            sampling=RTMI_SAMPLING,
            callback=coll.cb
        )
        time.sleep(0.3)  # RTMI 稳定

        # 发阶跃：iD=500mA, iT=0
        raw_step = ma_to_raw(args.target_ma)
        step_val = raw_step & 0xFFFF  # [15:0]=flux_target (iD)
        print(f"  Step: TF_TARGET = 0x{step_val:08X} (flux={raw_step}, torque=0)")
        tmc.write_register(REG_TF_TARGET, step_val)
        # readback 验证写入是否生效
        rb = tmc.read_register(REG_TF_TARGET)
        print(f"  Step readback: 0x{rb:08X} {'OK' if rb == step_val else 'MISMATCH!'}" if rb else "  Step readback: FAIL")
        # 重置帧计数，打印 step 后前10帧
        coll._frame_cnt = 0
        coll._print_limit = 10

        # 采集
        print(f"  Collecting {args.duration}s... ", end="", flush=True)
        time.sleep(args.duration)
        coll.stop()
        print("done")

        # 停 RTMI，目标归零
        tmc.stop_rtmi()
        time.sleep(0.1)
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        tmc.write_register(REG_TF_TARGET, 0)

        # ═══════════════════════════════════════════
        # Phase 4: 数据
        # ═══════════════════════════════════════════
        print("\n" + "=" * 60)
        print("Phase 4: Data")
        tgt, act = coll.unpack_flux()
        print(f"  Target: {len(tgt)} points")
        print(f"  Actual: {len(act)} points")
        if tgt:
            tgt_ma = [v for _, v in tgt]
            print(f"  Target flux: [{min(tgt_ma):.0f}, {max(tgt_ma):.0f}] mA")
        if act:
            act_ma = [v for _, v in act]
            print(f"  Actual flux: [{min(act_ma):.0f}, {max(act_ma):.0f}] mA")

        # Debug: 原始 RTMI 数据
        # (已关闭，需要时取消注释)

        # ═══════════════════════════════════════════
        # Phase 5: 绘图
        # ═══════════════════════════════════════════
        if args.plot and tgt and act:
            try:
                import matplotlib
                matplotlib.use('Agg')
                import matplotlib.pyplot as plt

                # 去掉前100个点（RTMI启动不稳定）
                tgt = tgt[100:]
                act = act[100:]
                t0 = min(tgt[0][0], act[0][0])  # 统一时间零点
                tgt_ms = [(t - t0) * 1000 for t, _ in tgt]
                tgt_ma = [v for _, v in tgt]
                act_ms = [(t - t0) * 1000 for t, _ in act]
                act_ma = [v for _, v in act]

                fig, axes = plt.subplots(2, 1, figsize=(14, 8), sharex=True)
                fig.suptitle(
                    f'TMC6460 Current Loop Step Response\n'
                    f'R={args.R}Ω L={args.L*1e6:.1f}uH  f_bw={args.f_bw}Hz  '
                    f'P={p_reg} I={i_reg}  iD step={args.target_ma}mA',
                    fontsize=12
                )

                # 上图: target + actual
                ax1 = axes[0]
                ax1.plot(tgt_ms, tgt_ma, 'b-', lw=0.8, alpha=0.8, label='Target (flux)')
                ax1.plot(act_ms, act_ma, 'r-', lw=0.8, alpha=0.8, label='Actual (flux)')
                ax1.set_ylabel('Current (mA)')
                ax1.legend(loc='upper right')
                ax1.grid(True, alpha=0.3)
                ax1.set_title(f'Target vs Actual  ({len(tgt)} / {len(act)} pts)')

                # 下图: 误差
                ax2 = axes[1]
                if len(tgt_ms) == len(act_ms):
                    err = [a - t for t, a in zip(tgt_ma, act_ma)]
                    ax2.plot(tgt_ms, err, 'g-', lw=0.8, alpha=0.8)
                else:
                    # 长度不一致，分别画
                    ax2.plot(act_ms, act_ma, 'r-', lw=0.5, label='Actual')
                    ax2.legend()
                ax2.set_ylabel('Error (mA)')
                ax2.set_xlabel('Time (ms)')
                ax2.grid(True, alpha=0.3)
                ax2.set_title('Tracking Error')

                plt.tight_layout()
                p = os.path.join(args.plot_dir, 'step_response.png')
                plt.savefig(p, dpi=150)
                print(f"\n  Plot: {p}")
                plt.close()
            except Exception as e:
                print(f"\n  Plot fail: {e}")

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
