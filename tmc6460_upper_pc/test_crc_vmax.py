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

def r_crc(addr):
    cmd = bytes([0x42 | (((addr>>8)&3)<<4), addr & 0xFF])
    cmd += bytes([crc8(cmd)])
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    return ser.read(8)

def w_crc(addr, data):
    cmd = bytes([0x4A|(((addr>>8)&3)<<4), addr & 0xFF]) + struct.pack('>I', data)
    cmd += bytes([crc8(cmd)])
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    return ser.read(8)

print('=== 验证7字节CRC写入 ===')

# Test 1: Write V_MAX with known pattern
print(f'\nV_MAX(0x1CE) before: {show(r_crc(0x1CE))}')
print(f'Write 0x0000ABCD to V_MAX...')
wresp = w_crc(0x1CE, 0x0000ABCD)
print(f'  Write resp: {show(wresp)}')
time.sleep(0.1)
v = r_crc(0x1CE)
print(f'  V_MAX after: {show(v)}')

# Test 2: Write GDRV default with CRC
print(f'\nGDRV(0x101) before: {show(r_crc(0x101))}')
print(f'Write 0x81003431 to GDRV...')
wresp = w_crc(0x101, 0x81003431)
print(f'  Write resp: {show(wresp)}')
time.sleep(0.1)
g = r_crc(0x101)
print(f'  GDRV after: {show(g)}')

# Test 3: Read several times quickly to catch any transient
print(f'\nRapid reads GDRV after write 0x81003431:')
w_crc(0x101, 0x81003431)
for i in range(5):
    g = r_crc(0x101)
    print(f'  [{i}] {show(g)}')
    time.sleep(0.02)

ser.close()
