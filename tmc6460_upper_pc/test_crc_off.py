import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def show(d): return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

def d32(raw):
    if len(raw) < 5: return show(raw)
    return f'0x{(raw[1]<<24|raw[2]<<16|raw[3]<<8|raw[4]):08X}'

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    time.sleep(0.05)
    return ser.read(6)

def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    ser.read(10)

print('=== 关闭 CRC 后写入 GDRV ===')

# Step 0: 读当前状态
print(f'GDRV: {d32(r(0x101))}')
print(f'UART.CONTROL: {d32(r(0x340))}')

# Step 1: 关 CRC (写 0x01040208, 清 bit0 & bit1)
print(f'\n1. 关 NORMAL_CRC_EN + RTMI_CRC_EN...')
w(0x340, 0x01040208)  # was 0x0104020B, clear bits 0&1
time.sleep(0.1)
print(f'   UART.CONTROL: {d32(r(0x340))}')

# Step 2: 写 GDRV 默认值
print(f'\n2. 写 GDRV=0x81003431')
w(0x101, 0x81003431)
time.sleep(0.1)
g = r(0x101)
print(f'   GDRV: {d32(g)} raw={show(g)}')
v = int(d32(g), 16)
print(f'   CHARGE_PUMP_EN(bit31)={v>>31} DRV_EN(bit16)={(v>>16)&1}')

# Step 3: 如果成功，继续
if v >> 31:
    print('\n3. CHARGE_PUMP_EN=1! 继续配置...')
    w(0x1CE, 0x000186A0)  # V_MAX
    mm = (1<<15)|(1<<14)|(11<<9)|(3<<7)|2
    w(0x100, mm)  # MOTOR_MOTION
    w(0x1CA, 1000)  # V_START
    w(0x200, 0x00001388)  # UD=5000
    
    print('   Monitoring...')
    for i in range(10):
        time.sleep(0.2)
        print(f'   [{i}] VEL={d32(r(0x154))} POS={d32(r(0x155))}')
    
    w(0x200, 0)
    w(0x100, 0)

ser.close()
print('\ndone')
