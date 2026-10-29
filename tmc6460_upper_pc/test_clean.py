import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def r(addr):
    ser.rts = True
    time.sleep(0.003)
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    ser.flush()
    ser.rts = False
    time.sleep(0.01)
    d = ser.read(6)
    return d

def w(addr, data):
    ser.rts = True
    time.sleep(0.003)
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    ser.flush()
    ser.rts = False
    time.sleep(0.01)
    # 读掉写响应 (5字节)
    wr = ser.read(6)
    return wr

def d32(raw):
    if len(raw) >= 6:
        return f'0x{(raw[2]<<24|raw[3]<<16|raw[4]<<8|raw[5]):08X}'
    return ' '.join(f'{b:02X}' for b in raw)

def show(raw):
    return ' '.join(f'{b:02X}' for b in raw)

print('=== 完整流程(读掉写响应) ===\n')

# Step 0: 当前
g = r(0x101)
print(f'GDRV={d32(g)} raw={show(g)}')

# Step 1: 写完整默认值
print(f'\n1. 写 GDRV=0x81003431...')
wr = w(0x101, 0x81003431)
print(f'   写响应: {show(wr)}')
time.sleep(0.1)
g = r(0x101)
print(f'   读GDRV: {d32(g)} raw={show(g)}')
v = int(d32(g), 16)
print(f'   CP_EN={v>>31} DRV_EN={(v>>16)&1} IREF={(v>>24)&1}')

# Step 2: V_MAX
print(f'\n2. V_MAX=100000...')
w(0x1CE, 0x000186A0)
time.sleep(0.05)
print(f'   读回: {d32(r(0x1CE))}')

# Step 3: MOTOR_MOTION
mm = (1<<15)|(1<<14)|(11<<9)|(3<<7)|2
print(f'\n3. MOTOR_MOTION=0x{mm:04X}...')
w(0x100, mm)
time.sleep(0.05)
print(f'   读回: {d32(r(0x100))}')

# Step 4: V_START
print(f'\n4. V_START=1000...')
w(0x1CA, 1000)
time.sleep(0.05)
print(f'   读回: {d32(r(0x1CA))}')

# Step 5: EXT_CTRL
print(f'\n5. UD=5000...')
w(0x200, 0x00001388)
time.sleep(0.05)
print(f'   读回: {d32(r(0x200))}')

# Step 6: Monitor
print(f'\n6. 监控:')
for i in range(10):
    time.sleep(0.2)
    print(f'   [{i}] RAMPER_V={d32(r(0x1D0))} VEL={d32(r(0x154))} POS={d32(r(0x155))}')

# Stop
w(0x200, 0)
w(0x100, 0)
ser.close()
print('\ndone')
