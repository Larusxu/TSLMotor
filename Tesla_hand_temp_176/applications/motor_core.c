/**
 * @file motor_core.c
 * @brief 电机抽象层实现
 *
 * 架构：每电机独立 TCP 连接，20ms 主循环写目标力矩
 * 所有接口使用用户单位（mA, RPM, 0.01°），内部自动换算
 */
#include <rtthread.h>
#include <stdlib.h>
#include <string.h>

#if !defined(SAL_USING_POSIX)
#error "Please enable SAL_USING_POSIX!"
#else
#include <sys/select.h>
#include <sys/time.h>
#endif
#include <sys/socket.h>
#include "netdb.h"

#include "motor_core.h"
#include "motor_config.h"
#include "tmc6460_protocol.h"
#include "yinshi_protocol.h"

/* ---------- 全局数据 ---------- */
motor_data_t g_motor[MC];
static int g_sk[MC];


///*食初始位置*/int16_t pos0[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
///*食指弯曲*/int16_t pos1[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 0, 0, 0, 400, 0, 0, 0, 0, 0};
///*中指弯曲*/int16_t pos2[MC] = {300, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
///*无名指弯曲*/int16_t pos3[MC] = {0, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0};
///*小拇指弯曲*/int16_t pos4[MC] = {0, 0, 0, 0, 0, 0, 300, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
///*四指全弯曲*/int16_t pos5[MC] = {300, 300, 0, 0, 400, 0, 300, 400, 0, 300, 0, 400, 0, 400, 0, 0, 0, 0, 0};
///*大拇指翻转*/int16_t pos6[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
///*大拇指指根*/int16_t pos7[MC] = {0, 0, 0, 0, 0, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
///*大拇指中*/int16_t pos8[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
///*大拇指尖*/int16_t pos9[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 600, 0, 0, 0, 0, 0, 1900};
///*食指左*/int16_t pos10[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0, 0, 0};
///*中指左*/int16_t pos11[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0};
///*无名指左*/int16_t pos12[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0, 0};
///*小指指左*/int16_t pos13[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0};
///*全部并拢*/int16_t pos14[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, -300, 0, -700, 0};
///*完全张开*/int16_t pos15[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -300, 150, 0, 300, 0};
///*手掌*/int16_t pos16[MC] = {0, 0, 0, 700, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
///*手腕前*/int16_t pos17[MC] = {0, 0, -500, 0, 0, 0, 0, 0, 0, 0, -500, 0, 0, 0, 0, 0, 0, 0, 0};
///*手腕右*/int16_t pos18[MC] = {0, 0, 500, 0, 0, 0, 0, 0, 0, 0, -500, 0, 0, 0, 0, 0, 0, 0, 0};
///*手腕左*/int16_t pos19[MC] = {0, 0, -500, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0};
///*手腕后*/int16_t pos20[MC] = {0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0};

/*食初始位置*/int16_t pos0[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
/*食指弯曲*/int16_t pos1[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 1000, 0, 0, 0, 0, 0};
/*中指弯曲*/int16_t pos2[MC] = {1000, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
/*无名指弯曲*/int16_t pos3[MC] = {0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0};
/*小拇指弯曲*/int16_t pos4[MC] = {0, 0, 0, 0, 0, 0, 1000, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
/*四指全弯曲*/int16_t pos5[MC] = {1000, 1000, 0, 0, 1000, 0, 1000, 1000, 0, 1000, 0, 1000, 0, 1000, 0, 0, 0, 0, 0};
/*大拇指翻转*/int16_t pos6[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
/*大拇指指根*/int16_t pos7[MC] = {0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
/*大拇指中*/int16_t pos8[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
/*大拇指尖*/int16_t pos9[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 1900};
/*食指左*/int16_t pos10[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0, 0, 0};
/*中指左*/int16_t pos11[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0};
/*无名指左*/int16_t pos12[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0, 0};
/*小指指左*/int16_t pos13[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0};
/*全部并拢*/int16_t pos14[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, -300, 0, -700, 0};
/*完全张开*/int16_t pos15[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -300, 150, 0, 300, 0};
/*手掌*/int16_t pos16[MC] = {0, 0, 0, 700, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
/*手腕前*/int16_t pos17[MC] = {0, 0, -500, 0, 0, 0, 0, 0, 0, 0, -500, 0, 0, 0, 0, 0, 0, 0, 0};
/*手腕右*/int16_t pos18[MC] = {0, 0, 500, 0, 0, 0, 0, 0, 0, 0, -500, 0, 0, 0, 0, 0, 0, 0, 0};
/*手腕左*/int16_t pos19[MC] = {0, 0, -500, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0};
/*手腕后*/int16_t pos20[MC] = {0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0};

/* ---------- 单位换算（TMC6460 专用） ---------- */

/* mA → 内部 count（写力矩/限制时用） */
static uint16_t ma_to_raw(uint16_t ma)
{
    return (uint16_t)(ma / TMC6460_MA_PER_COUNT);
}

/* 内部 count → mA（读力矩时用） */
static int16_t raw_to_ma(int16_t raw)
{
    return (int16_t)(raw * TMC6460_MA_PER_COUNT);
}

/* RPM → 内部单位（写速度限时用） */
static uint32_t rpm_to_raw(uint16_t rpm)
{
    return (uint32_t)(rpm * TMC6460_K_VEL);
}

/* 内部单位 → RPM（读速度时用） */
static int32_t raw_to_rpm(int32_t raw)
{
    return (int32_t)(raw / TMC6460_K_VEL);
}

/* 0.01° → 内部单位（写位置时用） */
static int32_t deg01_to_raw(int32_t deg01)
{
    return (int32_t)(deg01 * TMC6460_POS_PER_01DEG);
}

/* 内部单位 → 0.01°（读位置时用） */
static int32_t raw_to_deg01(int32_t raw)
{
    return (int32_t)(raw / TMC6460_POS_PER_01DEG);
}

/* ---------- TCP 辅助 ---------- */

static int motor_send(uint8_t id, const uint8_t *data, int len)
{
    if (id >= MC || g_sk[id] < 0) {
        return -1;
    }
    int ret = send(g_sk[id], data, len, 0);
    if (ret < 0) {
        g_motor[id].err_cnt++;
    }
    return ret;
}

static int motor_recv(uint8_t id, uint8_t *buf, int maxlen, int timeout_ms)
{
    if (id >= MC || g_sk[id] < 0) {
        return -1;
    }

    fd_set rfds;
    struct timeval tv;
    int ret;

    FD_ZERO(&rfds);
    FD_SET(g_sk[id], &rfds);
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;

    ret = select(g_sk[id] + 1, &rfds, RT_NULL, RT_NULL, &tv);
    if (ret <= 0) {
        return -1;
    }

    return recv(g_sk[id], buf, maxlen, 0);
}

/* ---------- TMC6460 同步读写 ---------- */

static int tmc6460_read_reg_sync(uint8_t id, uint16_t reg_addr, uint32_t *value)
{
    uint8_t tx_buf[TMC6460_RD_REQ_LEN];
    uint8_t rx_buf[TMC6460_RD_RESP_LEN];
    int ret;

    tmc6460_build_rd_req(tx_buf, reg_addr);
    ret = motor_send(id, tx_buf, TMC6460_RD_REQ_LEN);
    if (ret < 0) return TMC6460_ERR_COMM_FAIL;

    ret = motor_recv(id, rx_buf, TMC6460_RD_RESP_LEN, 100);
    if (ret < TMC6460_RD_RESP_LEN) return TMC6460_ERR_TIMEOUT;

    return tmc6460_parse_rd_resp(rx_buf, ret, reg_addr, value);
}

static int tmc6460_write_reg_sync(uint8_t id, uint16_t reg_addr, uint32_t value)
{
    uint8_t tx_buf[TMC6460_WR_REQ_LEN];
    uint8_t rx_buf[TMC6460_WR_RESP_LEN];
    int ret;

    tmc6460_build_wr_req(tx_buf, reg_addr, value);
    ret = motor_send(id, tx_buf, TMC6460_WR_REQ_LEN);
//    rt_kprintf("tx==> 0x%x  %d: %x  %x  %x  %x  %x  %x\n",reg_addr, ret, tx_buf[0], tx_buf[1], tx_buf[2], tx_buf[3], tx_buf[4], tx_buf[5]);

    if (ret < 0) return TMC6460_ERR_COMM_FAIL;

//    rt_thread_mdelay(50);
    ret = motor_recv(id, rx_buf, TMC6460_WR_RESP_LEN, 100);

//    rt_kprintf("rx==> 0x%x  %d: %x  %x  %x  %x  %x\n",reg_addr, ret, rx_buf[0], rx_buf[1], rx_buf[2], rx_buf[3], rx_buf[4]);
    if (ret < TMC6460_WR_RESP_LEN) return TMC6460_ERR_TIMEOUT;

    uint32_t resp_val;
    return tmc6460_parse_wr_resp(rx_buf, ret, &resp_val);
}

#define WR_MAX_RETRY    5
#define TMC_RW_INTERVAL_MS  1   /* 连续读写间隔，满足 TMC6460 UART 超时要求 */

/**
 * @brief TMC6460 带重试的写寄存器
 * 成功返回 TMC6460_OK，5 次失败则死循环等待
 */
static int tmc6460_write_reg_verify(uint8_t id, uint16_t reg_addr, uint32_t value)
{
    int retry;
    int ret;

    for (retry = 0; retry < WR_MAX_RETRY; retry++) {
        ret = tmc6460_write_reg_sync(id, reg_addr, value);
        if (ret == TMC6460_OK) {
            rt_thread_mdelay(TMC_RW_INTERVAL_MS);
            return TMC6460_OK;
        }
        rt_kprintf("[MOTOR] %s: write 0x%03X fail (%d), retry %d\n",
                   motor_configs[id].name, reg_addr, ret, retry + 1);
        rt_thread_mdelay(10);
    }

    /* 5 次失败，死循环等待 */
    rt_kprintf("[MOTOR] %s: write 0x%03X FATAL: %d retries failed, HALT\n",
               motor_configs[id].name, reg_addr, WR_MAX_RETRY);
    while (1) {
        rt_thread_mdelay(1000);
    }
    return ret; /* unreachable */
}

/**
 * @brief TMC6460 带重试的读寄存器
 * 成功返回 TMC6460_OK，5 次失败则死循环等待
 */
static int tmc6460_read_reg_verify(uint8_t id, uint16_t reg_addr, uint32_t *value)
{
    int retry;
    int ret;

    for (retry = 0; retry < WR_MAX_RETRY; retry++) {
        ret = tmc6460_read_reg_sync(id, reg_addr, value);
        if (ret == TMC6460_OK) {
            rt_thread_mdelay(TMC_RW_INTERVAL_MS);
            return TMC6460_OK;
        }
        rt_kprintf("[MOTOR] %s: read 0x%03X fail (%d), retry %d\n",
                   motor_configs[id].name, reg_addr, ret, retry + 1);
        rt_thread_mdelay(10);
    }

    /* 5 次失败，死循环等待 */
    rt_kprintf("[MOTOR] %s: read 0x%03X FATAL: %d retries failed, HALT\n",
               motor_configs[id].name, reg_addr, WR_MAX_RETRY);
    while (1) {
        rt_thread_mdelay(1000);
    }
    return ret; /* unreachable */
}

/* ---------- 因时同步读写 ---------- */

static int yinshi_read_status_sync(uint8_t id, yinshi_status_t *status)
{
    uint8_t tx_buf[YINSHI_MAX_FRAME_LEN];
    uint8_t rx_buf[YINSHI_MAX_FRAME_LEN];
    int ret;

    int tx_len = yinshi_build_rd_status(tx_buf, motor_configs[id].yinshi_id);
    ret = motor_send(id, tx_buf, tx_len);
    if (ret < 0) return YINSHI_ERR_COMM_FAIL;

    ret = motor_recv(id, rx_buf, YINSHI_MAX_FRAME_LEN, 100);
    if (ret < 4) return YINSHI_ERR_TIMEOUT;

    yinshi_response_t resp;
    int parsed = yinshi_parse_response(rx_buf, ret, &resp);
    if (parsed <= 0) return YINSHI_ERR_BAD_FRAME;

    return yinshi_extract_status(&resp, status);
}

static int yinshi_write_reg_sync(uint8_t id, uint16_t reg, uint16_t value)
{
    uint8_t tx_buf[YINSHI_MAX_FRAME_LEN];
    uint8_t rx_buf[YINSHI_MAX_FRAME_LEN];
    int ret;

    int tx_len = yinshi_build_wr_reg_u16(tx_buf, motor_configs[id].yinshi_id, reg, value);
    ret = motor_send(id, tx_buf, tx_len);
    if (ret < 0) return YINSHI_ERR_COMM_FAIL;

    ret = motor_recv(id, rx_buf, YINSHI_MAX_FRAME_LEN, 100);
    if (ret < 4) return YINSHI_ERR_TIMEOUT;

    yinshi_response_t resp;
    int parsed = yinshi_parse_response(rx_buf, ret, &resp);
    if (parsed <= 0) return YINSHI_ERR_BAD_FRAME;

    return YINSHI_OK;
}

/**
 * @brief 因时电缸带重试的写寄存器
 * 成功返回 YINSHI_OK，5 次失败则死循环等待
 */
static int yinshi_write_reg_verify(uint8_t id, uint16_t reg, uint16_t value)
{
    int retry;
    int ret;

    for (retry = 0; retry < WR_MAX_RETRY; retry++) {
        ret = yinshi_write_reg_sync(id, reg, value);
        if (ret == YINSHI_OK) {
            return YINSHI_OK;
        }
        rt_kprintf("[MOTOR] %s: write reg 0x%02X fail (%d), retry %d\n",
                   motor_configs[id].name, reg, ret, retry + 1);
        rt_thread_mdelay(10);
    }

    rt_kprintf("[MOTOR] %s: write reg 0x%02X FATAL: %d retries failed, HALT\n",
               motor_configs[id].name, reg, WR_MAX_RETRY);
    while (1) {
        rt_thread_mdelay(1000);
    }
    return ret; /* unreachable */
}

/* ---------- 连接管理 ---------- */

int motor_connect_all(void)
{
    int fail_cnt = 0;
    int i;

    for (i = 0; i < MC; i++) {
        g_sk[i] = -1;
        g_motor[i].connected = 0;
        g_motor[i].pos_read_ok = 0;
    }

    for (i = 0; i < MC; i++) {
        struct sockaddr_in server_addr;
        int sk;

        sk = socket(AF_INET, SOCK_STREAM, 0);
        if (sk < 0) {
            rt_kprintf("[MOTOR] %s: socket failed\n", motor_configs[i].name);
            fail_cnt++;
            continue;
        }

        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
        setsockopt(sk, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        memset(&server_addr, 0, sizeof(server_addr));
        server_addr.sin_family = AF_INET;
        server_addr.sin_port = htons(motor_configs[i].tcp_port);
        server_addr.sin_addr.s_addr = inet_addr(SERVER_IP);

        if (connect(sk, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
            rt_kprintf("[MOTOR] %s: connect %s:%d failed\n",
                       motor_configs[i].name, SERVER_IP, motor_configs[i].tcp_port);
            closesocket(sk);
            fail_cnt++;
            continue;
        }

        g_sk[i] = sk;
        g_motor[i].connected = 1;
        rt_kprintf("[MOTOR] %s: connected port %d\n", motor_configs[i].name, motor_configs[i].tcp_port);
    }

    return fail_cnt;
}

int motor_reconnect(uint8_t id)
{
    if (id >= MC) return -1;

    if (g_sk[id] >= 0) {
        closesocket(g_sk[id]);
        g_sk[id] = -1;
    }
    g_motor[id].connected = 0;

    struct sockaddr_in server_addr;
    int sk = socket(AF_INET, SOCK_STREAM, 0);
    if (sk < 0) return -1;

    struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
    setsockopt(sk, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(motor_configs[id].tcp_port);
    server_addr.sin_addr.s_addr = inet_addr(SERVER_IP);

    if (connect(sk, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        closesocket(sk);
        return -1;
    }

    g_sk[id] = sk;
    g_motor[id].connected = 1;
    rt_kprintf("[MOTOR] %s: reconnected\n", motor_configs[id].name);
    return 0;
}

/* ---------- 编码器配置 ---------- */

/**
 * @brief 构建 IO Controller SPI 命令
 * 来源: tmc6460_encoder.py build_spi_cmd()
 */
static uint32_t build_spi_cmd(uint8_t spi_bus_mode, uint32_t spi_freq,
                              uint8_t spi_bits, uint8_t spi_idle)
{
    uint8_t half_period = (uint8_t)(60000000 / (2 * spi_freq) - 1);
    uint8_t u = (spi_bits - 1) & 0x1F;
    u |= 0x80;  /* csn_enc_n = True */

    uint32_t cmd = 0xF0000000;
    cmd |= (spi_bus_mode & 3) << 26;
    cmd |= 2 << 24;           /* request_type=2: poll->PHI_EXT_A */
    cmd |= (spi_idle & 0xFF) << 16;
    cmd |= (u & 0xFF) << 8;
    cmd |= (half_period & 0xFF);
    return cmd;
}

/**
 * @brief 配置 SSI 编码器
 * 来源: tmc6460_encoder.py setup_encoder()
 * 配置 IO_MATRIX、IO Controller、Feedback Channel A
 * 5 次失败死循环
 */
static int tmc6460_setup_encoder(uint8_t id)
{
    uint32_t val;
    int ret;
    int retry;

    rt_kprintf("[MOTOR] %s: 配置编码器...\n", motor_configs[id].name);

    /* 0. 配置波特率 115200，禁用 autobaud
     * UART.CONTROL (0x340):
     *   bit[0] = AUTOBAUD_EN (0=禁用)
     *   MANTISSA_LIMIT = 521 (0x209)
     * 来源: tmc6460.pdf Table 3: 115200 → MANTISSA_LIMIT = 521
     */
    tmc6460_write_reg_verify(id, TMC6460_REG_UART_CONTROL, 0x00000209);
    rt_kprintf("[MOTOR] %s: UART 115200 OK\n", motor_configs[id].name);

    /* 1. 停止 IO Controller */
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_CMD, 0x00000000);
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_RESP0, 0x00000000);
    rt_thread_mdelay(50);

    /* 2. IO_MATRIX: ENC_A=OUT0(SCK), ENC_B=IN0(SDI), ENC_N=IN1_OUT1(CSN) */
    tmc6460_read_reg_verify(id, TMC6460_REG_CHIP_IO_MATRIX, &val);
    uint32_t mask = 0x3F | (7 << 12);
    uint32_t new_io = (val & ~mask) | 0x3F | (3 << 12);
    tmc6460_write_reg_verify(id, TMC6460_REG_CHIP_IO_MATRIX, new_io);

    /* 3. 探测 IO Controller 固件 */
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_CMD, 0x00000000);
    rt_thread_mdelay(20);
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_CMD, 0xAA000000);
    rt_thread_mdelay(50);
    tmc6460_read_reg_verify(id, TMC6460_REG_IO_RESP1, &val);
    uint32_t fw_type = val >> 8;
    if (fw_type != 0x646000 && fw_type != 0x52414D) {
        rt_kprintf("[MOTOR] %s: IO Controller FW unsupported (0x%08X)\n",
                   motor_configs[id].name, val);
        return -1;
    }
    rt_kprintf("[MOTOR] %s: IO Controller FW OK (0x%08X)\n",
               motor_configs[id].name, fw_type);

    /* 4. Feedback channel A 配置 */
    tmc6460_write_reg_verify(id, TMC6460_REG_FEEDBACK_A_CFG, 0x07000400);
    tmc6460_write_reg_verify(id, TMC6460_REG_FEEDBACK_A_SPI_CFG, 0x000DA71E);
    tmc6460_write_reg_verify(id, TMC6460_REG_FEEDBACK_A_FILTER, 0xFFF00001);
    tmc6460_write_reg_verify(id, TMC6460_REG_FEEDBACK_A_SCALE, 0x00400001);

    /* 5. 电角度偏置 */
    if (motor_configs[id].phi_e_offset != 0) {
        tmc6460_write_reg_verify(id, TMC6460_REG_PHI_E_OFFSET,
                                 motor_configs[id].phi_e_offset);
    }

    /* 6. 启动 IO Controller */
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_CMD, 0x00000000);
    rt_thread_mdelay(20);

    /* DATA_MASK -> SEND_DATA -> COMMAND (顺序重要!) */
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_RESP2, TMC6460_SPI_DATA_MASK);
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_RESP1, 0x00000000);  /* SEND_DATA = 0 */

    uint32_t spi_cmd = build_spi_cmd(TMC6460_SPI_BUS_MODE,
                                     TMC6460_SPI_FREQ_HZ,
                                     TMC6460_SPI_BITS,
                                     TMC6460_SPI_IDLE_TIME);
    tmc6460_write_reg_verify(id, TMC6460_REG_IO_CMD, spi_cmd);
    rt_thread_mdelay(100);

    /* 7. 验证 IO Controller 是否执行 */
    tmc6460_read_reg_verify(id, TMC6460_REG_IO_RESP0, &val);
    if (val == 0) {
        rt_kprintf("[MOTOR] %s: IO Controller 未响应!\n", motor_configs[id].name);
        return -1;
    }

    rt_kprintf("[MOTOR] %s: 编码器配置完成 (CMD=0x%08X)\n",
               motor_configs[id].name, spi_cmd);
    return 0;
}

/* ---------- 初始化 ---------- */

int motor_init_all(void)
{
    int i, ret, retry;
    uint32_t reg_val;
    yinshi_status_t ys_status;

    rt_kprintf("[MOTOR] === 初始化开始 ===\n");

    /* 1. 建连 */
    rt_kprintf("[MOTOR] 建立 TCP 连接...\n");
    int fail = motor_connect_all();
    if (fail > 0) {
        rt_kprintf("[MOTOR] 警告: %d 路连接失败\n", fail);
    }

    /* 2. TMC6460 初始化 */
    for (i = 0; i < MC; i++) {
        if (motor_configs[i].type != MOTOR_TYPE_TMC6460) continue;
        if (!g_motor[i].connected) continue;

        /* 初始化运动模式 */
        g_motor[i].motion_mode = motor_configs[i].motion_mode;

        rt_kprintf("[MOTOR] %s: === TMC6460 初始化 ===\n", motor_configs[i].name);

        /* 2a. 配置编码器（IO_MATRIX + IO Controller + Feedback Channel A） */
        tmc6460_setup_encoder(i);

        /* 2b. PWM 配置
         * 来源: 上位机 main.py: write_register(0x103, 0xFFFF12C0)
         * 0x12C0 = 4800, f_PWM = 60MHz / 4800 = 12.5kHz
         */
        tmc6460_write_reg_verify(i, TMC6460_REG_PWM_PERIOD, 0xFFFF12C0);

        /* 2c. CSA gain = 3 (10V/V) */
        tmc6460_write_reg_verify(i, TMC6460_REG_CSA, 3);

        /* 2d. MOTION_MODE + N_POLE_PAIRS */
        reg_val = tmc6460_make_motor_motion(motor_configs[i].motion_mode,
                                            motor_configs[i].n_pole_pairs);
        tmc6460_write_reg_verify(i, TMC6460_REG_MOTOR_MOTION, reg_val);
        rt_kprintf("[MOTOR] %s: MOTION MODE=%d POLES=%d OK\n",
                   motor_configs[i].name,
                   motor_configs[i].motion_mode,
                   motor_configs[i].n_pole_pairs);

        /* 读初始位置（确保读到），转换为用户单位 */
        tmc6460_read_reg_verify(i, TMC6460_REG_PID_POSITION_ACTUAL, &reg_val);
        g_motor[i].pos_actual = raw_to_deg01((int32_t)reg_val);
        g_motor[i].pos_read_ok = 1;
        rt_kprintf("[MOTOR] %s: pos=%d (0.01deg)\n", motor_configs[i].name, g_motor[i].pos_actual);

        /* 配置力矩限制（mA → 内部单位） */
        reg_val = tmc6460_make_torque_flux_limits(ma_to_raw(motor_configs[i].torque_limit),
                                                  ma_to_raw(motor_configs[i].flux_limit));
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_TORQUE_FLUX_LIMITS, reg_val);
        g_motor[i].torque_limit = motor_configs[i].torque_limit;
        rt_kprintf("[MOTOR] %s: limit=%d mA\n", motor_configs[i].name, motor_configs[i].torque_limit);

        /* 配置 PID 参数 */
        /* 电流环: 0x142=FLUX_COEFF, 0x143=TORQUE_COEFF, [31:16]=Kp, [15:0]=Ki */
        reg_val = ((uint32_t)motor_configs[i].cur_kp << 16) | motor_configs[i].cur_ki;
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_FLUX_COEFF, reg_val);
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_TORQUE_COEFF, reg_val);

        /* 速度环: 0x145=VELOCITY_COEFF, [31:16]=Kp, [15:0]=Ki */
        reg_val = ((uint32_t)motor_configs[i].vel_kp << 16) | motor_configs[i].vel_ki;
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_VELOCITY_COEFF, reg_val);

        /* 位置环: 0x146=POSITION_COEFF, [31:16]=Kp, [15:0]=0 */
        reg_val = (uint32_t)motor_configs[i].pos_kp << 16;
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_POSITION_COEFF, reg_val);

        /* 速度限幅: 0x14B（RPM → 内部单位） */
        if (motor_configs[i].vel_limit != 0) {
            tmc6460_write_reg_verify(i, TMC6460_REG_PID_VELOCITY_LIMIT,
                                     rpm_to_raw(motor_configs[i].vel_limit));
        }

        /* 2h. GDRV: 使能 DRV + Charge Pump（最后使能，防止配置过程中电机误动作）
         * 来源: 上位机 main.py
         *   gdrv |= (1 << 31) | (1 << 16)
         */
        tmc6460_read_reg_verify(i, TMC6460_REG_GDRV, &reg_val);
        reg_val |= (1 << 31) | (1 << 16);
        tmc6460_write_reg_verify(i, TMC6460_REG_GDRV, reg_val);
        rt_kprintf("[MOTOR] %s: GDRV OK\n", motor_configs[i].name);

        rt_kprintf("[MOTOR] %s: PID OK\n", motor_configs[i].name);
    }

    /* 3. 因时电缸初始化 */
//    for (i = 0; i < MC; i++) {
//        if (motor_configs[i].type != MOTOR_TYPE_YINSHI) continue;
//        if (!g_motor[i].connected) continue;
//
//        for (retry = 0; retry < MOTOR_POS_READ_MAX_RETRY; retry++) {
//            ret = yinshi_read_status_sync(i, &ys_status);
//            if (ret == YINSHI_OK) {
//                g_motor[i].pos_actual = ys_status.current_pos;  /* 步数 */
//                g_motor[i].torque_actual = ys_status.force_grams;  /* g */
//                g_motor[i].error_flags = ys_status.error_flags;
//                g_motor[i].pos_read_ok = 1;
//                rt_kprintf("[MOTOR] %s: pos=%d force=%dg\n",
//                           motor_configs[i].name, g_motor[i].pos_actual, g_motor[i].torque_actual);
//                break;
//            }
//            rt_thread_mdelay(10);
//        }
//        if (!g_motor[i].pos_read_ok) {
//            rt_kprintf("[MOTOR] %s: 状态读取失败!\n", motor_configs[i].name);
//        }
//    }

    rt_kprintf("[MOTOR] === 初始化完成 ===\n");


    for(i = 0; i < MC; i++)
    {

        if (motor_configs[i].type != MOTOR_TYPE_TMC6460) continue;
        if (!g_motor[i].connected) continue;
        int32_t raw = (int32_t)(-2000 * TMC6460_K_VEL);
                rt_kprintf("%d   %d\n", g_motor[i].velocity, raw);
        tmc6460_write_reg_sync(i, TMC6460_REG_PID_VELOCITY_TARGET, (uint32_t)raw);
    }

    rt_thread_mdelay(90000);

    for (i = 0; i < MC; i++) {

        if (motor_configs[i].type != MOTOR_TYPE_TMC6460) continue;
        if (!g_motor[i].connected) continue;

        motor_read_position(i, &g_motor[i].pos_actual);
    }

    g_motor[0].pos_offset = 360000 + 90 * motor_configs[0].ratio; //中指指根
    g_motor[1].pos_offset = 360000 + 100 * motor_configs[1].ratio;//无名指指根
    g_motor[2].pos_offset = 360000 + 2600 * motor_configs[2].ratio;//手腕电机 小拇指侧
    g_motor[3].pos_offset = 360000 + 100 * motor_configs[3].ratio;//手掌
    g_motor[4].pos_offset = 360000 + 400 * motor_configs[4].ratio;//中指指中
    g_motor[5].pos_offset = 360000 + 50 * motor_configs[5].ratio;//大拇指指根
    g_motor[6].pos_offset = 360000 + 50 * motor_configs[6].ratio;//小拇指指根
    g_motor[7].pos_offset = 360000 + 150 * motor_configs[7].ratio;//小拇指指中
    g_motor[8].pos_offset = 360000 + 380 * motor_configs[8].ratio;//大拇指指中
    g_motor[9].pos_offset = 360000 + 70 * motor_configs[9].ratio;//食指指根
    g_motor[10].pos_offset = 360000 + 2600 * motor_configs[10].ratio;//手腕电机 大拇指侧
    g_motor[11].pos_offset = 360000 + 150 * motor_configs[11].ratio;//无名指指中
    g_motor[12].pos_offset = 360000 + 220 * motor_configs[12].ratio;//大拇指指尖
    g_motor[13].pos_offset = 360000 + 420 * motor_configs[13].ratio;//食指指中
    g_motor[14].pos_offset = 1000 + (-150) * motor_configs[14].ratio;//食指并拢
    g_motor[15].pos_offset = 1000 + (-200) * motor_configs[15].ratio;//无名指并拢
    g_motor[16].pos_offset = 1000 + (-150) * motor_configs[16].ratio;//中并拢
    g_motor[17].pos_offset = 1000 + (-150) * motor_configs[17].ratio;//小拇指并拢
    g_motor[18].pos_offset = 0;//大拇指反转
    for(i = 0; i < MC; i++)
    {
        g_motor[i].pos_zero = 0;

        if (motor_configs[i].type != MOTOR_TYPE_TMC6460) continue;
        if (!g_motor[i].connected) continue;
        int32_t raw = (int32_t)(0 * TMC6460_K_VEL);
                rt_kprintf("%d   %d\n", g_motor[i].velocity, raw);
        tmc6460_write_reg_sync(i, TMC6460_REG_PID_VELOCITY_TARGET, (uint32_t)raw);
    }


    rt_kprintf("pos_zero: ");
    for(i = 0; i < MC; i++)
    {
        if (motor_configs[i].type == MOTOR_TYPE_TMC6460)
        {
            g_motor[i].pos_zero = g_motor[i].pos_actual;
        }

        g_motor[i].pos_target = g_motor[i].pos_zero + g_motor[i].pos_offset;
        rt_kprintf("%d ",g_motor[i].pos_zero);
    }
    rt_kprintf("\n");

    /* 4. 切换到位置模式 */
    for(i = 0; i < MC; i++)
    {
        if (motor_configs[i].type != MOTOR_TYPE_TMC6460) continue;
        if (!g_motor[i].connected) continue;



        reg_val = tmc6460_make_torque_flux_limits(ma_to_raw(motor_configs[i].torque_limit),
                                                  ma_to_raw(motor_configs[i].flux_limit));
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_TORQUE_FLUX_LIMITS, reg_val);

        rt_kprintf("[MOTOR] %s: limit=%d mA\n", motor_configs[i].name, motor_configs[i].torque_limit);




        reg_val = tmc6460_make_motor_motion(TMC6460_MODE_POSITION,
                                            motor_configs[i].n_pole_pairs);
        tmc6460_write_reg_verify(i, TMC6460_REG_MOTOR_MOTION, reg_val);
        g_motor[i].motion_mode = TMC6460_MODE_POSITION;

        /* 写目标位置 */
        int32_t raw = deg01_to_raw(g_motor[i].pos_target);
        tmc6460_write_reg_verify(i, TMC6460_REG_PID_POSITION_TARGET, (uint32_t)raw);
//        motor_send_position(i, g_motor[i].pos_target);



        rt_kprintf("[MOTOR] %s: POSITION MODE, target=%d (0.01deg)\n",
                   motor_configs[i].name, g_motor[i].pos_target);
    }

    rt_thread_mdelay(2000);
    for(i = 0; i < MC; i++)
    {
        if (motor_configs[i].type != MOTOR_TYPE_TMC6460) continue;
        if (!g_motor[i].connected) continue;

//        reg_val = tmc6460_make_torque_flux_limits(ma_to_raw(motor_configs[i].torque_limit),
//                                                  ma_to_raw(motor_configs[i].flux_limit));
//        tmc6460_write_reg_verify(i, TMC6460_REG_PID_TORQUE_FLUX_LIMITS, reg_val);

        rt_kprintf("[MOTOR] %s: limit=%d mA\n", motor_configs[i].name, motor_configs[i].torque_limit);
    }
    return 0;
}

/* ---------- 运行时接口（用户单位） ---------- */

int motor_set_torque(uint8_t id, int16_t torque_ma)
{
    if (id >= MC || !g_motor[id].connected) return -1;

    if (motor_configs[id].type == MOTOR_TYPE_TMC6460) {
        /* mA → 内部 count */
        int16_t raw = (int16_t)(torque_ma / TMC6460_MA_PER_COUNT);
        uint32_t val = tmc6460_make_torque_flux_target(raw, 0);
        return tmc6460_write_reg_verify(id, TMC6460_REG_PID_TORQUE_FLUX_TARGET, val);
    } else {
        /* 因时：直接用 g */
        return yinshi_write_reg_verify(id, YINSHI_REG_FORCE_TARGET, (uint16_t)torque_ma);
    }
}

int motor_set_torque_limit(uint8_t id, uint16_t limit_ma)
{
    if (id >= MC || !g_motor[id].connected) return -1;

    if (motor_configs[id].type == MOTOR_TYPE_TMC6460) {
        /* mA → 内部 count */
        uint16_t raw = ma_to_raw(limit_ma);
        uint16_t flux_raw = ma_to_raw(motor_configs[id].flux_limit);
        uint32_t val = tmc6460_make_torque_flux_limits(raw, flux_raw);
        int ret = tmc6460_write_reg_verify(id, TMC6460_REG_PID_TORQUE_FLUX_LIMITS, val);
        if (ret == TMC6460_OK) g_motor[id].torque_limit = limit_ma;
        return ret;
    }
    return -1;
}

int motor_set_velocity(uint8_t id, int32_t vel_rpm)
{
    if (id >= MC || !g_motor[id].connected) return -1;
    if (motor_configs[id].type != MOTOR_TYPE_TMC6460) return -1;

    g_motor[id].velocity = vel_rpm;
    return 0;
}

int motor_read_position(uint8_t id, int32_t *pos)
{
    if (id >= MC || !g_motor[id].connected || !pos) return -1;

    if (motor_configs[id].type == MOTOR_TYPE_TMC6460) {
        uint32_t val;
        int ret = tmc6460_read_reg_verify(id, TMC6460_REG_PID_POSITION_ACTUAL, &val);
        /* 内部单位 → 0.01° */
        *pos = raw_to_deg01((int32_t)val);
        g_motor[id].pos_actual = *pos;
        return 0;
    } else {
        yinshi_status_t status;
        int ret = yinshi_read_status_sync(id, &status);
        if (ret == YINSHI_OK) {
            *pos = status.current_pos;  /* 步数 */
            g_motor[id].pos_actual = status.current_pos;
            g_motor[id].torque_actual = status.force_grams;
            g_motor[id].error_flags = status.error_flags;
            return 0;
        }
        return ret;
    }
}

int motor_set_position(uint8_t id, int32_t pos)
{
    if (id >= MC || !g_motor[id].connected) return -1;

    int ret = 0;
    if (motor_configs[id].type == MOTOR_TYPE_TMC6460)
    {
        /* 0.01° → 内部单位 */
//        g_motor[id].pos_target = g_motor[id].pos_offset + g_motor[id].pos_zero + pos;
    }
    else if (motor_configs[id].type == MOTOR_TYPE_YINSHI_LASF)
    {
        /* 因时 LASF：速度力控模式5，方法二同时写 0x25~0x29 */
        uint16_t vals[5] = {
            YINSHI_MODE_SPEED_FORCE,            /* 0x25: 速度力控 */
            0,                                   /* 0x26: 电压不用 */
            YINSHI_LASF_FORCE_TARGET_G,          /* 0x27: 力控目标 10N */
            YINSHI_LASF_SPEED,                   /* 0x28: 速度 1000步/s */
            (uint16_t)pos                         /* 0x29: 目标位置 */
        };
        uint8_t buf[YINSHI_MAX_FRAME_LEN];
        int tx_len = yinshi_build_wr_reg_multi(buf, motor_configs[id].yinshi_id,
                                               0x25, vals, 5);
        if (tx_len > 0) {
            ret = motor_send(id, buf, tx_len) > 0 ? 0 : -1;
        } else {
            ret = tx_len;
        }
    }
    else if (motor_configs[id].type == MOTOR_TYPE_YINSHI_LAS)
    {
        uint8_t buf[9];
        buf[0] = 0x55;
        buf[1] = 0xaa;
        buf[2] = 0x04;
        buf[3] = motor_configs[id].yinshi_id;
        buf[4] = 0x03;
        buf[5] = 0x37;
        buf[6] = pos & 0xff;
        buf[7] = pos >> 8 & 0xff;
        buf[8] = buf[2] + buf[3] + buf[4] + buf[5] + buf[6] + buf[7];


        ret = motor_send(id, buf, 9) > 0 ? 0 : -1;
    }
//    if (ret == 0) g_motor[id].pos_target = pos;
    return ret;
}

int motor_read_velocity(uint8_t id, int32_t *vel)
{
    if (id >= MC || !g_motor[id].connected || !vel) return -1;

    if (motor_configs[id].type == MOTOR_TYPE_TMC6460) {
        uint32_t val;
        int ret = tmc6460_read_reg_verify(id, TMC6460_REG_PID_VELOCITY_ACTUAL, &val);
        /* 内部单位 → RPM */
        *vel = raw_to_rpm((int32_t)val);
        g_motor[id].velocity = *vel;
        return 0;
    }
    return -1;  /* 因时无速度接口 */
}

int motor_read_torque(uint8_t id, int16_t *torque)
{
    if (id >= MC || !g_motor[id].connected || !torque) return -1;

    if (motor_configs[id].type == MOTOR_TYPE_TMC6460) {
        uint32_t val;
        int ret = tmc6460_read_reg_verify(id, TMC6460_REG_PID_TORQUE_FLUX_ACTUAL, &val);
        /* 内部 count → mA */
        int16_t raw = (int16_t)((val >> 16) & 0xFFFF);
        *torque = raw_to_ma(raw);
        g_motor[id].torque_actual = *torque;
        return 0;
    } else {
        /* 因时：返回 g */
        yinshi_status_t status;
        int ret = yinshi_read_status_sync(id, &status);
        if (ret == YINSHI_OK) {
            *torque = status.force_grams;
            g_motor[id].torque_actual = *torque;
            return 0;
        }
        return ret;
    }
}

int motor_read_reg(uint8_t id, uint16_t reg, uint32_t *value)
{
    if (id >= MC || !g_motor[id].connected || !value) return -1;
    if (motor_configs[id].type != MOTOR_TYPE_TMC6460) return -1;
    return tmc6460_read_reg_verify(id, reg, value);
}

int motor_write_reg(uint8_t id, uint16_t reg, uint32_t value)
{
    if (id >= MC || !g_motor[id].connected) return -1;
    if (motor_configs[id].type != MOTOR_TYPE_TMC6460) return -1;
    return tmc6460_write_reg_verify(id, reg, value);
}

/* ---------- 主循环发送函数（不等响应，快速发送） ---------- */

/**
 * @brief 发送位置目标（0.01°），不等写响应
 */
int motor_send_position(uint8_t id, int32_t pos_deg01)
{
    if (id >= MC || !g_motor[id].connected) return -1;
    if (motor_configs[id].type != MOTOR_TYPE_TMC6460) return -1;

    int32_t raw = deg01_to_raw(pos_deg01);
    uint8_t buf[TMC6460_WR_REQ_LEN];
    tmc6460_build_wr_req(buf, TMC6460_REG_PID_POSITION_TARGET, (uint32_t)raw);
    return motor_send(id, buf, TMC6460_WR_REQ_LEN) > 0 ? 0 : -1;
}

/**
 * @brief 发送速度目标（RPM），不等写响应
 */
int motor_send_velocity(uint8_t id, int32_t vel_rpm)
{
    if (id >= MC || !g_motor[id].connected) return -1;
    if (motor_configs[id].type != MOTOR_TYPE_TMC6460) return -1;

    int32_t raw = (int32_t)(vel_rpm * TMC6460_K_VEL);
    uint8_t buf[TMC6460_WR_REQ_LEN];
    tmc6460_build_wr_req(buf, TMC6460_REG_PID_VELOCITY_TARGET, (uint32_t)raw);
    return motor_send(id, buf, TMC6460_WR_REQ_LEN) > 0 ? 0 : -1;
}

/**
 * @brief 发送力矩目标（mA），不等写响应
 */
int motor_send_torque(uint8_t id, int16_t torque_ma)
{
    if (id >= MC || !g_motor[id].connected) return -1;
    if (motor_configs[id].type != MOTOR_TYPE_TMC6460) return -1;

    int16_t raw = (int16_t)(torque_ma / TMC6460_MA_PER_COUNT);
    uint32_t val = tmc6460_make_torque_flux_target(raw, 0);
    uint8_t buf[TMC6460_WR_REQ_LEN];
    tmc6460_build_wr_req(buf, TMC6460_REG_PID_TORQUE_FLUX_TARGET, val);
    return motor_send(id, buf, TMC6460_WR_REQ_LEN) > 0 ? 0 : -1;
}

/* ---------- 主循环 ---------- */


void go_pos(int16_t *pos, uint16_t tim)
{
    for (uint16_t i = 0; i < MC; i++)
    {

        g_motor[i].pos_target = pos[i] * motor_configs[i].ratio + g_motor[i].pos_zero + g_motor[i].pos_offset;
//        g_motor[i].pos_target = new_target * motor_configs[i].ratio + g_motor[i].pos_zero + g_motor[i].pos_offset;

        //        if (!g_motor[i].connected) continue;
//
//        if (motor_configs[i].type == MOTOR_TYPE_TMC6460)
//        {
//            if (g_motor[i].motion_mode == TMC6460_MODE_VELOCITY) {
//                motor_send_velocity(i, g_motor[i].velocity);
//            } else if (g_motor[i].motion_mode == TMC6460_MODE_TORQUE) {
//                motor_send_torque(i, g_motor[i].torque_actual);
//            } else if (g_motor[i].motion_mode == TMC6460_MODE_POSITION) {
//                int32_t raw = deg01_to_raw(g_motor[i].pos_target);
//                tmc6460_write_reg_verify(i, TMC6460_REG_PID_POSITION_TARGET, (uint32_t)raw);
//            }
//        }
//        else
//        {
//            motor_set_position(i, g_motor[i].pos_target);
//        }
    }

    rt_thread_mdelay(tim);
}
#define PRINT_INTERVAL_MS   500     /* 打印间隔 500ms */

void motor_pos_test(void *param)
{

    rt_thread_mdelay(1000);
    while(1)
    {
        rt_thread_mdelay(10);
//        continue;
//        go_pos(pos0, 2000);
//        go_pos(pos1, 2000);

//        /*食初始位置*/int16_t pos0[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*食指弯曲*/int16_t pos1[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 0, 0, 0, 400, 0, 0, 0, 0, 0};
//        /*中指弯曲*/int16_t pos2[MC] = {300, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*无名指弯曲*/int16_t pos3[MC] = {0, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0};
//        /*小拇指弯曲*/int16_t pos4[MC] = {0, 0, 0, 0, 0, 0, 300, 400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*四指全弯曲*/int16_t pos5[MC] = {300, 300, 0, 0, 400, 0, 300, 400, 0, 300, 0, 400, 0, 400, 0, 0, 0, 0, 0};
//        /*大拇指翻转*/int16_t pos6[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
//        /*大拇指指根*/int16_t pos7[MC] = {0, 0, 0, 0, 0, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
//        /*大拇指中*/int16_t pos8[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1900};
//        /*大拇指尖*/int16_t pos9[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 600, 0, 0, 0, 0, 0, 1900};
//        /*食指左*/int16_t pos10[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0, 0, 0};
//        /*中指左*/int16_t pos11[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0};
//        /*无名指左*/int16_t pos12[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0, 0, 0};
//        /*小指指左*/int16_t pos13[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -200, 0};
//        /*全部并拢*/int16_t pos14[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, -300, 0, -700, 0};
//        /*完全张开*/int16_t pos15[MC] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -300, 150, 0, 300, 0};
//        /*手掌*/int16_t pos16[MC] = {0, 0, 0, 700, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*手腕前*/int16_t pos17[MC] = {0, 0, -1000, 0, 0, 0, 0, 0, 0, 0, -1000, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*手腕右*/int16_t pos18[MC] = {0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, -1000, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*手腕左*/int16_t pos19[MC] = {0, 0, -1000, 0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0};
//        /*手腕后*/int16_t pos20[MC] = {0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0};

        //初始位置
        go_pos(pos0, 4000);

        //钢琴手
        go_pos(pos1, 500);
        go_pos(pos2, 500);
        go_pos(pos3, 500);
        go_pos(pos4, 500);
        go_pos(pos1, 500);
        go_pos(pos2, 500);
        go_pos(pos3, 500);
        go_pos(pos4, 500);

        //四指弯曲
        go_pos(pos0, 500);
        go_pos(pos5, 500);
        go_pos(pos0, 500);
        go_pos(pos5, 500);
        go_pos(pos0, 1000);
        //大拇指
        go_pos(pos6, 1000);
        go_pos(pos7, 1000);go_pos(pos6, 1000);
        go_pos(pos8, 1000);go_pos(pos6, 1000);
        go_pos(pos9, 1000);go_pos(pos6, 1000);
        go_pos(pos0, 1000);

        //并指
        go_pos(pos10, 500);go_pos(pos0, 500);
        go_pos(pos11, 500);go_pos(pos0, 500);
        go_pos(pos12, 500);go_pos(pos0, 500);
        go_pos(pos13, 500);go_pos(pos0, 500);
        go_pos(pos14, 1000);
        go_pos(pos15, 1000);


        //手掌
        go_pos(pos16, 500);go_pos(pos0, 500);

        //手腕
        go_pos(pos17, 1000);
        go_pos(pos18, 2000);
        go_pos(pos20, 1000);
        go_pos(pos19, 2000);

        go_pos(pos0, 1000);
        go_pos(pos17, 1000);
        go_pos(pos20, 2000);
        go_pos(pos17, 2000);
        go_pos(pos20, 2000);
        go_pos(pos0, 1000);
        go_pos(pos18, 1000);
        go_pos(pos19, 2000);
        go_pos(pos18, 2000);
        go_pos(pos19, 2000);
        go_pos(pos0, 1000);
        rt_thread_mdelay(1000 * 30);

    }
}
void motor_main_loop_entry(void *param)
{
    int i;
    uint32_t print_tick = 0;
    uint32_t loop_cnt = 0;

    rt_kprintf("[MOTOR] 主循环启动 (%d ms)\n", MOTOR_POLL_PERIOD_MS);

    rt_thread_mdelay(1000);

//    while(1)
//    {
//        go_pos(pos0, 2000);
//        go_pos(pos1, 2000);
//    }
    while (1) {
//        /* 1. 读所有电机实时位置 */
//        for (i = 0; i < MC; i++) {
//            if (!g_motor[i].connected) continue;
//            motor_read_position(i, &g_motor[i].pos_actual);
//        }

        /* 2. 写目标（TMC6460 + 因时） */
        for (i = 0; i < MC; i++) {
//            g_motor[i].pos_target += 20000;
            if (!g_motor[i].connected) continue;

            if (motor_configs[i].type == MOTOR_TYPE_TMC6460)
            {
                if (g_motor[i].motion_mode == TMC6460_MODE_VELOCITY) {
                    motor_send_velocity(i, g_motor[i].velocity);
                } else if (g_motor[i].motion_mode == TMC6460_MODE_TORQUE) {
                    motor_send_torque(i, g_motor[i].torque_actual);
                } else if (g_motor[i].motion_mode == TMC6460_MODE_POSITION) {
                    int32_t raw = deg01_to_raw(g_motor[i].pos_target);
                    tmc6460_write_reg_verify(i, TMC6460_REG_PID_POSITION_TARGET, (uint32_t)raw);
                }
            }
            else
            {
                motor_set_position(i, g_motor[i].pos_target);
            }



        }

//        /* 3. 周期性打印位置 */
//        loop_cnt++;
//        if (loop_cnt * MOTOR_POLL_PERIOD_MS >= print_tick + PRINT_INTERVAL_MS) {
//            print_tick = loop_cnt * MOTOR_POLL_PERIOD_MS;
//            rt_kprintf("[POS] ");
//            for (i = 6; i < 7; i++) {
//                if (!g_motor[i].connected) continue;
//                rt_kprintf("%s:%d ", motor_configs[i].name, g_motor[i].pos_actual);
//            }
//            rt_kprintf("\n");
//        }

        rt_thread_mdelay(10);
    }
}

/* ---------- Shell 命令 ---------- */

static void cmd_status(int argc, char **argv)
{
    int i;

    if (argc >= 3) {
        int id = atoi(argv[2]);
        if (id < 0 || id >= MC) {
            rt_kprintf("ID: 0~%d\n", MC - 1);
            return;
        }
        rt_kprintf("--- [%d] %s ---\n", id, motor_configs[id].name);
        rt_kprintf("  类型:     %s\n", motor_configs[id].type == MOTOR_TYPE_TMC6460 ? "TMC6460" : "因时");
        rt_kprintf("  端口:     %d (TCP %d)\n", motor_configs[id].port, motor_configs[id].tcp_port);
        rt_kprintf("  连接:     %s\n", g_motor[id].connected ? "OK" : "断开");
        rt_kprintf("  pos_act:  %d %s\n", g_motor[id].pos_actual,
                   motor_configs[id].type == MOTOR_TYPE_TMC6460 ? "(0.01deg)" : "(step)");
        rt_kprintf("  pos_tgt:  %d %s\n", g_motor[id].pos_target,
                   motor_configs[id].type == MOTOR_TYPE_TMC6460 ? "(0.01deg)" : "(step)");
        rt_kprintf("  torque:   %d %s\n", g_motor[id].torque_actual,
                   motor_configs[id].type == MOTOR_TYPE_TMC6460 ? "mA" : "g");
        rt_kprintf("  limit:    %d %s\n", g_motor[id].torque_limit,
                   motor_configs[id].type == MOTOR_TYPE_TMC6460 ? "mA" : "g");
        rt_kprintf("  velocity: %d RPM\n", g_motor[id].velocity);
        rt_kprintf("  error:    0x%08X\n", g_motor[id].error_flags);
        rt_kprintf("  ack_cnt:  %d\n", g_motor[id].ack_cnt);
        rt_kprintf("  err_cnt:  %d\n", g_motor[id].err_cnt);
        return;
    }

    rt_kprintf("ID  Name     Type     Pos(0.01deg) Torque(mA) Limit(mA) Conn  Err\n");
    rt_kprintf("--- -------- -------- ------------ ---------- --------- -----\n");
    for (i = 0; i < MC; i++) {
        rt_kprintf("%2d  %-8s %-8s %12d %10d %9d   %s   %d\n",
                   i,
                   motor_configs[i].name,
                   motor_configs[i].type == MOTOR_TYPE_TMC6460 ? "TMC6460" : "YINSHI",
                   g_motor[i].pos_actual,
                   g_motor[i].torque_actual,
                   g_motor[i].torque_limit,
                   g_motor[i].connected ? "OK" : "--",
                   g_motor[i].err_cnt);
    }
}

static void cmd_read(int argc, char **argv)
{
    if (argc < 4) {
        rt_kprintf("用法: motor read <id> <reg>\n");
        return;
    }
    int id = atoi(argv[2]);
    uint32_t reg = strtoul(argv[3], RT_NULL, 0);
    uint32_t val;
    int ret = motor_read_reg(id, (uint16_t)reg, &val);
    if (ret == 0) {
        rt_kprintf("[%d] %s 0x%03X = 0x%08X (%d)\n", id, motor_configs[id].name, reg, val, val);
    } else {
        rt_kprintf("[%d] %s read 0x%03X fail (%d)\n", id, motor_configs[id].name, reg, ret);
    }
}

static void cmd_write(int argc, char **argv)
{
    if (argc < 5) {
        rt_kprintf("用法: motor write <id> <reg> <value>\n");
        return;
    }
    int id = atoi(argv[2]);
    uint32_t reg = strtoul(argv[3], RT_NULL, 0);
    uint32_t val = strtoul(argv[4], RT_NULL, 0);
    int ret = motor_write_reg(id, (uint16_t)reg, val);
    if (ret == 0) {
        rt_kprintf("[%d] %s 0x%03X = 0x%08X OK\n", id, motor_configs[id].name, reg, val);
    } else {
        rt_kprintf("[%d] %s write 0x%03X fail (%d)\n", id, motor_configs[id].name, reg, ret);
    }
}

static void cmd_pos(int argc, char **argv)
{
    if (argc < 3) {
        rt_kprintf("用法: motor pos <id>\n");
        return;
    }
    int id = atoi(argv[2]);
    int32_t pos;
    int ret = motor_read_position(id, &pos);
    if (ret == 0) {
        rt_kprintf("[%d] %s pos = %d %s\n", id, motor_configs[id].name, pos,
                   motor_configs[id].type == MOTOR_TYPE_TMC6460 ? "(0.01deg)" : "(step)");
    } else {
        rt_kprintf("[%d] %s pos fail (%d)\n", id, motor_configs[id].name, ret);
    }
}

static void cmd_set_pos(int argc, char **argv)
{
    if (argc < 4) {
        rt_kprintf("用法: motor set_pos <id> <pos(0.01deg)>\n");
        return;
    }
    int id = atoi(argv[2]);
    int32_t pos = atoi(argv[3]);
    int ret = motor_set_position(id, pos);
    rt_kprintf("[%d] %s set_pos=%d %s\n", id, motor_configs[id].name, pos, ret == 0 ? "OK" : "FAIL");
}

static void cmd_set_torque(int argc, char **argv)
{
    if (argc < 4) {
        rt_kprintf("用法: motor set_torque <id> <mA>\n");
        return;
    }
    int id = atoi(argv[2]);
    int16_t torque = (int16_t)atoi(argv[3]);
    int ret = motor_set_torque(id, torque);
    rt_kprintf("[%d] %s torque=%d mA %s\n", id, motor_configs[id].name, torque, ret == 0 ? "OK" : "FAIL");
}

static void cmd_set_velocity(int argc, char **argv)
{
    if (argc < 4) {
        rt_kprintf("用法: motor set_vel <id> <RPM>\n");
        return;
    }
    int id = atoi(argv[2]);
    int32_t vel = atoi(argv[3]);
    int ret = motor_set_velocity(id, vel);
    rt_kprintf("[%d] %s velocity=%d RPM %s\n", id, motor_configs[id].name, vel, ret == 0 ? "OK" : "FAIL");
}

static void cmd_set_limit(int argc, char **argv)
{
    if (argc < 4) {
        rt_kprintf("用法: motor set_limit <id> <mA>\n");
        return;
    }
    int id = atoi(argv[2]);
    uint16_t limit = (uint16_t)atoi(argv[3]);
    int ret = motor_set_torque_limit(id, limit);
    rt_kprintf("[%d] %s limit=%d mA %s\n", id, motor_configs[id].name, limit, ret == 0 ? "OK" : "FAIL");
}

static void cmd_connect(int argc, char **argv)
{
    int fail = motor_connect_all();
    rt_kprintf("连接完成, 失败: %d\n", fail);
}

static void cmd_reconnect(int argc, char **argv)
{
    if (argc < 3) {
        rt_kprintf("用法: motor reconnect <id>\n");
        return;
    }
    int id = atoi(argv[2]);
    int ret = motor_reconnect(id);
    rt_kprintf("[%d] %s reconnect: %s\n", id, motor_configs[id].name, ret == 0 ? "OK" : "FAIL");
}

static void cmd_test(int argc, char **argv)
{
    int i, ret, pass = 0, fail = 0;
    uint32_t val;

    rt_kprintf("[TEST] === 18路通信测试 ===\n");
while(1)
{

    for (i = 6; i < 7; i++) {
        if (!g_motor[i].connected) {
            rt_kprintf("[TEST] %s: 未连接\n", motor_configs[i].name);
            fail++;
            continue;
        }
        uint8_t tx_buf[5] = {0,2,3,4,5};
        uint8_t rx_buf[5];
        tx_buf[0] = i;
        motor_send(i, tx_buf, TMC6460_RD_REQ_LEN);
//
//        tmc6460_write_reg_sync(i, TMC6460_REG_UART_RTMI_CH7, 0x00000001);

        int ret = motor_recv(i, rx_buf, TMC6460_WR_RESP_LEN, 1000);

        rt_kprintf("rx==> 0x%x  %d: %x  %x  %x  %x  %x\n",i, ret, rx_buf[0], rx_buf[1], rx_buf[2], rx_buf[3], rx_buf[4]);

        rt_thread_mdelay(1);  /* 端口间隔 50ms */
    }
}
    rt_kprintf("[TEST] === 结果: %d OK, %d FAIL ===\n", pass, fail);
}

static void cmd_info(int argc, char **argv)
{
    int connected = 0, pos_ok = 0, i;
    for (i = 0; i < MC; i++) {
        if (g_motor[i].connected) connected++;
        if (g_motor[i].pos_read_ok) pos_ok++;
    }
    rt_kprintf("电机总数: %d\n", MC);
    rt_kprintf("已连接:   %d\n", connected);
    rt_kprintf("位置就绪: %d\n", pos_ok);
    rt_kprintf("TMC6460:  MODE=%d POLES=%d LIMIT=%d mA\n",
               TMC6460_MOTION_MODE, TMC6460_N_POLE_PAIRS, TMC6460_DEFAULT_TORQUE_LIMIT);
    rt_kprintf("周期:     %d ms\n", MOTOR_POLL_PERIOD_MS);
}

static void motor_cmd(int argc, char **argv)
{
    if (argc < 2) {
        rt_kprintf("用法: motor <status|read|write|pos|set_pos|set_torque|set_limit|connect|reconnect|info>\n");
        return;
    }

    if (strcmp(argv[1], "test") == 0)            cmd_test(argc, argv);
    else if (strcmp(argv[1], "status") == 0)      cmd_status(argc, argv);
    else if (strcmp(argv[1], "read") == 0)        cmd_read(argc, argv);
    else if (strcmp(argv[1], "write") == 0)       cmd_write(argc, argv);
    else if (strcmp(argv[1], "pos") == 0)         cmd_pos(argc, argv);
    else if (strcmp(argv[1], "set_pos") == 0)     cmd_set_pos(argc, argv);
    else if (strcmp(argv[1], "set_torque") == 0)  cmd_set_torque(argc, argv);
    else if (strcmp(argv[1], "set_vel") == 0)     cmd_set_velocity(argc, argv);
    else if (strcmp(argv[1], "set_limit") == 0)   cmd_set_limit(argc, argv);
    else if (strcmp(argv[1], "connect") == 0)     cmd_connect(argc, argv);
    else if (strcmp(argv[1], "reconnect") == 0)   cmd_reconnect(argc, argv);
    else if (strcmp(argv[1], "info") == 0)        cmd_info(argc, argv);
    else rt_kprintf("未知命令: %s\n", argv[1]);
}

MSH_CMD_EXPORT(motor_cmd, motor control: motor <test|status|read|write|pos|set_pos|set_torque|set_vel|set_limit|connect|reconnect|info>);
