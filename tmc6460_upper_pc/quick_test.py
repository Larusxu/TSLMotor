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

print(f'VER: {" ".join(f"{b:02X}" for b in r(0x000))}')
w(0x100, 0x8587)  # RAMP_USE_PHI_E=1, TORQUE, BLDC, 7poles
w(0x14A, 0x00C80000)  # torque_limit=200
w(0x00A, 0xFFFFFFFF)  # clear events
w(0x081, 0xFFFFFFFF)
for t in [0, 50, 100, 200, 100, 0]:
    w(0x14E, (t << 16) & 0xFFFF0000)
    time.sleep(0.5)
    tf = rv(0x153)
    vel = rv(0x154)
    pos = rv(0x155)
    ta = ((tf >> 16) & 0xFFFF) if tf else 0
    if ta > 0x7FFF: ta -= 0x10000
    print(f't={t:4d} torque={ta} vel=0x{vel:08X} pos=0x{pos:08X}' if tf else f't={t} FAIL')
w(0x14E, 0)
w(0x100, 0)
ser.close()
