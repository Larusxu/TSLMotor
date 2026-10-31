# TSLmoni · TSLHand 主控模拟器

没有板子也能跑 TSL Viewer：本工程在**进程内**模拟一台 TSLHand 主控 + 16 个 TMC6460 电机节点，
行为对齐固件 `TSLHand/application/TeslaHand/common`（`moto/los_moto.c`、`Modbus/los_motor_routes.c`）。

零依赖、无硬件、不占用串口。

## 用法

### 1. 被 TSL Viewer 内嵌（推荐）

`TSLViewer/src-tauri/Cargo.toml` 已通过 path 依赖引入本 crate：

```toml
tslmoni = { path = "../../TSLmoni" }
```

启动 TSL Viewer 后，端口下拉的第一项固定是 **`SIM1 · 内置模拟器 · 无需硬件`**，选中并连接即可。
`src-tauri/src/simport.rs` 只做一层 `gateway::Wire` 适配，协议栈其余部分完全走真实代码。

### 2. 独立运行

```powershell
cargo run --release --bin tslmoni -- --selftest   # 协议自检
cargo run --release --bin tslmoni -- --rpc        # 十六进制报文服务器
```

`--rpc` 与固件的 host 测试桩一致：stdin 每行一个**网关报文**
（`1, seq_lo, seq_hi, motor, op, len, 0, payload...`，十六进制），stdout 回一行响应报文；
报文非法时不回任何内容（等价于线上无应答/超时）。

```powershell
# 读 1 号电机 INFO
'01020001040000' | .\target\release\tslmoni.exe --rpc
# -> 01020001040a00 0b 01 03 20 1a 01 00 01 00 10
#                     uart chip out sys conn ready ovf ic live config

# 读固件串（BOARD offset 0x08，8 个字）
'010300000a02000808' | .\target\release\tslmoni.exe --rpc
# -> ...0a00 + "TSL-SIM FWHOST01"
```

`--mode main485|maincan` 决定报文 `source`（1=RS485，2=CAN），默认 `main485`。

## 模拟范围

| 项 | 行为 |
| --- | --- |
| 报文 | `moto/los_moto.h` 的 11 个 op 码与 6 个状态码；长度/版本/保留字节校验，非法即丢弃 |
| 占用 | `MOTO_OPEN` 抢占 owner；5 s 无请求自动 `ALL_OFF`；其他 source → `MOTO_BUSY` |
| 主控 INFO | 4 字节 `[1,16,initialized,owner]` |
| 电机 INFO | 10 字节 `[uart,chip,output,sys,connector,ready,overflow,ic_ok,diagnostics_live,16\|mask]` |
| 板级快照 | `MOTO_BOARD(start,count)`，`count∈1..=64`、`start+count≤256`，每字 2 字节；`0x08` 起为固件串，word 73 为 HandID |
| 电源 | 4 片 MAX20087 掩码；`MOTO_POWER` 只接受 0/1，`MOTO_ALL_OFF` / `MOTO_CLOSE` 清零 |
| RX 环 | 每节点 2048 B，溢出锁存 → `MOTO_READ` 返回 `MOTO_OVERFLOW`，`MOTO_CLEAR` 复位 |
| 线路格式 | `main485` Modbus-RTU、`maincan` USB-CAN-A 分片（id 0x0600/0x0580，6 字节/帧）、`direct` 原始 TMC 数据报 |
| 电机侧 | 10-bit 寄存器全量读写、`CHIP.ID=0x64600001`、PWM_PERIOD 4800（25 kHz）、速度/位置/力矩模式简单动力学、RTMI 帧按 `UART.CONTROL` 采样率与 `RTMI_CH_x` 映射合成 |
| I/O 控制器 | `SPI_ENC` 起停回显 + 按转子相位合成 `PHI_EXT_A`；`I2C_INIT_PP/OD`、`I2C_READ/WRITE`、`I2C_EEPROM`、`RAM_READ/WRITE` |
| 板载 EEPROM | M24C02 仿真：256 B 镜像（擦除态 0xFF），`Simulator::new_persistent()` 时每个电机存到 `<temp>/tslmoni-eeprom-<n>.bin`，断开重连不丢 |

**不做真实 FOC/电流环物理**：阶跃响应、PID 辨识看到的是合成波形，不能作为调参依据。

## 自检

```powershell
cargo test --release      # 8 个单元测试
cargo run --release --bin tslmoni -- --selftest
```
