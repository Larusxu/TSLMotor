# TMC6460 调试上位机

**状态：** 协议层 2026-05-19 实测修正，寄存器地址按 tmc6460.pdf 校正
**架构：** RTMI (Real Time Monitor Interface) + PyQt5 + pyqtgraph
**更新日期：** 2026-05-19

## 功能

1. **串口连接** — COM 口选择，波特率设置（默认 115200）
2. **寄存器读写** — 地址 hex 输入，单次读/写，原始数据显示
3. **实时波形** — 7 通道可选（力矩/磁通/速度/位置/目标值），pyqtgraph 实时绘图
4. **快速配置** — PID 参数、目标值控制面板
5. **寄存器树** — 按功能分组的寄存器列表，点击自动填入地址

## 使用方法

```bash
cd G:\project\hand\Tesla_hand\tmc6460_upper_pc
python main.py
```

## 依赖

- Python 3.13+
- pyserial 3.5
- PyQt5 5.15
- pyqtgraph 0.14
- numpy

## 协议说明（2026-05-19 实测确认）

- TMC6460 UART 115200 8N1（默认）
- CRC 不校验（芯片忽略 CRC 字节）
- 读请求：2 bytes → 读响应：5 bytes `[status][D3:D0]`
- 写请求：6 bytes → 写响应：4 bytes `[status][echo 3B]`
- 数据字节序：big-endian
- status: 0xA1=芯片寄存器, 0xA9=控制寄存器

## 文件结构

```
tmc6460_upper_pc/
├── main.py                  # 主界面 (PyQt5)
├── tmc6460_protocol.py      # 协议解析 + 寄存器定义
└── README.md
```

## 寄存器来源

- `G:\project\hand\Tesla_hand\tmc6460.pdf` — TMC6460 数据手册
- Page 147-170: 寄存器详细定义
- Page 31-40: UART 协议格式
