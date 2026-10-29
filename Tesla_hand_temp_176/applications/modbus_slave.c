/**
 * @file modbus_slave.c
 * @brief Modbus RTU 从机 - 用于上位机设置电机位置
 *
 * 寄存器映射（Holding Registers, 功能码 0x03/0x06/0x10）：
 *   地址 0~17:  18个电机目标位置（0.01°，可读写）
 *   地址 18~35: 18个电机实际位置（0.01°，只读）
 *   地址 36~53: 18个电机力矩（mA/g，只读）
 *   地址 54~71: 18个电机速度（RPM，只读）
 *
 * 从机地址：1（默认）
 * 波特率：115200, 8N1
 */
#include <rtthread.h>
#include <modbus.h>
#include "motor_core.h"
#include "motor_config.h"

#define MODBUS_SLAVE_ID         1
#define MODBUS_BAUDRATE         115200
#define MODBUS_RS485_RTS_PIN    57      /* RS485 收发控制引脚，根据实际硬件修改 */

/* 寄存器地址定义 */
#define REG_TARGET_POS_START    0       /* 目标位置起始地址 (0~18) */
#define REG_ACTUAL_POS_START    19      /* 实际位置起始地址 (19~37) */
#define REG_TORQUE_START        38      /* 力矩起始地址 (37~53) */
#define REG_VELOCITY_START      57      /* 速度起始地址 (54~71) */
#define REG_TOTAL_COUNT         76      /* 寄存器总数 */

/* 寄存器存储 */
static uint16_t reg_table[REG_TOTAL_COUNT];

/* Modbus 线程 */
static rt_thread_t modbus_thread = RT_NULL;
static modbus_t *mb_ctx = RT_NULL;
static modbus_mapping_t *mb_mapping = RT_NULL;

static volatile uint8_t mb_running = 0;

/**
 * @brief 同步电机数据到寄存器表
 * 从 g_motor 读取实际值，写入寄存器
 */
static void sync_motor_to_regs(void)
{
    int i;

    for (i = 0; i < MC; i++) {
        /* 目标位置：从 g_motor 读取 */
//        reg_table[REG_TARGET_POS_START + i] = (uint16_t)(g_motor[i].pos_target & 0xFFFF);

        /* 实际位置：从 g_motor 读取 */
        reg_table[REG_ACTUAL_POS_START + i] = (uint16_t)(g_motor[i].pos_actual & 0xFFFF);

        /* 力矩：从 g_motor 读取 */
        reg_table[REG_TORQUE_START + i] = (uint16_t)(g_motor[i].torque_actual & 0xFFFF);

        /* 速度：从 g_motor 读取 */
        reg_table[REG_VELOCITY_START + i] = (uint16_t)(g_motor[i].velocity & 0xFFFF);
    }
}

/**
 * @brief 从寄存器表同步到电机目标
 * 检查目标位置寄存器是否被上位机修改，更新 g_motor
 */
static void sync_regs_to_motor(void)
{
    int i;

    for (i = 0; i < MC; i++) {

        /* 检查目标位置是否被修改 */
        int32_t new_target = (int16_t)reg_table[REG_TARGET_POS_START + i];  /* 有符号扩展 */



//
//            if(new_target < 0 && i < 14)
//            {
//                new_target = 0;
//            }

            g_motor[i].pos_target = new_target * motor_configs[i].ratio + g_motor[i].pos_zero + g_motor[i].pos_offset;

//            rt_kprintf("%d ", g_motor[i].pos_target);
//            rt_kprintf("[MODBUS] motor %d target -> %d (0.01deg)\n", i, new_target);

    }
//    rt_kprintf("\n");
}

/**
 * @brief Modbus 从机线程
 */
static void modbus_slave_thread(void *param)
{
    uint8_t query[MODBUS_RTU_MAX_ADU_LENGTH];
    int rc;

    rt_kprintf("[MODBUS] 从机线程启动\n");

    while (mb_running) {
        /* 等待请求 */
        rc = modbus_receive(mb_ctx, query);

        if (rc > 0) {
            /* 先把当前寄存器复制到 mapping（读请求需要最新数据） */
            int i;
            for (i = 0; i < REG_TOTAL_COUNT; i++) {
                mb_mapping->tab_registers[i] = reg_table[i];
            }

            /* 处理请求（写请求会修改 mb_mapping->tab_registers） */
            modbus_reply(mb_ctx, query, rc, mb_mapping);

            /* 从 mapping 复制回 reg_table（获取上位机写入的新值） */
            for (i = 0; i < REG_TOTAL_COUNT; i++) {
                reg_table[i] = mb_mapping->tab_registers[i];
            }

            /* 同步：寄存器 -> 电机目标 */
            sync_regs_to_motor();

            /* 同步：电机状态 -> 寄存器 */
            sync_motor_to_regs();
        } else if (rc == -1) {
            /* 错误处理 */
            rt_thread_mdelay(10);
        }
    }
}

/**
 * @brief 初始化 Modbus 从机
 */
static int modbus_slave_init(void)
{
    int i;

    rt_kprintf("[MODBUS] 初始化从机...\n");

    /* 创建 Modbus 上下文 */
    mb_ctx = modbus_new_rtu("/dev/uart5", MODBUS_BAUDRATE, 'N', 8, 1);
    if (mb_ctx == NULL) {
        rt_kprintf("[MODBUS] 创建上下文失败\n");
        return -1;
    }

    /* 设置从机地址 */
    modbus_set_slave(mb_ctx, MODBUS_SLAVE_ID);

    /* 设置响应超时 */
    modbus_set_response_timeout(mb_ctx, 1, 0);

    /* RS485 模式 */
    modbus_rtu_set_serial_mode(mb_ctx, MODBUS_RTU_RS485);
    modbus_rtu_set_rts(mb_ctx, MODBUS_RS485_RTS_PIN, MODBUS_RTU_RTS_UP);

    /* 连接 */
    if (modbus_connect(mb_ctx) == -1) {
        rt_kprintf("[MODBUS] 连接失败\n");
        modbus_free(mb_ctx);
        mb_ctx = NULL;
        return -1;
    }

    /* 创建寄存器映射 */
    mb_mapping = modbus_mapping_new(0, 0, REG_TOTAL_COUNT, 0);
    if (mb_mapping == NULL) {
        rt_kprintf("[MODBUS] 创建映射失败\n");
        modbus_close(mb_ctx);
        modbus_free(mb_ctx);
        mb_ctx = NULL;
        return -1;
    }

    /* 初始化寄存器 */
    memset(reg_table, 0, sizeof(reg_table));

    /* 同步当前电机状态到寄存器 */
    sync_motor_to_regs();

    /* 启动线程 */
    mb_running = 1;
    modbus_thread = rt_thread_create("modbus_sl",
                                     modbus_slave_thread,
                                     RT_NULL,
                                     4096,
                                     25,     /* 优先级低于主循环 */
                                     10);
    if (modbus_thread != RT_NULL) {
        rt_thread_startup(modbus_thread);
        rt_kprintf("[MODBUS] 从机启动成功 (ID=%d, baud=%d)\n",
                   MODBUS_SLAVE_ID, MODBUS_BAUDRATE);
    } else {
        rt_kprintf("[MODBUS] 线程创建失败\n");
        modbus_mapping_free(mb_mapping);
        modbus_close(mb_ctx);
        modbus_free(mb_ctx);
        mb_ctx = NULL;
        return -1;
    }

    return 0;
}

/**
 * @brief 停止 Modbus 从机
 */
static void modbus_slave_stop(void)
{
    mb_running = 0;
    rt_thread_mdelay(500);

    if (mb_mapping != NULL) {
        modbus_mapping_free(mb_mapping);
        mb_mapping = NULL;
    }
    if (mb_ctx != NULL) {
        modbus_close(mb_ctx);
        modbus_free(mb_ctx);
        mb_ctx = NULL;
    }
    rt_kprintf("[MODBUS] 从机已停止\n");
}

/* Shell 命令 */
static void cmd_modbus(int argc, char **argv)
{
    if (argc < 2) {
        rt_kprintf("用法: modbus <start|stop|status|regs>\n");
        return;
    }

    if (strcmp(argv[1], "start") == 0) {
        if (mb_running) {
            rt_kprintf("[MODBUS] 已在运行\n");
        } else {
            modbus_slave_init();
        }
    } else if (strcmp(argv[1], "stop") == 0) {
        modbus_slave_stop();
    } else if (strcmp(argv[1], "status") == 0) {
        rt_kprintf("[MODBUS] 状态: %s\n", mb_running ? "运行中" : "已停止");
        if (mb_running) {
            rt_kprintf("[MODBUS] ID=%d, baud=%d, 寄存器=%d\n",
                       MODBUS_SLAVE_ID, MODBUS_BAUDRATE, REG_TOTAL_COUNT);
        }
    } else if (strcmp(argv[1], "regs") == 0) {
        sync_motor_to_regs();
        rt_kprintf("[MODBUS] 寄存器表:\n");
        rt_kprintf("  目标位置 (0~17):  ");
        for (int i = 0; i < MC; i++) {
            rt_kprintf("%d ", (int16_t)reg_table[REG_TARGET_POS_START + i]);
        }
        rt_kprintf("\n  实际位置 (18~35): ");
        for (int i = 0; i < MC; i++) {
            rt_kprintf("%d ", (int16_t)reg_table[REG_ACTUAL_POS_START + i]);
        }
        rt_kprintf("\n  力矩 (36~53):     ");
        for (int i = 0; i < MC; i++) {
            rt_kprintf("%d ", (int16_t)reg_table[REG_TORQUE_START + i]);
        }
        rt_kprintf("\n  速度 (54~71):     ");
        for (int i = 0; i < MC; i++) {
            rt_kprintf("%d ", (int16_t)reg_table[REG_VELOCITY_START + i]);
        }
        rt_kprintf("\n");
    } else {
        rt_kprintf("未知命令: %s\n", argv[1]);
    }
}

MSH_CMD_EXPORT(cmd_modbus, modbus slave: modbus <start|stop|status|regs>);

/* 自动初始化 */
//INIT_APP_EXPORT(modbus_slave_init);

void get_pos(void)
{

//    uint16_t pos0[18] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
    rt_kprintf("uint16_t pos0[MC] = {%d",(int16_t)reg_table[REG_TARGET_POS_START + 0]);
    for(uint16_t i = 1; i < MC; i++)
    {
        rt_kprintf(", %d", (int16_t)reg_table[REG_TARGET_POS_START + i]);
    }
    rt_kprintf("};\n");
}
MSH_CMD_EXPORT(get_pos, get_pos);
