import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def hexstr(b):
    return ' '.join(f'{x:02X}' for x in b)

# pytrinamic 5字节格式: [addr] [data_big_endian_4bytes]
def read5(addr):
    """5字节格式读"""
    ser.reset_input_buffer()
    ser.write(struct.pack('>BI', addr, 0))
    time.sleep(0.05)
    return ser.read(5)

def write5(addr, data):
    """5字节格式写"""
    ser.reset_input_buffer()
    ser.write(struct.pack('>BI', addr, data & 0xFFFFFFFF))
    time.sleep(0.05)
    return ser.read(5)

# TMC6460 datagram 格式 (我们原来的)
def read_datagram(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF]))
    time.sleep(0.05)
    return ser.read(10)

def write_datagram(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    return ser.read(10)

print("=== 对比两种协议 ===\n")

# 1. 读 VERSION (0x000) - datagram 格式
print("datagram 读 0x000:")
r = read_datagram(0x000)
print(f"  {hexstr(r)} ({len(r)}B)")

# 2. 读 VERSION (0x000) - 5字节格式
print("5字节 读 0x000:")
r = read5(0x000)
print(f"  {hexstr(r)} ({len(r)}B)")

# 3. 尝试读 0x100 - 两种格式
print("\ndatagram 读 0x100:")
r = read_datagram(0x100)
print(f"  {hexstr(r)} ({len(r)}B)")

print("5字节 读 0x100:")
r = read5(0x100)
print(f"  {hexstr(r)} ({len(r)}B)")

# 4. 5字节格式写 0x100=0x00000587 (TORQUE, BLDC, 7poles)
print("\n5字节 写 0x100=0x00000587:")
r = write5(0x100, 0x00000587)
print(f"  响应: {hexstr(r)} ({len(r)}B)")
time.sleep(0.05)
r = read5(0x100)
print(f"  读回: {hexstr(r)} ({len(r)}B)")

# 5. 5字节格式写力矩目标
print("\n5字节 写 0x14E=0x00640000 (torque=100):")
r = write5(0x14E, 0x00640000)
print(f"  响应: {hexstr(r)} ({len(r)}B)")

# 等一下看实际值
time.sleep(0.5)
r = read5(0x153)
print(f"  TF_ACTUAL: {hexstr(r)} ({len(r)}B)")
r = read5(0x154)
print(f"  VEL_ACTUAL: {hexstr(r)} ({len(r)}B)")
r = read5(0x155)
print(f"  POS_ACTUAL: {hexstr(r)} ({len(r)}B)")

# 清零
write5(0x14E, 0)
write5(0x100, 0)
ser.close()
print("\ndone")
