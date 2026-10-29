import serial
try:
    ser = serial.Serial('COM6', 115200, timeout=0.5)
    ser.write(bytes([0x42, 0x00]))
    import time; time.sleep(0.05)
    r = ser.read(5)
    print(f'OK len={len(r)} {" ".join(f"{b:02X}" for b in r)}')
    ser.close()
except Exception as e:
    print(f'ERR: {e}')
