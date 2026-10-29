/**
 * @file tmc6460_protocol.h
 * @brief TMC6460 UART 通信协议定义
 *
 * 帧格式（CRC 开启）：
 *   读请求：[byte0] [addr_lo] [crc]                          → 3 字节
 *   读响应：[byte0] [addr_lo] [D3] [D2] [D1] [D0] [crc]      → 7 字节
 *   写请求：[byte0] [addr_lo] [D3] [D2] [D1] [D0] [crc]      → 7 字节
 *   写响应：[byte0] [D3] [D2] [D1] [D0] [crc]                → 6 字节
 *
 * byte0 编码：
 *   bit[2:0] = 010b (sync)
 *   bit[3]   = WnR (0=读, 1=写)
 *   bit[5:4] = address[9:8]
 *   bit[7:6] = 10b (sync)
 *
 * CRC-8：多项式 x^8+x^4+x^3+x^2+1，等价于 CRC-8/MAXIM（poly=0x8C，字节 bit-reverse）
 *
 * 来源：G:\project\hand\Tesla_hand\tmc6460.pdf Page 31-40
 */

#ifndef __TMC6460_PROTOCOL_H
#define __TMC6460_PROTOCOL_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/* ---------- 帧长度（无 CRC，与 TMC6460 默认配置一致）----------
 * 来源: tmc6460_upper_pc/tmc6460_protocol.py
 * 写响应: ser.read(4) = 4 字节
 * 读响应: ser.read(6) = 6 字节
 */
#define TMC6460_RD_REQ_LEN      2       /* byte0 + addr_lo */
#define TMC6460_RD_RESP_LEN     6       /* byte0 + addr_lo + D3..D0 */
#define TMC6460_WR_REQ_LEN      6       /* byte0 + addr_lo + D3..D0 */
#define TMC6460_WR_RESP_LEN     5       /* byte0 + D3..D0 (40 bits) */
#define TMC6460_MAX_FRAME_LEN   8

/* ---------- byte0 编码 ---------- */
#define TMC6460_WNR_READ        0
#define TMC6460_WNR_WRITE       1

/* ---------- 寄存器地址 ---------- */
/* CHIP */
#define TMC6460_REG_CHIP_IO_MATRIX      0x006
#define TMC6460_REG_CHIP_STATUS_FLAGS   0x009
#define TMC6460_REG_CHIP_EVENTS         0x00A

/* UART */
#define TMC6460_REG_UART_CONTROL        0x340
#define TMC6460_REG_UART_TIMEOUT        0x341
#define TMC6460_REG_UART_TIMEOUT        0x341
#define TMC6460_REG_UART_STATUS         0x342
#define TMC6460_REG_UART_EVENTS         0x343
#define TMC6460_REG_UART_RTMI_CH7       0x34B

/* MCC_CONFIG */
#define TMC6460_REG_MOTOR_MOTION        0x100
#define TMC6460_REG_GDRV                0x101
#define TMC6460_REG_PWM                 0x102
#define TMC6460_REG_MCC_STATUS          0x105

/* FOC */
#define TMC6460_REG_PID_CONFIG                  0x140
#define TMC6460_REG_PID_U_S_MAX                 0x141
#define TMC6460_REG_PID_FLUX_COEFF              0x142
#define TMC6460_REG_PID_TORQUE_COEFF            0x143
#define TMC6460_REG_PID_VELOCITY_COEFF          0x145
#define TMC6460_REG_PID_POSITION_COEFF          0x146
#define TMC6460_REG_PID_POSITION_TOLERANCE      0x147
#define TMC6460_REG_PID_UQ_UD_LIMITS            0x149
#define TMC6460_REG_PID_TORQUE_FLUX_LIMITS      0x14A
#define TMC6460_REG_PID_VELOCITY_LIMIT          0x14B
#define TMC6460_REG_PID_POSITION_LIMIT_LOW      0x14C
#define TMC6460_REG_PID_POSITION_LIMIT_HIGH     0x14D
#define TMC6460_REG_PID_TORQUE_FLUX_TARGET      0x14E
#define TMC6460_REG_PID_TORQUE_FLUX_OFFSET      0x14F
#define TMC6460_REG_PID_VELOCITY_TARGET         0x150
#define TMC6460_REG_PID_POSITION_TARGET         0x152
#define TMC6460_REG_PID_TORQUE_FLUX_ACTUAL      0x153
#define TMC6460_REG_PID_VELOCITY_ACTUAL         0x154
#define TMC6460_REG_PID_POSITION_ACTUAL         0x155

/* RAMPER */
#define TMC6460_REG_RAMPER_V_ACTUAL     0x1D0
#define TMC6460_REG_RAMPER_POSITION     0x1D1
#define TMC6460_REG_RAMPER_STATUS       0x1D4

/* ENCODER / CALIBRATION */
#define TMC6460_REG_PHI_E_OFFSET        0x242       /* 电角度偏置 */
#define TMC6460_REG_CSA                 0x0C3       /* CSA 增益 */
#define TMC6460_REG_PWM_PERIOD          0x103       /* PWM 周期 */

/* FEEDBACK CHANNEL A */
#define TMC6460_REG_FEEDBACK_A_CFG      0x240       /* 反馈通道 A 配置 */
#define TMC6460_REG_FEEDBACK_A_SPI_CFG  0x244       /* SPI 编码器配置 */
#define TMC6460_REG_FEEDBACK_A_FILTER   0x245       /* 滤波器配置 */
#define TMC6460_REG_FEEDBACK_A_SCALE    0x250       /* 缩放配置 */

/* IO CONTROLLER */
#define TMC6460_REG_IO_CMD              0x381       /* IO 控制器命令 */
#define TMC6460_REG_IO_RESP0            0x382       /* IO 响应 0 */
#define TMC6460_REG_IO_RESP1            0x383       /* IO 响应 1 */
#define TMC6460_REG_IO_RESP2            0x384       /* IO 响应 2 */

/* ---------- MOTION_MODE（来源: tmc6460.pdf Page 148）---------- */
#define TMC6460_MODE_PWM_OFF            0   /* PWM 输出禁用 */
#define TMC6460_MODE_PWM_ON             1   /* PWM 输出使能 */
#define TMC6460_MODE_TORQUE             2   /* 力矩模式（只用力矩 PID） */
#define TMC6460_MODE_VELOCITY           3   /* 速度模式（速度→力矩级联） */
#define TMC6460_MODE_POSITION           4   /* 位置模式（完整级联控制器） */
#define TMC6460_MODE_PRBS_UD            5   /* PRBS UD */
#define TMC6460_MODE_PRBS_FLUX          6   /* PRBS 磁通 */
#define TMC6460_MODE_PRBS_TORQUE        7   /* PRBS 力矩 */
#define TMC6460_MODE_PRBS_VELOCITY      8   /* PRBS 速度 */
#define TMC6460_MODE_PRBS_POSITION      9   /* PRBS 位置 */
#define TMC6460_MODE_PWM_EXT            10  /* 外部 PWM */
#define TMC6460_MODE_VOLTAGE_EXT        11  /* 外部电压（开环） */

/* ---------- 返回值 ---------- */
#define TMC6460_OK              0
#define TMC6460_ERR_BAD_FRAME   (-1)
#define TMC6460_ERR_BAD_CRC     (-2)
#define TMC6460_ERR_TIMEOUT     (-3)
#define TMC6460_ERR_COMM_FAIL   (-4)
#define TMC6460_ERR_PARAM       (-5)

/* ---------- 用户单位换算 ---------- */
/* 来源: tmc6460.pdf p71, MT6701 SSI 14-bit, CPR_INV=1024, f_SYS=60MHz */
#define TMC6460_K_VEL           305.4f      /* 1 RPM = 305.4 内部单位 */
#define TMC6460_MA_PER_COUNT    0.20131f    /* 1 count = 0.20131 mA */
#define TMC6460_POS_PER_REV     65536       /* 1圈 = 65536 内部单位 */
#define TMC6460_POS_PER_DEG     182.044f    /* 1° = 65536/360 内部单位 */
#define TMC6460_POS_PER_01DEG   1.82044f    /* 0.01° = 65536/36000 内部单位 */

/* ---------- 函数声明 ---------- */

uint8_t tmc6460_crc8(const uint8_t *data, uint8_t len);
int tmc6460_build_rd_req(uint8_t *buf, uint16_t reg_addr);
int tmc6460_build_wr_req(uint8_t *buf, uint16_t reg_addr, uint32_t value);
int tmc6460_parse_rd_resp(const uint8_t *buf, int len, uint16_t reg_addr, uint32_t *value);
int tmc6460_parse_wr_resp(const uint8_t *buf, int len, uint32_t *value);

/* ---------- inline 辅助函数 ---------- */

static inline int16_t tmc6460_get_torque_limit(uint32_t reg_val)
{
    return (int16_t)((reg_val >> 16) & 0x7FFF);
}

static inline int16_t tmc6460_get_flux_limit(uint32_t reg_val)
{
    return (int16_t)(reg_val & 0x7FFF);
}

static inline uint32_t tmc6460_make_torque_flux_limits(uint16_t torque_limit, uint16_t flux_limit)
{
    return ((uint32_t)(torque_limit & 0x7FFF) << 16) | (flux_limit & 0x7FFF);
}

static inline int16_t tmc6460_get_torque_actual(uint32_t reg_val)
{
    return (int16_t)(reg_val >> 16);
}

static inline int16_t tmc6460_get_flux_actual(uint32_t reg_val)
{
    return (int16_t)(reg_val & 0xFFFF);
}

static inline uint32_t tmc6460_make_torque_flux_target(int16_t torque_target, int16_t flux_target)
{
    return ((uint32_t)(uint16_t)torque_target << 16) | (uint16_t)flux_target;
}

/* MOTOR_TYPE (bit[8:7]) */
#define TMC6460_MOTOR_TYPE_NONE         0
#define TMC6460_MOTOR_TYPE_DC           1
#define TMC6460_MOTOR_TYPE_BLDC         3

static inline uint32_t tmc6460_make_motor_motion(uint8_t motion_mode, uint8_t n_pole_pairs)
{
    return ((uint32_t)(motion_mode & 0x0F) << 9)
         | ((uint32_t)TMC6460_MOTOR_TYPE_BLDC << 7)
         | (n_pole_pairs & 0x7F);
}

#ifdef __cplusplus
}
#endif
#endif /* __TMC6460_PROTOCOL_H */
