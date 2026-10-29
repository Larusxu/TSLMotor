/**
 * @file yinshi_protocol.c
 * @brief 因时 LA 系列执行器通信协议实现（V2.0.4）
 *
 * 帧格式（V2.0.4）：
 *   指令帧：[0x55 0xAA] [长度] [ID] [CMD] [RegAddr_L] [RegAddr_H] [Data...] [校验和]
 *   长度 = N+3（N为数据字节数），即 CMD(1) + RegAddr(2) + Data(N)
 *   校验和 = 除帧头外所有字节累加和的低8位
 *
 * 应答帧：[0xAA 0x55] [长度] [ID] [CMD] [数据段...] [校验和]
 *
 * 纯C实现，不依赖RT-Thread。
 */

#include "yinshi_protocol.h"
#include <string.h>

/* ---- 内部辅助函数 ---- */

static uint8_t calc_checksum(const uint8_t *data, int len)
{
    uint8_t sum = 0;
    for (int i = 0; i < len; i++)
        sum += data[i];
    return sum;
}

/* ===================== 帧构建 ===================== */

/**
 * @brief 读电缸状态信息帧（CMD_RD_STATUS 0x30）
 *
 * 指令帧：55 AA 01 ID 30 CS
 * 数据长度 = 0x01（只有CMD，无寄存器地址无数据）
 * 校验和 = ID + 0x30
 */
int yinshi_build_rd_status(uint8_t *buf, uint8_t id)
{
    if (!buf) return YINSHI_ERR_PARAM;

    buf[0] = YINSHI_HEADER_0;   /* 0x55 */
    buf[1] = YINSHI_HEADER_1;   /* 0xAA */
    buf[2] = 0x01;              /* 数据长度 = 1（只有CMD） */
    buf[3] = id;
    buf[4] = YINSHI_CMD_RD_STATUS;  /* 0x30 */
    buf[5] = calc_checksum(&buf[2], 3);  /* 对 长度+ID+CMD 求和 */

    return 6;
}

/**
 * @brief 读寄存器帧（CMD_RD_REG 0x31）
 *
 * 指令帧：55 AA 04 ID 31 RegL RegH Count CS
 * 数据长度 = 0x04（CMD + RegAddr(2) + Count）
 */
int yinshi_build_rd_reg(uint8_t *buf, uint8_t id,
                        uint16_t reg_offset, uint8_t reg_count)
{
    if (!buf) return YINSHI_ERR_PARAM;

    buf[0] = YINSHI_HEADER_0;
    buf[1] = YINSHI_HEADER_1;
    buf[2] = 0x04;                          /* 数据长度 */
    buf[3] = id;
    buf[4] = YINSHI_CMD_RD_REG;             /* 0x31 */
    buf[5] = (uint8_t)(reg_offset & 0xFF);  /* 寄存器地址低字节 */
    buf[6] = (uint8_t)(reg_offset >> 8);    /* 寄存器地址高字节 */
    buf[7] = reg_count;                     /* 寄存器个数 */
    buf[8] = calc_checksum(&buf[2], 6);

    return 9;
}

/**
 * @brief 写单个寄存器帧（CMD_WR_REG 0x32，n=1）
 *
 * 指令帧：55 AA 05 ID 32 RegL RegH ValL ValH CS
 * 数据长度 = 0x05（CMD + RegAddr(2) + Data(2)）
 */
int yinshi_build_wr_reg_u16(uint8_t *buf, uint8_t id,
                            uint16_t reg_offset, uint16_t value)
{
    if (!buf) return YINSHI_ERR_PARAM;

    buf[0] = YINSHI_HEADER_0;
    buf[1] = YINSHI_HEADER_1;
    buf[2] = 0x05;                          /* 数据长度 = 3 + 2*1 */
    buf[3] = id;
    buf[4] = YINSHI_CMD_WR_REG;             /* 0x32 */
    buf[5] = (uint8_t)(reg_offset & 0xFF);  /* 寄存器地址低字节 */
    buf[6] = (uint8_t)(reg_offset >> 8);    /* 寄存器地址高字节 */
    buf[7] = (uint8_t)(value & 0xFF);       /* 数据低字节 */
    buf[8] = (uint8_t)(value >> 8);         /* 数据高字节 */
    buf[9] = calc_checksum(&buf[2], 7);

    return 10;
}

/**
 * @brief 写多个连续寄存器帧（CMD_WR_REG 0x32，n个寄存器）
 *
 * 指令帧：55 AA L ID 32 RegL RegH Val0L Val0H ... ValNL ValNH CS
 * 数据长度 L = 3 + 2*n
 */
int yinshi_build_wr_reg_multi(uint8_t *buf, uint8_t id,
                              uint16_t reg_offset,
                              const uint16_t *values, uint8_t count)
{
    if (!buf || (!values && count > 0) || count == 0)
        return YINSHI_ERR_PARAM;

    int payload_len = 3 + 2 * count;  /* CMD(1) + RegAddr(2) + Data(2*n) */
    int frame_len = YINSHI_HEADER_SIZE + payload_len + YINSHI_CHECKSUM_SIZE;

    if (frame_len > YINSHI_MAX_FRAME_LEN)
        return YINSHI_ERR_BUF_OVERFLOW;

    buf[0] = YINSHI_HEADER_0;
    buf[1] = YINSHI_HEADER_1;
    buf[2] = (uint8_t)payload_len;
    buf[3] = id;
    buf[4] = YINSHI_CMD_WR_REG;
    buf[5] = (uint8_t)(reg_offset & 0xFF);
    buf[6] = (uint8_t)(reg_offset >> 8);

    /* 填充数据：每个寄存器2字节，小端序 */
    for (int i = 0; i < count; i++) {
        buf[7 + i * 2]     = (uint8_t)(values[i] & 0xFF);
        buf[7 + i * 2 + 1] = (uint8_t)(values[i] >> 8);
    }

    buf[frame_len - 1] = calc_checksum(&buf[2], payload_len + 2);

    return frame_len;
}

/* ===================== 响应解析 ===================== */

/**
 * @brief 从字节流中解析一个响应帧
 *
 * 响应帧格式：[0xAA 0x55] [长度] [ID] [CMD] [数据...] [校验和]
 * 长度字段 = 数据段字节数 + 3（CMD(1) + 数据长度本身不含？）
 * 实际上：长度 = 数据段总字节数（从CMD到数据结束），即 L = 3 + 数据域字节数
 */
int yinshi_parse_response(const uint8_t *buf, int len, yinshi_response_t *resp)
{
    if (!buf || len < 0 || !resp)
        return YINSHI_ERR_PARAM;

    /* 至少需要 帧头(2) + 长度(1) + ID(1) = 4字节 */
    if (len < 4)
        return 0;

    /* 扫描寻找响应帧头 0xAA 0x55 */
    int pos = 0;
    while (pos <= len - 2) {
        if (buf[pos] == YINSHI_RESP_HEADER_0 && buf[pos + 1] == YINSHI_RESP_HEADER_1)
            break;
        pos++;
    }

    if (pos > len - 2)
        return 0;

    if (len - pos < 4)
        return 0;

    /* payload_len = 长度字段的值 */
    uint8_t payload_len = buf[pos + 2];
    int frame_len = YINSHI_HEADER_SIZE + payload_len + YINSHI_CHECKSUM_SIZE;

    /* 帧不完整 */
    if (len - pos < frame_len)
        return 0;

    /* 校验和验证：对 长度+ID+数据段 求和 */
    uint8_t expected = calc_checksum(&buf[pos + 2], payload_len + 2);
    uint8_t actual = buf[pos + frame_len - 1];
    if (expected != actual)
        return YINSHI_ERR_BAD_CHECKSUM;

    /* 解析各字段 */
    resp->id = buf[pos + 3];
    resp->cmd = buf[pos + 4];

    /* 数据域 = payload_len - 1（减去CMD字节） */
    int data_bytes = payload_len - 1;
    if (data_bytes < 0) data_bytes = 0;
    if (data_bytes > (int)sizeof(resp->data))
        data_bytes = (int)sizeof(resp->data);

    resp->data_len = (uint8_t)data_bytes;
    if (data_bytes > 0)
        memcpy(resp->data, &buf[pos + 5], data_bytes);

    return pos + frame_len;
}

/**
 * @brief 从状态查询/写寄存器应答中提取状态信息
 *
 * CMD_RD_STATUS(0x30) 和 CMD_WR_REG(0x32) 的应答数据域格式相同：
 *   保留(1B) + 保留(1B) + 状态信息(12B)
 *   目标位置 int16 LE (2B)
 *   实际位置 int16 LE (2B)
 *   实际电流 uint16 LE (2B)
 *   力传感器 int16 LE (2B)
 *   力传感器原始值 uint16 LE (2B)
 *   温度 int8 (1B)
 *   故障码 uint8 (1B)
 */
int yinshi_extract_status(const yinshi_response_t *resp, yinshi_status_t *status)
{
    if (!resp || !status)
        return YINSHI_ERR_PARAM;

    /* 数据域至少14字节（2保留 + 12状态） */
    if (resp->data_len < 14)
        return YINSHI_ERR_BAD_FRAME;

    /* 跳过前2字节保留，从第3字节开始是状态信息 */
    const uint8_t *d = &resp->data[2];

    status->target_pos  = (int16_t)(d[0] | ((uint16_t)d[1] << 8));
    status->current_pos = (int16_t)(d[2] | ((uint16_t)d[3] << 8));
    status->current_ma  = (uint16_t)(d[4] | ((uint16_t)d[5] << 8));
    status->force_grams = (int16_t)(d[6] | ((uint16_t)d[7] << 8));
    status->force_raw   = (uint16_t)(d[8] | ((uint16_t)d[9] << 8));
    status->temperature = (int8_t)d[10];
    status->error_flags = d[11];

    return YINSHI_OK;
}

/**
 * @brief 从读寄存器响应中提取 uint16 值
 *
 * CMD_RD_REG(0x31) 应答数据域：
 *   RegAddr_L + RegAddr_H + Data0_L + Data0_H + ...
 */
int yinshi_extract_u16(const yinshi_response_t *resp, uint16_t *value)
{
    if (!resp || !value)
        return YINSHI_ERR_PARAM;

    if (resp->cmd != YINSHI_CMD_RD_REG)
        return YINSHI_ERR_BAD_FRAME;

    /* 数据域至少 2(RegAddr) + 2(Data) = 4字节 */
    if (resp->data_len < 4)
        return YINSHI_ERR_BAD_FRAME;

    /* 跳过2字节寄存器地址，取数据 */
    *value = (uint16_t)(resp->data[2] | ((uint16_t)resp->data[3] << 8));
    return YINSHI_OK;
}

/**
 * @brief 从读寄存器响应中提取 int16 值
 */
int yinshi_extract_i16(const yinshi_response_t *resp, int16_t *value)
{
    if (!resp || !value)
        return YINSHI_ERR_PARAM;

    if (resp->cmd != YINSHI_CMD_RD_REG)
        return YINSHI_ERR_BAD_FRAME;

    if (resp->data_len < 4)
        return YINSHI_ERR_BAD_FRAME;

    *value = (int16_t)(resp->data[2] | ((uint16_t)resp->data[3] << 8));
    return YINSHI_OK;
}
