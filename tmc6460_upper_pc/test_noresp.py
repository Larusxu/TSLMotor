import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def show(d): return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

def d32(raw):
    if len(raw) < 5: return show(raw)
    return f'0x{(raw[1]<<24|raw[2]<<16|raw[3]<<8|raw[4]):08X}'

print('=== 不管写响应，只验证写入是否生效 ===')

# 辅助：发读请求 + drain + 读6字节
def r(addr):
    ser.reset_input_buffer()
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    time.sleep(0.05)
    # drain: read all available
    d = ser.read(6)
    return d

# 辅助：只写不发读
def w(addr, data):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((addr>>8)&3)<<4), addr&0xFF]) + struct.pack('>I', data))
    time.sleep(0.05)
    # 不管响应，直接drain
    ser.read(10)  # 吸干

# 读当前 GDRV
print(f'GDRV: {d32(r(0x101))} raw={show(r(0x101))}')

# 写 GDRV 全默认值
print(f'\n写 GDRV=0x81003431')
w(0x101, 0x81003431)
time.sleep(0.1)

# 反复读几次
for i in range(3):
    g = r(0x101)
    print(f'  [{i}] GDRV: {d32(g)} raw={show(g)}')
    time.sleep(0.05)

# 再写一次，sleep更长
print(f'\n写 GDRV=0x81003431 (等500ms)')
w(0x101, 0x81003431)
time.sleep(0.5)
g = r(0x101)
print(f'  GDRV: {d32(g)} raw={show(g)}')

# 读 UART.CONTROL (0x340) 检查 CRC 等配置
for addr in [0x340, 0x341, 0x342, 0x343]:
    v = r(addr)
    print(f'\nUART 0x{addr:03X}: {d32(v)} raw={show(v)}')

ser.close()
