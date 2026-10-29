#!/usr/bin/env python3
"""
TMC6460 PID 整定 Worker
支持电流环和速度环阶跃响应
"""

import time
import math
from PyQt5.QtCore import QThread, pyqtSignal

from tmc6460_encoder import setup_encoder
from step_response import (
    Collector, compute_pi, raw_to_ma, ma_to_raw,
    REG_MOTOR_MOTION, REG_PWM_PERIOD, REG_CSA_GAIN,
    REG_FLUX_COEFF, REG_TORQUE_COEFF, REG_TF_LIMITS,
    REG_TF_TARGET, REG_TF_ACTUAL, REG_RAMP_V_MAX,
    REG_RAMP_V_START, REG_RAMP_A1, REG_RAMP_A_MAX,
    REG_PHI_E_OFFSET, REG_GDRV, REG_PRBS_AMPLITUDE,
    MAX_RAW, PWM_FREQ, RTMI_SAMPLING
)

# 速度环寄存器
REG_VEL_COEFF   = 0x145  # PID_VELOCITY_COEFF [31:16]=P, [15:0]=I
REG_VEL_TARGET  = 0x150  # PID_VELOCITY_TARGET
REG_VEL_ACTUAL  = 0x154  # PID_VELOCITY_ACTUAL
REG_VEL_LIMIT   = 0x14B  # PID_VELOCITY_LIMIT

# 速度单位换算: 1 RPM = K_VEL 内部单位
# 来源: tmc6460.pdf p71, k = CPR_EXT * CPR_INV * 2^24 / (256 * f_SYS * 60)
# MT6701 SSI 14-bit, CPR_INV=1024, f_SYS=60MHz
K_VEL = 305.4

# 电流单位换算 (来自 step_response.py MA_PER_COUNT)
MA_PER_COUNT = 0.20131  # mA/count


class AutotuneWorker(QThread):
    """PID 整定后台线程"""
    finished = pyqtSignal(dict)
    progress = pyqtSignal(str)

    def __init__(self, tmc, params):
        super().__init__()
        self.tmc = tmc
        self.params = params

    def run(self):
        result = {'success': False, 'message': '', 'image_path': '', 'tgt': [], 'act': [], 'params': self.params}
        try:
            tmc = self.tmc
            p = self.params
            offset = p['offset']
            loop_type = p.get('loop_type', 'current')

            # 清理上次运行残留
            try:
                tmc.stop_rtmi()
            except: pass
            time.sleep(0.2)
            if tmc.ser and tmc.ser.is_open:
                tmc.ser.reset_input_buffer()
                time.sleep(0.05)
                tmc.ser.reset_input_buffer()
            # 目标归零
            tmc.write_register(REG_TF_TARGET, 0)
            tmc.write_register(0x150, 0)
            # 清积分器
            tmc.write_register(0x15D, 0)
            tmc.write_register(0x15E, 0)
            time.sleep(0.1)

            # Phase 1: 硬件配置
            self.progress.emit('Phase 1: 硬件配置...')
            for enc_try in range(3):
                ok, msg = setup_encoder(tmc, 'MT6701 (SSI, 14-bit)', pole_pairs=p['poles'])
                if ok:
                    break
                tmc.write_register(0x381, 0x00000000)
                tmc.write_register(0x382, 0x00000000)
                time.sleep(0.5)
            if not ok:
                result['message'] = f'编码器配置失败: {msg}'
                self.finished.emit(result)
                return

            tmc.write_register(REG_PWM_PERIOD, 0xFFFF12C0)
            tmc.write_register(REG_PHI_E_OFFSET, offset)
            tmc.write_register(REG_CSA_GAIN, 3)
            tmc.write_register(REG_TF_LIMITS, (MAX_RAW << 16) | MAX_RAW)

            gdrv = tmc.read_register(REG_GDRV)
            if gdrv:
                gdrv |= (1 << 31) | (1 << 16)
                tmc.write_register(REG_GDRV, gdrv)

            tmc.write_register(REG_PRBS_AMPLITUDE, 0)

            if loop_type == 'current':
                self._run_current(tmc, p, result)
            elif loop_type == 'velocity':
                self._run_velocity(tmc, p, result)
            else:
                result['message'] = f'未支持: {loop_type}'

            self.finished.emit(result)

        except Exception as e:
            result['message'] = f'异常: {e}'
            self.finished.emit(result)

    def _run_current(self, tmc, p, result):
        """电流环阶跃响应"""
        motion = (0 << 15) | (0 << 14) | (0 << 13) | (2 << 9) | (3 << 7) | (p['poles'] & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)
        tmc.write_register(REG_RAMP_V_MAX, 0x10000)
        tmc.write_register(REG_RAMP_V_START, 0)
        tmc.write_register(REG_RAMP_A1, 0x00020000)
        tmc.write_register(REG_RAMP_A_MAX, 0x40000)

        self.progress.emit('Phase 2: 写入电流环 PI...')
        pi_val = (p['p_reg'] << 16) | (p['i_reg'] & 0xFFFF)
        self._verify_write(tmc, REG_FLUX_COEFF, pi_val)
        self._verify_write(tmc, REG_TORQUE_COEFF, pi_val)
        tmc.write_register(REG_MOTOR_MOTION, motion)

        # 电流环积分限幅 + 抗饱和: 限制最大 iq = 1000mA
        torque_limit_raw = int(1000 / MA_PER_COUNT)  # ≈ 4967
        tmc.write_register(REG_TF_LIMITS, (torque_limit_raw << 16) | torque_limit_raw)

        self.progress.emit('Phase 3: 电流阶跃采集...')
        tgt, act = self._step_collect(tmc, REG_TF_TARGET, REG_TF_ACTUAL,
                                       step_val=ma_to_raw(p['target_ma']) & 0xFFFF,
                                       duration=p['duration'])

        result['tgt'] = tgt
        result['act'] = act
        result['title'] = f"Current Loop (iD={p['target_ma']}mA)"
        result['ylabel'] = 'Current (mA)'

        if len(tgt) < 10 or len(act) < 10:
            result['message'] = f'数据不足'
            return

        self.progress.emit('Phase 4: 绘图...')
        self._save_plot(result, tgt, act, p)
        result['success'] = True
        result['message'] = f'完成: {len(tgt)} pts'
        result['image_path'] = p['plot_path']

        # 清理
        tmc.write_register(REG_TF_TARGET, 0)
        tmc.write_register(0x15D, 0)  # 清积分器
        tmc.write_register(0x15E, 0)
        tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (p['poles'] & 0x7F))  # PWM_OFF

    def _run_velocity(self, tmc, p, result):
        """速度环阶跃响应"""
        # 电流环 PI（内环）
        self.progress.emit('Phase 2: 写入电流环 PI...')
        cur_pi = (p['cur_p_reg'] << 16) | (p['cur_i_reg'] & 0xFFFF)
        tmc.write_register(REG_FLUX_COEFF, cur_pi)
        tmc.write_register(REG_TORQUE_COEFF, cur_pi)

        # 速度环 PI
        self.progress.emit('Phase 3: 写入速度环 PI...')
        vel_pi = (p['vel_p_reg'] << 16) | (p['vel_i_reg'] & 0xFFFF)
        self._verify_write(tmc, REG_VEL_COEFF, vel_pi)

        # MOTION: VELOCITY, RAMP_EN=0, RAMP_USE_PHI_E=0
        motion = (0 << 15) | (0 << 14) | (0 << 13) | (3 << 9) | (3 << 7) | (p['poles'] & 0x7F)
        tmc.write_register(REG_MOTOR_MOTION, motion)

        # 速度环输出限幅: 最大 iq = 1000mA
        torque_limit_raw = int(1000 / MA_PER_COUNT)  # ≈ 4967
        tmc.write_register(REG_TF_LIMITS, (torque_limit_raw << 16) | torque_limit_raw)  # 限速度PID输出(扭矩目标)

        self.progress.emit('Phase 4: 速度阶跃采集...')
        # RPM 转内部单位
        step_val = int(p['target_rpm'] * K_VEL)
        tgt_raw, act_raw = self._step_collect_raw(tmc, REG_VEL_TARGET, REG_VEL_ACTUAL,
                                       step_val=step_val,
                                       duration=p['duration'])
        # 速度寄存器是32位有符号整数，内部单位转 RPM
        tgt = [(t, v / K_VEL) for t, v in tgt_raw]
        act = [(t, v / K_VEL) for t, v in act_raw]

        # 停电机
        tmc.write_register(REG_VEL_TARGET, 0)
        tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (p['poles'] & 0x7F))

        result['tgt'] = tgt
        result['act'] = act
        result['title'] = f"Velocity Loop ({p['target_rpm']}rpm)"
        result['ylabel'] = 'Velocity (rpm)'

        if len(tgt) < 10 or len(act) < 10:
            result['message'] = f'数据不足'
            return

        self.progress.emit('Phase 5: 绘图...')
        self._save_plot(result, tgt, act, p)
        result['success'] = True
        result['message'] = f'完成: {len(tgt)} pts'
        result['image_path'] = p['plot_path']

        # 清理
        tmc.write_register(REG_VEL_TARGET, 0)
        tmc.write_register(0x15D, 0)
        tmc.write_register(0x15E, 0)
        tmc.write_register(REG_MOTOR_MOTION, (3 << 7) | (p['poles'] & 0x7F))

    def _step_collect(self, tmc, target_reg, actual_reg, step_val, duration, raw=False):
        """通用阶跃采集：写目标 → RTMI 采集 → 返回 (tgt, act)"""
        tmc.write_register(target_reg, 0)
        time.sleep(0.5)

        tmc.stop_rtmi()
        time.sleep(0.3)
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()
            time.sleep(0.05)
            tmc.ser.reset_input_buffer()

        coll = Collector()
        coll.start()
        tmc.start_rtmi({0: target_reg, 1: actual_reg}, sampling=RTMI_SAMPLING, callback=coll.cb)
        time.sleep(0.3)

        tmc.write_register(target_reg, step_val)
        time.sleep(duration)
        coll.stop()

        tmc.stop_rtmi()
        time.sleep(0.1)
        if tmc.ser and tmc.ser.is_open:
            tmc.ser.reset_input_buffer()

        tgt, act = coll.unpack_raw() if raw else coll.unpack_flux()
        return tgt, act

    def _step_collect_raw(self, tmc, target_reg, actual_reg, step_val, duration):
        """速度/位置环用：返回原始32位数据"""
        return self._step_collect(tmc, target_reg, actual_reg, step_val, duration, raw=True)

    def _verify_write(self, tmc, addr, val, retries=5):
        for _ in range(retries):
            tmc.write_register(addr, val)
            time.sleep(0.01)
            if tmc.read_register(addr) == val:
                return True
            time.sleep(0.05)
        return False

    def _save_plot(self, result, tgt, act, p):
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt

        tgt = tgt[100:]
        act = act[100:]
        if not tgt or not act:
            return

        t0 = min(tgt[0][0], act[0][0])
        tgt_ms = [(t - t0) * 1000 for t, _ in tgt]
        tgt_v = [v for _, v in tgt]
        act_ms = [(t - t0) * 1000 for t, _ in act]
        act_v = [v for _, v in act]

        title = result.get('title', 'Step Response')
        ylabel = result.get('ylabel', 'Value')

        fig, ax = plt.subplots(1, 1, figsize=(14, 5))
        fig.suptitle(f'TMC6460 {title}', fontsize=12)
        ax.plot(tgt_ms, tgt_v, 'b-', lw=0.8, alpha=0.8, label='Target')
        ax.plot(act_ms, act_v, 'r-', lw=0.8, alpha=0.8, label='Actual')
        ax.set_ylabel(ylabel)
        ax.set_xlabel('Time (ms)')
        ax.legend(loc='upper right')
        ax.grid(True, alpha=0.3)
        plt.tight_layout()
        plt.savefig(p['plot_path'], dpi=150, bbox_inches='tight')
        plt.close()
