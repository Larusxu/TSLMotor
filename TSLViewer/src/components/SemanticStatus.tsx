import { useApp } from "../lib/app-store";
import { semanticFresh } from "../lib/semantic-state";
import { Stat } from "./ui";

/** Operator-facing homing/position snapshot. */
export function SemanticStatus() {
  const app = useApp();
  const current = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic);
  const m = current ? app.semantic.state : null;
  const sampled = !!m?.feedback_fresh;
  return <>
    <div className="grid cols-3">
      <Stat label="找零状态" value={m ? m.motion_owner === 2 ? "找零中" : m.span_valid ? "已完成" : "待找零" : "未确认"} tone={m?.span_valid ? "var(--ok)" : undefined} />
      <Stat label="实际位置" value={sampled && m?.coordinate_valid ? m.logical_position ?? "—" : "—"} unit="Count" />
      <Stat label="机构速度" value={sampled ? (-m!.velocity_raw * 3600000000 / 1099511627776).toFixed(1) : "—"} unit="rpm" />
    </div>
    <div className="row-wrap tiny muted" role="status">
      <span>全行程 <b>{m?.coordinate_valid ? m.logical_span : "—"}</b> Count</span>
      <span>故障 <b>{m ? m.fault ? String(m.fault) : m.last_error ? String(m.last_error) : "无" : "未确认"}</b></span>
    </div>
  </>;
}
