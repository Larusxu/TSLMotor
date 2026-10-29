def crc8(data, poly=0x1D, init=0x00, refin=False, refout=False, xorout=0x00):
    crc = init
    for b in data:
        if refin:
            b = int(format(b, '08b')[::-1], 2)
        crc ^= b
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ poly) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    if refout:
        crc = int(format(crc, '08b')[::-1], 2)
    return crc ^ xorout

tests = [
    ('rd req   ', bytes([0x52, 0x40]), 0x12),
    ('write ex ', bytes([0x5A, 0x4E, 0x01, 0x00, 0x01, 0x00]), 0x5A),
    ('rd resp  ', bytes([0x52, 0x40, 0x00, 0x00, 0x85, 0x5C]), 0x6A),
]

print("=== Verify CRC-8: poly=0x1D, init=0x00, refin=True ===")
all_ok = True
for name, d, exp in tests:
    c = crc8(d, refin=True)
    ok = 'OK' if c == exp else 'FAIL'
    if c != exp: all_ok = False
    print(f"  {name}: got {c:02X} exp {exp:02X} [{ok}]")

if all_ok:
    print("\n=== CRC MATCH! ===")
    
    # GDRV write with CRC
    gdrv = bytes([0x5A, 0x01, 0x81, 0x00, 0x34, 0x31])
    crc = crc8(gdrv, refin=True)
    print(f"\nGDRV write CRC: 0x{crc:02X}")
    print(f"Full 7-byte cmd: 5A 01 81 00 34 31 {crc:02X}")
    
    # UART.CONTROL write (addr 0x340 = DA 40, data 0x01040208 to disable CRC)
    ctrl = bytes([0xDA, 0x40, 0x01, 0x04, 0x02, 0x08])
    crc = crc8(ctrl, refin=True)
    print(f"\nUART.CONTROL write CRC: 0x{crc:02X}")
    print(f"Full 7-byte cmd: DA 40 01 04 02 08 {crc:02X}")
    
    # UART read request with CRC: read 0x101
    rd = bytes([0x52, 0x01])
    crc = crc8(rd, refin=True)
    print(f"\nRead 0x101 CRC: 0x{crc:02X}")
    print(f"Full 3-byte cmd: 52 01 {crc:02X}")
else:
    print("CRC NOT MATCHED")
