"""LA cylinder protocol (gateway op 34), ported from ``src-tauri/src/cylinder.rs``."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from .link import Link, LinkError

OP = 34
LOCK = threading.Lock()


@dataclass
class Snapshot:
    pending: bool = False
    result: int = 0
    ticket: int = 0
    permit: bool = False
    online: bool = False
    id: int = 1
    position: int = 0
    target: int = 0
    current_ma: int = 0
    temperature_c: int = 0
    restart_c: int = 0
    current_limit_ma: int = 0
    temperature_limit_c: int = 0
    fault: int = 0
    lower: int = 0
    upper: int = 2000
    initial: int = 0
    storage_ready: bool = False


def encode(op: int, cid: int, values: tuple[int, ...] = ()) -> bytes:
    if not 1 <= cid <= 254:
        raise LinkError("电缸 ID 需为 1…254")
    payload = bytearray([op, cid])
    for value in values:
        payload += int(value).to_bytes(2, "little")
    return bytes(payload)


def decode(p: bytes) -> Snapshot:
    if len(p) != 68 or p[0] != 1:
        raise LinkError("电缸响应格式不匹配，请确认已更新主控固件")

    def w(i: int) -> int:
        return int.from_bytes(p[i : i + 2], "little")

    def reg(addr: int) -> int:
        return w(8 + 2 * (addr - 0x16))

    return Snapshot(
        pending=p[1] != 0,
        result=w(2) if w(2) < 0x8000 else w(2) - 0x10000,
        ticket=w(4),
        permit=p[6] != 0,
        online=p[7] != 0,
        id=p[67],
        target=reg(0x29),
        position=reg(0x2A),
        current_ma=reg(0x2B),
        temperature_c=reg(0x2E) if reg(0x2E) < 0x8000 else reg(0x2E) - 0x10000,
        restart_c=reg(0x1F),
        current_limit_ma=reg(0x20),
        temperature_limit_c=reg(0x1E),
        fault=reg(0x2F),
        lower=w(60),
        upper=w(62),
        initial=w(64),
        storage_ready=p[66] != 0,
    )


def execute(link: Link, channel: int, op: int, cid: int, values: tuple[int, ...] = ()) -> Snapshot:
    if not 1 <= channel <= 5:
        raise LinkError("电缸通道需为 1…5")
    if op == 3:
        lower, upper, initial = values
        if lower > upper or upper > 2000 or initial < lower or initial > upper:
            raise LinkError("行程需满足 0 ≤ 下限 ≤ 初始位置 ≤ 上限 ≤ 2000")
    if op == 4 and values and values[0] > 2000:
        raise LinkError("目标行程超出 0…2000")
    payload = encode(op, cid, values)

    def call(data: bytes) -> Snapshot:
        return decode(link.gateway_control(channel, OP, data))

    with LOCK:
        snap = call(payload)
        if op == 0:
            return snap
        if snap.result != 0:
            raise LinkError(f"电缸 C{channel} 请求未执行，主控结果 {snap.result}")
        ticket = snap.ticket
        start = time.monotonic()
        while snap.pending:
            if time.monotonic() - start > 4:
                raise LinkError(f"电缸 C{channel} 操作完成状态未确认，请读取核对；未自动重发")
            time.sleep(0.025)
            snap = call(bytes([0, payload[1]]))
            if snap.ticket != ticket:
                raise LinkError("电缸请求被另一控制端替换，请读取当前状态")
        if snap.result != 0:
            raise LinkError(f"电缸 C{channel} 操作失败（{snap.result}），请检查 ID、接线及供电")
        link.log("ok", "cylinder", f"C{channel} UART{channel + 17} 操作 {payload[0]} 完成")
        return snap
