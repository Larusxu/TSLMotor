"""正确的开环力矩测试（按数据手册）"""
import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def read_reg(addr):
    return bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF])

def write_reg(addr, data):
    return bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data)

def read_raw(addr):
    ser.reset_input_buffer()
    ser.write(read_reg(addr))
    return ser.read(10)

def read_val(addr):
    resp = read_raw(addr)
    if len(resp) >= 5:
        return resp[1] << 24 | resp[2] << 16 | resp[3] << 8 | resp[4]
    return None

def write_val(addr, data):
    ser.reset_input_buffer()
    ser.write(write_reg(addr, data))
    time.sleep(0.02)
    return ser.read(10)

def hexstr(b):
    return ' '.join(f'{x:02X}' for x in b)

def decode_motor_motion(val):
    if val is None: return "FAIL"
    motion_mode = (val >> 9) & 0x0F
    motor_type = (val >> 7) & 0x03
    pole_pairs = val & 0x7F
    ramp_phi_e = (val >> 15) & 1
    ramp_en = (val >> 14) & 1
    modes = {0:"PWM_OFF", 1:"PWM_ON", 2:"TORQUE", 3:"VELOCITY", 4:"POSITION",
             5:"PRBS_UD", 6:"PRBS_FLUX", 7:"PRBS_TORQUE", 8:"PRBS_VEL", 9:"PRBS_POS",
             10:"PWM_EXT", 11:"VOLTAGE_EXT"}
    types = {0:"NONE", 1:"DC", 3:"BLDC"}
    return f"mode={modes.get(motion_mode, motion_mode)} type={types.get(motor_type, motor_type)} poles={pole_pairs} ramp_phi_e={ramp_phi_e} ramp_en={ramp_en}"

print("=== 正确的开环力矩测试 ===\n")

# 1. 读当前状态
print("[1] 当前状态:")
print(f"  MOTOR_MOTION: {hexstr(read_raw(0x100))} -> {decode_motor_motion(read_val(0x100))}")
print(f"  GDRV:         {hexstr(read_raw(0x101))}")
print(f"  MCC_STATUS:   {hexstr(read_raw(0x105))}")

# 2. 正确配置 MOTOR_MOTION (0x100)
# bit[15]  = RAMP_USE_PHI_E = 1 (开环: 用内部生成的 phi_e)
# bit[12:9] = MOTION_MODE = 2 (TORQUE)
# bit[8:7]  = MOTOR_TYPE = 3 (BLDC)
# bit[6:0]  = N_POLE_PAIRS = 7
motor_motion = (1 << 15) | (2 << 9) | (3 << 7) | 7  # = 0x8647
print(f"\n[2] 写 MOTOR_MOTION = 0x{motor_motion:04X}")
print(f"    RAMP_USE_PHI_E=1, TORQUE, BLDC, 7 poles")
write_val(0x100, motor_motion)
time.sleep(0.05)
mm = read_val(0x100)
print(f"    读回: {hexstr(read_raw(0x100))} -> {decode_motor_motion(mm)}")

# 3. 设置 GDRV（使能驱动）
# 默认 0x81003431, 先读回来
gdrv = read_val(0x101)
print(f"\n[3] GDRV 当前: 0x{gdrv:08X}" if gdrv is not None else "\n[3] GDRV: FAIL")

# 4. 力矩限制
print("\n[4] 设置力矩限制...")
# PID_TORQUE_FLUX_LIMITS (0x14A): [31:16]=torque_limit, [15:0]=flux_limit
write_val(0x14A, 0x03E80000)  # torque_limit=1000
time.sleep(0.05)
print(f"  TF_LIMITS: {hexstr(read_raw(0x14A))}")

# 5. 清除事件
write_val(0x00A, 0xFFFFFFFF)
write_val(0x081, 0xFFFFFFFF)

# 6. 设置小力矩目标并观察
print("\n[5] 力矩测试:")
for torque in [0, 100, 500, 1000, 500, 100, 0]:
    # PID_TORQUE_FLUX_TARGET (0x14E): [31:16]=torque, [15:0]=flux
    val = (torque << 16) & 0xFFFF0000
    write_val(0x14E, val)
    time.sleep(0.3)
    
    torque_actual = read_val(0x153)
    vel_actual = read_val(0x154)
    pos_actual = read_val(0x155)
    mcc = read_val(0x105)
    
    # 解码实际力矩 (signed 16-bit in upper half)
    ta = (torque_actual >> 16) & 0xFFFF if torque_actual else 0
    if ta > 0x7FFF: ta -= 0x10000
    
    print(f"  target={torque:5d} -> torque_actual={ta:6d} vel=0x{vel_actual:08X} pos=0x{pos_actual:08X} mcc=0x{mcc:08X}" if all(v is not None for v in [torque_actual, vel_actual, pos_actual, mcc]) else f"  target={torque:5d} -> read fail")

# 7. 清零
write_val(0x14E, 0)
write_val(0x100, 0)  # PWM_OFF

ser.close()
print("\n完成")
