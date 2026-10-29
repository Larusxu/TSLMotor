# Verify CRC-8 polynomial from datasheet
# P(x) = x^8 + x^4 + x^3 + x^2 + 1 = 0x1D

data1 = bytes([0x52, 0x40])  # read req to 0x140
exp1 = 0x12

data2 = bytes([0x5A, 0x4E, 0x01, 0x00, 0x01, 0x00])  # write to 0x14E
exp2 = 0x5A

data3 = bytes([0x52, 0x40, 0x00, 0x00, 0x85, 0x5C])  # read resp
exp3 = 0x6A

def crc8(data, poly=0x1D, init=0x00, refin=False, refout=False, xorout=0x00):
    crc = init
    for b in data:
        if refin:
            b = int(f'{b:08b}'[::-1], 2)
        crc ^= b
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ poly) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    if refout:
        crc = int(f'{crc:08b}'[::-1], 2)
    return crc ^ xorout

# Test known examples
tests = [
    ("read req 0x140", data1, exp1),
    ("write 0x14E", data2, exp2),
    ("read resp", data3, exp3),
]

# Try without bit reflection first
print("=== Simple CRC-8, poly=0x1D ===")
for name, data, exp in tests:
    c = crc8(data)
    print(f"  {name}: {c:02X} (exp {exp:02X}) {'OK' if c==exp else 'FAIL'}")

# MSB-first interpretation of poly
print("\n=== Poly=0x07 (0x1D reversed) ===")
for init in [0x00, 0xFF]:
    for refin in [False, True]:
        for refout in [False, True]:
            for xorout in [0x00, 0xFF]:
                ok = True
                for name, data, exp in tests:
                    c = crc8(data, poly=0x07, init=init, refin=refin, refout=refout, xorout=xorout)
                    if c != exp:
                        ok = False
                        break
                if ok:
                    print(f"  init=0x{init:02X} refin={refin} refout={refout} xorout=0x{xorout:02X}")

print("\n=== Poly=0x1D (MSB) with reflections ===")
for init in [0x00, 0xFF]:
    for refin in [False, True]:
        for refout in [False, True]:
            for xorout in [0x00, 0xFF]:
                ok = True
                for name, data, exp in tests:
                    c = crc8(data, poly=0x1D, init=init, refin=refin, refout=refout, xorout=xorout)
                    if c != exp:
                        ok = False
                        break
                if ok:
                    print(f"  init=0x{init:02X} refin={refin} refout={refout} xorout=0x{xorout:02X}")

# Poly=0x8C? (reversed 0x1D with leading 1 -> 0x8E? no... 0x1D reversed = 0xB8)
# Actually: 0x1D = 00011101, reversed = 10111000 = 0xB8
print("\n=== Poly=0xB8 (0x1D fully reversed) ===")
for init in [0x00, 0xFF]:
    for refin in [False, True]:
        for refout in [False, True]:
            for xorout in [0x00, 0xFF]:
                ok = True
                for name, data, exp in tests:
                    c = crc8(data, poly=0xB8, init=init, refin=refin, refout=refout, xorout=xorout)
                    if c != exp:
                        ok = False
                        break
                if ok:
                    print(f"  init=0x{init:02X} refin={refin} refout={refout} xorout=0x{xorout:02X}")
