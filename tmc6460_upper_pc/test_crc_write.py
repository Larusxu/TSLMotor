import serial, struct, time

def crc8(data, poly=0x1D, refin=True):
    crc = 0
    for b in data:
        if refin:
            b = int(format(b, '08b')[::-1], 2)
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ poly) if crc & 0x80 else (crc << 1)
            crc &= 0xFF
    return crc

ser = serial.Serial('COM6', 115200, timeout=0.3)

def show(d): return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

def r(addr):
    """3-byte read request (with CRC)"""
    cmd = bytes([0x42 | (((addr>>8)&3)<<4), addr & 0xFF])
    cmd += bytes([crc8(cmd)])
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    d = ser.read(8)
    return d

def w(addr, data):
    """7-byte write request (with CRC)"""
    cmd = bytes([0x4A|(((addr>>8)&3)<<4), addr & 0xFF]) + struct.pack('>I', data)
    cmd += bytes([crc8(cmd)])
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    d = ser.read(8)
    return d

print('=== 7-byte Write (with CRC-8) ===')
print()

# 1. 读当前 GDRV
g = r(0x101)
print(f'GDRV: len={len(g)} raw={show(g)}')

# 2. 7-byte 写 GDRV=0x81003431
cmd = bytes([0x5A, 0x01, 0x81, 0x00, 0x34, 0x31, 0xF1])
print(f'\nTX: {show(cmd)}')
ser.reset_input_buffer()
ser.write(cmd)
time.sleep(0.1)
wr = ser.read(8)
print(f'写响应: len={len(wr)} raw={show(wr)}')

# 3. 读回 GDRV
time.sleep(0.1)
g = r(0x101)
print(f'GDRV: len={len(g)} raw={show(g)}')

# 4. 如果不行，试直接 7-byte 写 UART.CONTROL 关 CRC
ctrl_cmd = bytes([0xDA, 0x40, 0x01, 0x04, 0x02, 0x08, 0x72])
print(f'\nTX UART.CTRL: {show(ctrl_cmd)}')
ser.reset_input_buffer()
ser.write(ctrl_cmd)
time.sleep(0.1)
ser.read(8)
ctrl = r(0x340)
print(f'UART.CONTROL: len={len(ctrl)} raw={show(ctrl)}')

ser.close()
