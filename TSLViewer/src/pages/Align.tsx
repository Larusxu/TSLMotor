import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import {
  Badge,
  Button,
  Card,
  Check,
  Field,
  HexField,
  Icon,
  KV,
  Notice,
  NumField,
  Steps,
} from "../components/ui";
import { countsFromMa, fmt, hex } from "../lib/units";
import type { CalibCfgPayload, CalibResult } from "../lib/types";

export default function AlignPage() {
  const app = useApp();
  const [fluxMa, setFluxMa] = useState(300);
  const [poles, setPoles] = useState(app.cal.poles);
  const [settle, setSettle] = useState(700);
  const [stepDeg, setStepDeg] = useState(90);
  const [endDeg, setEndDeg] = useState(720);
  const [writeBack, setWriteBack] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [safety, setSafety] = useState(false);
  const [result, setResult] = useState<CalibResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [rpm, setRpm] = useState(100);
  const [runSafety, setRunSafety] = useState(false);

  useEffect(() => {
    const d = app.lastDone;
    if (d && d.ok && d.data && typeof d.data === "object" && "offset_hex" in (d.data as object)) {
      const r = d.data as CalibResult;
      setResult(r);
      setOffset(r.offset);
      app.toast("ok", `对齐完成：offset ${r.offset_hex} · R²=${r.r2.toFixed(5)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lastDone]);

  const cfg: CalibCfgPayload = {
    flux_ma: fluxMa,
    poles,
    settle_ms: settle,
    step_deg: stepDeg,
    end_deg: endDeg,
    ma_per_count: app.cal.maPerCount,
    write_back: writeBack,
    dry_run: dryRun,
    cpr: app.cal.cpr,
  };

  const fluxCounts = countsFromMa(fluxMa, app.cal.maPerCount);
  const overLimit = fluxCounts > 8192;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid flow-2-1">
        <div className="col-stack">
        <Card title="电角度对齐" sub="PHI_E ALIGNMENT" right={<Badge tone={app.jobRunning ? "accent" : "neutral"} dot={app.jobRunning ? "live" : undefined}>{app.jobRunning ? "执行中" : "空闲"}</Badge>}>
          <div className="stack" style={{ gap: 12 }}>
            <Notice tone="warn">
              对齐会以开环电流把转子拉到已知电角度，<b>电机会明显转动</b>。Tesla 手指电机限幅只有 800 mA，
              建议 200–350 mA，不要用上位机默认的 10000 counts（≈2 A）。
            </Notice>

            <div className="grid cols-4" style={{ gap: 10 }}>
              <Field label="对齐电流" hint={`${fluxCounts} counts`}>
                <NumField value={fluxMa} onChange={setFluxMa} min={50} max={1600} step={10} unit="mA" />
              </Field>
              <Field label="极对数">
                <NumField value={poles} onChange={(v) => { setPoles(v); app.setCal({ poles: v }); }} min={1} max={127} />
              </Field>
              <Field label="稳定时间" hint="每点等待">
                <NumField value={settle} onChange={setSettle} min={100} max={3000} step={50} unit="ms" />
              </Field>
              <Field label="步进电角度" hint="电角度">
                <NumField value={stepDeg} onChange={setStepDeg} min={15} max={180} step={15} unit="°" />
              </Field>
            </div>

            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
              <Field label="扫描上限" hint="覆盖 2 个电周期">
                <NumField value={endDeg} onChange={setEndDeg} min={360} max={1080} step={90} unit="°" />
              </Field>
              <div className="grow" />
              <Check checked={writeBack} onChange={setWriteBack}>
                自动写回 0x242
              </Check>
              <Check checked={dryRun} onChange={setDryRun}>
                干跑（不扫描）
              </Check>
            </div>

            {overLimit && (
              <Notice tone="danger">
                对齐电流 {fluxMa} mA 超过 4× 增益满量程（1.65 A）。请降低电流或把 CSA 改为 1×。
              </Notice>
            )}

            <div className="divider" />
            <Check checked={safety} onChange={setSafety}>
              我已确认电机固定、联轴器锁紧、电源限流
            </Check>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Align width={14} height={14} />}
                disabled={!app.connected || !app.armed || !safety || app.jobRunning}
                onClick={() => {
                  setResult(null);
                  void app.runJob("calibrate", { cfg, frameBits: 14 });
                }}
              >
                开始对齐
              </Button>
              <Button
                variant="ghost"
                icon={<Icon.Stop width={13} height={13} />}
                disabled={!app.jobRunning}
                onClick={app.cancel}
              >
                取消
              </Button>
              {!app.armed && <span className="tiny muted">需解锁 ARM</span>}
            </div>
          </div>
        </Card>

        <Card title="对齐流程" sub="ALIGN SEQUENCE">
          <div className="scroll-y" style={{ maxHeight: 320 }}>
            <Steps steps={app.steps} />
          </div>
        </Card>
        </div>

        <div className="col-stack">
        <Card title="对齐结果" sub="FIT RESULT">
          {!result ? (
            <div className="empty">
              <Icon.Align width={22} height={22} />
              尚未执行对齐
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <div className="row" style={{ gap: 10 }}>
                <div className="grow">
                  <div className="stat-label">PHI_E_OFFSET</div>
                  <div className="stat-value mono">{result.offset_hex}</div>
                </div>
                <Badge tone={result.r2 > 0.99 ? "ok" : result.r2 > 0.9 ? "warn" : "danger"}>
                  R² {result.r2.toFixed(5)}
                </Badge>
              </div>
              <KV
                rows={[
                  ["0° 时编码器值", <span key="a" className="mono">{fmt(result.intercept % 16384, 1)}</span>],
                  ["拟合斜率", <span key="b" className="mono">{fmt(result.slope, 4)} LSB/°</span>],
                  ["已写回", <span key="c">{result.written ? "是" : "否"}</span>],
                ]}
              />
              <table className="table">
                <thead>
                  <tr>
                    <th>deg</th>
                    <th>n</th>
                    <th>平均编码器</th>
                    <th>残差</th>
                  </tr>
                </thead>
                <tbody>
                  {result.groups.map((g) => (
                    <tr key={g.deg}>
                      <td className="mono">{g.deg}°</td>
                      <td className="mono">{g.n}</td>
                      <td className="mono">{fmt(g.avg, 1)}</td>
                      <td className="mono" style={{ color: Math.abs(g.residual) > 80 ? "var(--warn)" : "var(--text-2)" }}>
                        {g.residual > 0 ? "+" : ""}
                        {fmt(g.residual, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row" style={{ gap: 8 }}>
                <div style={{ width: 120 }}>
                  <HexField value={offset} onChange={setOffset} bits={16} />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!app.connected || !app.armed}
                  onClick={async () => {
                    try {
                      await api.writeReg(0x242, offset & 0xffff, true);
                      app.toast("ok", `0x242 ← ${hex(offset, 4)}`);
                    } catch (e) {
                      app.toast("error", String(e));
                    }
                  }}
                >
                  手动写入 0x242
                </Button>
              </div>
              <Notice tone={result.r2 > 0.99 ? "ok" : "warn"}>
                {result.r2 > 0.99
                  ? "拟合质量良好：可以进入速度闭环。"
                  : "拟合质量一般：检查编码器打滑、极对数、SPI 掩码，或增大对齐电流后重试。"}
              </Notice>
            </div>
          )}
        </Card>

        <Card title="速度闭环" sub="CLOSED LOOP VELOCITY">
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid cols-3" style={{ gap: 10 }}>
              <Field label="目标转速" hint="RPM">
                <NumField value={rpm} onChange={setRpm} min={-3000} max={3000} step={25} unit="RPM" />
              </Field>
              <Field label="目标内部值" hint="× 305.4">
                <div className="input-wrap">
                  <input className="mono" readOnly value={Math.round(rpm * app.cal.countsPerRpm)} />
                </div>
              </Field>
              <Field label="当前实际" hint="0x154">
                <div className="input-wrap">
                  <input
                    className="mono"
                    readOnly
                    value={(() => {
                      const v = app.scope.latest.get(0);
                      return v === undefined ? "—" : fmt(v, 1);
                    })()}
                  />
                  <span className="suffix">RPM</span>
                </div>
              </Field>
            </div>

            <Check checked={runSafety} onChange={setRunSafety}>
              我已确认参数，允许闭环运行（飞车时立即急停）
            </Check>

            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Bolt width={14} height={14} />}
                disabled={!app.connected || !app.armed || !runSafety}
                onClick={async () => {
                  try {
                    await api.setVelocity(rpm, app.cal.poles, app.cal.countsPerRpm);
                    app.toast("ok", `速度目标 ${rpm} RPM`);
                  } catch (e) {
                    app.toast("error", String(e));
                  }
                }}
              >
                启动闭环
              </Button>
              <Button
                variant="ghost"
                icon={<Icon.Stop width={13} height={13} />}
                disabled={!app.connected}
                onClick={async () => {
                  try {
                    await api.stopMotion(app.cal.poles);
                    app.toast("warn", "已停止（PWM_OFF）");
                  } catch (e) {
                    app.toast("error", String(e));
                  }
                }}
              >
                停止
              </Button>
              <Button variant="ghost" disabled={!app.connected} onClick={() => void app.startStream()}>
                开始采集
              </Button>
            </div>
          </div>
        </Card>

        <Card title="闭环前检查" sub="PRE-CHECKS">
          <div className="stack" style={{ gap: 10 }}>
            <Notice>
              ① 编码器角度随手动转动变化；② <span className="mono">0x0C3 = 3</span>（4×）；③ PID 已写入且
              <b> 电流归一化 = Shift by 8</b>；④ <span className="mono">0x14A</span> 力矩限幅 &gt; 0。
            </Notice>
            <div className="tiny muted">
              若 300 RPM 目标下实际转速在 200–330 RPM 摆动（遗留上位机的现象），说明速度环 P/I 偏大或测速更新率不足，
              请到「PID 与限幅」页做阶跃测试重新整定。
            </div>
          </div>
        </Card>
        </div>
      </div>
    </div>
  );
}
