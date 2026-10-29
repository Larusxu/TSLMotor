/**
 * @file motor_core.h
 * @brief 电机抽象层接口
 *
 * 所有接口使用用户单位:
 *   - 力矩/力: mA（TMC6460）、g（因时电缸）
 *   - 速度: RPM
 *   - 位置: 0.01°（TMC6460）、步（因时电缸 0~2000）
 *   - 力矩限制: mA
 */
#ifndef __MOTOR_CORE_H
#define __MOTOR_CORE_H

#include <rtthread.h>
#include "motor_config.h"

typedef struct {
    int32_t  pos_actual;        /* 实际位置（用户单位） */
    int32_t  pos_target;        /* 目标位置（用户单位） */
    int16_t  torque_actual;     /* 实际力矩（mA / g） */
    int16_t  flux_actual;       /* 实际磁通（mA） */
    uint16_t torque_limit;      /* 力矩限制（mA） */
    int32_t  velocity;          /* 实际速度（RPM） */
    uint32_t error_flags;       /* 错误标志 */
    uint32_t ack_cnt;           /* 应答计数 */
    uint32_t err_cnt;           /* 错误计数 */
    uint8_t  connected;         /* 1=通信正常 */
    uint8_t  pos_read_ok;       /* 1=位置已读到 */
    uint8_t  motion_mode;       /* 当前运动模式（可运行时切换） */
    int32_t  pos_zero;          /* 机械零点位置 */
    int32_t  pos_offset;        /* 手指零点到机械零点偏移 */
} motor_data_t;

extern motor_data_t g_motor[MC];

/* 连接管理 */
int motor_connect_all(void);
int motor_reconnect(uint8_t id);

/* 初始化 */
int motor_init_all(void);

/* 运行时接口（用户单位） */
int motor_set_torque(uint8_t id, int16_t torque_ma);        /* 设置目标力矩（mA） */
int motor_set_torque_limit(uint8_t id, uint16_t limit_ma);  /* 设置力矩限制（mA） */
int motor_set_velocity(uint8_t id, int32_t vel_rpm);        /* 设置目标速度（RPM） */
int motor_read_position(uint8_t id, int32_t *pos);           /* 读实际位置（0.01°） */
int motor_set_position(uint8_t id, int32_t pos);             /* 写目标位置（0.01°） */
int motor_read_velocity(uint8_t id, int32_t *vel);           /* 读实际速度（RPM） */
int motor_read_torque(uint8_t id, int16_t *torque);          /* 读实际力矩（mA） */

/* 主循环发送函数（不等响应，快速发送） */
int motor_send_position(uint8_t id, int32_t pos_deg01);     /* 发送位置目标（0.01°） */
int motor_send_velocity(uint8_t id, int32_t vel_rpm);       /* 发送速度目标（RPM） */
int motor_send_torque(uint8_t id, int16_t torque_ma);       /* 发送力矩目标（mA） */

/* 寄存器直接操作（原始值，不经换算） */
int motor_read_reg(uint8_t id, uint16_t reg, uint32_t *value);
int motor_write_reg(uint8_t id, uint16_t reg, uint32_t value);

/* 主循环入口 */
void motor_main_loop_entry(void *param);

#endif /* __MOTOR_CORE_H */
