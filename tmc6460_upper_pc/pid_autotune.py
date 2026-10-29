#!/usr/bin/env python3
"""
TMC6460 电流环 PI 自动整定

方法: 模型辨识 + 经验公式 + 迭代优化
  1. P-only (I=0) 阶跃 → 提取一阶模型 (Kp_plant, τ_plant)
  2. 基于模型计算 P 初始值 (Kp = τ_plant / (Kp_plant * τ_c))
  3. I 初始值 = 让积分器在 20ms 内累积到 P 的满量程输出
  4. 阶跃验证 + 自动迭代修正

用法:
  python pid_autotune.py COM10
  python pid_autotune.py COM10 --target-ma 500 --plot
"""

import sys, os, time, argparse, threading, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

# ========== 寄存器 ==========
REG_MOTOR_MOTION = 0x100
REG_PWM_PERIOD   = 0x103
REG_CSA_GAIN     = 0x0C3
REG_FLUX_COEFF   = 0x142
REG_TORQUE_COEFF = 0x143
REG_TF_LIMITS    = 0x14A
REG_TF_TARGET    = 0x14E
REG_TF_ACTUAL    = 0x153
REG_RAMP_V_MAX   = 0x1CE
REG_RAMP_V_START = 0x1CA
REG_RAMP_A1      = 0x1C4
REG_RAMP_A_MAX   = 0x1C6
REG_PHI_E_OFFSET = 0x242

MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0 / 4.0 * 0.982  # 0.2013 mA/LSB
MAX_RAW = 8192
PWM_FREQ = 50000  # Hz

def raw_to_ma(raw):
    if raw > 32767: raw -= 65536
    return raw * MA_PER_COUNT

def ma_to_raw(ma):
    return max(-MAX_RAW, min(MAX_RAW, int(ma / MA_PER_COUNT)))


# ========== RTMI 采集器 ==========
class RTMICollector:
    def __init__(self):
        self.data = []
        self._lock = threading.Lock()
        self._collecting = False

    def start(self):
        with self._lock:
            self.data.clear()
            self._collecting = True

    def stop(self):
        with self._lock:
            self._collecting = False

    def callback(self, ch_id, raw_data):
        if not self._collecting:
            return
        i_d = raw_data & 0xFFFF
        with self._lock:
            self.data.append((time.time(), i_d))

    def get_data(self):
        with self._lock:
            return list(self.data)


# ========== 工具函数 ==========
def set_pi_verify(tmc, p_reg, i_reg, retries=3):
    """写 PI 参数并验证, 返回是否成功"""
    target = (p_reg << 16) | (i_reg & 0xFFFF)
    for _ in range(retries):
        tmc.write_register(REG_FLUX_COEFF, target)
        time.sleep(0.01)
        tmc.write_register(REG_TORQUE_COEFF, target)
        time.sleep(0.01)
        rb_f = tmc.read_register(REG_FLUX_COEFF)
        rb_t = tmc.read_register(REG_TORQUE_COEFF)
        if rb_f == target and rb_t == target:
            return True
        time.sleep(0.02)
    return False


def step_test(tmc, collector, target_ma, duration_s=0.5):
    """阶跃响应测试"""
    tmc.write_register(REG_TF_TARGET, 0)
    time.sleep(0.3)

    collector.start()
    time.sleep(0.02)

    raw_target = ma_to_raw(target_ma)
    print(f"    [STEP] TF_TARGET=0x{raw_target & 0xFFFF:04X} ({target_ma}mA)")
    tmc.write_register(REG_TF_TARGET, raw_target & 0xFFFF)
    time.sleep(duration_s)

    tmc.write_register(REG_TF_TARGET, 0)
    collector.stop()

    raw_data = collector.get_data()
    print(f"    [STEP] 采集到 {len(raw_data)} 个数据点")
    if raw_data:
        first_vals = [raw_to_ma(d[1]) for d in raw_data[:3]]
        last_vals = [raw_to_ma(d[1]) for d in raw_data[-3:]]
        print(f"    [STEP] 前3={[f'{v:.0f}' for v in first_vals]} "
              f"后3={[f'{v:.0f}' for v in last_vals]}")
    else:
        print(f"    [STEP] 无数据! RTMI 状态: running={tmc.rtmi_running}")

    times = [d[0] for d in raw_data]
    values_ma = [raw_to_ma(d[1]) for d in raw_data]
    return times, values_ma


def extract_model(times, values_ma, step_input_ma):
    """从阶跃响应提取一阶模型"""
    if len(times) < 20:
        return None

    n = len(values_ma)
    y_ss = sum(values_ma[int(n*0.7):]) / (n - int(n*0.7))

    # 闭环增益
    K_cl = y_ss / step_input_ma if abs(step_input_ma) > 0.1 else 0

    # 时间常数 (到达 63.2%)
    target_632 = y_ss * 0.632
    tau_cl = None
    for i in range(n):
        if values_ma[i] >= target_632:
            tau_cl = times[i]
            break
    if tau_cl is None:
        tau_cl = 0.01

    return {'K_cl': K_cl, 'tau_cl': tau_cl, 'y_ss': y_ss}


def compute_pi(model, p_ctrl, desired_tau_c=None):
    """
    基于模型计算 PI 参数

    P: Kp = τ_plant / (Kp_plant * τ_c)
    I: 让积分器在 settle_time 内累积到能消除稳态误差
    """
    K_cl = model['K_cl']
    tau_cl = model['tau_cl']

    if K_cl >= 1.0 or K_cl <= 0:
        return None

    # 反推植物参数
    Kp_plant = K_cl / (p_ctrl * (1 - K_cl))
    tau_plant = tau_cl * (1 + p_ctrl * Kp_plant)

    # P 值: 期望闭环时间常数
    if desired_tau_c is None:
        desired_tau_c = max(tau_plant * 0.5, 0.002)  # 默认: τ_plant/2, 最小 2ms
    kp = tau_plant / (Kp_plant * desired_tau_c)
    kp = max(0.5, min(kp, 10.0))  # 限幅

    p_reg = max(1, min(65535, int(kp * 256)))

    # I 值: 基于消除稳态误差的时间
    # 对于 500mA 目标, P-only 稳态约 Kp*Kp_plant/(1+Kp*Kp_plant)*target
    # 积分器需要补充差值
    # 设 settle_time = 20ms (1000 个 PWM 周期)
    # 需要: I_reg/256 × e_avg × 1000 ≈ MAX_RAW
    # I_reg ≈ MAX_RAW × 256 / (e_avg × 1000)
    # 简化: I_reg = MAX_RAW × 256 / (target_raw × settle_cycles)
    # 但 TMC6460 的 I 增益是每周期的, 经验值:
    #   I_reg=10 → 500mA 阶跃, ~30ms 消除稳态误差
    #   I_reg=20 → ~15ms
    #   I_reg=50 → ~6ms (可能振荡)
    # 用经验值, 基于目标电流缩放
    settle_cycles = 1000  # 20ms at 50kHz
    target_raw = ma_to_raw(step_input_ma) if 'step_input_ma' in dir() else MAX_RAW // 2
    i_reg = max(1, min(65535, int(MAX_RAW * 256 / (max(target_raw, 100) * settle_cycles) * 50)))
    # 兜底: 不小于 5
    i_reg = max(5, i_reg)

    return {
        'kp': kp, 'p_reg': p_reg, 'i_reg': i_reg,
        'Kp_plant': Kp_plant, 'tau_plant': tau_plant,
    }


def analyze_step(times, values_ma, target_ma):
    """分析阶跃响应指标"""
    if len(times) < 10:
        return None

    n = len(values_ma)
    y_ss = sum(values_ma[int(n*0.7):]) / (n - int(n*0.7))

    # 上升时间 10%→90%
    v10, v90 = target_ma * 0.1, target_ma * 0.9
    t10 = t90 = None
    for i in range(n):
        if values_ma[i] >= v10 and t10 is None:
            t10 = times[i]
        if values_ma[i] >= v90 and t90 is None:
            t90 = times[i]
            break
    rise_time = (t90 - t10) if (t10 and t90) else None

    peak = max(values_ma)
    os_pct = ((peak - target_ma) / target_ma * 100) if target_ma > 0.1 else 0
    ss_err = y_ss - target_ma
    ss_pct = (ss_err / target_ma * 100) if target_ma > 0.1 else 0

    iae = 0
    for i in range(1, n):
        iae += abs(values_ma[i] - target_ma) * (times[i] - times[i-1])

    return {
        'rise_time': rise_time, 'overshoot_pct': os_pct,
        'ss_error': ss_err, 'ss_error_pct': ss_pct,
        'iae': iae, 'y_ss': y_ss, 'peak': peak,
    }


# ========== 主流程 ==========
def main():
    parser = argparse.ArgumentParser(description="TMC6460 电流环 PI 自动整定")
    parser.add_argument("port")
    parser.add_argument("--offset", default="0xFFFF962B")
    parser.add_argument("--poles", type=int, default=1)
    parser.add_argument("--target-ma", type=float, default=500)
    parser.add_argument("--max-iter", type=int, default=5)
    parser.add_argument("--plot", action="store_true")
    parser.add_argument("--plot-dir", default=".")
    args = parser.parse_args()

    offset = int(args.offset, 16) if args.offset.startswith("0x") else int(args.offset)

    tmc = TMC6460Serial(port=args.port, baudrate=115200)
    if not tmc.connect():
        print("连接失败"); return
    print(f"连接 {args.port} OK")

    collector = RTMICollector()
    all_curves = []

    try:
        # ===== Phase 1: 编码器 + 使能 =====
        print("\n" + "="*60)
        print("Phase 1: 编码器 + 电机使能")

        ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=args.poles)
        print(f"  {msg}")
        if not ok: return

        tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
        tmc.write_register(REG_PHI_E_OFFSET, offset)
        rb = tmc.read_register(REG_PHI_E_OFFSET)
        print(f"  OFFSET=0x{offset:08X} → 读回 0x{rb:08X}" if rb is not None else "  OFFSET FAIL")

        tmc.write_register(REG_CSA_GAIN, 3)
        tmc.write_register(REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

        gdrv = tmc.read_register(0x101)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(0x101, gdrv)

        motion = (1 << 15) | (1 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (args.poles & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        print(f"  GDRV=0x{gdrv:08X}  MOTION=0x{motion:08X}")

        # ===== Phase 2: RTMI =====
        print("\n" + "="*60)
        print("Phase 2: RTMI 配置")
        ok = tmc.start_rtmi({0: REG_TF_ACTUAL}, sampling=49, callback=collector.callback)
        if not ok:
            print("[FAIL] RTMI"); return
        print("  RTMI CH0 → 0x153 @ 1kHz")
        time.sleep(0.1)

        # ===== Phase 3: P-only 辨识 =====
        print("\n" + "="*60)
        print(f"Phase 3: P-only 阶跃辨识 (I=0, 目标 {args.target_ma}mA)")

        p_test = 64
        set_pi_verify(tmc, p_test, 0)
        print(f"  P={p_test} (增益 {p_test/256:.3f}), I=0")

        times, values = step_test(tmc, collector, args.target_ma, duration_s=0.5)
        all_curves.append({
            'name': f'P-only (P={p_test})',
            'times': times, 'values': values,
        })

        model = extract_model(times, values, args.target_ma)
        if model is None:
            print("  [FAIL] 模型提取失败"); return

        print(f"  K_cl={model['K_cl']:.4f}  τ_cl={model['tau_cl']*1000:.2f}ms  y_ss={model['y_ss']:.1f}mA")

        # ===== Phase 4: 计算 PI =====
        print("\n" + "="*60)
        print("Phase 4: 计算 PI")

        p_gain = p_test / 256.0
        pi = compute_pi(model, p_gain)
        if pi is None:
            print("  [FAIL] 无法计算 PI"); return

        print(f"  Kp_plant={pi['Kp_plant']:.4f}  τ_plant={pi['tau_plant']*1000:.2f}ms")
        print(f"  P_reg={pi['p_reg']} (增益 {pi['p_reg']/256:.3f})")
        print(f"  I_reg={pi['i_reg']} (增益 {pi['i_reg']/256:.3f})")

        # ===== Phase 5: 阶跃验证 =====
        print("\n" + "="*60)
        print("Phase 5: 阶跃验证")

        ok = set_pi_verify(tmc, pi['p_reg'], pi['i_reg'])
        print(f"  PI 写入{'成功' if ok else '失败!'}")

        times, values = step_test(tmc, collector, args.target_ma, duration_s=0.3)
        analysis = analyze_step(times, values, args.target_ma)
        all_curves.append({
            'name': f'初始 PI (P={pi["p_reg"]}, I={pi["i_reg"]})',
            'times': times, 'values': values,
            'analysis': analysis,
        })

        if analysis:
            rt_str = f"{analysis['rise_time']*1000:.1f}" if analysis['rise_time'] else "---"
            print(f"  上升={rt_str}ms 超调={analysis['overshoot_pct']:.1f}% "
                  f"稳态={analysis['ss_error_pct']:+.1f}% ({analysis['y_ss']:.0f}mA)")
            print(f"  [DEBUG] 点={len(values)} 前3={[f'{v:.0f}' for v in values[:3]]} "
                  f"后3={[f'{v:.0f}' for v in values[-3:]]} max={max(values):.0f}")

        # ===== Phase 6: 迭代修正 =====
        print("\n" + "="*60)
        print("Phase 6: 迭代修正")

        current_p = pi['p_reg']
        current_i = pi['i_reg']
        current_analysis = analysis

        def score(a):
            if a is None: return 0
            s = 0
            if a['rise_time'] and a['rise_time'] < 0.005: s += 3
            elif a['rise_time'] and a['rise_time'] < 0.01: s += 2
            elif a['rise_time'] and a['rise_time'] < 0.02: s += 1
            if abs(a['overshoot_pct']) < 5: s += 3
            elif abs(a['overshoot_pct']) < 10: s += 2
            elif abs(a['overshoot_pct']) < 20: s += 1
            if abs(a['ss_error_pct']) < 2: s += 3
            elif abs(a['ss_error_pct']) < 5: s += 2
            elif abs(a['ss_error_pct']) < 10: s += 1
            return s

        current_score = score(current_analysis)

        for iteration in range(1, args.max_iter + 1):
            if current_analysis is None:
                break
            a = current_analysis

            # 达标检查
            if (abs(a['overshoot_pct']) < 5 and
                abs(a['ss_error_pct']) < 3 and
                a['rise_time'] and a['rise_time'] < 0.015):
                print(f"  ✓ 达标! 上升={a['rise_time']*1000:.1f}ms "
                      f"超调={a['overshoot_pct']:.1f}% 稳态={a['ss_error_pct']:+.1f}%")
                break

            new_p = current_p
            new_i = current_i
            actions = []

            # 稳态误差大 → 升 I (主要手段)
            if abs(a['ss_error_pct']) > 10:
                new_i = min(65535, int(current_i * 3))
                actions.append(f"I {current_i}→{new_i} (稳态差{a['ss_error_pct']:+.1f}%)")
            elif abs(a['ss_error_pct']) > 3:
                new_i = min(65535, int(current_i * 1.8))
                actions.append(f"I {current_i}→{new_i} (稳态差{a['ss_error_pct']:+.1f}%)")

            # 超调大 → 降 P
            if abs(a['overshoot_pct']) > 15:
                new_p = max(1, int(current_p * 0.7))
                actions.append(f"P {current_p}→{new_p} (超调{a['overshoot_pct']:.1f}%)")
            elif abs(a['overshoot_pct']) > 8:
                new_p = max(1, int(current_p * 0.85))
                actions.append(f"P {current_p}→{new_p} (超调{a['overshoot_pct']:.1f}%)")

            # 上升慢且超调小 → 升 P
            if a['rise_time'] and a['rise_time'] > 0.02 and abs(a['overshoot_pct']) < 3:
                new_p = min(65535, int(current_p * 1.5))
                actions.append(f"P {current_p}→{new_p} (上升慢{a['rise_time']*1000:.1f}ms)")

            # 积分饱和 → 降 I
            if a['overshoot_pct'] > 50:
                new_i = max(1, int(current_i * 0.5))
                actions.append(f"I {current_i}→{new_i} (积分饱和)")

            if not actions:
                print(f"  迭代{iteration}: 无法改进")
                break

            print(f"  迭代{iteration}: " + ", ".join(actions))

            ok = set_pi_verify(tmc, new_p, new_i)
            if not ok:
                print(f"    [WARN] PI 写入验证失败")

            times, values = step_test(tmc, collector, args.target_ma, duration_s=0.3)
            new_analysis = analyze_step(times, values, args.target_ma)
            new_score = score(new_analysis)

            all_curves.append({
                'name': f'迭代{iteration} (P={new_p}, I={new_i})',
                'times': times, 'values': values,
                'analysis': new_analysis,
            })

            if new_analysis:
                rt_str = f"{new_analysis['rise_time']*1000:.1f}" if new_analysis['rise_time'] else "---"
                print(f"    → 上升={rt_str}ms 超调={new_analysis['overshoot_pct']:.1f}% "
                      f"稳态={new_analysis['ss_error_pct']:+.1f}% ({new_analysis['y_ss']:.0f}mA)")
                print(f"    [DEBUG] 点={len(values)} 前3={[f'{v:.0f}' for v in values[:3]]} "
                      f"后3={[f'{v:.0f}' for v in values[-3:]]} max={max(values):.0f}")

                if new_score >= current_score:
                    current_p, current_i = new_p, new_i
                    current_analysis = new_analysis
                    current_score = new_score
                else:
                    print(f"    评分下降 ({current_score}→{new_score}), 回退")
                    # 写回上一组
                    set_pi_verify(tmc, current_p, current_i)
                    break
            else:
                break

        # ===== 最终推荐 =====
        print(f"\n" + "="*60)
        print(f"最终推荐: P={current_p} I={current_i}")
        print(f"  寄存器: 0x{(current_p << 16 | current_i):08X}")
        print(f"  P增益: {current_p/256:.3f}  I增益: {current_i/256:.3f}")
        if current_analysis:
            a = current_analysis
            rt_str = f"{a['rise_time']*1000:.1f}ms" if a['rise_time'] else "---"
            print(f"  上升: {rt_str}  超调: {a['overshoot_pct']:.1f}%  "
                  f"稳态: {a['ss_error_pct']:+.1f}% ({a['y_ss']:.0f}mA)")

        # ===== 波形图 =====
        if args.plot and all_curves:
            try:
                import matplotlib
                matplotlib.use('Agg')
                import matplotlib.pyplot as plt
                plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'DejaVu Sans']
                plt.rcParams['axes.unicode_minus'] = False

                n_plots = len(all_curves)
                fig, axes = plt.subplots(n_plots, 1, figsize=(12, 3.5 * n_plots), squeeze=False)
                fig.suptitle(f'TMC6460 Current Loop PI Autotune\n'
                            f'Target: {args.target_ma}mA', fontsize=13)

                for idx, r in enumerate(all_curves):
                    ax = axes[idx, 0]
                    t_ms = [(t - r['times'][0]) * 1000 for t in r['times']]
                    ax.plot(t_ms, r['values'], 'b-', linewidth=0.8, label='I_D actual')
                    ax.axhline(y=args.target_ma, color='r', linestyle='--',
                              alpha=0.7, label='target')
                    title = r['name']
                    if 'analysis' in r and r['analysis']:
                        a = r['analysis']
                        rt_str = f"{a['rise_time']*1000:.1f}ms" if a['rise_time'] else "---"
                        title += f"  rise={rt_str} OS={a['overshoot_pct']:.1f}% SS={a['ss_error_pct']:+.1f}%"
                    ax.set_title(title, fontsize=10)
                    ax.set_ylabel('I_D (mA)')
                    ax.legend(loc='right', fontsize=8)
                    ax.grid(True, alpha=0.3)
                    if idx == n_plots - 1:
                        ax.set_xlabel('Time (ms)')

                plt.tight_layout()
                plot_path = os.path.join(args.plot_dir, 'pid_autotune.png')
                plt.savefig(plot_path, dpi=150)
                print(f"\n  波形图: {plot_path}")
                plt.close()
            except Exception as e:
                print(f"\n  [WARN] 波形图失败: {e}")

        tmc.stop_rtmi()

    except KeyboardInterrupt:
        print("\n[中断]")
    finally:
        try:
            tmc.write_register(REG_TF_TARGET, 0)
            tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (args.poles & 0x7F))
        except:
            pass
        tmc.disconnect()
        print("已断开")


if __name__ == "__main__":
    main()
