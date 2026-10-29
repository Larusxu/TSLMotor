#!/usr/bin/env python3
"""测试不同 RTS 延时对读响应的影响"""
import serial, struct, time, sys

PORT = sys.argv[1] if len(sys.argv) > 1 else 'COM10'

def hexstr(d): return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

def try_read(ser, addr, delay_ms, use_rts=True, read_bytes=10):
    """用不同参数尝试读"""
    ser.reset_input_buffer()
    if use_rts:
        ser.rts = True
        time.sleep(0.002)
    ser.write(bytes([0x42 | (((addr>>8)&3)<<4), addr&0xFF]))
    ser.flush()
    if use_rts:
        time.sleep(delay_ms / 1000.0)  # 等方向切换
        ser.rts = False
    time.sleep(delay_ms / 1000.0)
    d = ser.read(read_bytes)
    return d

ser = serial.Serial(PORT, 115200, timeout=0.3)

print(f"测试端口: {PORT}")
print(f"RTS 支持: {hasattr(ser, 'rts')}")

# Test 1: 不用 RTS (自动方向)
print("\n--- 测试1: 不用 RTS (自动方向切换) ---")
ser.rts = False
for delay in [0.01, 0.02, 0.05]:
    d = try_read(ser, 0x100, int(delay*1000), use_rts=False)
    print(f"  delay={delay:.2f}s RX: {hexstr(d)}")

# Test 2: RTS + 长延时
print("\n--- 测试2: RTS + 不同延时 ---")
for delay_ms in [10, 20, 50, 100]:
    d = try_read(ser, 0x100, delay_ms, use_rts=True)
    echo_bytes = d[:2] if len(d)>=2 else d
    resp_bytes = d[2:] if len(d)>=2 else b''
    print(f"  delay={delay_ms}ms RX: {hexstr(d)}")
    print(f"           echo=[{hexstr(echo_bytes)}] resp=[{hexstr(resp_bytes)}]")

# Test 3: 读更多字节
print("\n--- 测试3: RTS+50ms, 读20字节 ---")
ser.reset_input_buffer()
ser.rts = True; time.sleep(0.002)
ser.write(bytes([0x42 | (((0x100>>8)&3)<<4), 0x100 & 0xFF]))
ser.flush()
time.sleep(0.05)
ser.rts = False
time.sleep(0.05)
d = ser.read(20)
print(f"  RX({len(d)}): {hexstr(d)}")

# Test 4: 验证写是真的生效了
print("\n--- 测试4: 写 MOTOR_MOTION=0x0581, 然后用不同方法读回 ---")
ser.rts = True; time.sleep(0.002)
ser.write(bytes([0x5A, 0x00, 0x00, 0x00, 0x05, 0x81]))
ser.flush()
ser.rts = False
time.sleep(0.01)
wr = ser.read(8)
print(f"  写响应: {hexstr(wr)}")
time.sleep(0.1)

# 用多种延时读回
for delay_ms in [20, 50, 100]:
    d = try_read(ser, 0x100, delay_ms, use_rts=True)
    # Skip echo (first 2 bytes), parse next 5
    if len(d) >= 7:
        resp = d[2:7]
        val = (resp[1]<<24)|(resp[2]<<16)|(resp[3]<<8)|resp[4]
        mode = (val>>9)&0xF
        poles = val&0x7F
        print(f"  delay={delay_ms}ms: raw={hexstr(d)}")
        print(f"    跳过echo后: status=0x{resp[0]:02X} data=0x{val:08X} MODE={mode} POLES={poles}")
    else:
        print(f"  delay={delay_ms}ms: raw={hexstr(d)} (太短)")

ser.close()
print("\n完成")
