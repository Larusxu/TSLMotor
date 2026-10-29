#!/usr/bin/env python3
"""
TMC6460 开环诊断 v4 — EXT_CTRL.VOLTAGE 直接电压驱动, 已验证可转
用法: python diag_openloop.py COM10
"""
import serial, struct, time, sys

PORT = sys.argv[1] if len(sys.argv) > 1 else 'COM10'

def hexstr(d): return ' '.join(f'{b:02X}' for b in d) if d else 'EMPTY'

def r(addr):
    """读寄存器 (无 CRC)"""
    ser.reset_input_buffer()
    req = bytes([0x42 | (((addr>>8)&3)<<4), addr & 0xFF])
    ser.write(req); ser.flush(); time.sleep(0.01)
    d = ser.read(10)
    return req, d

def w(addr, data):
    """写寄存器 (无 CRC)"""
    ser.reset_input_buffer()
    req = bytes([0x4A | (((addr>>8)&3)<<4), addr & 0xFF]) + struct.pack('>I', data)
    ser.write(req); ser.flush(); time.sleep(0.01)
    d = ser.read(10)
    return req, d

def d32(raw):
    """解析读响应: 跳过2字节回显, 取4字节数据 (6字节总长, 无CRC模式无status字节)"""
    if len(raw) >= 6:
        return struct.unpack('>I', raw[2:6])[0]
    return None

print("=" * 60)
print(f" TMC6460 开环诊断 v4 (EXT_CTRL.VOLTAGE, {PORT})")
print("=" * 60)

ser = serial.Serial(PORT, 115200, timeout=0.2, write_timeout=0.2)

# 1. 通信检查
print("\n[1] 通信检查")
req, resp = r(0x00)
ver = d32(resp)
print(f"    TX: {hexstr(req)} RX({len(resp)}): {hexstr(resp)}")
print(f"    VERSION = 0x{ver:08X}" if ver else "    VERSION = FAIL")

# 2. 读关键寄存器
print("\n[2] 读关键寄存器")
regs = {
    0x100: "MOTOR_MOTION",
    0x101: "GDRV",
    0x009: "STATUS",
    0x00A: "EVENTS",
    0x14A: "TF_LIMITS",
    0x14E: "TF_TARGET",
    0x150: "VEL_TARGET",
    0x153: "TF_ACTUAL",
    0x154: "VEL_ACTUAL",
    0x155: "POS",
}
for addr, name in regs.items():
    req, resp = r(addr)
    v = d32(resp)
    extra = ""
    if v is not None:
        if addr == 0x101:
            extra = f" CP_EN={(v>>31)&1} DRV_EN={(v>>16)&1}"
    if v is not None:
        print(f"    0x{addr:03X} {name:16s}: TX {hexstr(req)} RX {hexstr(resp)} = 0x{v:08X}{extra}")
    else:
        print(f"    0x{addr:03X} {name:16s}: TX {hexstr(req)} RX {hexstr(resp)} FAIL")

# 3. 清除事件
print("\n[3] 清除事件")
w(0x00A, 0xFFFFFFFF)
w(0x081, 0xFFFFFFFF)
time.sleep(0.05)
req, resp = r(0x00A)
print(f"    EVENTS 清零后: {hexstr(resp)}")

# 4. GDRV: 开启 CP_EN + DRV_EN
print("\n[4] GDRV 开启 CP_EN(bit31) + DRV_EN(bit16)")
req, resp = r(0x101)
gdrv = d32(resp)
if gdrv is not None:
    new_gdrv = gdrv | (1<<31) | (1<<16)
    w(0x101, new_gdrv)
    time.sleep(0.05)
    _, vr = r(0x101)
    vc = d32(vr)
    if vc:
        print(f"    GDRV = 0x{vc:08X} CP_EN={(vc>>31)&1} DRV_EN={(vc>>16)&1}")
    else:
        print("    GDRV 写验证 FAIL")
else:
    print("    GDRV 读 FAIL")

# 5. 力矩限制
print("\n[5] 力矩限制 = 1000")
w(0x14A, 0x03E80000)
time.sleep(0.05)
_, resp = r(0x14A)
print(f"    TF_LIMITS = 0x{d32(resp):08X}" if d32(resp) else "    FAIL")

# 6. MOTOR_MOTION: OPENLOOP_VEL + RAMP
print("\n[6] OPENLOOP_VEL mode=2 + RAMP_USE_PHI_E + RAMP_EN + RAMP_MODE(VEL)")
# bit15=RAMP_USE_PHI_E, bit14=RAMP_EN, bit13=RAMP_MODE(1=vel), bits[12:9]=2(OPENLOOP_VEL), bits[8:7]=3(BLDC), bits[6:0]=1(1pole)
new_mm = (1<<15) | (1<<14) | (1<<13) | (2<<9) | (3<<7) | 1  # 0xE581
w(0x100, new_mm)
time.sleep(0.05)
_, resp = r(0x100)
v = d32(resp)
if v:
    print(f"    MOTOR_MOTION = 0x{v:08X}")
    print(f"      MODE={(v>>9)&0xF} RAMP_USE_PHI_E={(v>>15)&1} RAMP_EN={(v>>14)&1} RAMP_MODE={(v>>13)&1} POLES={v&0x7F}")
else:
    print("    FAIL")

# 7. Ramp 参数
print("\n[7] Ramp 参数")
w(0x1CE, 200000)       # V_MAX (提高)
w(0x1CA, 1000)          # V_START
w(0x1CC, 50000)         # A_MAX (加快加速)
w(0x1C4, 0x00050000)    # A1
time.sleep(0.05)
print(f"    V_MAX(0x1CE)   = 0x{d32(r(0x1CE)[1]):08X}" if d32(r(0x1CE)[1]) else "    V_MAX FAIL")
print(f"    V_START(0x1CA) = 0x{d32(r(0x1CA)[1]):08X}" if d32(r(0x1CA)[1]) else "    V_START FAIL")

# 8. 速度目标 (0x150)
print("\n[8] 速度目标")
VEL = 100000  # 提高速度
w(0x150, VEL)
time.sleep(0.05)
_, resp = r(0x150)
print(f"    VEL_TARGET = 0x{d32(resp):08X} ({VEL})" if d32(resp) else "    FAIL")

# 9. UD 电压驱动测试
print("\n[9] UD 电压驱动")
for ud in [5000, 10000, 15000]:
    w(0x200, ud)
    time.sleep(0.5)

    _, ra = r(0x153)  # TORQUE_ACTUAL
    _, rv = r(0x154)  # VEL_ACTUAL
    _, rp = r(0x155)  # POS
    _, re = r(0x00A)  # EVENTS

    ta = d32(ra)
    va = d32(rv)
    pa = d32(rp)
    ev = d32(re)

    t_act = ((ta>>16)&0xFFFF) if ta else 0
    if t_act > 0x7FFF:
        t_act -= 0x10000

    print(f"    UD={ud:5d} TA={t_act:6d} VA=0x{va:08X} PA=0x{pa:08X} EV=0x{ev:08X}")
    print(f"         raw TA={hexstr(ra)} VA={hexstr(rv)} PA={hexstr(rp)} EV={hexstr(re)}")

# 10. 恢复
print("\n[10] 恢复")
w(0x200, 0)            # UD 归零
w(0x100, 0)             # 关模式
w(0x14E, 0)             # 力矩归零
time.sleep(0.05)
_, resp = r(0x100)
print(f"    MOTOR_MOTION = 0x{d32(resp):08X}" if d32(resp) else "    FAIL")

ser.close()
print("\n✅ 完成")
