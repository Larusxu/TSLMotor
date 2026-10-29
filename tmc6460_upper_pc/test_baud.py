import serial, time

for baud in [115200, 460800, 9600, 19200, 38400, 57600, 230400, 921600]:
    try:
        ser = serial.Serial('COM6', baud, timeout=0.3)
        ser.reset_input_buffer()
        # 多发几次让 autobaud 锁定
        for _ in range(3):
            ser.write(bytes([0x42, 0x00]))
            time.sleep(0.01)
        time.sleep(0.05)
        r = ser.read(10)
        ser.close()
        if len(r) > 0:
            print(f'{baud}: {" ".join(f"{b:02X}" for b in r)}')
        else:
            print(f'{baud}: no response')
    except Exception as e:
        print(f'{baud}: error {e}')
