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

print('=== 完整开环测试 (pytrinamic 地址) ===\n')

# 1. 芯片确认
print(f'ID: {hs(r(0x000))}')

# 2. GDRV 配置 (pytrinamic 脚本的设置)
# 默认 0x81003431, 脚本改为 EXT_IREF + SLEWRATE_400 + RES_50MOHM
# 先用默认值试试
print(f'GDRV: {hs(r(0x101))}')

# 3. FEEDBACK.OUTPUT_CONF (0x250)
# 告诉 FOC 从哪里获取电角度
# 当前值 0x05000001, 需要确认是否正确
print(f'OUTPUT_CONF: {hs(r(0x250))}')

# 4. 配置 MOTOR_MOTION
# RAMP_USE_PHI_E=1(bit15), TORQUE(bit12:9=2), BLDC(bit8:7=3), POLES=7
mm = (1 << 15) | (2 << 9) | (3 << 7) | 7
w(0x100, mm)
print(f'\n写 MOTOR_MOTION=0x{mm:04X}, 读回: {hs(r(0x100))}')

# 5. 力矩限制 (放在低24位)
w(0x14A, 0x00C80000)  # torque=200, flux=0
print(f'TF_LIMITS: {hs(r(0x14A))}')

# 6. 清事件
w(0x00A, 0xFFFFFFFF)

# 7. 从小到大力矩测试
print('\n--- 力矩测试 ---')
for t in [0, 50, 100, 200, 500, 200, 100, 0]:
    w(0x14E, (t << 16) & 0xFFFF0000)
    time.sleep(0.5)
    tf = r(0x153)
    vel = r(0x154)
    pos = r(0x155)
    # 解码力矩
    ta = ((tf >> 16) & 0xFFFF) if tf else 0
    if ta > 0x7FFF: ta -= 0x10000
    print(f'target={t:4d} torque={ta:6d} vel={hs(vel)} pos={hs(pos)}')

# 清零
w(0x14E, 0)
w(0x100, 0)
ser.close()
print('\ndone')
