"""Calibration, PID and test procedures.

Ported from ``src-tauri/src/procs.rs`` and ``src/lib/pi-auto/model.ts``.
Everything here is synchronous and runs inside a worker thread; ``Ctx`` reports
step progress to the UI and honours cancellation.
"""

from __future__ import annotations

import csv
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from . import regs
from .link import Link, LinkError
from .units import (
    MA_PER_COUNT,
    counts_from_ma,
    s16hi,
    temp_c,
)

JOB_LABEL = {
    "encoder": "编码器写入",
    "calibrate": "电角度对齐",
    "pid": "PID 与限幅写入",
    "step": "阶跃测试",
    "sequence": "自动测试序列",
    "looptest": "环路测试",
    "autotune": "参数整定",
    "commission": "组合标定与找零",
}


@dataclass
class StepEvent:
    idx: int
    total: int
    label: str
    status: str
    detail: str = ""


@dataclass
class Ctx:
    link: Link
    motor: int = 1
    total: int = 0
    idx: int = 0
    cancel: threading.Event = field(default_factory=threading.Event)
    on_step: Callable[[StepEvent], None] | None = None
    on_log: Callable[[str, str], None] | None = None

    def cancelled(self) -> bool:
        return self.cancel.is_set()

    def _emit(self, idx: int, label: str, status: str, detail: str = "") -> None:
        if self.on_step:
            self.on_step(StepEvent(idx, self.total, label, status, detail))

    def begin(self, label: str) -> None:
        if self.cancelled():
            raise LinkError("已取消")
        self.idx += 1
        self._emit(self.idx, label, "run")

    def ok(self, label: str, detail: str = "") -> None:
        self._emit(self.idx, label, "ok", detail)
        if self.on_log:
            self.on_log("ok", f"{self.idx:02d}/{self.total} {label} · {detail}" if detail else f"{self.idx:02d}/{self.total} {label}")

    def fail(self, label: str, detail: str = "") -> None:
        self._emit(self.idx, label, "fail", detail)
        if self.on_log:
            self.on_log("error", f"{self.idx:02d}/{self.total} {label} · {detail}")

    def info(self, label: str, detail: str = "") -> None:
        self._emit(self.idx, label, "info", detail)

    def sleep(self, ms: float) -> None:
        end = time.monotonic() + ms / 1000.0
        while time.monotonic() < end:
            if self.cancelled():
                raise LinkError("已取消")
            time.sleep(min(0.02, max(0.0, end - time.monotonic())))


def ms(value: float) -> None:
    time.sleep(max(0.0, value) / 1000.0)


def ensure_stopped(link: Link) -> None:
    if link.read_reg(regs.MCC_MOTOR_MOTION) & 0x1E00:
        raise LinkError("请先断使能；禁止在带载保持或运动中应用参数")
    velocity = link.read_reg(regs.FOC_PID_VELOCITY_ACTUAL)
    if velocity & 0x80000000:
        velocity -= 0x100000000
    if abs(velocity) > 200:
        raise LinkError("电机尚未静止，参数未写入")
    if link.read_reg(regs.CHIP_STATUS_FLAGS) & 0x3FFF:
        raise LinkError("芯片故障未清除，参数未写入")


def cpr_inv_for(cpr: int) -> int:
    return 0 if cpr <= 0 else (1 << 24) // cpr


def build_spi_command(frame_bits: int, spi_mode: int, spi_hz: int, idle: int, csn_enc_n: bool) -> int:
    half = max(0, min(255, round(60_000_000 / (2.0 * max(1, spi_hz))) - 1))
    u = (max(0, frame_bits - 1)) & 0x1F
    if csn_enc_n:
        u |= 0x80
    cmd = 0xF0000000
    cmd |= (spi_mode & 0x03) << 26
    cmd |= 2 << 24
    cmd |= (idle & 0xFF) << 16
    cmd |= (u & 0xFF) << 8
    cmd |= half & 0xFF
    return cmd


@dataclass
class EncoderCfg:
    poles: int = 1
    cpr: int = 16_384
    csn_via_enc_n: bool = True
    frame_bits: int = 14
    spi_mode: int = 1
    spi_hz: int = 2_000_000
    idle_cycles: int = 16
    data_mask: int = 0x3FFF
    send_data: int = 0
    pwm_max_count: int = 4800
    csa_gain: int = 3
    write_velocity_cfg: bool = True
    vel_frq_conf: int = 0x0002BB12
    vel_per_conf: int = 0
    write_phi_e_offset: bool = False
    phi_e_offset: int = 0


def setup_encoder(ctx: Ctx, cfg: EncoderCfg) -> str:
    link = ctx.link
    ctx.total = 12
    base_mm = regs.motor_motion(regs.MODE_PWM_OFF, cfg.poles)

    label = "桥臂安全态 (PWM_OFF)"
    ctx.begin(label)
    link.write_reg(regs.MCC_MOTOR_MOTION, base_mm)
    link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0)
    link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, 0)
    ctx.ok(label, f"MOTOR_MOTION=0x{base_mm:08X}")

    label = "停止 IO Controller"
    ctx.begin(label)
    link.write_reg(regs.IO_COMMAND, 0)
    link.write_reg(regs.IO_RESPONSE_0, 0)
    ctx.sleep(40)
    ctx.ok(label, "COMMAND=0, RESPONSE_0=0")

    label = "配置 IO_MATRIX (SCK/SDI/CSN)"
    ctx.begin(label)
    cur = link.read_reg_retry(regs.CHIP_IO_MATRIX, 3)
    mask = 0x3F | (7 << 12)
    new = (cur & ~mask) | 0x3F | (3 << 12)
    if cfg.csn_via_enc_n:
        new = (new & ~(3 << 4)) | (3 << 4)
    if not link.write_verified(regs.CHIP_IO_MATRIX, new, 0xFFFF):
        ctx.fail(label, "写入失败")
        raise LinkError("IO_MATRIX 写入失败")
    ctx.ok(label, f"0x{cur:08X} → 0x{new:08X} (CSN via {'ENC_N' if cfg.csn_via_enc_n else 'HALL_W'})")

    label = "探测 IO Controller 固件"
    ctx.begin(label)
    link.write_reg(regs.IO_COMMAND, 0)
    ctx.sleep(20)
    link.write_reg(regs.IO_COMMAND, 0xAA000000)
    ctx.sleep(50)
    fw = link.read_reg_retry(regs.IO_RESPONSE_1, 3)
    if fw == 0:
        ctx.fail(label, "RESPONSE_1=0")
        raise LinkError("IO Controller 无响应 (0x00000000)")
    ctx.ok(label, f"RESPONSE_1=0x{fw:08X} (fw=0x{fw >> 8:X})")

    label = "反馈通道 A (0x240)"
    ctx.begin(label)
    cpr_inv = cpr_inv_for(cfg.cpr)
    conf = (7 << 24) | (cpr_inv & 0x00FFFFFF)
    if not link.write_verified(regs.FEEDBACK_CONF_CH_A, conf, 0x0FFFFFFF):
        ctx.fail(label, "写入失败")
        raise LinkError("0x240 写入失败")
    ctx.ok(label, f"PHI_EXT_A, CPR_INV={cpr_inv} (CPR={cfg.cpr})")

    label = "速度测量配置 (0x244/0x245)"
    ctx.begin(label)
    if cfg.write_velocity_cfg:
        ok1 = link.write_verified(regs.FEEDBACK_VELOCITY_FRQ_CONF, cfg.vel_frq_conf, 0x00FFFFFF)
        ok2 = True if cfg.vel_per_conf == 0 else link.write_verified(
            regs.FEEDBACK_VELOCITY_PER_CONF, cfg.vel_per_conf, 0xFFFFFFFF
        )
        if not (ok1 and ok2):
            ctx.fail(label, "写入失败")
            raise LinkError("速度测量配置写入失败")
        ctx.ok(label, f"0x244=0x{cfg.vel_frq_conf:08X} 0x245=0x{cfg.vel_per_conf:08X}")
    else:
        ctx.ok(label, "保留当前值")

    label = "反馈输出 (0x250)"
    ctx.begin(label)
    out_conf = (1 << 22) | (cfg.poles & 0xFF)
    if not link.write_verified(regs.FEEDBACK_OUTPUT_CONF, out_conf, 0x00FFFFFF):
        ctx.fail(label, "写入失败")
        raise LinkError("0x250 写入失败")
    ctx.ok(label, f"PHI_E_MUL_FACTOR={cfg.poles} (极对数), 周期测速")

    label = "电角度偏移 (0x242)"
    ctx.begin(label)
    if cfg.write_phi_e_offset:
        if not link.write_verified(regs.FEEDBACK_PHI_E_OFFSET, cfg.phi_e_offset & 0xFFFF, 0xFFFF):
            ctx.fail(label, "写入失败")
            raise LinkError("0x242 写入失败")
        ctx.ok(label, f"0x{cfg.phi_e_offset & 0xFFFF:04X}（复现已知偏移）")
    else:
        ctx.ok(label, "跳过：偏移由「对齐与闭环 → 电角度对齐」测得后写回")

    label = "PWM 周期 / 电流采样增益"
    ctx.begin(label)
    period = regs.mcc_pwm_period(cfg.pwm_max_count)
    if not link.write_verified(regs.MCC_PWM_PERIOD, period, 0x0000FFFF) or not link.write_verified(
        regs.MCC_ADC_CSA_GAIN, cfg.csa_gain & 0x03, 0x03
    ):
        ctx.fail(label, "PWM周期或CSA增益回读不一致")
        raise LinkError("PWM周期或CSA增益写入校验失败")
    f_pwm = 120_000_000.0 / max(1, cfg.pwm_max_count)
    ctx.ok(label, f"MAX_COUNT={cfg.pwm_max_count} → {f_pwm / 1000:.2f} kHz, CSA_GAIN={cfg.csa_gain}")

    label = "SPI 数据掩码 / 发送数据"
    ctx.begin(label)
    link.write_verified(regs.IO_RESPONSE_2, cfg.data_mask, 0xFFFFFFFF)
    link.write_verified(regs.IO_RESPONSE_1, cfg.send_data, 0xFFFFFFFF)
    ctx.ok(label, f"mask=0x{cfg.data_mask:08X} send=0x{cfg.send_data:08X}")

    label = "启动 SPI 轮询"
    ctx.begin(label)
    cmd = build_spi_command(cfg.frame_bits, cfg.spi_mode, cfg.spi_hz, cfg.idle_cycles, cfg.csn_via_enc_n)
    link.write_reg(regs.IO_COMMAND, cmd)
    ctx.sleep(80)
    ctx.ok(label, f"COMMAND=0x{cmd:08X} (mode {cfg.spi_mode} · {cfg.spi_hz / 1e6:.2f} MHz · {cfg.frame_bits} bit)")

    label = "校验 IO Controller 执行"
    ctx.begin(label)
    resp0 = link.read_reg_retry(regs.IO_RESPONSE_0, 3)
    if resp0 == 0:
        ctx.fail(label, "RESPONSE_0 = 0")
        raise LinkError("IO Controller 未执行命令 (RESPONSE_0=0)")
    raw = link.read_reg_retry(regs.FEEDBACK_PHI_EXT_A, 3)
    angle = raw & (0x00FFFFFF if cfg.frame_bits > 14 else 0x3FFF)
    ctx.ok(label, f"RESPONSE_0=0x{resp0:08X} · PHI_EXT_A=0x{raw:08X} (raw {angle})")
    return f"编码器配置完成，PHI_EXT_A=0x{raw:08X}"


@dataclass
class PidCfg:
    flux_p: int = 64
    flux_i: int = 48
    torque_p: int = 64
    torque_i: int = 48
    vel_p: int = 500
    vel_i: int = 250
    pos_p: int = 500
    pos_i: int = 0
    cur_norm_p: int = 1
    cur_norm_i: int = 1
    vel_norm_p: int = 1
    vel_norm_i: int = 0
    pos_norm_p: int = 1
    pos_norm_i: int = 0
    vel_shift: int = 0
    pos_sampling: int = 0
    overwrite_target: bool = False
    keep_pos_target: bool = False
    torque_limit_ma: float = 800
    flux_limit_ma: float = 0
    vel_limit_rpm: float = 25_000
    uq_ud_limit: int = 0x5A81
    ma_per_count: float = MA_PER_COUNT
    counts_per_rpm: float = 305.4


def compose_pid_config(c: PidCfg) -> int:
    return (
        ((c.pos_sampling & 0x7F) << 16)
        | ((c.vel_shift & 0x0F) << 12)
        | ((c.pos_norm_i & 3) << 10)
        | ((c.pos_norm_p & 3) << 8)
        | ((c.vel_norm_i & 3) << 6)
        | ((c.vel_norm_p & 3) << 4)
        | ((c.cur_norm_i & 1) << 3)
        | ((c.cur_norm_p & 1) << 2)
        | ((1 << 1) if c.overwrite_target else 0)
        | (1 if c.keep_pos_target else 0)
    )


@dataclass
class PidSnapshot:
    config: int = 0
    flux_coeff: int = 0
    torque_coeff: int = 0
    vel_coeff: int = 0
    pos_coeff: int = 0
    tf_limits: int = 0
    vel_limit: int = 0
    uq_ud_limit: int = 0


def read_pid(link: Link) -> PidSnapshot:
    return PidSnapshot(
        config=link.read_reg_retry(regs.FOC_PID_CONFIG, 3),
        flux_coeff=link.read_reg_retry(regs.FOC_PID_FLUX_COEFF, 3),
        torque_coeff=link.read_reg_retry(regs.FOC_PID_TORQUE_COEFF, 3),
        vel_coeff=link.read_reg_retry(regs.FOC_PID_VELOCITY_COEFF, 3),
        pos_coeff=link.read_reg_retry(regs.FOC_PID_POSITION_COEFF, 3),
        tf_limits=link.read_reg_retry(regs.FOC_PID_TORQUE_FLUX_LIMITS, 3),
        vel_limit=link.read_reg_retry(regs.FOC_PID_VELOCITY_LIMIT, 3),
        uq_ud_limit=link.read_reg_retry(regs.FOC_PID_UQ_UD_LIMITS, 3),
    )


def apply_pid(ctx: Ctx, c: PidCfg) -> dict:
    link = ctx.link
    ensure_stopped(link)
    t = counts_from_ma(c.torque_limit_ma, c.ma_per_count)
    f = counts_from_ma(c.flux_limit_ma, c.ma_per_count)
    v = round(c.vel_limit_rpm * c.counts_per_rpm)
    plan = [
        (regs.FOC_PID_CONFIG, compose_pid_config(c), 0x7FFFFF),
        (regs.FOC_PID_FLUX_COEFF, ((c.flux_p & 0xFFFF) << 16) | (c.flux_i & 0xFFFF), 0xFFFFFFFF),
        (regs.FOC_PID_TORQUE_COEFF, ((c.torque_p & 0xFFFF) << 16) | (c.torque_i & 0xFFFF), 0xFFFFFFFF),
        (regs.FOC_PID_VELOCITY_COEFF, ((c.vel_p & 0xFFFF) << 16) | (c.vel_i & 0xFFFF), 0xFFFFFFFF),
        (regs.FOC_PID_POSITION_COEFF, ((c.pos_p & 0xFFFF) << 16) | (c.pos_i & 0xFFFF), 0xFFFFFFFF),
        (regs.FOC_PID_TORQUE_FLUX_LIMITS, ((t & 0x7FFF) << 16) | (f & 0x7FFF), 0x7FFF7FFF),
        (regs.FOC_PID_VELOCITY_LIMIT, v & 0x7FFFFFFF, 0x7FFFFFFF),
        (regs.FOC_PID_UQ_UD_LIMITS, c.uq_ud_limit & 0xFFFF, 0xFFFF),
    ]
    ctx.total = len(plan) + 4
    checks = []
    for addr, value, mask in plan:
        if ctx.cancelled():
            raise LinkError("PID apply cancelled")
        label = f"PID 0x{addr:03X}"
        ctx.begin(label)
        if not link.write_verified(addr, value, mask):
            ctx.fail(label, "回读不一致")
            raise LinkError(f"PID 0x{addr:03X} 写入校验失败")
        ctx.ok(label, f"0x{value:08X} · readback verified")
        checks.append({"addr": f"0x{addr:03X}", "ok": True})
    for addr in (0x15D, 0x15E, 0x15F, 0x160):
        label = f"Integrator 0x{addr:03X}"
        ctx.begin(label)
        if not link.write_verified(addr, 0, 0xFFFFFFFF):
            ctx.fail(label, "清零失败")
        else:
            ctx.ok(label, "zero verified")
    return {"checks": checks}


# ---------------------------------------------------------------------------
# phi_e alignment
# ---------------------------------------------------------------------------


@dataclass
class CalibCfg:
    flux_ma: float = 300.0
    poles: int = 1
    settle_ms: int = 700
    step_deg: int = 90
    end_deg: int = 720
    ma_per_count: float = MA_PER_COUNT
    write_back: bool = True
    dry_run: bool = False
    cpr: int = 16_384


@dataclass
class CalibPoint:
    deg: int
    enc: int


@dataclass
class CalibResult:
    offset: int = 0
    intercept: float = 0.0
    slope: float = 0.0
    r2: float = 0.0
    points: list[CalibPoint] = field(default_factory=list)
    written: bool = False

    @property
    def offset_hex(self) -> str:
        return f"0x{self.offset:04X}"


def _read_encoder_raw(link: Link, frame_bits: int) -> int:
    value = link.read_reg_retry(regs.FEEDBACK_PHI_EXT_A, 3)
    return value & (0x00FFFFFF if frame_bits > 14 else 0x3FFF)


def _fit_offset(points: list[CalibPoint], scale: float, poles: int) -> tuple[int, float, float, float] | None:
    bins: dict[int, list[float]] = {}
    for p in points:
        bins.setdefault(p.deg % 360, []).append(float(p.enc))
    if len(bins) < 3:
        return None
    avg = [(float(k), sum(v) / len(v)) for k, v in sorted(bins.items())]
    uw = [avg[0][1]]
    for i in range(1, len(avg)):
        delta = avg[i][1] - avg[i - 1][1]
        if delta < -8192:
            delta += 16384
        elif delta > 8192:
            delta -= 16384
        uw.append(uw[i - 1] + delta)
    n = len(avg)
    sx = sum(d for d, _ in avg)
    sy = sum(uw)
    sxy = sum(d * e for (d, _), e in zip(avg, uw))
    sxx = sum(d * d for d, _ in avg)
    den = n * sxx - sx * sx
    if abs(den) < 1e-9:
        return None
    slope = (n * sxy - sx * sy) / den
    intercept = (sy - slope * sx) / n
    mean = sy / n
    ss_tot = sum((e - mean) ** 2 for e in uw)
    ss_res = sum((e - (slope * d + intercept)) ** 2 for (d, _), e in zip(avg, uw))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    target16 = (0.0 / 360.0) * 65536.0
    converted = intercept * scale
    offset = int(round(target16 - converted * max(1, poles))) % 65536
    return offset, intercept, slope, r2


def calibrate_phi_e(ctx: Ctx, cfg: CalibCfg, frame_bits: int = 14) -> CalibResult:
    link = ctx.link
    angles = list(range(0, cfg.end_deg + 1, max(10, cfg.step_deg)))
    sequence = angles + list(reversed(angles))
    ctx.total = 5 + len(sequence)
    base_mm = regs.motor_motion(regs.MODE_PWM_OFF, cfg.poles)

    label = "基础配置（电流环/限幅）"
    ctx.begin(label)
    cnt = max(1, min(8192, counts_from_ma(cfg.flux_ma, cfg.ma_per_count)))
    if not link.write_verified(regs.MCC_ADC_CSA_GAIN, 3, 0x03):
        ctx.fail(label, "CSA增益未成功写为4×")
        raise LinkError("CSA增益写入校验失败，请重新配置编码器后再对齐")
    link.write_verified(regs.FOC_PID_FLUX_COEFF, (64 << 16) | 48, 0xFFFFFFFF)
    link.write_verified(regs.FOC_PID_TORQUE_COEFF, (64 << 16) | 48, 0xFFFFFFFF)
    link.write_verified(regs.FOC_PID_TORQUE_FLUX_LIMITS, (8192 << 16) | 8192, 0x7FFF7FFF)
    ctx.ok(label, f"{cnt} counts ≈ {cfg.flux_ma:.0f} mA")

    label = "使能驱动"
    ctx.begin(label)
    gdrv = link.read_reg_retry(regs.MCC_GDRV, 3)
    if not link.write_verified(regs.MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x80010000):
        ctx.fail(label, "DRV_EN 回读失败")
        raise LinkError("驱动使能失败")
    ctx.ok(label, "DRV_EN + 电荷泵")

    label = "进入开环力矩 + 位置 ramp"
    ctx.begin(label)
    mm = regs.motor_motion_openloop(regs.MODE_TORQUE, cfg.poles, False)
    link.write_verified(regs.MCC_MOTOR_MOTION, mm, 0x0000FFFF)
    link.write_verified(regs.RAMPER_V_MAX, 0x00010000, 0x07FFFFFF)
    link.write_verified(regs.RAMPER_V_START, 0, 0x07FFFFFF)
    link.write_verified(regs.RAMPER_A1, 0x00020000, 0x007FFFFF)
    link.write_verified(regs.RAMPER_A_MAX, 0x00040000, 0x007FFFFF)
    ctx.ok(label, f"MOTOR_MOTION=0x{mm:08X}")

    label = "施加对齐电流"
    ctx.begin(label)
    link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, cnt & 0xFFFF)
    ctx.sleep(300)
    actual = link.read_reg_retry(regs.FOC_PID_TORQUE_FLUX_ACTUAL, 3)
    ctx.ok(label, f"iD={cnt} counts (actual 0x{actual:08X})")

    if cfg.dry_run:
        ctx.info("干跑模式", "不扫描、不写回")
        _release_alignment(link, base_mm)
        return CalibResult()

    points: list[CalibPoint] = []
    try:
        for deg in sequence:
            if ctx.cancelled():
                raise LinkError("已取消")
            label = f"扫描 {deg}°"
            ctx.begin(label)
            target = int((deg % 360) / 360 * 65536) & 0xFFFF
            link.write_reg(regs.FOC_PID_POSITION_TARGET, target)
            deadline = time.monotonic() + 2.5
            arrived = False
            while time.monotonic() < deadline:
                try:
                    pe = link.read_reg(regs.RAMPER_PHI_E) & 0xFFFF
                    d = abs(pe - target)
                    if min(d, 65536 - d) < 0x800:
                        arrived = True
                        break
                except LinkError:
                    pass
                time.sleep(0.03)
            if not arrived:
                ctx.fail(label, "位置未到达（超时）")
                continue
            ctx.sleep(cfg.settle_ms)
            try:
                enc = _read_encoder_raw(link, frame_bits)
                points.append(CalibPoint(deg, enc))
                ctx.ok(label, f"enc={enc}")
            except LinkError as exc:
                ctx.fail(label, str(exc))
    finally:
        _release_alignment(link, base_mm)

    label = "拟合电角度偏移"
    ctx.begin(label)
    scale = 65536.0 / max(1, cfg.cpr)
    fit = _fit_offset(points, scale, cfg.poles)
    if fit is None:
        ctx.fail(label, "有效点不足，无法拟合")
        return CalibResult(points=points)
    offset, intercept, slope, r2 = fit
    ctx.ok(label, f"R²={r2:.5f} · offset 0x{offset:04X}")

    label = "写回 PHI_E_OFFSET (0x242)"
    ctx.begin(label)
    written = False
    if cfg.write_back and r2 > 0.9:
        written = link.write_verified(regs.FEEDBACK_PHI_E_OFFSET, offset, 0xFFFF)
        if written:
            ctx.ok(label, f"0x{offset:04X}")
        else:
            ctx.fail(label, "写入校验失败")
            raise LinkError("对齐偏移写入校验失败，未完成对齐")
    else:
        ctx.info(label, "未写回（干跑或拟合质量不足）")
    return CalibResult(offset, intercept, slope, r2, points, written)


def _release_alignment(link: Link, base_mm: int) -> None:
    try:
        link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, 0)
        link.write_reg(regs.MCC_MOTOR_MOTION, base_mm)
    except LinkError:
        pass


# ---------------------------------------------------------------------------
# step response / sequence
# ---------------------------------------------------------------------------


class Capture:
    """Records RTMI samples on demand (timestamp, channel, raw)."""

    def __init__(self, link: Link) -> None:
        self.link = link
        self.records: list[tuple[float, int, int]] = []
        self._saved = link.on_batch
        link.on_batch = self._on_batch

    def _on_batch(self, ts: float, pts: list[tuple[int, int]]) -> None:
        if self.records is not None:
            self.records.extend((ts, ch, raw) for ch, raw in pts)

    def close(self) -> None:
        self.link.on_batch = self._saved


def step_response(ctx: Ctx, kind: str, amplitude: float, duration_s: float, cal: dict) -> dict:
    link = ctx.link
    ctx.total = 6
    label = "安全态与参数"
    ctx.begin(label)
    ensure_stopped(link)
    link.stop_rtmi()
    ctx.ok(label, "驱动器已静止")

    label = "配置 RTMI（目标 / 实际 / 电流）"
    ctx.begin(label)
    link.start_rtmi([(0, regs.FOC_PID_VELOCITY_TARGET), (1, regs.FOC_PID_VELOCITY_ACTUAL), (2, regs.FOC_PID_TORQUE_FLUX_ACTUAL)], 0, False)
    capture = Capture(link)
    ctx.ok(label, "3 通道 · 直读采样")

    label = "使能驱动"
    ctx.begin(label)
    gdrv = link.read_reg_retry(regs.MCC_GDRV, 3)
    link.write_verified(regs.MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x80010000)
    ctx.ok(label, "DRV_EN")

    label = "施加阶跃"
    ctx.begin(label)
    k = cal.get("counts_per_rpm", 305.4)
    if kind == "current":
        counts = counts_from_ma(abs(amplitude), cal.get("ma_per_count", MA_PER_COUNT))
        mode = regs.MODE_TORQUE
        link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(mode, cal.get("poles", 1)), 0xFFFF)
        link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, counts & 0xFFFF)
    else:
        mode = regs.MODE_VELOCITY
        link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(mode, cal.get("poles", 1)), 0xFFFF)
        link.write_reg(regs.FOC_PID_VELOCITY_TARGET, round(amplitude * k) & 0xFFFFFFFF)
    ctx.ok(label, f"{amplitude:.0f} {'mA' if kind == 'current' else 'RPM'}")

    label = "采集响应"
    ctx.begin(label)
    ctx.sleep(duration_s * 1000)
    ctx.ok(label, f"{len(capture.records)} 帧")

    label = "停止与收尾"
    ctx.begin(label)
    link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0)
    link.write_reg(regs.FOC_PID_TORQUE_FLUX_TARGET, 0)
    link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, cal.get("poles", 1)))
    capture.close()
    link.stop_rtmi()
    ctx.ok(label, "PWM_OFF")

    label = "计算指标"
    ctx.begin(label)
    by_ch: dict[int, list[tuple[float, int]]] = {}
    for ts, ch, raw in capture.records:
        by_ch.setdefault(ch, []).append((ts, raw))
    series = by_ch.get(1) or by_ch.get(0) or []
    metrics = _step_metrics(series, kind, cal)
    ctx.ok(label, f"上升 {metrics['rise_ms']:.1f} ms · 超调 {metrics['overshoot_pct']:.1f} %")
    return {"metrics": metrics, "samples": [(ts, raw) for ts, raw in series]}


def _step_metrics(series: list[tuple[float, int]], kind: str, cal: dict) -> dict:
    if len(series) < 4:
        return {"rise_ms": 0.0, "overshoot_pct": 0.0, "settle_ms": 0.0}
    k = cal.get("counts_per_rpm", 305.4)
    values = [(ts, raw / k if kind != "current" else s16hi(raw) * cal.get("ma_per_count", MA_PER_COUNT)) for ts, raw in series]
    t0 = values[0][0]
    start = values[0][1]
    final = sum(v for _, v in values[-max(1, len(values) // 10) :]) / max(1, len(values) // 10)
    span = final - start
    if abs(span) < 1e-9:
        return {"rise_ms": 0.0, "overshoot_pct": 0.0, "settle_ms": 0.0}
    lo, hi = start + 0.1 * span, start + 0.9 * span
    t10 = t90 = None
    peak = start
    for ts, v in values:
        if t10 is None and (v - lo) * (span > 0) >= 0:
            t10 = ts
        if t90 is None and (v - hi) * (span > 0) >= 0:
            t90 = ts
        if (v - peak) * (span > 0) > 0:
            peak = v
    rise = (t90 - t10) if t10 is not None and t90 is not None else 0.0
    overshoot = abs((peak - final) / span * 100) if span else 0.0
    settle = 0.0
    for i, (ts, v) in enumerate(values):
        if abs(v - final) <= 0.02 * abs(span):
            settle = ts - t0
            break
    return {"rise_ms": rise, "overshoot_pct": overshoot, "settle_ms": settle}


def run_sequence(ctx: Ctx, cfg: dict, cal: dict, reports_dir: Path) -> dict:
    link = ctx.link
    steps = cfg.get("steps") or []
    ctx.total = 4 + len(steps) * 3
    label = "准备测试"
    ctx.begin(label)
    ensure_stopped(link)
    link.stop_rtmi()
    ctx.ok(label, "静止检查通过")

    label = "配置 RTMI"
    ctx.begin(label)
    link.start_rtmi([(0, regs.FOC_PID_VELOCITY_TARGET), (1, regs.FOC_PID_VELOCITY_ACTUAL), (2, regs.FOC_PID_TORQUE_FLUX_ACTUAL), (3, regs.ADC_TEMP_RAW)], 0, False)
    ctx.ok(label, "4 通道")

    label = "使能驱动"
    ctx.begin(label)
    gdrv = link.read_reg_retry(regs.MCC_GDRV, 3)
    link.write_verified(regs.MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x80010000)
    link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_VELOCITY, cal.get("poles", 1)), 0xFFFF)
    ctx.ok(label, "VELOCITY 模式")

    k = cal.get("counts_per_rpm", 305.4)
    rows = []
    t_start = time.monotonic()
    for i, step in enumerate(steps, 1):
        rpm = float(step.get("rpm", 0))
        hold = float(step.get("hold_s", 2))
        label = f"档位 {i} · {rpm:.0f} RPM"
        ctx.begin(label)
        link.write_reg(regs.FOC_PID_VELOCITY_TARGET, round(rpm * k) & 0xFFFFFFFF)
        ctx.sleep(min(300, hold * 1000 / 4))
        ctx.ok(label, "已下发")
        label = f"档位 {i} · 保持 {hold:.1f} s"
        ctx.begin(label)
        capture = Capture(link)
        ctx.sleep(hold * 1000)
        rows.append(_sequence_row(i, rpm, capture.records, cal, t_start))
        capture.close()
        ctx.ok(label, f"均值 {rows[-1]['mean']:.1f} RPM")
        label = f"档位 {i} · 判据"
        ctx.begin(label)
        tol = float(cfg.get("tolerance", 50))
        verdict = "pass" if abs(rows[-1]["mean"] - rpm) <= tol and rows[-1]["ripple"] <= tol * 2 else "fail"
        rows[-1]["verdict"] = verdict
        ctx.ok(label, "通过" if verdict == "pass" else "超差")

    label = "停止与收尾"
    ctx.begin(label)
    link.write_reg(regs.FOC_PID_VELOCITY_TARGET, 0)
    link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, cal.get("poles", 1)))
    link.stop_rtmi()
    ctx.ok(label, "PWM_OFF")

    label = "导出 CSV"
    ctx.begin(label)
    path = _write_sequence_csv(cfg, rows, reports_dir)
    ctx.ok(label, str(path))
    return {"summary": rows, "csv_path": str(path)}


def _sequence_row(index: int, rpm: float, records: list[tuple[float, int, int]], cal: dict, t_start: float) -> dict:
    k = cal.get("counts_per_rpm", 305.4)
    speed = [raw / k for _, ch, raw in records if ch == 1]
    current = [s16hi(raw) * cal.get("ma_per_count", MA_PER_COUNT) for _, ch, raw in records if ch == 2]
    temps = [temp_c(raw, cal.get("temp_offset", 0)) for _, ch, raw in records if ch == 3]
    mean = sum(speed) / len(speed) if speed else 0.0
    ripple = (max(speed) - min(speed)) if speed else 0.0
    return {
        "idx": index,
        "rpm": rpm,
        "mean": mean,
        "ripple": ripple,
        "current": sum(current) / len(current) if current else 0.0,
        "temp": sum(temps) / len(temps) if temps else 0.0,
        "verdict": "—",
    }


def _write_sequence_csv(cfg: dict, rows: list[dict], reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    serial_no = str(cfg.get("serial") or "UNSET").strip().replace(" ", "_")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = reports_dir / f"{serial_no}-{stamp}.csv"
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(["serial", "operator", "note", "mode", "index", "target_rpm", "mean_rpm", "ripple_rpm", "mean_iq_ma", "temp_c", "verdict"])
        for r in rows:
            writer.writerow([
                serial_no,
                cfg.get("operator", ""),
                cfg.get("note", ""),
                cfg.get("mode", "closed"),
                r["idx"],
                r["rpm"],
                f"{r['mean']:.2f}",
                f"{r['ripple']:.2f}",
                f"{r['current']:.1f}",
                f"{r['temp']:.1f}",
                r["verdict"],
            ])
    return path


# ---------------------------------------------------------------------------
# PRBS identification (host-driven, same ARX math as pi-auto/model.ts)
# ---------------------------------------------------------------------------


@dataclass
class PiSample:
    at: float
    reference: float
    actual: float
    effort: float


@dataclass
class PiCapture:
    loop: int = 0
    sample_hz: float = 0.0
    pwm_hz: float = 0.0
    pid_config: int = 0
    samples: list[PiSample] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.samples)


def prbs_bits(length: int, seed: int = 0x5A) -> list[int]:
    """Maximal-length LFSR (x^7 + x^6 + 1) → +1/-1 excitation."""
    state = seed & 0x7F or 0x7F
    out = []
    for _ in range(length):
        bit = ((state >> 6) ^ (state >> 5)) & 1
        state = ((state << 1) | bit) & 0x7F
        out.append(1 if state & 0x40 else -1)
    return out


def capture_prbs(ctx: Ctx, loop: int, amplitude: float, duration_s: float, cal: dict, sampling: int = 4) -> PiCapture:
    """Excite one loop with a PRBS reference and record reference/actual/effort."""
    link = ctx.link
    ensure_stopped(link)
    link.stop_rtmi()
    k = cal.get("counts_per_rpm", 305.4)
    if loop == 3:
        ref_addr, act_addr = regs.FOC_PID_POSITION_TARGET, regs.FOC_PID_POSITION_ACTUAL
        mode = regs.MODE_POSITION
        scale = 65536 / 360.0
    elif loop == 2:
        ref_addr, act_addr = regs.FOC_PID_VELOCITY_TARGET, regs.FOC_PID_VELOCITY_ACTUAL
        mode = regs.MODE_VELOCITY
        scale = k
    else:
        ref_addr, act_addr = regs.FOC_PID_TORQUE_FLUX_TARGET, regs.FOC_PID_TORQUE_FLUX_ACTUAL
        mode = regs.MODE_TORQUE
        scale = 1.0 / max(1e-6, cal.get("ma_per_count", MA_PER_COUNT))
    link.start_rtmi([(0, ref_addr), (1, act_addr), (2, regs.FOC_PID_TORQUE_FLUX_ACTUAL)], sampling, False)
    cap = Capture(link)
    try:
        gdrv = link.read_reg_retry(regs.MCC_GDRV, 3)
        link.write_verified(regs.MCC_GDRV, gdrv | (1 << 31) | (1 << 16), 0x80010000)
        link.write_verified(regs.MCC_MOTOR_MOTION, regs.motor_motion(mode, cal.get("poles", 1)), 0xFFFF)
        bits = prbs_bits(int(duration_s * 100))
        interval = 0.01
        start = time.monotonic()
        index = 0
        while time.monotonic() - start < duration_s:
            if ctx.cancelled():
                break
            bit = bits[index % len(bits)]
            value = int(amplitude * bit * scale) if loop != 0 else int(amplitude * bit / max(1e-6, cal.get("ma_per_count", MA_PER_COUNT))) & 0xFFFF
            link.write_reg(ref_addr, value & 0xFFFFFFFF)
            index += 1
            ctx.sleep(interval * 1000)
    finally:
        link.write_reg(ref_addr, 0)
        link.write_reg(regs.MCC_MOTOR_MOTION, regs.motor_motion(regs.MODE_PWM_OFF, cal.get("poles", 1)))
        link.stop_rtmi()
        cap.close()

    by: dict[int, list[tuple[float, int]]] = {}
    for ts, ch, raw in cap.records:
        by.setdefault(ch, []).append((ts, raw))
    refs = dict(by.get(0, []))
    acts = by.get(1, [])
    efforts = dict(by.get(2, []))
    samples: list[PiSample] = []
    for ts, raw_actual in acts:
        if ts in refs and ts in efforts:
            samples.append(PiSample(ts, float(refs[ts]), float(raw_actual), float(efforts[ts])))
    hz = 0.0
    if len(acts) > 1:
        span = (acts[-1][0] - acts[0][0]) / 1000.0
        hz = (len(acts) - 1) / span if span > 0 else 0.0
    return PiCapture(loop, hz, link.pwm_frequency_hz() or 25_000.0, read_pid(link).config, samples)


def identify(capture: PiCapture) -> dict:
    if capture.count < 96 or capture.sample_hz <= 0:
        raise ValueError("需要完整且无丢帧的辨识记录（至少 96 组）")
    s = capture.samples[24:]
    train = s[: len(s) // 2]
    validation = s[len(train) :]
    if len(train) < 8 or len(validation) < 4:
        raise ValueError("辨识样本不足")

    def avg(values):
        return sum(values) / len(values) if values else 0.0

    out = train[2:]
    prev = train[1:-1]
    lag = train[:-2]
    mean_z = avg([v.reference for v in prev])
    mean_w = avg([v.reference for v in lag])
    mean_y = avg([v.actual for v in out])
    mean_prev = avg([v.actual for v in prev])
    mean_u = avg([v.effort for v in prev])
    aa = ab = ba = bb = ay = by = energy = 0.0
    for k in range(2, len(train)):
        z = train[k - 1].reference - mean_z
        w = train[k - 2].reference - mean_w
        y = train[k].actual - mean_y
        pv = train[k - 1].actual - mean_prev
        u = train[k - 1].effort - mean_u
        aa += z * pv
        ab += z * u
        ba += w * pv
        bb += w * u
        ay += z * y
        by += w * y
        energy += y * y
    det = aa * bb - ab * ba
    scale = abs(aa * bb) + abs(ab * ba)
    if energy <= 0 or scale <= 0 or abs(det) < scale * 1e-5:
        raise ValueError("激励或响应不足，无法分辨对象动态；请检查信号及采样带宽")
    a = (ay * bb - ab * by) / det
    b = (aa * by - ay * ba) / det
    if not math.isfinite(a) or not math.isfinite(b) or a <= 0 or a > 1.01 or b <= 0:
        raise ValueError(f"一阶对象模型不适用（a={a:.4f}, b={b:.4g}），不生成PI")
    residual = 0.0
    for k in range(2, len(train)):
        residual += (
            train[k].actual - mean_y - a * (train[k - 1].actual - mean_prev) - b * (train[k - 1].effort - mean_u)
        ) ** 2
    fit = 1 - residual / energy
    if fit < 0.65:
        raise ValueError(f"模型拟合不足（{fit * 100:.1f}%），需要更合适的采样或模型")
    prediction = validation[0].actual
    error = power = 0.0
    offset = mean_y - a * mean_prev - b * mean_u
    center = avg([v.actual for v in validation])
    for k in range(1, len(validation)):
        prediction = a * prediction + b * validation[k - 1].effort + offset
        error += (validation[k].actual - prediction) ** 2
        power += (validation[k].actual - center) ** 2
    validation_fit = 1 - error / power if power > 0 else -math.inf
    if not math.isfinite(validation_fit) or validation_fit < 0.65:
        raise ValueError(f"独立自由响应验证不足（{validation_fit * 100:.1f}%），不生成PI")
    return {
        "a": a,
        "b": b,
        "fit": fit,
        "validationFit": validation_fit,
        "tauSeconds": -1 / (capture.sample_hz * math.log(a)) if a < 1 else None,
        "dcGain": b / (1 - a) if a < 1 else None,
    }


def calculate_pi(capture: PiCapture, bandwidth_hz: float) -> dict:
    if not math.isfinite(bandwidth_hz) or bandwidth_hz <= 0 or bandwidth_hz > capture.sample_hz / 10:
        raise ValueError(f"目标带宽应大于0且不超过本次采样率的1/10（{capture.sample_hz / 10:.2f} Hz）")
    model = identify(capture)
    if capture.loop < 2 and model["a"] < math.exp(-0.5):
        raise ValueError("电流对象时间常数不足两个采样周期，当前链路无法可靠整定该电流环")
    pole = math.exp(-2 * math.pi * bandwidth_hz / capture.sample_hz)
    kp = (model["a"] - pole * pole) / model["b"]
    ki_per_s = (1 - pole) ** 2 / model["b"] * capture.sample_hz
    p, i = encode_gains(kp, ki_per_s, _controller_hz(capture), capture.pid_config, capture.loop)
    return {
        "p": p,
        "i": i,
        "kp": kp,
        "kiPerSecond": ki_per_s,
        "bandwidthHz": bandwidth_hz,
        "model": model,
        "warnings": [],
    }


def _controller_hz(capture: PiCapture) -> float:
    if capture.loop < 2:
        return capture.pwm_hz
    if capture.loop == 2:
        vel_shift = (capture.pid_config >> 12) & 0x0F
        return capture.pwm_hz / (1 << vel_shift)
    pos_sampling = (capture.pid_config >> 16) & 0x7F
    return capture.pwm_hz / max(1, pos_sampling + 1)


def encode_gains(kp: float, ki_per_s: float, controller_hz: float, config: int, loop: int) -> tuple[int, int]:
    current = loop < 2
    pf = ((config >> 2) & 1) * 8 if current else ((config >> (4 if loop == 2 else 8)) & 3) * 8
    inf = ((config >> 3) & 1) * 8 if current else 8 + ((config >> (6 if loop == 2 else 10)) & 3) * 8
    shift = ((config >> 12) & 15) if loop == 2 else 0
    if not all(math.isfinite(v) for v in (kp, ki_per_s, controller_hz)) or kp <= 0 or ki_per_s < 0 or controller_hz <= 0:
        raise ValueError("PI换算输入无效")
    p = round(kp * 2 ** (pf + shift))
    i = round(ki_per_s / controller_hz * 2 ** (inf + shift))
    if p < 1 or p > 32767 or i < 0 or i > 32767:
        raise ValueError("当前归一化无法表示候选PI；请调整带宽或在PID页配置归一化后重新辨识")
    return p, i


def read_live_angle(link: Link, frame_bits: int = 14) -> dict:
    raw = link.read_reg_retry(regs.FEEDBACK_PHI_EXT_A, 3)
    phi = link.read_reg_retry(regs.FEEDBACK_PHI_E, 3)
    if frame_bits > 14:
        angle = (raw & 0x00FFFFFF) / (1 << 24) * 360
    else:
        angle = (raw & 0x3FFF) / 16384 * 360
    return {"raw": raw, "angle": angle, "phiE": phi & 0xFFFF}


# ---------------------------------------------------------------------------
# split storage (MCU W25 archive / M24 backup)
# ---------------------------------------------------------------------------

STORAGE_OP_READ = 1
STORAGE_OP_WRITE = 3
STORAGE_OP_M24_READ = 4
STORAGE_OP_M24_SAVE = 5
STORAGE_OP_VERIFY = 6


def storage_request(link: Link, motor: int, operation: int, offset: int = 0, data: bytes = b"") -> dict:
    if not 1 <= operation <= 6 or offset > 128 or len(data) > 106 or offset + len(data) > 128:
        raise LinkError("Invalid split-storage request")
    request_id = int(time.time() * 1000) & 0xFFFFFFFF
    payload = bytes([1, operation]) + request_id.to_bytes(4, "little") + bytes([offset, len(data)]) + data
    reply = link.gateway_control(motor, 33, payload)
    if len(reply) < 22 or reply[0] != 1 or reply[1] > 5 or reply[18] & ~7 or reply[19] or reply[20] > 128 or reply[21] > 106 or len(reply) != 22 + reply[21]:
        raise LinkError("Invalid split-storage response")
    rid = int.from_bytes(reply[2:6], "little")
    result = int.from_bytes(reply[6:10], "little", signed=True)
    if rid != request_id or reply[10] != motor or not 1 <= reply[11] <= 5 or (operation != 6 and reply[11] != operation):
        raise LinkError(f"Storage rejected or stale response (result={result}); read device status before resubmitting")
    return {
        "id": rid,
        "phase": reply[1],
        "result": result,
        "motor": reply[10],
        "operation": reply[11],
        "generation": int.from_bytes(reply[12:16], "little"),
        "hand_id": int.from_bytes(reply[16:18], "little"),
        "flags": reply[18],
        "offset": reply[20],
        "data": list(reply[22:]),
    }


def eeprom_probe(link: Link) -> dict:
    return {
        "ok": False,
        "length": 256,
        "message": "M24C02 字节访问后端尚未验证：TMC ROM 定义为12位地址/16位数据，器件寻址、字节序和 SSI 恢复仍待核实；本次未访问或修改 EEPROM",
    }
