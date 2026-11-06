"""Gateway semantic protocol (op 32) — Stage C.

Ported subset of ``src-tauri/src/semantic_control.rs``: state polling, motion
authorisation, power/config commissioning, jog/stop and homing configuration.
Payloads use little-endian integers exactly like the MCU contract.
"""

from __future__ import annotations

import random
import struct
import time
from dataclasses import dataclass
from typing import Any

from .link import Link, LinkError

OP = 32
NAMES = [
    "OK", "BUSY", "NOT_AUTHORIZED", "DRIVE_NOT_READY", "ALIGN_INVALID", "HOME_INVALID",
    "OUT_OF_RANGE", "STALE_SESSION", "TIMEOUT", "FAULT_LATCHED", "CONFIG_MISMATCH",
    "EEPROM_INVALID", "UNSUPPORTED", "IO_ERROR", "BAD_REQUEST", "TRAVEL_LIMIT",
]

CODES = {
    "get_state": 1,
    "position_state": 1,
    "encoder_state": 1,
    "rtmi_state": 1,
    "open": 2,
    "pulse": 3,
    "close": 4,
    "permit": 5,
    "drive_disable": 6,
    "drive_enable": 7,
    "limits": 8,
    "mode": 9,
    "jog_start": 10,
    "jog_renew": 11,
    "move": 12,
    "stop": 14,
    "estop": 15,
    "clear_fault": 16,
    "status": 17,
    "commission": 18,
    "alignment": 18,
    "homing_start": 18,
    "homing_config_read": 21,
    "homing_config_write": 22,
    "pi_tune": 23,
    "rtmi_config": 25,
    "task_speed": 26,
    "velocity_start": 27,
    "open_loop_start": 30,
}


@dataclass
class MotorState:
    sampled_at_ms: int = 0
    fault: int = 0
    last_error: int = 0
    position: int = 0
    negative_contact: int = 0
    positive_contact: int = 0
    velocity_raw: int = 0
    iq_raw: int = 0
    connection: bool = False
    permit: bool = False
    drive: int = 0
    align_valid: bool = False
    home_neg_valid: bool = False
    home_pos_valid: bool = False
    span_valid: bool = False
    motion_owner: int = 0
    feedback_fresh: bool = False
    config_verified: bool = False
    logic_power: bool = False
    motion_active: bool = False
    effective_iq_raw: int = 0
    effective_velocity_raw: int = 0
    mode: int = 0
    safety_phase: int = 0
    limits_valid: bool = False
    pending_action: int = 0
    logical_position: int | None = None
    logical_span: int | None = None
    margin_counts: int | None = None
    coordinate_valid: bool = False
    temperature_raw: int | None = None
    arrival_phase: int | None = None
    arrival_flags: int | None = None


@dataclass
class DeviceState:
    capabilities: int = 0
    motors: int = 0
    source: int = 0
    active_motor: int = 0
    stopping: bool = False
    request_floor: int = 0


@dataclass
class SemanticReply:
    operation: int = 0
    request_id: int = 0
    boot_id: str = "0"
    session_id: int = 0
    task_id: int = 0
    timestamp_ms: int = 0
    result: int = 0
    result_name: str = "OK"
    replayed: bool = False
    pending: bool = False
    device: DeviceState | None = None
    motor: MotorState | None = None
    homing_config: list[int] | None = None
    raw: bytes = b""


def _u32(p: bytes, i: int) -> int:
    return int.from_bytes(p[i : i + 4], "little")


def _i32(p: bytes, i: int) -> int:
    return int.from_bytes(p[i : i + 4], "little", signed=True)


def _i64(p: bytes, i: int) -> int:
    return int.from_bytes(p[i : i + 8], "little", signed=True)


def _i16(p: bytes, i: int) -> int:
    return int.from_bytes(p[i : i + 2], "little", signed=True)


class SemanticSession:
    """One open gateway session; the MCU owns execution and latching."""

    def __init__(self, link: Link, motor: int) -> None:
        self.link = link
        self.motor = motor
        self.boot_id = "0"
        self.session_id = 0
        self.task_id = 0
        self.request_id = random.randint(1, 1000)
        self.permit_wanted = False
        self.last_reply: SemanticReply | None = None

    # ------------------------------------------------------------- framing
    def command(self, motor: int | None = None, kind: str = "get_state", **args: Any) -> SemanticReply:
        motor = self.motor if motor is None else motor
        op = CODES[kind]
        self.request_id = (self.request_id + 1) & 0xFFFFFFFF or 1
        payload = bytearray([2, op])
        payload += struct.pack("<I", self.request_id)
        payload += struct.pack("<Q", int(self.boot_id or "0"))
        payload += struct.pack("<I", self.session_id)
        payload += struct.pack("<I", self.task_id)
        if kind == "permit":
            payload.append(1 if args.get("enabled") else 0)
            payload += struct.pack("<I", int(args.get("lease_ms", 0)))
        elif kind == "stop":
            payload.append(int(args.get("after", 1)))
        elif kind in ("jog_start", "velocity_start", "open_loop_start"):
            payload += struct.pack("<i", int(args.get("velocity_raw", 0)))
            payload += struct.pack("<I", int(args.get("lease_ms", 700)))
        elif kind == "task_speed":
            payload += struct.pack("<I", int(args.get("velocity_raw", 0)))
            payload.append(int(args.get("mode", 0)))
        elif kind == "move":
            payload += struct.pack("<q", int(args.get("position", 0)))
        elif kind == "commission":
            payload.append(int(args.get("action", 1)))
        elif kind == "homing_start":
            payload.append(int(args.get("direction", 0)))
            payload += struct.pack("<H", int(args.get("step_unit", 100)))
            payload.append(1 if args.get("dual") else 0)
        elif kind == "homing_config_write":
            for value in args.get("config", [0] * 8):
                payload += struct.pack("<H", int(value) & 0xFFFF)
        elif kind == "alignment":
            payload.append(2)
            for value in (
                int(args.get("scan_degrees", 720)),
                int(args.get("step_degrees", 90)),
                int(args.get("settle_ms", 700)),
                int(args.get("current_ma", 300)),
            ):
                payload += struct.pack("<H", value)
            payload.append(1 if args.get("clearance") else 0)
        reply = self.link.gateway_control(motor, OP, bytes(payload))
        decoded = self.decode(motor, kind, bytes(payload), reply)
        self.last_reply = decoded
        if decoded.result == 0 and decoded.boot_id != "0":
            self.boot_id = decoded.boot_id
        if decoded.session_id:
            self.session_id = decoded.session_id
        if decoded.task_id:
            self.task_id = decoded.task_id
        return decoded

    def decode(self, motor: int, kind: str, request: bytes, p: bytes) -> SemanticReply:
        if len(p) < 28:
            raise LinkError("语义状态长度错误")
        op = CODES[kind]
        if p[0] != 2 or p[1] != op or _u32(p, 2) != _u32(request, 2):
            raise LinkError("语义响应身份/标志不匹配")
        result = p[22]
        if result >= len(NAMES):
            raise LinkError("未知主控结果码")
        reply = SemanticReply(
            operation=op,
            request_id=_u32(p, 2),
            boot_id=str(int.from_bytes(p[6:14], "little")),
            session_id=_u32(p, 14),
            task_id=_u32(p, 18),
            result=result,
            result_name=NAMES[result],
            replayed=bool(p[23] & 1),
            pending=bool(p[23] & 2),
            timestamp_ms=_u32(p, 24),
            raw=p,
        )
        if result != 0:
            return reply
        body = p[28:]
        if motor == 0:
            if len(body) >= 12:
                reply.device = DeviceState(
                    capabilities=_u32(body, 0),
                    motors=body[4],
                    source=body[5],
                    active_motor=body[6],
                    stopping=bool(body[7]),
                    request_floor=_u32(body, 8),
                )
            return reply
        if kind in ("homing_config_read", "homing_config_write"):
            if len(body) >= 16:
                reply.homing_config = [int.from_bytes(body[i * 2 : i * 2 + 2], "little") for i in range(8)]
            return reply
        if kind in ("position_state", "encoder_state", "rtmi_state"):
            return reply
        if len(body) < 68:
            return reply
        m = MotorState(
            sampled_at_ms=_u32(body, 0),
            fault=_u32(body, 4),
            last_error=_u32(body, 8),
            position=_i64(body, 12),
            negative_contact=_i64(body, 20),
            positive_contact=_i64(body, 28),
            velocity_raw=_i32(body, 36),
            iq_raw=_i32(body, 40),
            connection=bool(body[44]),
            permit=bool(body[45]),
            drive=body[46],
            align_valid=bool(body[47]),
            home_neg_valid=bool(body[48]),
            home_pos_valid=bool(body[49]),
            span_valid=bool(body[50]),
            motion_owner=body[51],
            feedback_fresh=bool(body[52]),
            config_verified=bool(body[53]),
            logic_power=bool(body[54]),
            motion_active=bool(body[55]),
            effective_iq_raw=_u32(body, 56),
            effective_velocity_raw=_u32(body, 60),
            mode=body[64],
            safety_phase=body[65],
            limits_valid=bool(body[66]),
            pending_action=body[67],
        )
        if len(p) >= 120 and body[88] != 0:
            m.coordinate_valid = True
            m.logical_position = _i64(body, 68)
            m.logical_span = _i64(body, 76)
            m.margin_counts = _u32(body, 84)
        if len(p) >= 120 and body[91] == 1:
            m.temperature_raw = _i16(body, 89)
        if len(p) == 128:
            m.arrival_phase = body[92]
            m.arrival_flags = body[93]
        reply.motor = m
        return reply

    # ------------------------------------------------------------ workflows
    def open_session(self) -> SemanticReply:
        device = self.command(0, "get_state")
        if not device.device:
            raise LinkError("主控未返回设备状态")
        if device.device.capabilities != 3:
            raise LinkError("主控不支持生产执行器")
        self.boot_id = device.boot_id
        self.request_id = max(self.request_id, device.device.request_floor)
        self.session_id = random.randint(1, 0xFFFFFFFF)
        try:
            return self.command(0, "open")
        except LinkError:
            self.session_id = 0
            self.boot_id = "0"
            raise

    def get_state(self) -> SemanticReply:
        reply = self.command(self.motor, "get_state")
        if reply.motor:
            self.permit_wanted = reply.motor.permit and self.permit_wanted
        return reply

    def initialize(self) -> SemanticReply:
        current = self.command(self.motor, "get_state")
        m = current.motor
        if m and m.logic_power and m.config_verified and m.limits_valid and not current.pending:
            return current
        self.command(self.motor, "commission", action=1)
        return self.wait(15.0, lambda r: bool(r.motor and r.motor.config_verified and r.motor.limits_valid))

    def permit(self, enabled: bool) -> SemanticReply:
        self.permit_wanted = False
        if enabled:
            state = self.command(self.motor, "get_state")
            if state.motor and not state.motor.config_verified:
                self.initialize()
        reply = self.command(self.motor, "permit", enabled=enabled, lease_ms=1500 if enabled else 0)
        self.permit_wanted = enabled and bool(reply.motor and reply.motor.permit)
        return reply

    def power_off(self) -> None:
        self.stop(disable=True)
        self.wait(15.0, lambda r: bool(r.motor and r.motor.drive == 0 and not r.motor.motion_active))
        self.permit(False)
        self.link.gateway_control(self.motor, 5, bytes([0]))

    def stop(self, disable: bool = False) -> SemanticReply:
        return self.command(self.motor, "stop", after=2 if disable else 1)

    def emergency(self) -> SemanticReply:
        return self.command(self.motor, "estop")

    def jog(self, velocity_raw: int) -> SemanticReply:
        return self.command(self.motor, "jog_start", velocity_raw=velocity_raw, lease_ms=700)

    def velocity_start(self, velocity_raw: int) -> SemanticReply:
        return self.command(self.motor, "velocity_start", velocity_raw=velocity_raw, lease_ms=700)

    def open_loop_start(self, velocity_raw: int) -> SemanticReply:
        return self.command(self.motor, "open_loop_start", velocity_raw=velocity_raw, lease_ms=700)

    def task_speed(self, velocity_raw: int, mode: int) -> SemanticReply:
        return self.command(self.motor, "task_speed", velocity_raw=velocity_raw, mode=mode)

    def move(self, position: int) -> SemanticReply:
        return self.command(self.motor, "move", position=position)

    def homing_config_read(self) -> SemanticReply:
        return self.command(self.motor, "homing_config_read")

    def homing_config_write(self, config: list[int]) -> SemanticReply:
        return self.command(self.motor, "homing_config_write", config=config)

    def homing_start(self, direction: int, step_unit: int, dual: bool) -> SemanticReply:
        return self.command(self.motor, "homing_start", direction=direction, step_unit=step_unit, dual=dual)

    def wait(self, timeout_s: float, predicate) -> SemanticReply:
        deadline = time.monotonic() + timeout_s
        last: SemanticReply | None = None
        while time.monotonic() < deadline:
            last = self.command(self.motor, "get_state")
            if last.result != 0:
                return last
            if predicate(last):
                return last
            time.sleep(0.15)
        if last is None:
            raise LinkError("等待主控状态超时")
        return last
