"""100 RPM 开环测试"""
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

def decode_mcc(val):
    if val is None: return "FAIL"
    flags = []
    if val & 0x01: flags.append("SHRT2G_CH1")
    if val & 0x02: flags.append("SHRT2G_CH2")
    if val & 0x04: flags.append("SHRT2G_CH3")
    if val & 0x20: flags.append("SHRT2V_CH1")
    if val & 0x40: flags.append("OVERTEMP_CH1")
    if val & 0x80: flags.append("OVERTEMP_CH2")
    if val & 0x100: flags.append("OVERTEMP_CH3")
    return "|".join(flags) if flags else "OK"

print("=== 100 RPM 开环测试 ===\n")

# 1. 清除所有故障事件
print("[1] 清除故障...")
write_val(0x00A, 0xFFFFFFFF)   # CHIP.EVENTS
write_val(0x007, 0xFFFFFFFF)   # CHIP.EVENTS (另一个?)
write_val(0x081, 0xFFFFFFFF)   # FOC.EVENTS
# 尝试清除 MCC_STATUS 的 W1C 事件位 (bit16-24)
write_val(0x105, 0x01FF0000)
time.sleep(0.1)

mcc = read_val(0x105)
print(f"  MCC_STATUS: {hexstr(read_raw(0x105))} → {decode_mcc(mcc)}")

# 2. 读当前配置
print("\n[2] 当前配置:")
print(f"  MOTOR_MOTION: {hexstr(read_raw(0x100))}")
print(f"  PWM_MAXCNT:   {hexstr(read_raw(0x085))}")
print(f"  GDRV:         {hexstr(read_raw(0x101))}")

# 3. 设置开环速度模式
print("\n[3] 配置开环速度模式...")
# MOTION_MODE=2 (OPEN_LOOP_VEL), N_POLE_PAIRS=7
write_val(0x100, 0x00000407)
time.sleep(0.05)
print(f"  MOTOR_MOTION: {hexstr(read_raw(0x100))}")

# 4. 设置力矩限制 (开环模式下控制电流幅值)
print("\n[4] 设置力矩限制...")
# PID_TORQUE_FLUX_LIMITS: [31:16]=torque_limit, [15:0]=flux_limit
# 力矩限制 500
write_val(0x14A, 0x01F40000)
time.sleep(0.05)
print(f"  TF_LIMITS: {hexstr(read_raw(0x14A))}")

# 5. 设置速度目标
# 100 RPM → 需要知道编码器分辨率换算
# 先用一个较小的值测试
print("\n[5] 设置速度目标...")
# 试不同的速度值
for vel in [100, 500, 1000, 5000]:
    write_val(0x150, vel)
    time.sleep(0.3)
    
    vel_actual = read_val(0x154)
    pos_actual = read_val(0x155)
    mcc = read_val(0x105)
    torque = read_val(0x153)
    
    print(f"  vel_target={vel:6d} → vel_actual={hexstr(read_raw(0x154))} pos={hexstr(read_raw(0x155))} mcc={decode_mcc(mcc)}")

# 6. 清零
print("\n[6] 清零...")
write_val(0x150, 0)
time.sleep(0.1)
print(f"  最终 MCC_STATUS: {hexstr(read_raw(0x105))}")

ser.close()
print("\n完成")
