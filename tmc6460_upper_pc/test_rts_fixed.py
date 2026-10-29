import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def r(addr):
    """读寄存器, 返回 6 字节(raw)"""
    ser.rts = True
    time.sleep(0.002)
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    ser.flush()
    ser.rts = False
    time.sleep(0.08)
    d = ser.read(6)
    return d

def w(addr, data):
    """写寄存器"""
    ser.rts = True
    time.sleep(0.002)
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    ser.flush()
    ser.rts = False
    time.sleep(0.08)
    d = ser.read(5)
    return d

def d32(raw):
    """6字节raw转32位数据"""
    if len(raw) >= 6:
        return f'0x{(raw[2]<<24|raw[3]<<16|raw[4]<<8|raw[5]):08X}'
    elif len(raw) >= 2:
        return ' '.join(f'{b:02X}' for b in raw)
    return 'FAIL'

print('=== 修正 RTS 后的完整流程 ===\n')

# 0. 当前
print(f'GDRV 当前: {d32(r(0x101))} (raw: {" ".join(f"{b:02X}" for b in r(0x101))})')

# 1. 写 GDRV 默认值 0x81003431
print(f'\n1. 写 GDRV=0x81003431...')
w(0x101, 0x81003431)
time.sleep(0.1)
g = r(0x101)
print(f'   读回: {d32(g)} raw={" ".join(f"{b:02X}" for b in g)}')
print(f'   CHARGE_PUMP_EN={int(d32(g),16)>>31}')

# 2. V_MAX
print(f'\n2. V_MAX=100000...')
w(0x1CE, 0x000186A0)
print(f'   读回: {d32(r(0x1CE))}')

# 3. MOTOR_MOTION
mm = (1<<15)|(1<<14)|(11<<9)|(3<<7)|2
print(f'\n3. MOTOR_MOTION=0x{mm:04X}...')
w(0x100, mm)
print(f'   读回: {d32(r(0x100))}')

# 4. V_START
print(f'\n4. V_START=1000...')
w(0x1CA, 1000)
print(f'   读回: {d32(r(0x1CA))}')

# 5. EXT_CTRL.VOLTAGE
print(f'\n5. UD=5000...')
w(0x200, 0x00001388)
print(f'   读回: {d32(r(0x200))}')

# 6. Monitor
print(f'\n6. 监控:')
for i in range(10):
    time.sleep(0.2)
    vramp = d32(r(0x1D0))
    vel = d32(r(0x154))
    pos = d32(r(0x155))
    print(f'   [{i}] RAMPER_V={vramp} VEL={vel} POS={pos}')

# 7. 加UD
print(f'\n7. UD=20000...')
w(0x200, 0x00004E20)
for i in range(5):
    time.sleep(0.2)
    print(f'   [{i}] RAMPER_V={d32(r(0x1D0))} VEL={d32(r(0x154))}')

# 停
w(0x200, 0)
w(0x100, 0)
ser.close()
print('\ndone')
