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
    ser.read(8)

print('=== GDRV 位写入粒度测试 ===')
print(f'Current: {show(r_crc(0x101))}')
print()

# Test patterns
tests = [
    (0x80000000, 'CHARGE_PUMP_EN(bit31)'),
    (0x10000000, 'LP_MODE_EN(bit28)'),
    (0x01000000, 'USE_INTERNAL_R_REF(bit24)'),
    (0x00010000, 'DRV_EN(bit16)'),
    (0x00000001, 'LSB(bit0)'),
    (0x0000FFFF, 'lower 16 bits'),
    (0x00FF0000, 'bits 23:16'),
    (0xFF000000, 'bits 31:24'),
]

for val, name in tests:
    w_crc(0x101, val)
    time.sleep(0.05)
    raw = r_crc(0x101)
    v = int.from_bytes(raw, 'big') if len(raw)==4 else 0
    ok = 'OK' if (v & val) or (v & (val>>8)) else 'X'
    print(f'  {name:30s} wrote 0x{val:08X} -> {show(raw)}')

# Restore DRV_EN
print(f'\nRestore DRV_EN=1...')
w_crc(0x101, 0x00010000)
print(f'GDRV: {show(r_crc(0x101))}')

ser.close()
