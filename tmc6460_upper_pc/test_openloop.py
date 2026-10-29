import serial, struct, time

ser = serial.Serial('COM6', 115200, timeout=0.3)

def show(d): return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

def d32(raw):
    if len(raw) < 4: return show(raw)
    return f'0x{int.from_bytes(raw[:4], "big"):08X}'

def r(addr):
    cmd = bytes([0x42 | (((addr>>8)&3)<<4), addr & 0xFF])
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    d = ser.read(6)
    return d

def w(addr, data):
    cmd = bytes([0x4A|(((addr>>8)&3)<<4), addr & 0xFF]) + struct.pack('>I', data)
    ser.reset_input_buffer()
    ser.write(cmd)
    time.sleep(0.05)
    d = ser.read(6)
    return d

print('=== Open Loop Velocity Mode ===')
print()

# Read initial state
print('--- Initial State ---')
for reg, addr in [('GDRV',0x101), ('MOTOR_MOTION',0x100), ('V_MAX',0x1CE),
                   ('A_MAX',0x1CC), ('V_START',0x1CA), ('VEL_TARGET',0x14C),
                   ('VEL_ACTUAL',0x154), ('POS_ACTUAL',0x155), ('PHI_E',0x1D2),
                   ('STATUS',0x009)]:
    v = r(addr)
    print(f'  RD 0x{addr:03X}: TX 42 {addr&0xFF:02X}  RX {show(v)}')

print()

# Step 1: GDRV DRV_EN=1
print('--- Step1: GDRV DRV_EN=1 ---')
cmd = bytes([0x5A, 0x01, 0x00, 0x01, 0x00, 0x00])
print(f'  TX: {show(cmd)}')
wr = w(0x101, 0x00010000)
print(f'  Write resp: {show(wr)}')
time.sleep(0.05)
rd = r(0x101)
print(f'  RD GDRV:    {show(rd)}')

# Step 2: Set ramp parameters
print('\n--- Step2: Ramp Parameters ---')
# V_MAX=100000
cmd_vmax = bytes([0x5A, 0xCE, 0x00, 0x01, 0x86, 0xA0])
print(f'  TX V_MAX=100000: {show(cmd_vmax)}')
w(0x1CE, 0x000186A0)
print(f'  RD V_MAX: {show(r(0x1CE))}')

# A_MAX=5000
print(f'  TX A_MAX=5000:')
w(0x1CC, 5000)
print(f'  RD A_MAX: {show(r(0x1CC))}')

# V_START=0
print(f'  TX V_START=0:')
w(0x1CA, 0)
print(f'  RD V_START: {show(r(0x1CA))}')

# Step 3: MOTOR_MOTION = RAMP_EN + RAMP_USE_PHI_E + RAMP_MODE(VEL) + MOTION_MODE(VELOCITY) + BLDC + 2poles
print('\n--- Step3: MOTOR_MOTION ---')
# RAMP_USE_PHI_E(15) | RAMP_EN(14) | RAMP_MODE(13=VEL) | MOTION_MODE(12:9=3=VELOCITY) | MOTOR_TYPE(8:7=3=BLDC) | N_POLE_PAIRS(6:0=2)
mm = (1<<15) | (1<<14) | (1<<13) | (3<<9) | (3<<7) | 2  # = 0xE782
cmd_mm = bytes([0x5A, 0x00, 0x00, 0x00, 0xE7, 0x82])
print(f'  TX MM=0x{mm:04X}: {show(cmd_mm)}')
w(0x100, mm)
print(f'  RD MOTOR_MOTION: {show(r(0x100))}')

# Step 4: Set velocity target
print('\n--- Step4: Velocity Target ---')
vel_target = 50000
cmd_vel = struct.pack('>I', vel_target)
print(f'  TX VEL_TARGET={vel_target}: 5A 4C {show(cmd_vel)}')
w(0x14C, vel_target)
print(f'  RD VEL_TARGET: {show(r(0x14C))}')

# Step 5: Monitor
print('\n--- Step5: Monitor (10 samples @ 200ms) ---')
print(f'  {"t":4s} {"VEL_ACT":>12s} {"POS_ACT":>12s} {"PHI_E":>12s}')
for i in range(10):
    time.sleep(0.2)
    vel = r(0x154)
    pos = r(0x155)
    phi = r(0x1D2)
    print(f'  {i:4d} {d32(vel):>12s} {d32(pos):>12s} {d32(phi):>12s}')

# Stop
print('\n--- Stop ---')
w(0x100, 0)
print(f'  RD MOTOR_MOTION: {show(r(0x100))}')

ser.close()
print('\ndone')
