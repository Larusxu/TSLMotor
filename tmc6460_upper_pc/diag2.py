import serial, struct, time
ser = serial.Serial('COM6', 115200, timeout=0.5)
def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF]))
    time.sleep(0.05)
    return ser.read(10)
def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    return ser.read(10)
def rv(addr):
    resp = r(addr)
    return resp[1] << 24 | resp[2] << 16 | resp[3] << 8 | resp[4] if len(resp) >= 5 else None
def hs(addr):
    return ' '.join(f'{b:02X}' for b in r(addr))

print('=== 关键寄存器 dump ===')
for addr, name in [
    (0x100, 'MOTOR_MOTION'),
    (0x101, 'GDRV'),
    (0x102, 'PWM_CFG (0x102)'),
    (0x103, 'PWM_PERIOD'),
    (0x105, 'MCC_STATUS'),
    (0x009, 'IO_CTRL'),
    (0x080, 'FOC_STATUS'),
    (0x082, 'DRV_STATUS'),
    (0x085, 'PWM_MAXCNT'),
    (0x065, 'FEEDBACK_OUT_CONF'),
    (0x140, 'PID_CONFIG'),
    (0x14A, 'TF_LIMITS'),
    (0x14E, 'TF_TARGET'),
    (0x153, 'TF_ACTUAL'),
    (0x154, 'VEL_ACTUAL'),
    (0x155, 'POS_ACTUAL'),
]:
    print(f'  {name:20s} ({addr:#05x}): {hs(addr)}')

# 检查 CHOP 模式 (0x102 bit[2:0])
pwm_cfg = rv(0x102)
if pwm_cfg:
    chop = pwm_cfg & 0x07
    chop_names = {0:'OFF_FREE', 1:'OFF_LSON', 2:'OFF_HSON', 3:'OFF_FREE2', 4:'OFF_FREE3', 5:'LSPWM', 6:'HSPWM', 7:'CENTERED'}
    print(f'\nCHOP = {chop} ({chop_names.get(chop, "?")})')
    if chop != 7:
        print('>>> PWM 没开！设为 CENTERED(7)...')
        w(0x102, (pwm_cfg & 0xFFFFFFF8) | 7)
        time.sleep(0.05)
        print(f'写回: {hs(0x102)}')

# 检查 FEEDBACK.OUTPUT_CONF (0x065)
fb = rv(0x065)
print(f'\nFEEDBACK.OUTPUT_CONF = 0x{fb:08X}' if fb else '\nFEEDBACK.OUTPUT_CONF = FAIL')

# 尝试: 逐个设字段
print('\n=== 逐字段配置 ===')
# 1. CHOP = CENTERED
w(0x102, 7)
print(f'PWM_CFG: {hs(0x102)}')

# 2. MOTOR_TYPE = BLDC
# 3. N_POLE_PAIRS = 7
# 4. MOTION_MODE = TORQUE(2)
# 5. RAMP_USE_PHI_E = 1
# 逐个写 bit field 试试
w(0x100, 0x00000007)  # poles=7
time.sleep(0.05)
print(f'MOTOR_MOTION (poles): {hs(0x100)}')

w(0x100, 0x00000107)  # MOTOR_TYPE=2(BLDC)? 不对, BLDC=3
# MOTOR_TYPE bits[8:7]: 3=BLDC -> bit8=1, bit7=1
# 0x00000107: bit8=1, bit7=0 -> type=2 (reserved)
# 正确: (3<<7)|7 = 0x180|7 = 0x187
w(0x100, 0x00000187)  # BLDC, 7 poles
time.sleep(0.05)
print(f'MOTOR_MOTION (BLDC,7): {hs(0x100)}')

w(0x100, 0x00000587)  # TORQUE(2), BLDC, 7 poles
time.sleep(0.05)
print(f'MOTOR_MOTION (+TORQUE): {hs(0x100)}')

w(0x100, 0x00008587)  # RAMP_USE_PHI_E=1, TORQUE, BLDC, 7 poles
time.sleep(0.05)
print(f'MOTOR_MOTION (+RAMP_PHI_E): {hs(0x100)}')

# 力矩限制 (只写低24位)
w(0x14A, 0x00C80000)  # torque=200
time.sleep(0.05)
print(f'TF_LIMITS: {hs(0x14A)}')

# 清事件
w(0x00A, 0xFFFFFFFF)
w(0x081, 0xFFFFFFFF)

# 给力矩
print('\n--- 给力矩 100 ---')
w(0x14E, 0x00640000)  # torque=100
time.sleep(1.0)
print(f'TF_ACTUAL: {hs(0x153)}')
print(f'VEL: {hs(0x154)}')
print(f'POS: {hs(0x155)}')
print(f'MCC: {hs(0x105)}')

w(0x14E, 0)
w(0x100, 0)
ser.close()
print('\ndone')
