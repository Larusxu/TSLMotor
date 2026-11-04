import { useApp } from "../lib/app-store";
import { semanticFresh } from "../lib/semantic-state";
import { Notice, Stat, KV } from "./ui";

/** Main-controller observations only. Neither PC ARM nor a raw readable
 * register is accepted as controller permit/alignment/feedback evidence. */
export function SemanticStatus() {
  const app = useApp();
  const view = app.semantic;
  const current = app.connected && view.motor === app.motor && semanticFresh(view);
  const m = current ? view.state : null;
  const sampled = !!m?.feedback_fresh;
  const source = current ? `主控 op32 · ${new Date(view.receivedAt).toLocaleTimeString()} · boot ${view.bootId}` : "主控 op32 · 未读取或已过期";
  const drive = ["未使能", "初始化中", "已就绪", "故障"];
  const note = view.error || (!current ? "尚无当前主控状态，不使用旧页面缓存推定有效性。"
    : view.bootId === "0" || view.device?.capabilities !== 3
    ? "主控生产初始化尚未接入：运动执行保持禁用；状态读取不代表已完成反馈或标定验证。" : "");
  return <>
    <div className="grid cols-3">
      <Stat label="找零状态" value={m ? m.motion_owner === 2 ? "找零中" : m.span_valid ? "已完成" : "待找零" : "未确认"} tone={m?.span_valid ? "var(--ok)" : undefined} />
      <Stat label="行程零点" value={m ? m.home_neg_valid && m.home_pos_valid && m.span_valid ? "有效" : "待建立" : "—"} tone={m?.span_valid ? "var(--ok)" : "var(--text-4)"} />
      <Stat label="i_q 实测" value={sampled ? (m!.iq_raw * .20131).toFixed(1) : "—"} unit="mA" />
    </div>
    <div className="controller-summary">
      <div className="row-wrap tiny muted" role="status">
        <span>驱动 <b>{m ? drive[m.drive] ?? "未知" : "未确认"}</b></span>
        <span>授权 <b>{m ? m.permit ? "已开启" : "未开启" : "未确认"}</b></span>
        <span>编码器 <b>{m ? m.align_valid ? "有效" : "待标定" : "未确认"}</b></span>
        <span>负端 / 正端 <b>{m ? `${m.home_neg_valid ? "有效" : "未定"} / ${m.home_pos_valid ? "有效" : "未定"}` : "—"}</b></span>
        <span>故障 <b>{m ? m.fault ? String(m.fault) : m.last_error ? `结果码 ${m.last_error}` : "无" : "未确认"}</b></span>
      </div>
      <details className="controller-diagnostics"><summary>状态详情</summary>
        <KV rows={[["状态来源", source], ["实际位置", sampled && m?.coordinate_valid ? `${m.logical_position ?? "未提供"} Count` : "未找零或无新鲜反馈"], ["芯片位置 / 全行程", sampled ? `${m!.position} / ${m?.logical_span ?? "未确认"} Count` : "无新鲜反馈"], ["机构速度", sampled ? `${(-m!.velocity_raw * 3600000000 / 1099511627776).toFixed(1)} rpm` : "未提供"], ["采样时刻", sampled ? `${m!.sampled_at_ms} ms` : "无新鲜反馈"]]} />
      </details>
    </div>
    <div className="motion-message-slot" role="status">{note && <Notice tone="warn">{note}</Notice>}</div>
  </>;
}
