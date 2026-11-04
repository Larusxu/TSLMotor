import { semanticMotion } from "./semantic-motion";
import type { SemanticReply } from "./semantic-state";

export type AlignmentPlan = {
  scanDegrees: number; stepDegrees: number; settleMs: number; currentMa: number; clearance: boolean;
};
/** One MCU commissioning owner. The PC renews permission but never emits a
 * position trajectory or marks configuration/calibration successful itself. */
class CommissionService {
  private running = false;
  private cancelled = false;
  async cancel() { this.cancelled = true; }
  async align(motor: number, plan: AlignmentPlan, update: (r: SemanticReply) => void) {
    if (this.running) throw Error("主控标定任务进行中");
    this.running = true; this.cancelled = false;
    try {
      await semanticMotion.permit(motor, true);
      update(await semanticMotion.command(motor, { kind: "alignment", scan_degrees: plan.scanDegrees,
        step_degrees: plan.stepDegrees, settle_ms: plan.settleMs, current_ma: plan.currentMa, clearance: plan.clearance }));
      const deadline = Date.now() + 150000;
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (this.cancelled) throw Error("已请求取消标定");
        if (Date.now() >= deadline) throw Error("主控标定等待超时");
        const r = await semanticMotion.command(motor, { kind: "get_state" });
        update(r);
        if (r.motor?.fault || r.motor?.last_error) throw Error(`主控标定失败 ${r.motor.fault}/${r.motor.last_error}`);
        if (r.motor?.drive !== 1 && r.motor?.align_valid && r.motor.config_verified && !r.motor.motion_active) return r;
      }
    } catch(e) {
      this.cancelled = true; throw e;
    } finally {
      try { if (this.cancelled) await semanticMotion.close(); }
      finally { this.running = false; }
    }
  }
}
export const semanticCommission = new CommissionService();

export function alignmentRetreatDegrees(scanDegrees: number, poles: number) {
  if (!Number.isInteger(scanDegrees) || scanDegrees < 360 || scanDegrees > 1080 ||
      !Number.isInteger(poles) || poles < 1 || poles > 127) throw new Error("扫描角度或极对数无效");
  const mechanical = Math.ceil(scanDegrees / poles);
  return mechanical + Math.max(180, Math.ceil(mechanical / 4));
}
