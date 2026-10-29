import { REGISTERS, type RegisterDef, type RegisterGroup } from "./registers.gen";

export { REGISTERS };
export type { RegisterDef, RegisterGroup };

export const GROUP_LABELS: Record<RegisterGroup, string> = {
  CHIP: "芯片 / 引脚",
  CLK_CTRL: "时钟",
  ADC: "ADC 采样",
  MCC_ADC: "电流采样",
  MCC_CONFIG: "运动引擎",
  FOC: "FOC / PID",
  BIQUAD: "双二阶滤波",
  RAMPER: "斜坡发生器",
  EXT_CTRL: "外部控制",
  FEEDBACK: "反馈引擎",
  ABN: "ABN 编码器",
  ABN2: "ABN 编码器 2",
  HALL: "霍尔 / 模拟传感器",
  UART: "UART / RTMI",
  IO_CONTROLLER: "IO 控制器",
};

export interface RegMeta {
  /** Chinese label shown in tables. */
  label: string;
  desc?: string;
  bits?: [number, number, string][];
  ro?: boolean;
}

/** Hand written metadata for the registers the UI actually surfaces. */
export const REG_META: Record<number, RegMeta> = {
  0x000: { label: "芯片 ID", desc: "CHIP.ID，上电自检用", ro: true },
  0x001: { label: "型号变体", ro: true },
  0x002: { label: "版本号", ro: true },
  0x006: {
    label: "引脚复用 IO_MATRIX",
    desc: "配置 ENC_A/B/N、HALL、SCK/SDO/SDI 的复用功能",
    bits: [
      [1, 0, "PIN_ENC_A"],
      [3, 2, "PIN_ENC_B"],
      [5, 4, "PIN_ENC_N"],
      [7, 6, "PIN_HALL_U[1:0]"],
      [8, 8, "PIN_HALL_U[2]"],
      [10, 9, "PIN_HALL_V"],
      [12, 11, "PIN_HALL_W"],
      [14, 13, "PIN_REF_L"],
      [16, 15, "PIN_REF_R"],
      [18, 17, "PIN_SDI"],
      [20, 19, "PIN_SDO"],
      [22, 21, "PIN_SCK"],
      [24, 23, "PIN_PWM_IN"],
      [26, 25, "PIN_UART_RXD"],
      [28, 27, "PIN_UART_TXD"],
      [30, 29, "PIN_FAULTN"],
    ],
  },
  0x009: {
    label: "状态标志 STATUS_FLAGS",
    desc: "所有故障位的汇总，bit31..bit0 与右表一一对应",
    ro: true,
    bits: [
      [31, 31, "GDRV_ON_STATE"],
      [30, 30, "SYS_READY_STATE"],
      [29, 29, "OVERTEMP_WARN"],
      [28, 28, "OV_VM_LIMIT_FAIL"],
      [27, 27, "VM_TEMP_CLIPPED"],
      [26, 26, "AIN_CLIPPED"],
      [25, 25, "I_CLIPPED"],
      [24, 24, "CURRENT_OVERLOAD"],
      [23, 23, "HALL_FAIL"],
      [22, 22, "ABN_FAIL"],
      [21, 21, "RAMP_REF_H"],
      [20, 20, "RAMP_REF_LR"],
      [19, 19, "RAMP_V_ZERO"],
      [18, 18, "RAMP_V_REACHED"],
      [17, 17, "RAMP_TARGET_REACHED"],
      [16, 16, "RAMP_STALL_FAIL"],
      [15, 15, "IO_CONTROLLER"],
      [14, 14, "DIFF_ENC_FAIL"],
      [13, 13, "OT_FAIL"],
      [12, 12, "SHRT_FAIL"],
      [11, 11, "VEL_FAIL"],
      [10, 10, "TEMP_LIMIT_FAIL"],
      [9, 9, "ADC_FAIL"],
      [8, 8, "EXT_RES_FAIL"],
      [7, 7, "CLK_PLL_FAIL"],
      [6, 6, "POWER_FAIL"],
      [5, 5, "UV_VM"],
      [4, 4, "CP_FAIL"],
      [3, 3, "VCC_IOF_FAIL"],
      [2, 2, "UART_FAIL"],
      [1, 1, "SPI_FAIL"],
      [0, 0, "PWRUP_FAIL"],
    ],
  },
  0x00a: { label: "事件锁存 EVENTS", desc: "写 1 清零；重新使能驱动前需确认已清", ro: true },
  0x00b: { label: "FAULTN / 中断屏蔽" },
  0x082: {
    label: "相电流 I1/I2 原始",
    desc: "[31:16]=I2, [15:0]=I1，有符号",
    ro: true,
  },
  0x083: {
    label: "供电电压 / 相电流 I3",
    desc: "[31:16]=VM, [15:0]=I3，有符号 16 位",
    ro: true,
  },
  0x084: {
    label: "结温 / 外部温度",
    desc: "[31:16]=TEMP_INT, [15:0]=TEMP_EXT，有符号 16 位",
    ro: true,
  },
  0x0c3: {
    label: "电流采样增益 CSA_GAIN",
    desc: "0=1x 1=2x 2=3x 3=4x；不改 A/count，只改量程",
    bits: [[1, 0, "CSA_GAIN"]],
  },
  0x100: {
    label: "运动模式 / 极对数",
    desc: "MOTOR_MOTION：模式、电机类型、极对数、斜坡使能",
    bits: [
      [6, 0, "N_POLE_PAIRS"],
      [8, 7, "MOTOR_TYPE"],
      [12, 9, "MOTION_MODE"],
      [13, 13, "RAMP_MODE"],
      [14, 14, "RAMP_EN"],
      [15, 15, "RAMP_USE_PHI_E"],
      [16, 16, "TORQUE_FF_ACC_EN"],
      [17, 17, "TORQUE_FF_COULOMB_EN"],
      [18, 18, "TORQUE_FF_VISC_EN"],
      [19, 19, "VELOCITY_FF_EN"],
    ],
  },
  0x101: {
    label: "栅极驱动 GDRV",
    desc: "bit16 = DRV_EN_BIT，bit31 = 电荷泵",
    bits: [
      [1, 0, "SLEW_RATE"],
      [5, 4, "LS_RES_ON"],
      [9, 9, "OCP_DETECTION_MODE"],
      [11, 10, "OCP_DEGLITCH"],
      [13, 12, "OCP_AUTORETRY"],
      [16, 16, "DRV_EN_BIT"],
      [20, 20, "OVERTEMP_LATCH"],
      [24, 24, "USE_INTERNAL_R_REF"],
      [28, 28, "LP_MODE_EN"],
      [31, 31, "CHARGE_PUMP_EN"],
    ],
  },
  0x102: {
    label: "PWM 调制",
    desc: "SV_MODE：0 无 / 1 三次谐波 / 2 底钳位 / 3 底钳位+偏移",
    bits: [
      [1, 0, "SV_MODE"],
      [2, 2, "CHOP"],
    ],
  },
  0x103: {
    label: "PWM 周期 / Kirchhoff 门限",
    desc: "fPWM = 120 MHz / MAX_COUNT；4800 → 25 kHz",
    bits: [
      [15, 0, "MAX_COUNT"],
      [31, 16, "AUTO_KIRCHHOFF_LIM"],
    ],
  },
  0x105: { label: "MCC 状态", ro: true },
  0x140: {
    label: "PID 全局配置",
    desc: "归一化格式、速度输出右移、位置降采样",
    bits: [
      [0, 0, "KEEP_POS_TARGET"],
      [1, 1, "OVERWRITE_TARGET"],
      [2, 2, "CURRENT_NORM_P"],
      [3, 3, "CURRENT_NORM_I"],
      [5, 4, "VELOCITY_NORM_P"],
      [7, 6, "VELOCITY_NORM_I"],
      [9, 8, "POSITION_NORM_P"],
      [11, 10, "POSITION_NORM_I"],
      [15, 12, "VELOCITY_SHIFT"],
      [22, 16, "POSITION_SAMPLING"],
    ],
  },
  0x141: { label: "弱磁电压门限 U_S_MAX" },
  0x142: {
    label: "磁链(电流 d) P/I",
    desc: "[31:16]=P, [15:0]=I",
    bits: [
      [31, 16, "FLUX_P"],
      [15, 0, "FLUX_I"],
    ],
  },
  0x143: {
    label: "力矩(电流 q) P/I",
    desc: "[31:16]=P, [15:0]=I",
    bits: [
      [31, 16, "TORQUE_P"],
      [15, 0, "TORQUE_I"],
    ],
  },
  0x144: { label: "弱磁 P/I" },
  0x145: {
    label: "速度环 P/I",
    desc: "[31:16]=P, [15:0]=I",
    bits: [
      [31, 16, "VELOCITY_P"],
      [15, 0, "VELOCITY_I"],
    ],
  },
  0x146: {
    label: "位置环 P/I",
    desc: "[31:16]=P, [15:0]=I",
    bits: [
      [31, 16, "POSITION_P"],
      [15, 0, "POSITION_I"],
    ],
  },
  0x147: { label: "位置容差" },
  0x148: { label: "位置容差延时（PWM 周期）" },
  0x149: {
    label: "电压矢量限幅 UQ/UD",
    desc: "HARMONIC 调制下 18900 = 100%",
  },
  0x14a: {
    label: "力矩 / 磁链限幅",
    desc: "[30:16]=力矩, [14:0]=磁链，单位 = 电流 LSB",
    bits: [
      [30, 16, "PID_TORQUE_LIMIT"],
      [14, 0, "PID_FLUX_LIMIT"],
    ],
  },
  0x14b: { label: "速度目标限幅" },
  0x14c: { label: "位置目标下限" },
  0x14d: { label: "位置目标上限" },
  0x14e: {
    label: "力矩 / 磁链目标",
    desc: "[31:16]=力矩, [15:0]=磁链（有符号）",
    bits: [
      [31, 16, "PID_TORQUE_TARGET"],
      [15, 0, "PID_FLUX_TARGET"],
    ],
  },
  0x14f: { label: "力矩 / 磁链前馈偏移" },
  0x150: { label: "速度目标" },
  0x151: { label: "速度前馈偏移" },
  0x152: { label: "位置目标" },
  0x153: {
    label: "力矩 / 磁链实际",
    desc: "[31:16]=力矩, [15:0]=磁链（有符号）",
    ro: true,
    bits: [
      [31, 16, "PID_TORQUE_ACTUAL"],
      [15, 0, "PID_FLUX_ACTUAL"],
    ],
  },
  0x154: { label: "速度实际", ro: true },
  0x155: { label: "位置实际", ro: true },
  0x156: { label: "位置实际偏移" },
  0x157: { label: "力矩误差", ro: true },
  0x158: { label: "磁链误差", ro: true },
  0x159: { label: "速度误差", ro: true },
  0x15b: { label: "位置误差", ro: true },
  0x15d: { label: "力矩积分器" },
  0x15e: { label: "磁链积分器" },
  0x15f: { label: "速度积分器" },
  0x160: { label: "位置积分器" },
  0x168: { label: "Iq / Id", desc: "[31:16]=Iq, [15:0]=Id", ro: true },
  0x169: { label: "Uq / Ud", desc: "[31:16]=Uq, [15:0]=Ud", ro: true },
  0x171: {
    label: "电压 / 电流矢量幅值",
    desc: "[31:16]=U_S_ACTUAL, [15:0]=I_S_ACTUAL",
    ro: true,
  },
  0x172: { label: "电机功率 P_MOTOR", ro: true },
  0x1c3: {
    label: "开环 phi_e / 偏置",
    desc: "[31:16]=PHI_E_OFFSET, [15:0]=PHI_E",
    bits: [
      [31, 16, "PHI_E_OFFSET"],
      [15, 0, "PHI_E"],
    ],
  },
  0x240: {
    label: "反馈通道 A 配置",
    desc: "SRC_SEL_A[27:24] + CPR_INV_A[23:0]",
    bits: [
      [23, 0, "CPR_INV_A"],
      [27, 24, "SRC_SEL_A"],
    ],
  },
  0x242: {
    label: "电角度偏移 PHI_E_OFFSET",
    desc: "对齐后写入，16 位无符号",
    bits: [[15, 0, "PHI_E_OFFSET"]],
  },
  0x244: {
    label: "频率测速配置",
    desc: "VELOCITY_SCALING[23:8] + VELOCITY_SAMPLING[7:1] + 同步源",
    bits: [
      [0, 0, "VELOCITY_SYNC_SRC"],
      [7, 1, "VELOCITY_SAMPLING"],
      [23, 8, "VELOCITY_SCALING"],
    ],
  },
  0x245: { label: "周期测速配置" },
  0x247: { label: "缩放后机械角", ro: true },
  0x24a: { label: "频率测速结果", ro: true },
  0x24b: { label: "周期测速结果", ro: true },
  0x24d: {
    label: "外部角度输入 PHI_EXT_A",
    desc: "SPI/SSI 编码器由 IO 控制器写入，24 位",
    bits: [[23, 0, "PHI_EXT_A"]],
  },
  0x24e: { label: "外部角度输入 PHI_EXT_B" },
  0x250: {
    label: "反馈输出配置",
    desc: "PHI_E_MUL_FACTOR 低字节 = 极对数",
    bits: [
      [7, 0, "PHI_E_MUL_FACTOR"],
      [17, 16, "PHI_E_SRC"],
      [20, 20, "POSITION_SRC"],
      [21, 21, "VELOCITY_SRC"],
      [23, 22, "VELOCITY_SELECTION"],
    ],
  },
  0x251: {
    label: "电角度 PHI_E",
    desc: "[15:0] = 反馈引擎算出的电角度",
    ro: true,
    bits: [[15, 0, "PHI_E_FOC"]],
  },
  0x340: {
    label: "UART 控制",
    desc: "波特率、autobaud、RTMI 使能与降采样",
    bits: [
      [12, 0, "MANTISSA_LIMIT"],
      [16, 16, "TIMEOUT_PRE_DIVIDER_EN"],
      [18, 18, "AUTOBAUD_EN"],
      [19, 19, "RX_FILTER_EN"],
      [20, 20, "NORMAL_CRC_EN"],
      [21, 21, "RTMI_CRC_EN"],
      [22, 22, "RTMI_EN"],
      [31, 24, "RTMI_SAMPLING"],
    ],
  },
  0x342: { label: "UART 状态", ro: true },
  0x343: { label: "UART 事件", ro: true },
  0x344: {
    label: "RTMI 通道 0",
    desc: "[16]=CH_EN, [9:0]=映射寄存器地址",
    bits: [
      [9, 0, "CH_0_ADDR"],
      [16, 16, "CH_0_EN"],
    ],
  },
  0x34b: {
    label: "RTMI 通道 7（写应答）",
    desc: "CH_7_EN=1 时才会返回普通写应答",
    bits: [
      [9, 0, "CH_7_ADDR"],
      [16, 16, "CH_7_EN"],
    ],
  },
  0x380: { label: "IO 控制器控制", bits: [[0, 0, "RESET"]] },
  0x381: {
    label: "IO 控制器命令 COMMAND",
    desc: "SPI_ENC: 0xF | mode | 请求类型 | CS 间隔 | 位长 | 时钟",
  },
  0x382: {
    label: "IO 控制器 RESPONSE_0",
    desc: "握手：等于 COMMAND 表示命令执行完成",
    ro: true,
  },
  0x383: { label: "IO 控制器 RESPONSE_1（发送数据）" },
  0x384: { label: "IO 控制器 RESPONSE_2（数据掩码）" },
  0x385: { label: "IO 控制器 RESPONSE_3（客户端应答）", ro: true },
};

/** Registers pinned at the top of the register explorer. */
export const FAVORITES = [
  0x000, 0x009, 0x00a, 0x08c, 0x0c3, 0x100, 0x101, 0x103, 0x140, 0x142, 0x143, 0x145, 0x146,
  0x149, 0x14a, 0x14b, 0x14e, 0x150, 0x153, 0x154, 0x155, 0x159, 0x168, 0x169, 0x1c3, 0x240,
  0x242, 0x244, 0x24d, 0x250, 0x251, 0x340, 0x344, 0x381, 0x382, 0x385,
];

export function regByAddr(addr: number): RegisterDef | undefined {
  return REGISTERS.find((r) => r.addr === addr);
}

export function regLabel(addr: number): string {
  const meta = REG_META[addr];
  if (meta) return meta.label;
  return regByAddr(addr)?.name ?? `0x${addr.toString(16).toUpperCase()}`;
}

export function regName(addr: number): string {
  return regByAddr(addr)?.name ?? "—";
}

export function groupOf(addr: number): RegisterGroup | "UNKNOWN" {
  return regByAddr(addr)?.group ?? "UNKNOWN";
}

/** All registers that make sense to stream through RTMI. */
export const STREAMABLE = new Set<number>([
  0x009, 0x082, 0x083, 0x084, 0x08c, 0x100, 0x105, 0x142, 0x143, 0x145, 0x146, 0x149, 0x14a,
  0x150, 0x152, 0x153, 0x154, 0x155, 0x157, 0x158, 0x159, 0x15b, 0x15d, 0x15e, 0x15f, 0x160,
  0x161, 0x162, 0x163, 0x164, 0x165, 0x166, 0x167, 0x168, 0x169, 0x16a, 0x170, 0x171, 0x172,
  0x173, 0x1c3, 0x1d0, 0x1d1, 0x240, 0x242, 0x244, 0x247, 0x24a, 0x24b, 0x24d, 0x250, 0x251,
  0x342,
]);

export const STATUS_BITS: [number, string, "info" | "warn" | "error"][] = [
  [31, "GDRV 已使能", "info"],
  [30, "系统就绪", "info"],
  [29, "过温预警", "warn"],
  [28, "母线过压", "error"],
  [27, "母线电压削顶", "warn"],
  [26, "模拟输入削顶", "warn"],
  [25, "电流削顶", "warn"],
  [24, "电流过载", "error"],
  [23, "霍尔故障", "error"],
  [22, "ABN 故障", "error"],
  [21, "右参考开关", "info"],
  [20, "左参考开关", "info"],
  [19, "ramp 零速", "info"],
  [18, "ramp 到达速度", "info"],
  [17, "ramp 到达目标", "info"],
  [16, "ramp 堵转", "error"],
  [15, "IO 控制器状态", "info"],
  [14, "差分编码器故障", "error"],
  [13, "过温保护", "error"],
  [12, "短路保护", "error"],
  [11, "速度异常", "error"],
  [10, "温度限值", "warn"],
  [9, "ADC 故障", "error"],
  [8, "外部电阻故障", "error"],
  [7, "时钟/PLL 故障", "error"],
  [6, "电源故障", "error"],
  [5, "母线欠压", "error"],
  [4, "电荷泵故障", "error"],
  [3, "VCC_IOF 故障", "error"],
  [2, "UART 故障", "error"],
  [1, "SPI 故障", "error"],
  [0, "上电复位", "info"],
];
