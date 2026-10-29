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

# 用 pytrinamic 的地址读
print('=== pytrinamic 地址验证 ===')
for addr, name in [
    (0x000, 'CHIP.ID'),
    (0x006, 'CHIP.IO_MATRIX (pytrinamic)'),
    (0x008, 'CHIP.IO_CONFIG (pytrinamic)'),
    (0x009, 'CHIP.STATUS_FLAGS (pytrinamic)'),
    (0x100, 'MOTOR_MOTION'),
    (0x101, 'GDRV'),
    (0x102, 'PWM'),
    (0x250, 'FEEDBACK.OUTPUT_CONF (pytrinamic)'),
    (0x24D, 'FEEDBACK.PHI_EXT_A (pytrinamic)'),
]:
    print(f'  {name:40s} ({addr:#05x}): {hs(r(addr))}')

# 关键: 读 FEEDBACK.OUTPUT_CONF (0x250)
# 这个寄存器告诉 FOC 从哪里获取电角度
print(f'\n=== FEEDBACK.OUTPUT_CONF (0x250) ===')
v = r(0x250)
print(f'  当前值: {hs(v)}')

# 尝试配置 FEEDBACK.OUTPUT_CONF
# PHI_E_SRC = 选择角度来源 (具体值需要查)
# 先读 CONF_CH_A (0x240) 看编码器配置
print(f'\n=== 编码器配置 ===')
for addr in [0x240, 0x241, 0x242, 0x243, 0x244, 0x245, 0x246, 0x247, 0x251, 0x252]:
    print(f'  0x{addr:03X}: {hs(r(addr))}')

ser.close()
print('\ndone')
