# TMC6460 电角度标定方法

> 此文档记录标定流程和关键参数。具体 OFFSET 值因电机而异，不记。

## 原理

14-bit 绝对值编码器（MT6701 SSI），每 360° 电角度编码器回到同一位置。利用此周期性，无需跨圈解缠绕。

### 步骤

1. **编码器配置** — `setup_encoder()` 一键配 SSI 通信
2. **电流环注入** — I_D 恒定（200~750mA），I_Q=0，TORQUE 模式保持电角度锁死
3. **720° 正转扫频** — 0°→90°→...→720°，每 90° 通过写 0x152（POS_TARGET）步进
4. **720° 反转扫频** — 720°→630°→...→0°，同上
5. **拟合** — 所有点按 `deg%360` 分组取平均，4 个平均点先解缠绕再线性拟合
6. **计算 OFFSET** — `PHI_E_OFFSET = -(b % 16384) × MUL_FACTOR`

## 寄存器设置

| 寄存器 | 地址 | 值 | 说明 |
|--------|------|------|------|
| CSA_GAIN | 0x0C3 | 3 | CSA=4x，配合 LS_RES_ON=3，1LSb=0.2013mA |
| TF_LIMITS | 0x14A | 0x20002000 | 8192/8192（max=2¹⁵/4） |
| MOTOR_MOTION | 0x100 | TORQUE + RAMP_POS + poles=1 | 力矩模式 + 位置 ramp |
| POS_TARGET | 0x152 | 16-bit（0x0000/0x4000/0x8000/0xC000） | 0°/90°/180°/270° |

## 电流换算（LS_RES_ON=3, CSA=4x）

来源：TMC6460 手册 Table 20 (Page 72)

```
I_D [A] = I_D_raw × 0.00164 / 8 × 4/4 × 0.982
1 LSb  = 0.2013 mA
raw_max = 32768 / 4 = 8192
满量程   = 1.65A
```

## 拟合公式

```python
# 4 个平均点先解缠绕（跨圈检测: delta < -8192 → +16384）
uw[0] = avg_enc[0]
uw[i] = uw[i-1] + delta_corrected

# enc_uw = k × deg + b
# b14 = b % 16384  （0°电角度时编码器14-bit值）
PHI_E_OFFSET = -b14 × MUL_FACTOR  # 写 0x242
```

## 评估标准

- R² > 0.999
- 各度残差 < ±80（< 0.5° 电角度）
- 不同 I_D 下 OFFSET 偏差 < ±50（< 0.3° 电角度）

## 注意事项

- **不要写 VEL_TARGET=0** 在 POS 模式下 — 会锁死 ramp
- POS_TARGET 用 **16-bit** 值，不是 32-bit
- CSA_GAIN=3 是 4x（不是 8x）
- TF_LIMITS 不要超过 8192（4x 增益下的 raw_max）
- 每个点到达目标后再 settle 1s，保证稳定
