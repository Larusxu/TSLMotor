import serial, struct, time
ser = serial.Serial('COM6', 115200, timeout=0.3)
def r(a):
    ser.reset_input_buffer()
    ser.write(bytes([0x42|(((a>>8)&3)<<4),a&0xFF]))
    time.sleep(0.03)
    d=ser.read(5)
    return d
def w(a,v):
    ser.reset_input_buffer()
    ser.write(bytes([0x4A|(((a>>8)&3)<<4),a&0xFF])+struct.pack('>I',v))
    time.sleep(0.03)
    ser.read(4)

# 快速连续读 POS_ACTUAL 20次
print('POS_ACTUAL 连读20次:')
for i in range(20):
    d = r(0x155)
    print(f'  {" ".join(f"{b:02X}" for b in d)}')

# 写配置后再读
print('\n配置后:')
w(0x100, 0x8587)
time.sleep(0.1)
for i in range(10):
    d = r(0x155)
    print(f'  POS: {" ".join(f"{b:02X}" for b in d)}')

# 读不同寄存器交替
print('\n交替读:')
for i in range(10):
    d1 = r(0x153)
    d2 = r(0x154)
    d3 = r(0x155)
    print(f'  TF={" ".join(f"{b:02X}" for b in d1)} VEL={" ".join(f"{b:02X}" for b in d2)} POS={" ".join(f"{b:02X}" for b in d3)}')

w(0x100, 0)
ser.close()
