import { invokeCommand } from "./api";

export interface DeviceState {
  capabilities: number; motors: number; source: number; active_motor: number;
  stopping: boolean; request_floor: number;
}
export interface MotorState {
  sampled_at_ms: number; fault: number; last_error: number;
  position: string; negative_contact: string; positive_contact: string;
  velocity_raw: number; iq_raw: number; connection: boolean; permit: boolean;
  drive: number; align_valid: boolean; home_neg_valid: boolean; home_pos_valid: boolean;
  span_valid: boolean; motion_owner: number; feedback_fresh: boolean; config_verified: boolean;
  logic_power: boolean; motion_active: boolean; effective_iq_raw: number;
  effective_velocity_raw: number; mode: number; safety_phase: number;
  limits_valid: boolean; pending_action: number;
  arrival_phase?: number | null; arrival_flags?: number | null; arrival_ms?: number | null;
  arrival_tolerance?: number | null; arrival_dwell_ms?: number | null;
  logical_position?: string | null; logical_span?: string | null; margin_counts?: number | null; coordinate_valid?: boolean;
  temperature_raw?: number | null;
  /** Optional mainboard telemetry fields: absent on existing firmware -> UI displays —. */
  bus_voltage_mv?: number | null; id_raw?: number | null;
  target_logical_position?: string | null;
  protection_state?: number | null;
}
export interface SemanticReply {
  protocol_version: number; operation: number; request_id: number; boot_id: string;
  session_id: number; task_id: number; timestamp_ms: number; result: number;
  result_name: string; replayed: boolean; pending: boolean;
  device: DeviceState | null; motor: MotorState | null; homing_config?: number[] | null;
  encoder?: number[] | null;
  rtmi?: number[] | null;
  identification?: number[] | null;
  telemetry?: { sampled_at_ms: number; bus_voltage_mv?: number | null; id_raw?: number | null; target_logical_position?: string | null; protection_state?: number | null } | null;
}
export interface SemanticView {
  motor: number; bootId: string; receivedAt: number; taskId?: number;
  device: DeviceState | null; state: MotorState | null; error: string;
}
type Reader = (motor: number, id: number) => Promise<SemanticReply>;
let encoderSequence = 0;
/** Passive encoder cache query: opening the page must not claim a motor session. */
export async function readEncoderSnapshot(motor: number): Promise<SemanticReply> {
  const request_id = ++encoderSequence;
  const reply = await invokeCommand<SemanticReply>("motor_semantic", { motor, request: {
    request_id, boot_id: "0", session_id: 0, task_id: 0, command: { kind: "encoder_state" },
  } });
  if (reply.request_id !== request_id || reply.protocol_version !== 2 || reply.operation !== 1 || reply.result || reply.replayed)
    throw new Error(`编码器回读未确认：${reply.result_name}`);
  return reply;
}
async function readTelemetry(motor: number, id: number): Promise<SemanticReply> {
  return invokeCommand<SemanticReply>("motor_semantic", { motor, request: {
    request_id: id, boot_id: "0", session_id: 0, task_id: 0,
    command: { kind: "telemetry_state" },
  } });
}
async function read(motor: number, id: number): Promise<SemanticReply> {
  const request = async (kind: string) => invokeCommand<SemanticReply>("motor_semantic", { motor, request: {
    request_id: id, boot_id: "0", session_id: 0, task_id: 0, command: { kind },
  } });
  const result = await request(motor ? "position_state" : "get_state");
  // Old firmware explicitly rejects the opt-in byte. Read-only fallback only.
  return motor && result.result === 14 ? request("get_state") : result;
}

/** One read-only source. Discovery never opens/renews a session, grants a
 * permit, enables a drive, or reuses raw register values as readiness proof. */
export class SemanticStateSource {
  private epoch = 0;
  private sequence = 0;
  private inFlight = false;
  private current: SemanticView = this.empty(0);
  constructor(private reader: Reader = read, private clock = () => Date.now()) {}
  private empty(motor: number, error = ""): SemanticView {
    return { motor, bootId: "0", receivedAt: 0, device: null, state: null, error };
  }
  view() { return this.current; }
  reset(motor: number, error = "") {
    this.epoch++;
    this.current = this.empty(motor, error);
    return this.current;
  }
  async poll(motor: number): Promise<SemanticView> {
    if (motor < 1 || motor > 16 || !Number.isInteger(motor)) throw new Error("电机编号无效");
    if (this.current.motor !== motor) this.reset(motor);
    if (this.inFlight) return this.current;
    const epoch = this.epoch;
    this.inFlight = true;
    try {
      const query = async (m: number) => {
        if (this.sequence >= 0xffffffff) throw new Error("查询编号已耗尽，请重启上位机");
        const id = ++this.sequence;
        const r = await this.reader(m, id);
        if (r.protocol_version !== 2 || r.operation !== 1 || r.request_id !== id || r.replayed || r.result !== 0)
          throw new Error(`主控状态未确认：${r.result_name}`);
        return r;
      };
      const d = await query(0);
      if (epoch !== this.epoch) return this.current;
      if (this.current.bootId !== "0" && d.boot_id !== this.current.bootId)
        this.current = this.empty(motor, "主控已重启，等待电机状态");
      const m = await query(motor);
      if (epoch !== this.epoch) return this.current;
      if (d.boot_id !== m.boot_id) this.current = this.empty(motor);
      if (!d.device || !m.motor || d.boot_id !== m.boot_id || d.session_id !== m.session_id)
        throw new Error("主控启动或会话已变化，等待重新读取");
      // Optional v2 read-only telemetry page; older firmware safely returns unsupported.
      // Never publish it if boot/session/sample identity changed between queries.
      let state = m.motor;
      if (this.reader === read && this.sequence < 0xffffffff) {
        try {
          const id = ++this.sequence;
          const x = await readTelemetry(motor, id);
          if (epoch !== this.epoch) return this.current;
          if (x.result === 0 && x.protocol_version === 2 && x.operation === 1 &&
              x.request_id === id && !x.replayed && x.boot_id === m.boot_id &&
              x.session_id === m.session_id && x.telemetry &&
              x.telemetry.sampled_at_ms === m.motor.sampled_at_ms) {
            state = { ...m.motor,
              bus_voltage_mv: x.telemetry.bus_voltage_mv ?? null,
              id_raw: x.telemetry.id_raw ?? null,
              target_logical_position: x.telemetry.target_logical_position ?? null,
              protection_state: x.telemetry.protection_state ?? null,
            };
          }
        } catch { /* Optional page unavailable: basic state remains usable. */ }
      }
      this.current = { motor, taskId:m.task_id, bootId: m.boot_id, receivedAt: this.clock(), device: d.device, state, error: "" };
    } catch (error) {
      if (epoch === this.epoch) this.current = { ...this.current, error: String(error) };
    } finally { this.inFlight = false; }
    return this.current;
  }
}
export function semanticFresh(view: SemanticView, now = Date.now()) {
  return !!view.device && !!view.state && now >= view.receivedAt && now - view.receivedAt <= 2000;
}
