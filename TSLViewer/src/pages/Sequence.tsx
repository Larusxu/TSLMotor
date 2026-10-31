import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import {
  Badge,
  Button,
  Card,
  Check,
  Field,
  Icon,
  Notice,
  NumField,
  Segmented,
  Steps,
  TextField,
} from "../components/ui";
import { fmt } from "../lib/units";
import type { SeqCfgPayload, SeqResult } from "../lib/types";

export default function SequencePage() {
  const app = useApp();
  const [serial, setSerial] = useState("");
  const [operator, setOperator] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"closed" | "open">("closed");
  const [steps, setSteps] = useState<{ rpm: number; hold_s: number }[]>([
    { rpm: 100, hold_s: 3 },
    { rpm: 300, hold_s: 3 },
    { rpm: 600, hold_s: 3 },
    { rpm: -300, hold_s: 3 },
  ]);
  const [tolerance, setTolerance] = useState(8);
  const [settle, setSettle] = useState(1.2);
  const [openUd, setOpenUd] = useState(0x0a00);
  const [safety, setSafety] = useState(false);
  const [result, setResult] = useState<SeqResult | null>(null);

  useEffect(() => {
    const d = app.lastDone;
    if (d?.ok && d.data && typeof d.data === "object" && "rows" in (d.data as object)) {
      setResult(d.data as SeqResult);
    }
  }, [app.lastDone]);

  const cfg: SeqCfgPayload = useMemo(
    () => ({
      serial,
      operator,
      note,
      steps,
      poles: app.cal.poles,
      counts_per_rpm: app.cal.countsPerRpm,
      ma_per_count: app.cal.maPerCount,
      tolerance_pct: tolerance,
      settle_s: settle,
      mode,
      open_ud: openUd,
    }),
    [serial, operator, note, steps, app.cal, tolerance, settle, mode, openUd]
  );

  const totalSeconds = steps.reduce((a, s) => a + s.hold_s + settle, 0);
  const pass = result?.summary.every((s) => s.verdict !== "check") ?? false;

  const chart = useMemo(() => {
    if (!result || !result.rows.length) return null;
    const W = 720;
    const H = 200;
    const rows = result.rows;
    const tMax = rows[rows.length - 1].t_ms || 1;
    const speeds = rows.map((r) => r.actual_rpm).filter((v) => Number.isFinite(v));
    const targets = rows.map((r) => r.target_rpm).filter((v) => Number.isFinite(v));
    const all = [...speeds, ...targets];
    let min = Math.min(...all, 0);
    let max = Math.max(...all, 0);
    const pad = (max - min) * 0.1 || 1;
    min -= pad;
    max += pad;
    const x = (t: number) => 40 + (t / tMax) * (W - 50);
    const y = (v: number) => 8 + (1 - (v - min) / (max - min)) * (H - 28);
    const line = (key: "actual_rpm" | "target_rpm") =>
      rows
        .filter((r) => Number.isFinite(r[key]))
        .map((r, i) => `${i === 0 ? "M" : "L"}${x(r.t_ms).toFixed(1)},${y(r[key]).toFixed(1)}`)
        .join(" ");
    return { W, H, line, min, max };
  }, [result]);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid flow-2-1">
        <div className="col-stack">
        <Card title="测试配置" sub="RUN CONFIG">
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid cols-3" style={{ gap: 10 }}>
              <Field label="电机序列号" hint="必填，用于文件名">
                <TextField value={serial} onChange={setSerial} placeholder="扫码或输入" />
              </Field>
              <Field label="操作员">
                <TextField value={operator} onChange={setOperator} placeholder="可选" />
              </Field>
              <Field label="备注">
                <TextField value={note} onChange={setNote} placeholder="批次 / 工位" />
              </Field>
            </div>

            <div className="row-wrap" style={{ gap: 12 }}>
              <Field label="控制模式" hint="闭环测速 / 开环电压">
                <Segmented
                  value={mode}
                  onChange={(v) => setMode(v)}
                  options={[
                    { value: "closed", label: "闭环" },
                    { value: "open", label: "开环" },
                  ]}
                />
              </Field>
              {mode === "open" && (
                <Field label="最大 UD" hint="0x200">
                  <NumField value={openUd} onChange={setOpenUd} min={0} max={18900} step={128} />
                </Field>
              )}
              <Field label="容差">
                <NumField value={tolerance} onChange={setTolerance} min={1} max={50} unit="%" />
              </Field>
              <Field label="档位间隔">
                <NumField value={settle} onChange={setSettle} min={0.2} max={10} step={0.2} unit="s" />
              </Field>
            </div>

            <div className="divider" />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="stat-label">测试档位</span>
              <div className="row" style={{ gap: 6 }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSteps((s) => [...s, { rpm: 0, hold_s: 3 }])}
                >
                  + 添加
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSteps([
                      { rpm: 100, hold_s: 3 },
                      { rpm: 300, hold_s: 3 },
                      { rpm: 600, hold_s: 3 },
                      { rpm: -300, hold_s: 3 },
                    ])
                  }
                >
                  重置
                </Button>
              </div>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>转速 RPM</th>
                  <th>保持 s</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {steps.map((s, i) => (
                  <tr key={i}>
                    <td className="mono muted">{i + 1}</td>
                    <td>
                      <NumField
                        value={s.rpm}
                        onChange={(v) =>
                          setSteps((prev) => prev.map((x, j) => (j === i ? { ...x, rpm: v } : x)))
                        }
                        min={-3000}
                        max={3000}
                        step={50}
                      />
                    </td>
                    <td>
                      <NumField
                        value={s.hold_s}
                        onChange={(v) =>
                          setSteps((prev) => prev.map((x, j) => (j === i ? { ...x, hold_s: v } : x)))
                        }
                        min={0.5}
                        max={60}
                        step={0.5}
                      />
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="tiny muted">
              {steps.length} 档 · 预计 {(totalSeconds / 60).toFixed(1)} 分钟 · 报告保存到 <span className="mono">{app.reportsPath}</span>
            </div>

            <div className="divider" />
            <Check checked={safety} onChange={setSafety}>
              我已确认电机已固定、电源限流已设置；测试会驱动电机正反转
            </Check>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Sequence width={14} height={14} />}
                disabled={
                  !app.connected || !app.armed || !safety || !serial.trim() || app.jobRunning || !steps.length
                }
                onClick={() => void app.runJob("sequence", cfg)}
              >
                开始测试
              </Button>
              <Button variant="ghost" disabled={!app.connected} onClick={() => void api.openReportsDir()}>
                <Icon.Folder width={13} height={13} /> 报告目录
              </Button>
              {app.jobRunning && (
                <Button variant="ghost" onClick={app.cancel}>
                  取消
                </Button>
              )}
            </div>
            {!serial.trim() && <Notice tone="warn">序列号必填（用于 CSV 文件名与追溯）。</Notice>}
          </div>
        </Card>
        </div>

        <div className="col-stack">
          <Card title="执行进度" sub="PROGRESS">
            <div className="scroll-y" style={{ maxHeight: 320 }}>
              <Steps steps={app.steps} />
            </div>
          </Card>
          <Card title="汇总" sub="WINDOWS" right={result && <Badge tone={pass ? "ok" : "warn"}>{pass ? "全部通过" : "需复核"}</Badge>}>
            {!result ? (
              <div className="empty">尚未测试</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>档位</th>
                    <th>均值</th>
                    <th>纹波</th>
                    <th>结论</th>
                  </tr>
                </thead>
                <tbody>
                  {result.summary.map((s) => (
                    <tr key={s.window}>
                      <td className="mono">{s.window}</td>
                      <td className="mono">{fmt(s.mean_rpm, 1)}</td>
                      <td className="mono">{fmt(s.ripple_pct, 1)}%</td>
                      <td>
                        <Badge tone={s.verdict === "pass" ? "ok" : s.verdict === "idle" ? "neutral" : "warn"}>
                          {s.verdict}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title="采集曲线"
        sub="ACTUAL vs TARGET"
        right={
          result && (
            <span className="tiny mono muted" style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 380 }}>
              {result.csv_path}
            </span>
          )
        }
      >
        {!chart ? (
          <div className="empty">
            <Icon.Sequence width={22} height={22} />
            运行一次测试后显示曲线
          </div>
        ) : (
          <svg viewBox={`0 0 ${chart.W} ${chart.H}`} style={{ width: "100%", height: "auto", display: "block" }}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line
                  x1={40}
                  x2={chart.W - 10}
                  y1={8 + f * (chart.H - 28)}
                  y2={8 + f * (chart.H - 28)}
                  className="chart-grid"
                />
                <text x={4} y={11 + f * (chart.H - 28)} fontSize="8.5" className="chart-ink" fontFamily="Consolas, monospace">
                  {fmt(chart.max - f * (chart.max - chart.min), 0)}
                </text>
              </g>
            ))}
            <path d={chart.line("target_rpm")} fill="none" stroke="var(--ch-1)" strokeWidth="1.3" strokeDasharray="4 3" />
            <path d={chart.line("actual_rpm")} fill="none" stroke="var(--ch-0)" strokeWidth="1.6" />
          </svg>
        )}
      </Card>
        </div>
      </div>
    </div>
  );
}
