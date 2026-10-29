import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    time.sleep(0.05)
    d = ser.read(5)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

def d32(d):
    parts = d.split()
    return f'0x{(int(parts[1],16)<<24|int(parts[2],16)<<16|int(parts[3],16)<<8|int(parts[4],16)):08X}' if len(parts)==5 else 'FAIL'

def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    d = ser.read(5)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

print('=== 逐步验证 ===\n')

# Step 0: 当前状态
print(f'0. 初始状态')
print(f'   GDRV={d32(r(0x101))}')
print(f'   STATUS_FLAGS={d32(r(0x009))}')
print(f'   MCC_STATUS={d32(r(0x105))}')

# Step 1: 只写 GDRV
print(f'\n1. 写 GDRV=0x81003431...')
print(f'   写响应: {w(0x101, 0x81003431)}')
g1 = d32(r(0x101))
print(f'   读GDRV: {g1}')
print(f'   bit31={int(g1,16)>>31} bit16={(int(g1,16)>>16)&1}')

# Step 2: V_MAX
if int(g1,16) >> 31:
    print(f'\n2. V_MAX=100000...')
    print(f'   写响应: {w(0x1CE, 0x000186A0)}')
    print(f'   读回: {d32(r(0x1CE))}')
    print(f'   GDRV bit31 still: {(int(d32(r(0x101)),16)>>31)&1}')

# Step 3: MOTOR_MOTION
if int(g1,16) >> 31:
    mm = (1<<15)|(1<<14)|(11<<9)|(3<<7)|2
    print(f'\n3. MOTOR_MOTION=0x{mm:04X}...')
    print(f'   写响应: {w(0x100, mm)}')
    print(f'   读回: {d32(r(0x100))}')
    print(f'   GDRV bit31 still: {(int(d32(r(0x101)),16)>>31)&1}')

# Step 4: EXT_CTRL
if int(g1,16) >> 31:
    print(f'\n4. EXT_CTRL.VOLTAGE UD=5000...')
    print(f'   写响应: {w(0x200, 0x00001388)}')
    print(f'   读回: {d32(r(0x200))}')
    print(f'   GDRV bit31 still: {(int(d32(r(0x101)),16)>>31)&1}')

    # Monitor
    print(f'\n5. Monitor:')
    for i in range(5):
        time.sleep(0.2)
        print(f'   [{i}] VEL={d32(r(0x154))} POS={d32(r(0x155))} TF={d32(r(0x153))}')

    # Stop
    w(0x200, 0)
    w(0x100, 0)

ser.close()
print('\ndone')
