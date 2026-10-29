/**
 * @file main.c
 * @brief 特斯拉手临时主控程序
 *
 * 系统架构：
 *   睿擎派 (RC-Pi-3506, RT-Thread) → 以太网 → ZQWL-EthRS-L24 → 18 电机
 *
 * 启动流程：
 *   1. 建连 → 2. 配置 MOTION_MODE/N_POLE_PAIRS → 3. 读初始位置 → 4. 写力矩限制
 *   5. 进入主循环，每 20ms 设置目标力矩
 */
#include <rtthread.h>
#include "motor_core.h"

#define INIT_THREAD_STACK_SIZE  4096
#define INIT_THREAD_PRIORITY    15
#define MAIN_THREAD_STACK_SIZE  2048
#define MAIN_THREAD_PRIORITY    15

static rt_thread_t main_thread = RT_NULL;

static void init_thread_entry(void *param)
{
    /* 等待网络就绪 */
    rt_kprintf("[MAIN] 等待网络...\n");
    rt_thread_mdelay(3000);

    /* 初始化所有电机 */
    motor_init_all();

    /* 启动主循环 */
    void motor_pos_test(void *param);
    main_thread = rt_thread_create("motor_loop",
            motor_pos_test,
                                   RT_NULL,
                                   MAIN_THREAD_STACK_SIZE,
                                   MAIN_THREAD_PRIORITY,
                                   10);
    if (main_thread != RT_NULL) {
        rt_thread_startup(main_thread);
    } else {
        rt_kprintf("[MAIN] 主循环线程创建失败!\n");
    }

    motor_main_loop_entry(RT_NULL);

}

int main(void)
{
    rt_kprintf("\n");
    rt_kprintf("========================================\n");
    rt_kprintf("  特斯拉手临时主控 v1.0\n");
    rt_kprintf("  14x TMC6460 + 4x 因时电缸\n");
    rt_kprintf("  周期: %d ms\n", MOTOR_POLL_PERIOD_MS);
    rt_kprintf("========================================\n");
    rt_kprintf("\n");
    int msh_exec(char *, rt_size_t);
    msh_exec("telnet_server", 13);
    msh_exec("ifconfig e0 192.168.1.100 192.168.1.1 255.255.255.0", 51);
    rt_thread_mdelay(1000);
    msh_exec("ifconfig e1 192.168.1.101 192.168.1.1 255.255.255.0", 51);
    rt_thread_t init = rt_thread_create("motor_init",
                                        init_thread_entry,
                                        RT_NULL,
                                        INIT_THREAD_STACK_SIZE,
                                        INIT_THREAD_PRIORITY,
                                        10);
    if (init != RT_NULL) {
        rt_thread_startup(init);
    } else {
        rt_kprintf("[MAIN] 初始化线程创建失败!\n");
        return -1;
    }

    return 0;
}
