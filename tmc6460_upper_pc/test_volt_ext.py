import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def r(addr):
    ser.reset_input_buffer()
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    byte1 = addr & 0xFF
    ser.write(bytes([byte0, byte1]))
    time.sleep(0.05)
    d = ser.read(5)
    return f'0x{(d[1]<<24|d[2]<<16|d[3]<<8|d[4]):08X}' if len(d)>=5 else 'FAIL'

def rraw(addr):
    ser.reset_input_buffer()
    byte0 = 0x42 | (((addr >> 8) & 0x03) << 4)
    byte1 = addr & 0xFF
    ser.write(bytes([byte0, byte1]))
    time.sleep(0.05)
    d = ser.read(5)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

def w(addr, data):
    ser.reset_input_buffer()
    byte0 = 0x4A | (((addr >> 8) & 0x03) << 4)
    byte1 = addr & 0xFF
    ser.write(bytes([byte0, byte1]) + struct.pack('>I', data))
    time.sleep(0.05)
    d = ser.read(5)
    return ' '.join(f'{b:02X}' for b in d) if d else 'FAIL'

print('=== TMC6460 VOLTAGE_EXT ===')
print()

# 1. GDRV
print('1. GDRV=0x81003431...')
print(f'   写入前: {r(0x101)}')
w(0x101, 0x81003431)
print(f'   写入后: {r(0x101)}')
gdrv_raw = rraw(0x101)
print(f'   raw: {gdrv_raw}')
cp = int(gdrv_raw.split()[1], 16) >> 7 if len(gdrv_raw.split()) >= 2 else -1
print(f'   CHARGE_PUMP_EN(bit31) = {cp}')

# 2. 如果 cp=1, 继续
if cp:
    print('\n2. Setup...')
    print(f'   V_MAX=100000: before={r(0x1CE)}')
    w(0x1CE, 0x000186A0)
    print(f'                 after ={r(0x1CE)}')

    mm = (1<<15)|(1<<14)|(11<<9)|(3<<7)|2
    print(f'   MOTOR_MOTION=0x{mm:04X}: before={r(0x100)}')
    w(0x100, mm)
    print(f'                             after ={r(0x100)}')

    print(f'   V_START: before={r(0x1CA)}')
    w(0x1CA, 1000)
    print(f'            after ={r(0x1CA)}')

    print(f'   UD=5000: before={r(0x200)}')
    w(0x200, 0x00001388)
    print(f'            after ={r(0x200)}')

    print('\n3. Monitor (10 samples, 200ms):')
    print(f'   {"t":4s} {"RAMPER_POS":>12s} {"RAMPER_V":>12s} {"VEL_ACT":>12s} {"TF_ACT":>12s} {"POS_ACT":>12s}')
    for i in range(10):
        print(f'   {i:4d} {r(0x1D1):>12s} {r(0x1D0):>12s} {r(0x154):>12s} {r(0x153):>12s} {r(0x155):>12s}')
        time.sleep(0.2)

    print('\n4. UD=20000...')
    w(0x200, 0x00004E20)
    for i in range(5):
        print(f'   {i:4d} {r(0x1D1):>12s} {r(0x1D0):>12s} {r(0x154):>12s}')
        time.sleep(0.2)

    print(f'\n5. MCC_STATUS: {r(0x105)}')
    print(f'   STATUS_FLAGS: {r(0x009)}')

    # stop
    w(0x200, 0)
    w(0x100, 0)
else:
    print('\nCHARGE_PUMP_EN 还是 0，先解决这个问题')

ser.close()
print('\ndone')
