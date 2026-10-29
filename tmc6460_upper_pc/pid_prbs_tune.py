#!/usr/bin/env python3
"""
TMC6460 Current Loop PI Tuning (PRBS System Identification)

Flow:
  1. Input R/L initial values
  2. Compute initial PI from bandwidth formula
  3. PRBS system identification (MOTION_MODE=6 PRBS_FLUX)
  4. Analyze frequency response, correct R/L
  5. Compute final PI from corrected R/L
  6. Step response validation

Usage:
  python pid_prbs_tune.py COM10 --R 2.01 --L 0.0001118 --plot
"""

import sys, os, time, argparse, threading, math
import numpy as np
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
REG_RAMP_V_MAX   = 0x1CE
REG_RAMP_V_START = 0x1CA
REG_RAMP_A1      = 0x1C4
REG_RAMP_A_MAX   = 0x1C6
REG_PHI_E_OFFSET = 0x242
REG_GDRV         = 0x101
REG_PRBS_AMPLITUDE = 0x174
REG_PRBS_DOWN_SAMPLING_RATIO = 0x175

MA_PER_COUNT = 0.00164 * 1000 / 8 * 4.0 / 4.0 * 0.982
MAX_RAW = 8192
PWM_FREQ = 50000


def raw_to_ma(raw):
    if raw > 32767: raw -= 65536
    return raw * MA_PER_COUNT


def ma_to_raw(ma):
    return max(-MAX_RAW, min(MAX_RAW, int(ma / MA_PER_COUNT)))


class Collector:
    def __init__(self):
        self.data = []   # [(t, i_d_raw)]
        self.err = []    # [(t, flux_error_raw)]
        self._lock = threading.Lock()
        self._on = False
    def start(self):
        with self._lock:
            self.data.clear()
            self.err.clear()
            self._on = True
    def stop(self):
        with self._lock:
            self._on = False
    def cb(self, ch_id, raw):
        if not self._on:
            return
        with self._lock:
            if ch_id == 0:
                self.data.append((time.time(), raw & 0xFFFF))
            elif ch_id == 1:
                self.err.append((time.time(), raw & 0xFFFF))
    def get(self):
        with self._lock:
            return list(self.data)
    def get_err(self):
        with self._lock:
            return list(self.err)


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
        tmc.start_rtmi({0: REG_TF_ACTUAL, 1: 0x158}, sampling=49, callback=lambda c, d: None)
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
        tmc.start_rtmi({0: REG_TF_ACTUAL, 1: 0x158}, sampling=49, callback=lambda c, d: None)
        time.sleep(0.3)
    return rb


def step_test(tmc, collector, target_ma, duration=0.3):
    raw_target = ma_to_raw(target_ma)
    # Stop RTMI, write 0
    tmc.stop_rtmi()
    time.sleep(0.1)
    if tmc.ser and tmc.ser.is_open:
        tmc.ser.reset_input_buffer()
    tmc.write_register(REG_TF_TARGET, 0)
    time.sleep(0.3)
    # Start RTMI, collect
    collector.start()
    tmc.start_rtmi({0: REG_TF_ACTUAL, 1: 0x158}, sampling=49, callback=collector.cb)
    time.sleep(0.3)
    # Stop RTMI, fire step
    tmc.stop_rtmi()
    time.sleep(0.02)
    if tmc.ser and tmc.ser.is_open:
        tmc.ser.reset_input_buffer()
    tmc.write_register(REG_TF_TARGET, raw_target & 0xFFFF)
    # Restart RTMI to capture response
    tmc.start_rtmi({0: REG_TF_ACTUAL, 1: 0x158}, sampling=49, callback=collector.cb)
    time.sleep(duration)
    # Stop, clean up
    tmc.stop_rtmi()
    time.sleep(0.02)
    if tmc.ser and tmc.ser.is_open:
        tmc.ser.reset_input_buffer()
    tmc.write_register(REG_TF_TARGET, 0)
    collector.stop()
    raw = collector.get()
    err_raw = collector.get_err()
    times = [d[0] for d in raw]
    values = [raw_to_ma(d[1]) for d in raw]
    err_values = [raw_to_ma(d[1]) for d in err_raw]
    return times, values, err_values


def analyze(times, values, target):
    if len(times) < 10:
        return None
    n = len(values)
    y_ss = sum(values[int(n * 0.7):]) / (n - int(n * 0.7))
    v10, v90 = target * 0.1, target * 0.9
    t10 = t90 = None
    for i in range(n):
        if values[i] >= v10 and t10 is None:
            t10 = times[i]
        if values[i] >= v90 and t90 is None:
            t90 = times[i]
            break
    rt = (t90 - t10) if (t10 and t90) else None
    peak = max(values)
    os = ((peak - target) / target * 100) if target > 0.1 else 0
    ss = ((y_ss - target) / target * 100) if target > 0.1 else 0
    return {'rt': rt, 'os': os, 'ss': ss, 'y_ss': y_ss, 'peak': peak}


def score(a):
    if a is None:
        return 0
    s = 0
    if a['rt'] and a['rt'] < 0.005: s += 3
    elif a['rt'] and a['rt'] < 0.01: s += 2
    elif a['rt'] and a['rt'] < 0.02: s += 1
    if abs(a['os']) < 5: s += 3
    elif abs(a['os']) < 10: s += 2
    elif abs(a['os']) < 20: s += 1
    if abs(a['ss']) < 2: s += 3
    elif abs(a['ss']) < 5: s += 2
    elif abs(a['ss']) < 10: s += 1
    return s


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("port")
    parser.add_argument("--R", type=float, required=True)
    parser.add_argument("--L", type=float, required=True)
    parser.add_argument("--offset", default="0xFFFF962B")
    parser.add_argument("--poles", type=int, default=1)
    parser.add_argument("--target-ma", type=float, default=500)
    parser.add_argument("--bw-ratio", type=int, default=10)
    parser.add_argument("--prbs-amplitude", type=float, default=200)
    parser.add_argument("--prbs-freq", type=int, default=1000, help="PRBS frequency (Hz)")
    parser.add_argument("--prbs-duration", type=float, default=2.0)
    parser.add_argument("--max-iter", type=int, default=5)
    parser.add_argument("--plot", action="store_true")
    parser.add_argument("--plot-dir", default=".")
    args = parser.parse_args()

    offset = int(args.offset, 16) if args.offset.startswith("0x") else int(args.offset)

    tmc = TMC6460Serial(port=args.port, baudrate=460800)
    if not tmc.connect():
        print("FAIL: connect"); return
    print(f"Connected {args.port} @ 460800")

    coll = Collector()
    curves = []

    try:
        # === Phase 1: Config ===
        print("\n" + "=" * 60)
        print("Phase 1: Config")
        ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=args.poles)
        print(f"  Encoder: {msg}")
        if not ok: return

        tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
        tmc.write_register(REG_PHI_E_OFFSET, offset)
        rb = tmc.read_register(REG_PHI_E_OFFSET)
        print(f"  OFFSET 0x{offset:08X} -> 0x{rb:08X}" if rb else "  OFFSET FAIL")
        tmc.write_register(REG_CSA_GAIN, 3)
        tmc.write_register(REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

        gdrv = tmc.read_register(REG_GDRV)
        gdrv |= (1 << 31) | (1 << 16)
        tmc.write_register(REG_GDRV, gdrv)
        motion = (1 << 15) | (1 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (args.poles & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)
        print(f"  GDRV=0x{gdrv:08X} MOTION=0x{motion:08X}")

        # === Phase 2: Initial PI ===
        print("\n" + "=" * 60)
        print(f"Phase 2: Initial PI (R={args.R}, L={args.L*1e6:.1f}uH)")
        p0, i0, kp, ki, f_bw = compute_pi(args.R, args.L, PWM_FREQ, args.bw_ratio)
        print(f"  f_bw={f_bw:.0f} Kp={kp:.4f} Ki={ki:.2f}")
        print(f"  P={p0} I={i0} -> 0x{(p0<<16|i0):08X}")
        ok, rb = write_pi_reliable(tmc, p0, i0)
        print(f"  Write: {'OK' if ok else 'FAIL'} (0x{rb:08X})" if rb else "  Write FAIL")

        # === Phase 3: PRBS identification ===
        print("\n" + "=" * 60)
        print(f"Phase 3: PRBS identification (amp={args.prbs_amplitude}mA, {args.prbs_duration}s)")

        motion_prbs = (1 << 15) | (1 << 14) | (6 << 9) | (3 << 7) | (args.poles & 0x7F)
        rb_motion = write_reg_reliable(tmc, REG_MOTOR_MOTION, motion_prbs)
        print(f"  MOTION=0x{motion_prbs:08X} (PRBS_FLUX) readback=0x{rb_motion:08X}" if rb_motion else "  MOTION write FAIL")

        rb_amp = write_reg_reliable(tmc, REG_PRBS_AMPLITUDE, ma_to_raw(args.prbs_amplitude) & 0xFFFF)
        print(f"  PRBS_AMP={ma_to_raw(args.prbs_amplitude)} readback=0x{rb_amp:08X}" if rb_amp else "  PRBS_AMP write FAIL")

        # PRBS down sampling ratio
        prbs_ratio = max(0, (PWM_FREQ // args.prbs_freq) - 1)
        rb_ratio = write_reg_reliable(tmc, REG_PRBS_DOWN_SAMPLING_RATIO, prbs_ratio)
        f_prbs = PWM_FREQ / (prbs_ratio + 1)
        print(f"  PRBS_RATIO={prbs_ratio} (f_PRBS={f_prbs:.0f}Hz) readback=0x{rb_ratio:08X}" if rb_ratio else "  PRBS_RATIO write FAIL")

        # Collect PRBS response
        tmc.stop_rtmi()
        time.sleep(0.1)
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        coll.start()
        tmc.start_rtmi({0: REG_TF_ACTUAL, 1: 0x158}, sampling=49, callback=coll.cb)
        time.sleep(0.3)
        print(f"  Collecting...")
        time.sleep(args.prbs_duration)
        coll.stop()

        # Restore TORQUE mode
        tmc.stop_rtmi()
        time.sleep(0.1)
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_TF_TARGET, 0)
        print(f"  Restored MOTION=0x{motion:08X}")

        # Analyze PRBS
        raw = coll.get()
        vals = [raw_to_ma(d[1]) for d in raw]
        print(f"  Data: {len(vals)} points")

        R_final, L_final = args.R, args.L
        if len(vals) < 100:
            print("  [FAIL] insufficient data, using initial R/L")
        else:
            mean_v = sum(vals) / len(vals)
            print(f"  I_D: mean={mean_v:.0f} min={min(vals):.0f} max={max(vals):.0f} mA")

            # Power spectral density
            y = np.array(vals) - mean_v
            Y = np.fft.rfft(y)
            freqs = np.fft.rfftfreq(len(y), d=1.0 / 1000)
            psd = np.abs(Y) ** 2
            psd_db = 10 * np.log10(psd / psd.max() + 1e-12)

            # -3dB bandwidth from PSD
            peak_db = psd_db.max()
            f_3db = freqs[-1]
            for i in range(1, len(psd_db)):
                if psd_db[i] < peak_db - 3:
                    f_3db = freqs[i]
                    break

            # Expected closed-loop bandwidth
            f_cl = (kp * args.R + ki * args.L) / (2 * math.pi * args.L)
            print(f"  Measured -3dB: {f_3db:.0f} Hz")
            print(f"  Expected f_cl: {f_cl:.0f} Hz")

            if f_3db > 100:
                ratio = f_3db / f_cl if f_cl > 0 else 1.0
                R_final = args.R * ratio
                L_final = args.L
                print(f"  Correction: R {args.R:.3f} -> {R_final:.3f} (x{ratio:.3f})")
            else:
                print(f"  f_3db too low, no correction")

            curves.append({
                'name': f'PRBS PSD (f_3db={f_3db:.0f}Hz)',
                'type': 'psd', 'freqs': freqs, 'psd_db': psd_db, 'f_3db': f_3db,
            })

            # PRBS time-domain waveform (I_D + flux error)
            prbs_err_raw = coll.get_err()
            prbs_err_vals = [raw_to_ma(d[1]) for d in prbs_err_raw]
            curves.append({
                'name': f'PRBS I_D ({len(vals)} pts)',
                'type': 'step', 'times': [d[0] for d in raw], 'values': vals,
            })
            if prbs_err_vals:
                curves.append({
                    'name': f'PRBS FLUX_ERR ({len(prbs_err_vals)} pts)',
                    'type': 'step', 'times': [d[0] for d in prbs_err_raw], 'values': prbs_err_vals,
                })

        # === Phase 4: Final PI ===
        print("\n" + "=" * 60)
        print(f"Phase 4: Final PI (R={R_final:.3f}, L={L_final*1e6:.1f}uH)")
        p_f, i_f, kp_f, ki_f, f_bw_f = compute_pi(R_final, L_final, PWM_FREQ, args.bw_ratio)
        print(f"  f_bw={f_bw_f:.0f} Kp={kp_f:.4f} Ki={ki_f:.2f}")
        print(f"  P={p_f} I={i_f} -> 0x{(p_f<<16|i_f):08X}")
        ok, rb = write_pi_reliable(tmc, p_f, i_f)
        print(f"  Write: {'OK' if ok else 'FAIL'} (0x{rb:08X})" if rb else "  Write FAIL")

        # === Phase 5: Step validation ===
        print("\n" + "=" * 60)
        print(f"Phase 5: Step validation ({args.target_ma}mA)")
        ts, vs, es = step_test(tmc, coll, args.target_ma)
        a = analyze(ts, vs, args.target_ma)
        curves.append({
            'name': f'Step I_D P={p_f} I={i_f}',
            'type': 'step', 'times': ts, 'values': vs, 'analysis': a,
        })
        if es:
            curves.append({
                'name': f'Step FLUX_ERR P={p_f} I={i_f}',
                'type': 'step', 'times': ts, 'values': es,
            })
        if a:
            rt = f"{a['rt']*1000:.1f}ms" if a['rt'] else "---"
            print(f"  Rise={rt} OS={a['os']:.1f}% SS={a['ss']:+.1f}% ({a['y_ss']:.0f}mA)")
            if vs:
                print(f"  [DBG] n={len(vs)} first={[f'{v:.0f}' for v in vs[:3]]} "
                      f"last={[f'{v:.0f}' for v in vs[-3:]]} max={max(vs):.0f}")
        else:
            print(f"  [FAIL] no data (n={len(vs)})")

        # === Phase 6: Iterate ===
        cur_p, cur_i, cur_a = p_f, i_f, a
        cur_s = score(a)

        for it in range(1, args.max_iter + 1):
            if cur_a is None:
                break
            ca = cur_a
            if (abs(ca['os']) < 5 and abs(ca['ss']) < 3 and ca['rt'] and ca['rt'] < 0.015):
                print(f"\n  PASS: rt={ca['rt']*1000:.1f}ms os={ca['os']:.1f}% ss={ca['ss']:+.1f}%")
                break

            np_, ni_ = cur_p, cur_i
            acts = []
            if abs(ca['ss']) > 10:
                ni_ = min(65535, int(cur_i * 2)); acts.append(f"I*2")
            elif abs(ca['ss']) > 3:
                ni_ = min(65535, int(cur_i * 1.5)); acts.append(f"I*1.5")
            if abs(ca['os']) > 15:
                np_ = max(1, int(cur_p * 0.7)); acts.append(f"P*0.7")
            elif abs(ca['os']) > 8:
                np_ = max(1, int(cur_p * 0.85)); acts.append(f"P*0.85")
            if ca['rt'] and ca['rt'] > 0.02 and abs(ca['os']) < 3:
                np_ = min(65535, int(cur_p * 1.5)); acts.append(f"P*1.5")
            if ca['os'] > 50:
                ni_ = max(1, int(cur_i * 0.5)); acts.append(f"I*0.5")
            if not acts:
                break

            print(f"\n  Iter {it}: {', '.join(acts)} P={np_} I={ni_}")
            ok, rb = write_pi_reliable(tmc, np_, ni_)
            print(f"    PI: {'OK' if ok else 'FAIL'} (0x{rb:08X})" if rb else "    PI: FAIL")

            ts2, vs2, es2 = step_test(tmc, coll, args.target_ma)
            a2 = analyze(ts2, vs2, args.target_ma)
            curves.append({
                'name': f'Iter{it} P={np_} I={ni_}',
                'type': 'step', 'times': ts2, 'values': vs2, 'analysis': a2,
            })
            if a2 is None:
                print(f"    -> no data")
                write_pi_reliable(tmc, cur_p, cur_i)
                break
            s2 = score(a2)
            rt = f"{a2['rt']*1000:.1f}ms" if a2['rt'] else "---"
            print(f"    -> rt={rt} os={a2['os']:.1f}% ss={a2['ss']:+.1f}% ({a2['y_ss']:.0f}mA)")
            if vs2:
                print(f"    [DBG] n={len(vs2)} first={[f'{v:.0f}' for v in vs2[:3]]} "
                      f"last={[f'{v:.0f}' for v in vs2[-3:]]}")
            if s2 >= cur_s:
                cur_p, cur_i, cur_a, cur_s = np_, ni_, a2, s2
            else:
                print(f"    Score dropped, revert")
                write_pi_reliable(tmc, cur_p, cur_i)
                break

        # === Final ===
        print("\n" + "=" * 60)
        print(f"FINAL: P={cur_p} I={cur_i} (0x{(cur_p<<16|cur_i):08X})")
        print(f"  P gain={cur_p/256:.3f} I gain={cur_i/256:.3f}")
        if cur_a:
            rt = f"{cur_a['rt']*1000:.1f}ms" if cur_a['rt'] else "---"
            print(f"  rt={rt} os={cur_a['os']:.1f}% ss={cur_a['ss']:+.1f}%")

        # === Plot ===
        if args.plot and curves:
            try:
                import matplotlib
                matplotlib.use('Agg')
                import matplotlib.pyplot as plt

                n = len(curves)
                fig, axes = plt.subplots(n, 1, figsize=(12, 3.5 * n), squeeze=False)
                fig.suptitle(f'TMC6460 PI Tune R={args.R} L={args.L*1e6:.1f}uH', fontsize=13)

                for i, c in enumerate(curves):
                    ax = axes[i, 0]
                    if c['type'] == 'psd':
                        ax.semilogx(c['freqs'], c['psd_db'], 'b-', lw=0.8)
                        ax.axvline(c['f_3db'], color='r', ls='--', label=f"-3dB={c['f_3db']:.0f}Hz")
                        ax.set_ylabel('PSD (dB)')
                        ax.set_xlabel('Freq (Hz)')
                        ax.legend()
                    else:
                        t_ms = [(t - c['times'][0]) * 1000 for t in c['times']]
                        ax.plot(t_ms, c['values'], 'b-', lw=0.8, label='I_D')
                        ax.axhline(args.target_ma, color='r', ls='--', alpha=0.7, label='target')
                        ax.set_ylabel('I_D (mA)')
                        ax.set_xlabel('Time (ms)')
                        ax.legend()
                    title = c['name']
                    if 'analysis' in c and c['analysis']:
                        a = c['analysis']
                        rt = f"{a['rt']*1000:.1f}ms" if a['rt'] else "---"
                        title += f"  rt={rt} os={a['os']:.1f}% ss={a['ss']:+.1f}%"
                    ax.set_title(title, fontsize=10)
                    ax.grid(True, alpha=0.3)

                plt.tight_layout()
                p = os.path.join(args.plot_dir, 'pid_prbs_tune.png')
                plt.savefig(p, dpi=150)
                print(f"\nPlot: {p}")
                plt.close()
            except Exception as e:
                print(f"\nPlot fail: {e}")

        tmc.stop_rtmi()
    except KeyboardInterrupt:
        print("\nInterrupted")
    finally:
        try:
            tmc.write_register(REG_TF_TARGET, 0)
            tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (args.poles & 0x7F))
        except:
            pass
        tmc.disconnect()
        print("Disconnected")


if __name__ == "__main__":
    main()
