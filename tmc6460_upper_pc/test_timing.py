import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)
ser.rts = False  # 始终接收模式

def r(addr):
    """读: 短暂切发送→发2字节→切回接收→读6字节"""
    ser.rts = True
    time.sleep(0.001)
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    ser.flush()
    time.sleep(0.001)
    ser.rts = False
    time.sleep(0.015)
    d = ser.read(6)
    return d

def w(addr, data):
    """写: 短暂切发送→发6字节→切回接收→读写响应"""
    ser.rts = True
    time.sleep(0.001)
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    ser.flush()
    time.sleep(0.002)
    ser.rts = False
    time.sleep(0.015)
    d = ser.read(6)
    return d

def show(raw):
    return ' '.join(f'{b:02X}' for b in raw)

def d32(raw):
    if len(raw) >= 6:
        return f'0x{(raw[2]<<24|raw[3]<<16|raw[4]<<8|raw[5]):08X}'
    return ' '.join(f'{b:02X}' for b in raw)

print('=== 固定 RTS 逻辑 ===\n')

# 连读3次看稳定性
for i in range(3):
    g = r(0x101)
    print(f'[{i}] GDRV len={len(g)} raw={show(g)}')
    time.sleep(0.1)

# 写 GDRV
print(f'\n写 GDRV=0x81003431...')
w(0x101, 0x81003431)
time.sleep(0.1)
g = r(0x101)
print(f'读回: {show(g)}')

# 连读3次
for i in range(3):
    time.sleep(0.1)
    g = r(0x101)
    print(f'[{i}] GDRV len={len(g)} raw={show(g)}')

ser.close()
