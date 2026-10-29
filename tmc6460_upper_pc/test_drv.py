"""驱动使能诊断"""
import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def read_reg(addr):
    return bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF])

def write_reg(addr, data):
    return bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data)

def read_raw(addr):
    ser.reset_input_buffer()
    ser.write(read_reg(addr))
    return ser.read(10)

def read_val(addr):
    resp = read_raw(addr)
    if len(resp) >= 5:
        return resp[1] << 24 | resp[2] << 16 | resp[3] << 8 | resp[4]
    return None

def write_val(addr, data):
    ser.reset_input_buffer()
    ser.write(write_reg(addr, data))
    time.sleep(0.02)
    return ser.read(10)

def hexstr(b):
    return ' '.join(f'{x:02X}' for x in b)

print("=== 驱动使能诊断 ===")

# 读 GDRV 配置
gdrv = read_val(0x101)
print(f"GDRV (0x101): {hexstr(read_raw(0x101))}")

# 读 MCC_STATUS - 检查 fault
mcc = read_val(0x105)
print(f"MCC_STATUS (0x105): {hexstr(read_raw(0x105))}")

# 读 IO_CTRL
io_ctrl = read_val(0x009)
print(f"IO_CTRL (0x009): {hexstr(read_raw(0x009))}")

# 读 EVENTS
events = read_val(0x00A)
print(f"EVENTS (0x00A): {hexstr(read_raw(0x00A))}")

# 读 FOC.STATUS
foc_status = read_val(0x080)
print(f"FOC.STATUS (0x080): {hexstr(read_raw(0x080))}")

# 读 FOC.EVENTS
foc_events = read_val(0x081)
print(f"FOC.EVENTS (0x081): {hexstr(read_raw(0x081))}")

# 读 DRV_STATUS
drv = read_val(0x082)
print(f"DRV_STATUS (0x082): {hexstr(read_raw(0x082))}")

# 读 PWM 配置
pwm = read_val(0x085)
print(f"PWM_MAXCNT (0x085): {hexstr(read_raw(0x085))}")

pwm_cfg = read_val(0x102)
print(f"PWM_CFG (0x102): {hexstr(read_raw(0x102))}")

# 尝试: 清除所有事件 (W1C)
print("\n=== 清除事件 ===")
print(f"写 EVENTS=0xFFFFFFFF 清除...")
write_val(0x00A, 0xFFFFFFFF)
write_val(0x081, 0xFFFFFFFF)
time.sleep(0.05)

events2 = read_val(0x00A)
print(f"EVENTS 清除后: {hexstr(read_raw(0x00A))}")

# 尝试: 设置力矩模式 (MOTION_MODE=0, 最简单)
print("\n=== 尝试力矩模式 ===")
# MOTION_MODE=0 (TORQUE), N_POLE_PAIRS=7
write_val(0x100, 0x00000007)
print(f"MOTOR_MOTION 写后: {hexstr(read_raw(0x100))}")

# 设置小力矩
print("设置力矩目标=100...")
write_val(0x14E, 0x00000064)  # 力矩=100, 磁通=0
time.sleep(0.2)

print(f"读回 TORQUE_TARGET: {hexstr(read_raw(0x14E))}")
print(f"读回 TORQUE_ACTUAL: {hexstr(read_raw(0x153))}")
print(f"读回 MCC_STATUS:    {hexstr(read_raw(0x105))}")
print(f"读回 DRV_STATUS:    {hexstr(read_raw(0x082))}")

# 清零
print("\n清零力矩目标...")
write_val(0x14E, 0)

ser.close()
print("\n完成")
