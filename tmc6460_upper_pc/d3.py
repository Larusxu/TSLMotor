import serial, struct, time
ser = serial.Serial('COM6', 115200, timeout=0.3)
def r(a):
    ser.reset_input_buffer()
    ser.write(bytes([0x42|(((a>>8)&3)<<4),a&0xFF]))
    time.sleep(0.03)
    d=ser.read(5)
    return (d[1]<<24|d[2]<<16|d[3]<<8|d[4]) if len(d)>=5 else None
def w(a,v):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((a>>8)&3)<<4),a&0xFF])+struct.pack('>I',v))
    time.sleep(0.03)
    ser.read(4)

# dump
for a in [0x100,0x101,0x102,0x105,0x065]:
    v=r(a)
    print(f'0x{a:03X}=0x{v:08X}' if v else f'0x{a:03X}=FAIL')

# CHOP
v=r(0x102)
print(f'CHOP={v&7}' if v else 'CHOP=FAIL')

# 配置
w(0x102, 7)  # CENTERED
w(0x100, 0x8587)  # RAMP_PHI_E, TORQUE, BLDC, 7
w(0x14A, 0x00C80000)
w(0x00A, 0xFFFFFFFF)

# 给力矩1秒
w(0x14E, 0x00640000)
time.sleep(1)
print(f'TF={r(0x153):08X}' if r(0x153) else 'TF=FAIL')
print(f'VEL={r(0x154):08X}' if r(0x154) else 'VEL=FAIL')
print(f'POS={r(0x155):08X}' if r(0x155) else 'POS=FAIL')
w(0x14E, 0)
ser.close()
