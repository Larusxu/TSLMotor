"""
EEPROM I2C 测试程序
步骤:
  1. I2C_INIT_OD 初始化 I2C（开漏模式）
  2. I2C_WRITE 在地址 0x00 写入 0xAA55
  3. I2C_READ 从地址 0x00 读取
每步打印 raw 寄存器日志。
"""

import sys
import time
from tmc6460_protocol import (
    TMC6460Serial,
    IO_CONTROLLER_CONTROL,
    IO_CONTROLLER_COMMAND,
    IO_CONTROLLER_RESPONSE0,
    IO_CONTROLLER_RESPONSE1,
    IO_CONTROLLER_RESPONSE2,
    IO_CONTROLLER_RESPONSE3,
    make_write_request,
    make_read_request,
)


def raw_read(tmc, addr, label=""):
    """读寄存器并打印 raw 日志 + 请求帧 + 返回帧"""
    req = make_read_request(addr)
    req_hex = ' '.join(f'{b:02X}' for b in req)
    # 直接操作串口拿原始返回字节
    with tmc.lock:
        tmc.ser.reset_input_buffer()
        time.sleep(0.001)
        tmc.ser.reset_input_buffer()
        tmc.ser.write(req)
        resp = tmc.ser.read(6)
    resp_hex = ' '.join(f'{b:02X}' for b in resp)
    val = None
    if len(resp) >= 6:
        val = int.from_bytes(resp[2:6], byteorder='big')
    print(f"  [RD] 0x{addr:03X}  请求: [{req_hex}]  返回: [{resp_hex}] ({len(resp)}字节) → 0x{val:08X}" if val is not None else f"  [RD] 0x{addr:03X}  请求: [{req_hex}]  返回: [{resp_hex}] ({len(resp)}字节) 失败" + (f"  ({label})" if label else ""))
    return val


def raw_write(tmc, addr, val, label=""):
    """写寄存器并打印 raw 日志 + 原始帧"""
    frame = make_write_request(addr, val)
    hex_str = ' '.join(f'{b:02X}' for b in frame)
    print(f"  [WR] 0x{addr:03X} ← 0x{val:08X}  帧: [{hex_str}]  {'OK' if True else 'FAIL'}" + (f"  ({label})" if label else ""))
    ok = tmc.write_register(addr, val)
    return ok


def io_cmd_with_log(tmc, cmd, label="", timeout=0.5):
    """发送 IO Controller 命令，带详细 raw 日志"""
    print(f"\n--- {label} ---")
    print(f"  CMD = 0x{cmd:08X}")

    # 1. 写 RESPONSE_0 = 0 确保 COMMAND != RESPONSE_0
    raw_write(tmc, IO_CONTROLLER_RESPONSE0, 0x00000000, "clear RESP0")
    time.sleep(0.005)

    # 2. 读回确认
    resp0_before = raw_read(tmc, IO_CONTROLLER_RESPONSE0, "RESP0 before cmd")

    # 3. 写命令
    frame = make_write_request(IO_CONTROLLER_COMMAND, cmd)
    hex_str = ' '.join(f'{b:02X}' for b in frame)
    print(f"  [WR] 0x{IO_CONTROLLER_COMMAND:03X} ← 0x{cmd:08X}  帧: [{hex_str}]")
    ok = tmc.write_register(IO_CONTROLLER_COMMAND, cmd)
    print(f"  {'OK' if ok else 'FAIL'}")
    if not ok:
        print(f"  !! write_register 失败")
        return False

    # 4. 读回 COMMAND 确认
    cmd_rb = raw_read(tmc, IO_CONTROLLER_COMMAND, "CMD readback")

    # 5. 轮询 RESPONSE_0
    deadline = time.time() + timeout
    poll_count = 0
    while time.time() < deadline:
        resp0 = tmc.read_register(IO_CONTROLLER_RESPONSE0)
        poll_count += 1
        if resp0 == cmd:
            print(f"  [POLL] RESP0=0x{resp0:08X} == CMD  (第{poll_count}次轮询, 命令完成)")
            # 读所有 RESPONSE 寄存器
            r1 = raw_read(tmc, IO_CONTROLLER_RESPONSE1, "RESP1")
            r2 = raw_read(tmc, IO_CONTROLLER_RESPONSE2, "RESP2")
            r3 = raw_read(tmc, IO_CONTROLLER_RESPONSE3, "RESP3")
            return True
        time.sleep(0.01)

    # 超时
    resp0 = tmc.read_register(IO_CONTROLLER_RESPONSE0)
    print(f"  [POLL] 超时! RESP0=0x{resp0:08X} (期望 0x{cmd:08X}), 共{poll_count}次轮询")
    return False


def main():
    # 连接
    port = "COM3"  # 改为实际端口
    if len(sys.argv) > 1:
        port = sys.argv[1]

    tmc = TMC6460Serial(port=port, baudrate=115200, timeout=0.05)
    print(f"连接 {port}...")
    if not tmc.connect():
        print("连接失败!")
        return
    print("连接成功\n")

    try:
        # ========== Step 0: 读取初始状态 ==========
        print("=" * 60)
        print("Step 0: 读取 IO Controller 初始状态")
        print("=" * 60)
        raw_read(tmc, IO_CONTROLLER_CONTROL, "CONTROL")
        raw_read(tmc, IO_CONTROLLER_COMMAND, "COMMAND")
        raw_read(tmc, IO_CONTROLLER_RESPONSE0, "RESP0")
        raw_read(tmc, IO_CONTROLLER_RESPONSE1, "RESP1")

        # ========== Step 1: 配置 IO_MATRIX (HALL_U=SDA, HALL_V=SCL) ==========
        print("\n" + "=" * 60)
        print("Step 1: 配置 IO_MATRIX (HALL_U=SDA, HALL_V=SCL)")
        print("=" * 60)
        io_val = raw_read(tmc, 0x006, "IO_MATRIX 当前值")
        # bits[11:9]=PIN_HALL_V=3(SCL), bits[8:6]=PIN_HALL_U=3(SDA)
        hall_mask = (0x7 << 9) | (0x7 << 6)
        hall_val = (3 << 9) | (3 << 6)
        new_io = (io_val & ~hall_mask) | hall_val
        raw_write(tmc, 0x006, new_io, "IO_MATRIX 写入")
        io_check = raw_read(tmc, 0x006, "IO_MATRIX 读回验证")

        # ========== Step 2: I2C_INIT_OD ==========
        print("\n" + "=" * 60)
        print("Step 2: I2C_INIT_OD (开漏模式, 100kHz)")
        print("=" * 60)
        # yyyy = 0x0095 -> fI2C = 60MHz/4/(0x95+1) = 100kHz
        # I2C_INIT_OD = 0xAA02yyyy
        i2c_cmd = 0xAA020000 | 0x0095
        ok = io_cmd_with_log(tmc, i2c_cmd, "I2C_INIT_OD")
        if not ok:
            print("\n!! I2C_INIT_OD 失败，停止")
            return

        # ========== Step 3: I2C_WRITE ==========
        print("\n" + "=" * 60)
        print("Step 3: I2C_WRITE 0x0000 到 addr=0x000")
        print("=" * 60)
        adr = 0
        data = 0x1011
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0xA << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x000 data=0x1011")
        time.sleep(0.1)
        
        adr = 2
        data = 0x2012
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0xB << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x002 data=0x2012")
        time.sleep(0.1)
        
        adr = 4
        data = 0x3031
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0xC << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x004 data=0x3031")
        time.sleep(0.1)
        
        adr = 6
        data = 0x4041
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0xD << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x006 data=0x4041")
        time.sleep(0.1)
        
        adr = 8
        data = 0x5051
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0xE << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x008 data=0x5051")
        time.sleep(0.1)
        
        adr = 10
        data = 0x6061
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0xF << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x00A data=0x6061")
        time.sleep(0.1)
        
        adr = 12
        data = 0x7071
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0x8 << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x00C data=0x7071")
        time.sleep(0.1)
        
        adr = 14
        data = 0x8081
        cmd = 0xE0000000 | (adr << 24) | ((data & 0xff) << 16) | (0x5 << 8) | (data >> 8 & 0xff)
        print(f"  CMD = 0x{cmd:08X}")
        #io_cmd_with_log(tmc, cmd, "I2C_WRITE addr=0x00E data=0x8081")
        time.sleep(0.1)
          
        # ========== Step 4: I2C_READ ==========
        print("\n" + "=" * 60)
        print("Step 4: I2C_READ")
        print("=" * 60)
        for addr in [0x000, 0x200, 0x400, 0x600, 0x800, 0xA00, 0xC00, 0xE00]:
            cmd = 0xD0000000 | (addr << 16)
            print(f"  读 addr=0x{addr:03X}: CMD = 0x{cmd:08X}")
            io_cmd_with_log(tmc, cmd, f"I2C_READ addr=0x{addr:03X}")
            time.sleep(0.1)

        # ========== Step 5: 测试 I2C_READ 高地址 ==========
        print("\n" + "=" * 60)
        print("Step 5: 测试 I2C_READ 高地址 (yyy 各 bit 作用)")
        print("=" * 60)
        # 先写个标记到 addr 0x00 确认读取正常
        io_cmd_with_log(tmc, 0xE000AA55, "I2C_WRITE[0]=0xAA55")
        time.sleep(0.05)
        io_cmd_with_log(tmc, 0xD0000000, "I2C_READ[0] 确认")
        time.sleep(0.05)

        # 测试不同 yyy 值对读取结果的影响
        print("\n--- 测试 yyy 不同 bit 组合 ---")
        test_yyy = [0x000, 0x001, 0x002, 0x003, 0x010, 0x020, 0x040, 0x080,
                     0x100, 0x200, 0x400, 0x011, 0x021, 0x101, 0x110]
        for yyy in test_yyy:
            cmd = 0xD0000000 | (yyy << 16)
            io_cmd_with_log(tmc, cmd, f"I2C_READ yyy=0x{yyy:03X}")
            time.sleep(0.05)

        # ========== Step 6: I2C_EEPROM + 延时 + RAM_READ ==========
        print("\n" + "=" * 60)
        print("Step 6: I2C_EEPROM + 5s 等待 + RAM_READ")
        print("=" * 60)

        # 6a. I2C_EEPROM
        io_cmd_with_log(tmc, 0xAA030000, "I2C_EEPROM", timeout=2.0)

        # 6b. 等 5 秒让 EEPROM 完成
        print("  等待 5 秒...")
        time.sleep(5.0)

        # 6c. 读状态
        print("\n--- I2C_EEPROM +5s 后状态 ---")
        raw_read(tmc, IO_CONTROLLER_CONTROL, "CONTROL")
        raw_read(tmc, IO_CONTROLLER_COMMAND, "COMMAND")
        raw_read(tmc, IO_CONTROLLER_RESPONSE0, "RESP0")
        raw_read(tmc, IO_CONTROLLER_RESPONSE1, "RESP1")

        # 6d. RAM_READ
        print("\n--- RAM_READ[0] ---")
        io_cmd_with_log(tmc, 0xC0000000, "RAM_READ[0]", timeout=2.0)

        # 6e. 再试一次：先 idle 再 RAM_READ
        print("\n--- idle → RAM_READ[0] ---")
        io_cmd_with_log(tmc, 0x00000000, "idle")
        time.sleep(0.1)
        io_cmd_with_log(tmc, 0xC0000000, "RAM_READ[0] (after idle)", timeout=2.0)

    finally:
        tmc.disconnect()
        print("\n断开连接")


if __name__ == "__main__":
    main()
