import serial, struct, time
ser = serial.Serial('COM6', 115200, timeout=0.5)

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF]))
    time.sleep(0.03)
    d = ser.read(5)
    return d

def hs(d):
    return ' '.join(f'{b:02X}' for b in d)

# 读一堆寄存器, 看上位字节模式
print('=== 原始响应 dump ===')
for addr in [0x000, 0x006, 0x009, 0x100, 0x101, 0x102, 0x105, 0x140, 0x14A, 0x14E, 0x153, 0x154, 0x155, 0x1D0, 0x1D1, 0x250]:
    d = r(addr)
    print(f'  0x{addr:03X}: {hs(d)} ({len(d)}B)')

# 写一个值到 0x1D0 (RAMPER.POSITION) 看能否写入
import struct
def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.03)
    ser.read(4)

# 写 0x1D1 = 0x12345678
print('\n写 0x1D1=0x12345678:')
w(0x1D1, 0x12345678)
print(f'读回 0x1D1: {hs(r(0x1D1))}')

# 写 0x100 = 0xFFFFFFFF
print('\n写 0x100=0xFFFFFFFF:')
w(0x100, 0xFFFFFFFF)
print(f'读回 0x100: {hs(r(0x100))}')

# 写 0x100 = 0x00000000
w(0x100, 0)
ser.close()
print('\ndone')
