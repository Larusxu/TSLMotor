import serial, time
ser = serial.Serial('COM6', 115200, timeout=1)
ser.reset_input_buffer()
ser.write(bytes([0x42, 0x00]))
time.sleep(0.05)
r = ser.read(10)
print(f'len={len(r)} hex={" ".join(f"{b:02X}" for b in r)}')

# 现在测试正确的 MOTOR_MOTION
import struct

def write_reg(addr, data):
    return bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data)

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
    ser.write(write_reg(addr, data))
    time.sleep(0.05)
    return ser.read(10)

def hexstr(b):
    return ' '.join(f'{x:02X}' for x in b)

print(f'\nMOTOR_MOTION: {hexstr(read_raw(0x100))}')

# 正确的 MOTOR_MOTION: RAMP_USE_PHI_E=1, TORQUE, BLDC, 7 poles
motor_motion = (1 << 15) | (2 << 9) | (3 << 7) | 7
print(f'写 0x100 = 0x{motor_motion:04X}')
write_val(0x100, motor_motion)
time.sleep(0.05)
mm = read_val(0x100)
print(f'读回 0x100 = 0x{mm:04X}' if mm is not None else '读回 FAIL')
motion_mode = (mm >> 9) & 0x0F
motor_type = (mm >> 7) & 0x03
ramp_phi = (mm >> 15) & 1
poles = mm & 0x7F
print(f'  MOTION_MODE={motion_mode} MOTOR_TYPE={motor_type} RAMP_USE_PHI_E={ramp_phi} POLES={poles}')

# 力矩限制
write_val(0x14A, 0x03E80000)  # torque_limit=1000
print(f'TF_LIMITS: {hexstr(read_raw(0x14A))}')

# 清事件
write_val(0x00A, 0xFFFFFFFF)
write_val(0x081, 0xFFFFFFFF)

# 小力矩测试
print('\n力矩测试:')
for torque in [0, 100, 500, 1000, 0]:
    val = (torque << 16) & 0xFFFF0000
    write_val(0x14E, val)
    time.sleep(0.5)
    ta = read_val(0x153)
    va = read_val(0x154)
    pa = read_val(0x155)
    mc = read_val(0x105)
    print(f'  target={torque:5d} torque={hexstr(read_raw(0x153))} vel={hexstr(read_raw(0x154))} pos={hexstr(read_raw(0x155))} mcc={hexstr(read_raw(0x105))}')

# 清零
write_val(0x14E, 0)
write_val(0x100, 0)
ser.close()
print('\ndone')
