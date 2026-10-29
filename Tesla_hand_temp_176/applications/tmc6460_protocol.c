/**
 * @file tmc6460_protocol.c
 * @brief TMC6460 UART 协议实现（无 CRC 模式）
 *
 * TMC6460 默认 CRC 关闭（NORMAL_CRC_EN=0）
 * 帧格式：读请求 2 字节，读响应 6 字节，写请求 6 字节，写响应 5 字节
 * 数据字段：大端序（高字节在前）
 *
 * 来源：G:\project\hand\Tesla_hand\tmc6460.pdf Page 31-36
 */
#include "tmc6460_protocol.h"
#include <string.h>

/* ---------- 帧构建 ---------- */

/**
 * @brief 构造 byte0
 * bit[2:0] = 010b (sync)
 * bit[3]   = WnR (0=读, 1=写)
 * bit[5:4] = address[9:8]
 * bit[7:6] = 10b (sync)
 */
static uint8_t make_byte0(uint16_t reg_addr, uint8_t wnr)
{
    uint8_t b0 = 0x42; /* sync: bit[2:0]=010, bit[7:6]=10 */
    if (wnr) {
        b0 |= (1 << 3);
    }
    b0 |= ((reg_addr >> 8) & 0x03) << 4;
    return b0;
}

/**
 * @brief 构建读请求（2 字节，无 CRC）
 */
int tmc6460_build_rd_req(uint8_t *buf, uint16_t reg_addr)
{
    buf[0] = make_byte0(reg_addr, TMC6460_WNR_READ);
    buf[1] = (uint8_t)(reg_addr & 0xFF);
    return TMC6460_RD_REQ_LEN;
}

/**
 * @brief 构建写请求（6 字节，无 CRC）
 * 数据字段大端序：buf[2]=D[31:24], buf[3]=D[23:16], buf[4]=D[15:8], buf[5]=D[7:0]
 */
int tmc6460_build_wr_req(uint8_t *buf, uint16_t reg_addr, uint32_t value)
{
    buf[0] = make_byte0(reg_addr, TMC6460_WNR_WRITE);
    buf[1] = (uint8_t)(reg_addr & 0xFF);
    buf[2] = (uint8_t)((value >> 24) & 0xFF);  /* D[31:24] */
    buf[3] = (uint8_t)((value >> 16) & 0xFF);  /* D[23:16] */
    buf[4] = (uint8_t)((value >> 8) & 0xFF);   /* D[15:8]  */
    buf[5] = (uint8_t)(value & 0xFF);           /* D[7:0]   */
    return TMC6460_WR_REQ_LEN;
}

/* ---------- 响应解析 ---------- */

/**
 * @brief 解析读响应（6 字节，无 CRC）
 * 数据字段大端序：buf[2]=D[31:24], buf[3]=D[23:16], buf[4]=D[15:8], buf[5]=D[7:0]
 */
int tmc6460_parse_rd_resp(const uint8_t *buf, int len, uint16_t reg_addr, uint32_t *value)
{
    uint8_t expected_byte0;

    if (len < TMC6460_RD_RESP_LEN) {
        return TMC6460_ERR_BAD_FRAME;
    }

    expected_byte0 = make_byte0(reg_addr, TMC6460_WNR_READ);
    if (buf[0] != expected_byte0) {
        return TMC6460_ERR_BAD_FRAME;
    }

    if (buf[1] != (uint8_t)(reg_addr & 0xFF)) {
        return TMC6460_ERR_BAD_FRAME;
    }

    /* 大端序提取数据 */
    *value = ((uint32_t)buf[2] << 24)
           | ((uint32_t)buf[3] << 16)
           | ((uint32_t)buf[4] << 8)
           | (uint32_t)buf[5];

    return TMC6460_OK;
}

/**
 * @brief 解析写响应（5 字节，无 CRC）
 * 数据字段大端序：buf[1]=D[31:24], buf[2]=D[23:16], buf[3]=D[15:8], buf[4]=D[7:0]
 */
int tmc6460_parse_wr_resp(const uint8_t *buf, int len, uint32_t *value)
{
    if (len < TMC6460_WR_RESP_LEN) {
        return TMC6460_ERR_BAD_FRAME;
    }

    /* 校验 sync bits: bit0=1, bit7=0 */
    if ((buf[0] & 0x01) != 0x01 || (buf[0] & 0x80) != 0x00) {
        return TMC6460_ERR_BAD_FRAME;
    }

    /* 大端序提取数据 */
    *value = ((uint32_t)buf[1] << 24)
           | ((uint32_t)buf[2] << 16)
           | ((uint32_t)buf[3] << 8)
           | (uint32_t)buf[4];

    return TMC6460_OK;
}
