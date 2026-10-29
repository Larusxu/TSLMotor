/**
 * @file yinshi_protocol.h
 * @brief 因时 LA 系列执行器通信协议定义（V2.0.4）
 *
 * 帧格式：
 *   指令帧：[0x55 0xAA] [长度] [ID] [CMD] [RegAddr_L] [RegAddr_H] [Data...] [校验和]
 *   应答帧：[0xAA 0x55] [长度] [ID] [CMD] [数据段...] [校验和]
 *
 * 纯C实现，不依赖RT-Thread。
 */

#ifndef __YINSHI_PROTOCOL_H
#define __YINSHI_PROTOCOL_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/* ---------- 帧头标识 ---------- */
#define YINSHI_HEADER_0         0x55    /* 指令帧头第1字节 */
#define YINSHI_HEADER_1         0xAA    /* 指令帧头第2字节 */
#define YINSHI_RESP_HEADER_0    0xAA    /* 应答帧头第1字节 */
#define YINSHI_RESP_HEADER_1    0x55    /* 应答帧头第2字节 */

/* ---------- 指令类型（V2.0.4 只有3种指令） ---------- */
#define YINSHI_CMD_RD_STATUS    0x30    /* 读电缸状态信息 */
#define YINSHI_CMD_RD_REG       0x31    /* 读寄存器 */
#define YINSHI_CMD_WR_REG       0x32    /* 写寄存器（写寄存器应答也返回状态信息） */

/* ---------- 寄存器地址（V2.0.4，2字节地址） ---------- */
#define YINSHI_REG_ID               0x16    /* R/W, ID地址 1~254 */
#define YINSHI_REG_BAUD             0x17    /* R/W, 波特率: 0=19200 1=57600 2=115200 3=921600 */
#define YINSHI_REG_CLEAR_FAULT      0x18    /* R/W, 写1清除故障 */
#define YINSHI_REG_ESTOP            0x19    /* R/W, 写1急停 */
#define YINSHI_REG_PAUSE            0x1A    /* R/W, 写1暂停运动 */
#define YINSHI_REG_RESTORE          0x1B    /* R/W, 写1还原参数 */
#define YINSHI_REG_SAVE             0x1C    /* R/W, 写1保存参数到Flash（会返回两帧应答） */
#define YINSHI_REG_AUTH_CODE        0x1D    /* R/W, 权限验证码 */
#define YINSHI_REG_OT_PROT          0x1E    /* R/W, 过温保护值，单位℃ */
#define YINSHI_REG_RESUME_TEMP      0x1F    /* R/W, 回温启动值，单位℃ */
#define YINSHI_REG_OC_PROT          0x20    /* R/W, 过流保护值，单位mA */
#define YINSHI_REG_MOTOR_FWD_MAX    0x21    /* R/W, 电机正向输出最大值 [0,1000] */
#define YINSHI_REG_MOTOR_REV_MAX    0x22    /* R/W, 电机反向输出最大值 [0,1000] */
#define YINSHI_REG_TRAVEL_MAX       0x23    /* R/W, 行程上限值 [行程下限,2000] */
#define YINSHI_REG_TRAVEL_MIN       0x24    /* R/W, 行程下限值 [0,行程上限] */
#define YINSHI_REG_CTRL_MODE        0x25    /* R/W, 控制模式 */
#define YINSHI_REG_VOLTAGE_OUT      0x26    /* R/W, 电机输出电压（电压模式）[-1000,1000] */
#define YINSHI_REG_FORCE_TARGET     0x27    /* R/W, 力控目标值（力控模式），单位g */
#define YINSHI_REG_TARGET_SPEED     0x28    /* R/W, 目标速度（速度模式），步/s */
#define YINSHI_REG_TARGET_POS       0x29    /* R/W, 目标位置 [0,2000] */
#define YINSHI_REG_CURRENT_POS      0x2A    /* R,  实际位置 [0,2000] */
#define YINSHI_REG_CURRENT          0x2B    /* R,  电流值，单位mA */
#define YINSHI_REG_FORCE            0x2C    /* R,  实际受力值，单位g */
#define YINSHI_REG_FORCE_RAW        0x2D    /* R,  力传感器原始值 [0,4095] */
#define YINSHI_REG_TEMPERATURE      0x2E    /* R,  实际温度，单位℃ */
#define YINSHI_REG_ERROR_CODE       0x2F    /* R,  故障码 */

/* ---------- 控制模式（寄存器 0x25） ---------- */
#define YINSHI_MODE_POSITION    0   /* 定位模式：最短时间到达目标位置 */
#define YINSHI_MODE_SERVO       1   /* 伺服模式：位置插补跟随，建议≥50Hz */
#define YINSHI_MODE_SPEED       2   /* 速度模式：匀速运动到目标位置 */
#define YINSHI_MODE_FORCE       3   /* 力控模式：保持受力接近目标值 */
#define YINSHI_MODE_VOLTAGE     4   /* 电压模式：直接控制电机电压 */
#define YINSHI_MODE_SPEED_FORCE 5   /* 速度力控模式：匀速运动，超力停止 */

/* ---------- 故障码位定义（寄存器 0x2F） ---------- */
#define YINSHI_ERR_STALL        (1 << 0)  /* bit0: 堵转 */
#define YINSHI_ERR_OVER_TEMP    (1 << 1)  /* bit1: 过温 */
#define YINSHI_ERR_OVER_CURRENT (1 << 2)  /* bit2: 过流 */
#define YINSHI_ERR_MOTOR_ABNORM (1 << 3)  /* bit3: 电机异常 */
#define YINSHI_ERR_FLASH        (1 << 4)  /* bit4: Flash参数错误或未保存 */

/* ---------- 位置限制 ---------- */
#define YINSHI_POS_MIN          0       /* 最小位置值 */
#define YINSHI_POS_MAX          2000    /* 最大位置值 */
#define YINSHI_MAX_FRAME_LEN    64      /* 帧最大长度（字节） */
#define YINSHI_HEADER_SIZE      4       /* 帧头大小 = 帧头(2) + 长度(1) + ID(1) */
#define YINSHI_CHECKSUM_SIZE    1       /* 校验和占用字节数 */

/* ---------- 函数返回值 ---------- */
#define YINSHI_OK               0
#define YINSHI_ERR_BAD_FRAME    (-1)    /* 帧格式错误 */
#define YINSHI_ERR_BAD_CHECKSUM (-2)    /* 校验和不匹配 */
#define YINSHI_ERR_BUF_OVERFLOW (-3)    /* 缓冲区溢出 */
#define YINSHI_ERR_TIMEOUT      (-4)    /* 通信超时 */
#define YINSHI_ERR_COMM_FAIL    (-5)    /* 通信失败 */
#define YINSHI_ERR_PARAM        (-6)    /* 参数错误 */

/**
 * @brief 解析后的电缸状态信息（CMD_RD_STATUS 0x30 应答，12字节数据域）
 *
 * 应答数据格式：
 *   目标位置 int16 LE (2B)
 *   实际位置 int16 LE (2B)
 *   实际电流 uint16 LE (2B)
 *   力传感器 int16 LE (2B)
 *   力传感器原始值 uint16 LE (2B)
 *   温度 int8 (1B)
 *   故障码 uint8 (1B)
 */
typedef struct {
    int16_t  target_pos;    /* 目标位置（有符号） */
    int16_t  current_pos;   /* 实际位置（有符号） */
    uint16_t current_ma;    /* 电流（mA） */
    int16_t  force_grams;   /* 力传感器值（克） */
    uint16_t force_raw;     /* 力传感器原始值 */
    int8_t   temperature;   /* 温度（摄氏度） */
    uint8_t  error_flags;   /* 故障码位域 */
} yinshi_status_t;

/**
 * @brief 解析后的通用响应帧
 */
typedef struct {
    uint8_t  id;            /* 执行器ID */
    uint8_t  cmd;           /* 命令码 */
    uint8_t  data_len;      /* 数据域字节数（cmd之后、校验和之前） */
    uint8_t  data[32];      /* 数据载荷 */
} yinshi_response_t;

/* ===================== 帧构建函数 ===================== */

/**
 * @brief 构建读电缸状态信息帧（CMD_RD_STATUS 0x30）
 */
int yinshi_build_rd_status(uint8_t *buf, uint8_t id);

/**
 * @brief 构建读寄存器帧（CMD_RD_REG 0x31）
 * @param reg_offset  寄存器起始地址（2字节，小端序）
 * @param reg_count   要读取的寄存器个数
 */
int yinshi_build_rd_reg(uint8_t *buf, uint8_t id,
                        uint16_t reg_offset, uint8_t reg_count);

/**
 * @brief 构建写单个寄存器帧（CMD_WR_REG 0x32，n=1）
 */
int yinshi_build_wr_reg_u16(uint8_t *buf, uint8_t id,
                            uint16_t reg_offset, uint16_t value);
/**
 * @brief 构建写多个连续寄存器帧（CMD_WR_REG 0x32，n个寄存器）
 * @param values  数据数组，每2字节一个寄存器（小端序），共 n*2 字节
 * @param count   寄存器个数
 */
int yinshi_build_wr_reg_multi(uint8_t *buf, uint8_t id,
                              uint16_t reg_offset,
                              const uint16_t *values, uint8_t count);

/* ===================== 响应解析函数 ===================== */

/**
 * @brief 从字节流中解析一个响应帧
 * @return 已消费的字节数（>0），0=帧不完整，负值=错误
 */
int yinshi_parse_response(const uint8_t *buf, int len, yinshi_response_t *resp);

/**
 * @brief 从 CMD_RD_STATUS 0x30 或 CMD_WR_REG 0x32 应答中提取状态信息
 */
int yinshi_extract_status(const yinshi_response_t *resp, yinshi_status_t *status);

/**
 * @brief 从 CMD_RD_REG 0x31 应答中提取 uint16 值（小端序，第1个寄存器）
 */
int yinshi_extract_u16(const yinshi_response_t *resp, uint16_t *value);

/**
 * @brief 从 CMD_RD_REG 0x31 应答中提取 int16 值（小端序，第1个寄存器）
 */
int yinshi_extract_i16(const yinshi_response_t *resp, int16_t *value);

#ifdef __cplusplus
}
#endif
#endif /* __YINSHI_PROTOCOL_H */
