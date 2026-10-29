import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF]))
    time.sleep(0.03)
    d = ser.read(5)
    return (d[1]<<24|d[2]<<16|d[3]<<8|d[4]) if len(d)>=5 else None

def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.03)
    ser.read(4)

def hs(v):
    return f'0x{v:08X}' if v is not None else 'FAIL'

print('=== External Voltage Open Loop ===\n')

# GDRV: 开 DRV_EN
gdrv = r(0x101)
w(0x101, gdrv | (1 << 16))
print(f'GDRV: {hs(r(0x101))}')

# MOTOR_MOTION: VOLTAGE_EXT(11), BLDC(3), 7 poles, RAMP_USE_PHI_E=1
# MOTION_MODE=11 at bits[12:9]
mm = (1 << 15) | (11 << 9) | (3 << 7) | 7
print(f'写 MOTOR_MOTION=0x{mm:04X} (VOLTAGE_EXT, BLDC, 7poles, RAMP_PHI_E)')
w(0x100, mm)
time.sleep(0.05)
print(f'读回: {hs(r(0x100))}')

# 清事件
w(0x00A, 0xFFFFFFFF)

# VOLTAGE_EXT 模式下, 直接给 UQ/UD 电压
# 用 PID_VELOCITY_TARGET (0x150) 或直接写 FOC.UQ_UD?
# 先试写速度目标
print('\n--- 速度测试 (VOLTAGE_EXT) ---')
for vel in [0, 1000, 5000, 10000, 50000, 10000, 5000, 1000, 0]:
    w(0x150, vel)
    time.sleep(0.5)
    tf = r(0x153)
    va = r(0x154)
    pa = r(0x155)
    print(f'vel_target={vel:6d}  TF={hs(tf)}  VEL={hs(va)}  POS={hs(pa)}')

# 也试力矩目标
print('\n--- 力矩测试 (VOLTAGE_EXT) ---')
for t in [0, 100, 500, 1000, 500, 100, 0]:
    w(0x14E, (t << 16) & 0xFFFF0000)
    time.sleep(0.5)
    tf = r(0x153)
    va = r(0x154)
    pa = r(0x155)
    ta = ((tf>>16)&0xFFFF) if tf else 0
    if ta > 0x7FFF: ta -= 0x10000
    print(f'torque_target={t:4d}  torque={ta:6d}  VEL={hs(va)}  POS={hs(pa)}')

w(0x14E, 0)
w(0x150, 0)
w(0x100, 0)
ser.close()
print('\ndone')
