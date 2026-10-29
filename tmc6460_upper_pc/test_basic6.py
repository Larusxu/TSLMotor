import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    time.sleep(0.05)
    return ser.read(6)

def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    return ser.read(6)

def show(raw):
    return f'len={len(raw)} ' + ' '.join(f'{b:02X}' for b in raw)

print('=== 纯串口, 无RTS ===\n')

# 读 GDRV
print(f'GDRV: {show(r(0x101))}')

# 读 VERSION 验证
print(f'VERSION: {show(r(0x000))}')

# 读 PWM
print(f'PWM: {show(r(0x102))}')

# 写 GDRV 全默认
print(f'\n写 0x101=0x81003431...')
wresp = w(0x101, 0x81003431)
print(f'写响应: {show(wresp)}')
time.sleep(0.1)
print(f'GDRV: {show(r(0x101))}')

# 再读一次
print(f'GDRV(再): {show(r(0x101))}')

ser.close()
