"""清除故障并测试"""
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

print("=== 清除 MCC_STATUS 故障 ===")
# W1C: 写1清除
# bit0=SHRT2G_CH1, bit6=OVERTEMP_CH1
# 清除这两个: 写 0x00000041
print(f"清除前 MCC_STATUS: {hexstr(read_raw(0x105))}")

write_val(0x105, 0x00000041)
time.sleep(0.05)
print(f"清除后 MCC_STATUS: {hexstr(read_raw(0x105))}")

# 也清除 EVENTS
write_val(0x00A, 0xFFFFFFFF)
time.sleep(0.05)
print(f"EVENTS: {hexstr(read_raw(0x00A))}")

# 尝试设置力矩模式 + 小力矩
print("\n=== 力矩模式测试 ===")
# MOTION_MODE=0 (TORQUE), POLES=7
write_val(0x100, 0x00000007)
print(f"MOTOR_MOTION: {hexstr(read_raw(0x100))}")

# 力矩限制
write_val(0x14A, 0x00640000)  # torque_limit=100, flux_limit=0
print(f"TF_LIMITS: {hexstr(read_raw(0x14A))}")

# 小力矩目标
write_val(0x14E, 0x00000032)  # torque=50, flux=0
print(f"TF_TARGET: {hexstr(read_raw(0x14E))}")

# 等一下看电机有没有反应
time.sleep(1.0)

print(f"\n1秒后:")
print(f"  MCC_STATUS:    {hexstr(read_raw(0x105))}")
print(f"  TORQUE_ACTUAL: {hexstr(read_raw(0x153))}")
print(f"  VEL_ACTUAL:    {hexstr(read_raw(0x154))}")
print(f"  POS_ACTUAL:    {hexstr(read_raw(0x155))}")

# 清零
write_val(0x14E, 0)
print("\n力矩已清零")

ser.close()
print("完成")
