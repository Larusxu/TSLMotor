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

print('=== 开环测试 (开启驱动) ===\n')

# 1. 读当前 GDRV
gdrv = r(0x101)
print(f'GDRV 当前: {hs(gdrv)}')

# 2. 开启 CHARGE_PUMP_EN(bit31) + DRV_EN_BIT(bit16)
# 保留其他位, 加上这两个位
# 但有 24-bit 写入限制! bit31 会被丢掉
# 先试试
new_gdrv = gdrv | (1 << 31) | (1 << 16)
print(f'写 GDRV=0x{new_gdrv:08X} (开 CHARGE_PUMP + DRV_EN)...')
w(0x101, new_gdrv)
time.sleep(0.1)
gdrv2 = r(0x101)
print(f'读回: {hs(gdrv2)}')
print(f'  CHARGE_PUMP_EN(bit31): {(gdrv2>>31)&1}')
print(f'  DRV_EN_BIT(bit16): {(gdrv2>>16)&1}')

# 3. 如果 bit31 因为 24-bit 限制写不进去, 试试只开 bit16
if (gdrv2 >> 31) & 1 == 0:
    print('\nbit31 写不进去(24-bit限制), 只开 DRV_EN_BIT...')
    new_gdrv2 = gdrv | (1 << 16)
    w(0x101, new_gdrv2)
    time.sleep(0.1)
    gdrv3 = r(0x101)
    print(f'读回: {hs(gdrv3)}')
    print(f'  DRV_EN_BIT(bit16): {(gdrv3>>16)&1}')

# 4. 配置 MOTOR_MOTION
mm = (1 << 15) | (2 << 9) | (3 << 7) | 7
w(0x100, mm)
time.sleep(0.05)
print(f'\nMOTOR_MOTION: {hs(r(0x100))}')

# 5. 力矩限制
w(0x14A, 0x00C80000)
print(f'TF_LIMITS: {hs(r(0x14A))}')

# 6. 清事件
w(0x00A, 0xFFFFFFFF)

# 7. 力矩测试
print('\n--- 力矩测试 ---')
for t in [0, 50, 100, 200, 500, 200, 100, 0]:
    w(0x14E, (t << 16) & 0xFFFF0000)
    time.sleep(0.5)
    tf = r(0x153)
    vel = r(0x154)
    pos = r(0x155)
    ta = ((tf >> 16) & 0xFFFF) if tf else 0
    if ta > 0x7FFF: ta -= 0x10000
    print(f'target={t:4d} torque={ta:6d} vel={hs(vel)} pos={hs(pos)}')

w(0x14E, 0)
w(0x100, 0)
ser.close()
print('\ndone')
