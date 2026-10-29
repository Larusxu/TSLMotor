"""encoder_test.py — 最小编码器读测试"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tmc6460_protocol import TMC6460Serial
from tmc6460_encoder import setup_encoder

port = sys.argv[1] if len(sys.argv) > 1 else "COM10"
tmc = TMC6460Serial(port=port)
if not tmc.connect():
    print("连接失败"); exit(1)

# 1. 一键配置
ok, msg = setup_encoder(tmc, "MT6701 (SSI, 14-bit)", pole_pairs=1)
print(f"setup_encoder: {msg}")
if not ok:
    print("编码器配置失败"); exit(1)

# 2. 轮询读 0x24D
print("轮询 PHI_EXT_A (0x24D)...")
for i in range(50):
    val = tmc.read_register(0x24D)
    if val is not None:
        raw14 = val & 0x3FFF
        deg = raw14 * 360.0 / 16384.0
        print(f"  [{i:3d}] raw=0x{val:08X}  14bit={raw14:5d}  deg={deg:.2f}°")
    else:
        print(f"  [{i:3d}] read FAIL")
    time.sleep(0.1)

tmc.disconnect()
