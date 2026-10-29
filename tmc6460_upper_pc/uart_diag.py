import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.5)

def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr >> 8) & 0x03) << 4), addr & 0xFF]))
    time.sleep(0.05)
    d = ser.read(5)
    if len(d) >= 5:
        return d[1] << 24 | d[2] << 16 | d[3] << 8 | d[4]
    return None

def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A | (((addr >> 8) & 0x03) << 4), addr & 0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    d = ser.read(4)
    return d

def hs(v):
    return f'0x{v:08X}' if v is not None else 'FAIL'

print('=== UART 配置 ===')
ctrl = r(0x340)
print(f'UART.CONTROL = {hs(ctrl)}')
if ctrl:
    print(f'  RTMI_SAMPLING = {(ctrl >> 24) & 0xFF}')
    print(f'  RTMI_EN = {(ctrl >> 22) & 1}')
    print(f'  RTMI_CRC_EN = {(ctrl >> 21) & 1}')
    print(f'  NORMAL_CRC_EN = {(ctrl >> 20) & 1}')
    print(f'  RX_FILTER_EN = {(ctrl >> 19) & 1}')
    print(f'  AUTOBAUD_EN = {(ctrl >> 18) & 1}')
    print(f'  TIMEOUT_PRE_DIV = {(ctrl >> 16) & 1}')
    print(f'  MANTISSA_LIMIT = {ctrl & 0x1FFF}')

print(f'\nUART.STATUS = {hs(r(0x342))}')
print(f'UART.TIMEOUT = {hs(r(0x341))}')

# 测试写 UART.CONTROL 开启一些功能
# 开启 RX_FILTER (bit19) 看是否有区别
print('\n--- 测试: 开启 RX_FILTER ---')
new_ctrl = ctrl | (1 << 19)
w(0x340, new_ctrl)
time.sleep(0.05)
print(f'写入 0x{new_ctrl:08X}, 读回 {hs(r(0x340))}')

# 读 VERSION 看通信是否正常
print(f'VERSION: {hs(r(0x000))}')

# 写测试: 写 0x100 并读回
print('\n--- 写测试 ---')
w(0x100, 0x00000587)
time.sleep(0.1)
print(f'写 0x100=0x00000587, 读回 {hs(r(0x100))}')

# 读写测试: 用不同的寄存器
w(0x14E, 0x00640000)
time.sleep(0.1)
print(f'写 0x14E=0x00640000, 读回 {hs(r(0x14E))}')
print(f'TF_ACTUAL: {hs(r(0x153))}')

# 恢复
w(0x14E, 0)
w(0x100, 0)
w(0x340, ctrl)  # 恢复原始 UART 控制

ser.close()
print('\ndone')
