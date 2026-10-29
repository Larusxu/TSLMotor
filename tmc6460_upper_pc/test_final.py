import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def read_raw(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF]))
    time.sleep(0.05)
    return ser.read(10)

def read_val(addr):
    resp = read_raw(addr)
    if len(resp) >= 5:
        return resp[1] << 24 | resp[2] << 16 | resp[3] << 8 | resp[4]
    return None

def write_val(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    return ser.read(10)

def hs(b):
    return ' '.join(f'{x:02X}' for x in b)

# 连通测试
r = read_raw(0x000)
if len(r) < 5:
    print(f'芯片无响应: {hs(r)}')
    ser.close()
    exit(1)
print(f'VERSION: {hs(r)}')

# 当前状态
print(f'MOTOR_MOTION: {hs(read_raw(0x100))}')
print(f'GDRV: {hs(read_raw(0x101))}')
print(f'MCC_STATUS: {hs(read_raw(0x105))}')

# 正确配置 MOTOR_MOTION
# bit15=RAMP_USE_PHI_E=1, bit[12:9]=TORQUE(2), bit[8:7]=BLDC(3), bit[6:0]=7
mm_val = (1 << 15) | (2 << 9) | (3 << 7) | 7
print(f'\n写 MOTOR_MOTION = 0x{mm_val:04X}')
write_val(0x100, mm_val)
time.sleep(0.1)
print(f'读回: {hs(read_raw(0x100))}')

# 力矩限制
write_val(0x14A, 0x03E80000)  # 1000
print(f'TF_LIMITS: {hs(read_raw(0x14A))}')

# 清事件
write_val(0x00A, 0xFFFFFFFF)
write_val(0x081, 0xFFFFFFFF)

# 从小到大给力矩，观察实际值
print('\n--- 力矩测试 ---')
for torque in [0, 50, 100, 300, 500, 300, 100, 50, 0]:
    val = (torque << 16) & 0xFFFF0000
    write_val(0x14E, val)
    time.sleep(0.5)
    print(f'target={torque:4d}  TF_ACTUAL={hs(read_raw(0x153))}  VEL={hs(read_raw(0x154))}  POS={hs(read_raw(0x155))}  MCC={hs(read_raw(0x105))}')

write_val(0x14E, 0)
write_val(0x100, 0)
ser.close()
print('\ndone')
