import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def rraw(addr):
    ser.reset_input_buffer()
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    ser.write(bytes([byte0, addr & 0xFF]))
    time.sleep(0.1)
    d = ser.read(6)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

def wraw(addr, data):
    ser.reset_input_buffer()
    byte0 = 0x4A | (((addr >> 8) & 0x03) << 4)
    ser.write(bytes([byte0, addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.1)
    d = ser.read(6)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

print('=== GDRV 写入诊断 ===')

# 1. 当前 GDRV
print(f'当前 GDRV: {rraw(0x101)}')

# 2. 写 0x81003431
print(f'\n写 0x101=0x81003431')
tx = '5A 01 81 00 34 31'
print(f'TX: {tx}')
resp = wraw(0x101, 0x81003431)
print(f'写响应: {resp}')

# 3. 连读三次
print(f'\n连读三次 GDRV:')
for i in range(3):
    time.sleep(0.1)
    print(f'  [{i}] {rraw(0x101)}')

ser.close()
