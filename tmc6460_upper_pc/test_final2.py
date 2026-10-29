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

print('=== 开环力矩测试 (修正版) ===\n')

# MOTOR_MOTION: RAMP_USE_PHI_E=1, TORQUE, BLDC, 7 poles
mm = (1 << 15) | (2 << 9) | (3 << 7) | 7
write_val(0x100, mm)
print(f'MOTOR_MOTION: {hs(read_raw(0x100))}')

# 力矩限制: 放在低24位
# 数据手册: [30:16]=torque_limit, [14:0]=flux_limit
# 24-bit限制: 只能写 [23:16] (8bit) 和 [14:0] (15bit)
# torque=200, flux=0 -> (200 << 16) = 0x00C80000
tl = 200 << 16
write_val(0x14A, tl)
print(f'TF_LIMITS 写入 0x{tl:08X}, 读回: {hs(read_raw(0x14A))}')

# 清事件
write_val(0x00A, 0xFFFFFFFF)
write_val(0x081, 0xFFFFFFFF)

# 力矩测试: 从0逐步增加
print('\n--- 力矩测试 ---')
for torque in [0, 20, 50, 100, 150, 200, 150, 100, 50, 20, 0]:
    # [31:16]=torque_target, [15:0]=flux_target
    val = (torque << 16) & 0xFFFF0000
    write_val(0x14E, val)
    time.sleep(0.3)

    # 读实际值
    tf_raw = read_raw(0x153)
    vel_raw = read_raw(0x154)
    pos_raw = read_raw(0x155)
    mcc_raw = read_raw(0x105)

    tf = read_val(0x153)
    vel = read_val(0x154)
    pos = read_val(0x155)

    # 解码力矩 (signed 16-bit in upper half)
    if tf is not None:
        ta = (tf >> 16) & 0xFFFF
        if ta > 0x7FFF: ta -= 0x10000
        fa = tf & 0xFFFF
        if fa > 0x7FFF: fa -= 0x10000
    else:
        ta = fa = None

    print(f'target={torque:4d}  torque_actual={ta}  flux_actual={fa}  vel={hs(vel_raw)}  pos={hs(pos_raw)}  mcc={hs(mcc_raw)}')

# 清零
write_val(0x14E, 0)
write_val(0x100, 0)
ser.close()
print('\ndone')
