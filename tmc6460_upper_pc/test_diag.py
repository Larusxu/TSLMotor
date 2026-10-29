"""诊断数据字节序问题"""
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

# 读 VERSION 原始响应
print("=== 原始响应 ===")
print(f"  读 0x000: {hexstr(read_raw(0x000))}")
print(f"  读 0x100: {hexstr(read_raw(0x100))}")
print(f"  读 0x155: {hexstr(read_raw(0x155))}")

# 写测试: 写 0x100 = 0x12345678, 看读回来是什么
print("\n=== 写 0x100 = 0x12345678 ===")
wr = write_val(0x100, 0x12345678)
print(f"  写响应: {hexstr(wr)}")
time.sleep(0.05)
r = read_raw(0x100)
print(f"  读回:   {hexstr(r)}")

# 写 0x100 = 0xAA55AA55
print("\n=== 写 0x100 = 0xAA55AA55 ===")
wr = write_val(0x100, 0xAA55AA55)
print(f"  写响应: {hexstr(wr)}")
time.sleep(0.05)
r = read_raw(0x100)
print(f"  读回:   {hexstr(r)}")

# 写 0x100 = 0x00000000
print("\n=== 写 0x100 = 0x00000000 ===")
wr = write_val(0x100, 0x00000000)
print(f"  写响应: {hexstr(wr)}")
time.sleep(0.05)
r = read_raw(0x100)
print(f"  读回:   {hexstr(r)}")

# 恢复原始值
print("\n=== 恢复 0x100 = 0x00000407 ===")
wr = write_val(0x100, 0x00000407)
print(f"  写响应: {hexstr(wr)}")
time.sleep(0.05)
r = read_raw(0x100)
print(f"  读回:   {hexstr(r)}")

ser.close()
print("\n完成")
