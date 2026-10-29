import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def show(d):
    return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

# 先读 FOC.PID_TORQUE_FLUX_TARGET (0x14E) 当前值
print('=== 精确复现手册示例 ===')
print(f'0x14E 当前: {show(ser_read:=ser.read(6))}')

# 按手册: 5A 4E 01 00 01 00
cmd = bytes([0x5A, 0x4E, 0x01, 0x00, 0x01, 0x00])
print(f'\n发送: {show(cmd)}')
ser.reset_input_buffer()
ser.write(cmd)
time.sleep(0.05)
# 尝试读 5/6/8 字节看看到底几个
for n in [4,5,6,7,8]:
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    d = ser.read(n)
    print(f'  读{n}字节: len={len(d)} {show(d)}')

ser.close()
