import serial, struct, time

# 尝试 RTS 控制 485 方向
ser = serial.Serial('COM6', 115200, timeout=0.3)
ser.rts = True  # 先拉高发送方向

def r(addr):
    ser.rts = True
    time.sleep(0.001)
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    ser.flush()
    ser.rts = False  # 切换到接收
    time.sleep(0.05)
    d = ser.read(6)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

def w(addr, data):
    ser.rts = True
    time.sleep(0.001)
    ser.reset_input_buffer()
    cmd = bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data)
    print(f'  TX[{len(cmd)}]: {" ".join(f"{b:02X}" for b in cmd)}')
    ser.write(cmd)
    ser.flush()
    ser.rts = False  # 切换到接收
    time.sleep(0.1)
    d = ser.read(6)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

print('=== RTS 控制 485 方向测试 ===')
print(f'当前 GDRV: {r(0x101)}')

print(f'\n写 0x81003431...')
print(f'写响应: {w(0x101, 0x81003431)}')
time.sleep(0.1)
print(f'读回: {r(0x101)}')

# 再试一次确保
print(f'\n第二次写 0x81003431...')
print(f'写响应: {w(0x101, 0x81003431)}')
time.sleep(0.1)
print(f'读回: {r(0x101)}')

ser.close()
