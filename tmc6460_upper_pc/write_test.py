import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    time.sleep(0.05)
    d = ser.read(5)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    d = ser.read(5)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

print('=== 写入能力测试 ===')

# 0. 当前
print(f'GDRV={r(0x101)}')

# 1. 写 DRV_EN_BIT=1 (只改低16位)
print(f'\n写 0x101=0x00010000 (只开DRV_EN)...')
print(f'  写响应: {w(0x101, 0x00010000)}')
print(f'  读回: {r(0x101)}')

# 2. 读 VERSION 确认芯片在工作
print(f'\nVERSION={r(0x000)}')

# 3. 写 PWM 寄存器 (0x102) 测试其他寄存器写入
print(f'\n写 PWM(0x102)=0x00000017 (default)...')
print(f'  写响应: {w(0x102, 0x00000017)}')
print(f'  读回: {r(0x102)}')

# 4. 写 MCC_STATUS bit (应该写不进去，只读)
print(f'\nMCC_STATUS(0x105)={r(0x105)}')
print(f'写0x105=0x00000000... 写响应: {w(0x105, 0)}')
print(f'读回: {r(0x105)}')

ser.close()
