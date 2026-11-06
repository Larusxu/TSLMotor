# TSL Viewer · PyQt6 版（TSLViewer-2）

把 `TSLViewer`（Tauri + React + Rust）**当前工作区版本**移植为纯 Python 桌面应用：
PyQt6 负责界面，pyserial 负责串口，协议、找零、标定、存储、参数整定等逻辑全部在 Python 侧完成。

> 本目录对应 `TSLViewer` 工作区（含未提交的 2026-11-06 新页面：`SemanticHoming`、
> `FleetOverview`、`MainboardEncoder`、`Commissioning`）。设计令牌、页面结构、
> 中文文案与交互流程均按该版本复刻。

## 运行

```powershell
cd TSLViewer-2
python -m pip install -r requirements.txt
python main.py            # 接真实串口
python main.py --demo     # 离线演示：合成遥测，不打开串口
```

`run.bat` 等价于 `python main.py %*`。

## 目录

```
main.py                    入口（--demo）
tslviewer/
  app.py                   外壳：侧栏 / 顶栏 / 页头 / 电机工具栏 / 设置 / 提示
  theme.py                 设计令牌（深色/浅色）+ 全局 QSS
  icons.py                 矢量图标（QPainter，无外部资源）
  demo.py                  离线演示数据源
  core/
    protocol.py            TMC6460 UART 帧、CRC-8、CRC-16、RTMI 解析
    link.py                直连/主控 RS485/USB-CAN-A 传输、RTMI 线程
    semantic.py            主控语义协议 op 32（状态/授权/初始化/找零/点动）
    procedures.py          编码器写入、φ_e 对齐、PID、阶跃、序列、PRBS 辨识
    cylinder.py            LA 电缸协议 op 34
    fleet.py               16 路电机 + 4×MAX20087 供电快照解码
    registers.py           189 个寄存器表（由 scripts/gen_registers.py 生成）
    store.py               应用状态中枢（Qt 信号 + 工作线程）
    units.py / presets.py  单位换算 / 机型与信号目录
  widgets/                 卡片、按钮、字段、徽章、步骤、示波器、仪表、图表、遥测面板
  pages/                   12 个页面（与源项目一致）
scripts/gen_registers.py   从 TS 源重新生成寄存器表
```

## 页面（与当前源码一致）

| 页面 | 说明 |
| --- | --- |
| 运行概览 RUN | 直连：KPI + 开环点动 + 机器常数 + 驱动状态 + 故障位；主控：**FleetOverview**（阵列汇总、4×MAX20087、5 路电缸、16 路电机卡片/列表） |
| 电缸控制 LA | 五路电缸的阈值、行程、目标与实时状态（op 34） |
| 编码器与对齐 SSI | MT6701 SSI 参数、写入回读、角度仪表、φ_e 对齐（主控模式走 MCU 对齐） |
| 电机控制与找零 MOTION | 主控：找零状态/实际位置/机构速度、实时转速/电流/温度、电机控制（授权/停止/断使能/急停）、找零参数与双端找零 |
| 机械行程 AXIS | 丝杆换算、软限位、受控运动、回零向导 |
| PID 与限幅 TUNE | 顶部**实时遥测**（示波器 + RTMI 通道），三环 PID、归一化、限幅、阶跃测试 |
| 参数整定 IDENT | PRBS 激励、ARX(1,1) 辨识、双实极点 PI 设计、候选试用与历史 |
| 环路测试 LOOP | 恒 Iq/恒速度探测、速度 PI 倍率扫描、位置往复/正弦/保持 + 波形 |
| 板载存储 W25/M24 | 主控 W25 档案读写/导入导出、M24 备份读取与保存 |
| 寄存器 MAP | 189 寄存器浏览、位翻转、写读校验、快照对比 |
| 自动测试 QA | 档位序列、判据、CSV 报告 |
| 运行日志 LOG | 级别过滤、检索、复制、清空 |

## 与 Rust 后端对应的实现

* 直连帧：`read_request/write_request/parse_rtmi_frame/crc8`（`proto.rs`）。
* RTMI：`UART.CONTROL 0x340` + `RTMI_CH 0x344..0x34A`，写后读回，线程批量推送。
* 主控：RTU（`01 41 len payload crc16`）与 USB-CAN-A（`AA C0 xx 06 seq idx ... 55`）分片，
  语义 op 32、电缸 op 34、存储 op 33。
* RTMI 通道 → 工程量的换算与源项目 `convertSignal` 一致（速度按有符号 32 位）。

## 已知差异（下一轮）

* `MainboardEncoder` / `MainboardPid` 的 W25 档案二进制解码（电机档案/公共区）尚未完整移植；
  目前主控模式复用同一套 PID/对齐控件，寄存器读写与语义命令可正常工作。
* 电缸页顶部的 `CylinderToolbar` 在概览阵列里显示的是只读状态；完整写参数仍在电缸页。
* 参数整定页以「上位机驱动 PRBS」实现同样的 ARX/极点配置数学；源项目的 MCU 内建
  `IdentStart` 采集路径需配套固件，未在无固件环境启用。
