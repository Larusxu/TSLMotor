import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import {
  Badge,
  Button,
  Card,
  Check,
  Field,

  Icon,
  KV,
  Notice,
  NumField,
} from "../components/ui";
import { countsFromMa, fmt } from "../lib/units";
import { semanticCommission } from "../lib/semantic-commission";
import { semanticFresh, readEncoderSnapshot } from "../lib/semantic-state";
import { semanticMotion } from "../lib/semantic-motion";
import type { CalibCfgPayload, CalibResult } from "../lib/types";

/** 对齐结果表在还没跑过对齐时的占位行。 */
const PLACEHOLDER_GROUPS: CalibResult["groups"] = [0, 90, 180, 270].map((deg) => ({
  deg,
  n: 0,
  avg: 0,
  unwrapped: 0,
  residual: 0,
}));

/** 电角度对齐 + 结果 + 速度闭环。作为「编码器与对齐」页的第二节复用。 */
export type AlignmentProgress = { stage: "start" | "accepted" | "scanning" | "verifying" | "completed" | "failed" | "cancelled"; detail?: string };
export function AlignmentPanels({ onCompleted, onProgress }: { onCompleted?: () => Promise<void>; onProgress?: (progress: AlignmentProgress) => void } = {}) {
  const app = useApp();
  const [fluxMa, setFluxMa] = useState(300);
  const [poles, setPoles] = useState(app.cal.poles);
  const [settle, setSettle] = useState(700);
  const [stepDeg, setStepDeg] = useState(90);
  const [endDeg, setEndDeg] = useState(720);
  const [writeBack, setWriteBack] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const result = app.mode === "direct" ? app.alignment : null;
  const [rpm, setRpm] = useState(100);
  const [runSafety, setRunSafety] = useState(false);
  const [commissionBusy, setCommissionBusy] = useState(false);
  const [commissionNote, setCommissionNote] = useState("");
  const [verifiedOffset, setVerifiedOffset] = useState<number | null>(null);
  const mainboard = app.mode === "main485" || app.mode === "maincan";
  const state = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  useEffect(()=>{setVerifiedOffset(null);},[app.connected,app.motor,app.semantic.bootId]);
  useEffect(()=>{
    if(state&&!state.align_valid)setVerifiedOffset(null);
    if(!mainboard||!app.connected||!state?.config_verified||!state.align_valid||state.motion_active)return;
    let alive=true;
    void readEncoderSnapshot(app.motor).then(r=>{
      if(alive&&r.boot_id===app.semantic.bootId&&r.encoder?.[1])setVerifiedOffset(r.encoder[4]&65535);
    }).catch(()=>{});
    return()=>{alive=false;};
  },[mainboard,app.connected,app.motor,app.semantic.bootId,state?.config_verified,state?.align_valid,state?.motion_active]);
  const alignmentState = !state ? "未确认或已过期" : state.drive === 1 ? "主控执行中" : state.align_valid ? "主控已验证" : "本次未验证";
  const startAlignment = async () => {
    if (!mainboard) { await app.runJob("calibrate", { cfg, frameBits: 14 }); return; }
    if (dryRun || !writeBack) throw new Error("主控标定会验证并保存 W25 档案；请关闭干跑并勾选自动写回");
    if (poles !== app.cal.poles) throw new Error("极对数须先保存并由主控读回验证");
    setCommissionBusy(true); setCommissionNote("主控已接管：执行标定扫描");
    onProgress?.({stage:"start",detail:"准备主控标定命令"});
    try {
      await app.stopStream();
      let accepted = false;
      await semanticCommission.align(app.motor, { scanDegrees: endDeg, stepDegrees: stepDeg,
        settleMs: settle, currentMa: fluxMa }, r => {
          if (!accepted) { accepted = true; onProgress?.({stage:"accepted",detail:"主控已应答对齐指令"}); }
          if (r.motor) {
            if (r.motor.drive === 1) {
              setCommissionNote("主控执行中：扫描 / 读回");
              onProgress?.({stage:"scanning",detail:"主控正在执行扫描（阶段状态）"});
            } else {
              setCommissionNote("主控正在确认标定结果");
              onProgress?.({stage:"verifying",detail:"等待主控标定验证"});
            }
          }
        });
      onProgress?.({stage:"verifying",detail:"校验偏移与写回结果"});
      await semanticMotion.permit(app.motor,false);
      const readback = await semanticMotion.command(app.motor,{kind:"encoder_state"});
      const value = readback.encoder?.[1] ? readback.encoder[4] : null;
      setVerifiedOffset(value == null ? null : value & 0xffff);
      await onCompleted?.();
      setCommissionNote(`主控标定及 W25 / M24 保存比对已确认，实际偏移=${value == null ? "读回暂不可用" : value & 0xffff}；机械双端零点需重新建立`);
      onProgress?.({stage:"completed",detail:value == null ? "主控标定完成，偏移尚未回读" : `偏移 ${value & 0xffff} 已回读`});
    } catch (e) {
      const message = String(e);
      onProgress?.({stage:message.includes("取消") ? "cancelled" : "failed",detail:message});
      setCommissionNote(message); app.toast("error", message);
    }
    finally { setCommissionBusy(false); }
  };

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
    <div className="grid flow-2-1">
      <div className="col-stack">
        <Card title="电角度对齐" sub="PHI_E ALIGNMENT" right={<Badge tone={mainboard ? state?.align_valid ? "ok" : "neutral" : app.jobRunning ? "accent" : "neutral"}>{mainboard ? alignmentState : app.jobRunning ? "执行中" : "空闲"}</Badge>}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid align-inputs" style={{ gap: 10 }}>
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
              <Field label="扫描上限" hint="覆盖 2 个电周期">
                <NumField value={endDeg} onChange={setEndDeg} min={360} max={1080} step={90} unit="°" />
              </Field>
            </div>
            {overLimit && <Notice tone="danger">对齐电流超过 1.65 A 满量程，请降低电流或修改 CSA 增益。</Notice>}
            <div className="align-footer"><div className="row-wrap" style={{gap:16}}>
              <Check checked={writeBack} onChange={setWriteBack}>{mainboard ? "主控验证并保存 W25" : "自动写回"}</Check>
              <Check checked={dryRun} onChange={setDryRun}>干跑（不扫描）</Check>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Align width={14} height={14} />}
                disabled={!app.connected || app.jobRunning || commissionBusy || (mainboard && fluxMa > 500)}
                onClick={() => {
                  void startAlignment().catch(e => app.toast("error", String(e)));
                }}
              >
                开始对齐
              </Button>
              <Button
                variant="ghost"
                icon={<Icon.Stop width={13} height={13} />}
                disabled={!app.jobRunning && !commissionBusy}
                onClick={() => { if (commissionBusy) { onProgress?.({stage:"cancelled",detail:"已请求取消，等待任务退出"}); void semanticCommission.cancel(); } else app.cancel(); }}
              >
                取消
              </Button>

            </div></div>
            {commissionNote && <Notice tone={commissionBusy ? "warn" : "neutral"}>{commissionNote}</Notice>}
          </div>
        </Card>
        </div>

        <div className="col-stack">
        {mainboard ? <Card title="对齐结果" right={<Badge tone={state?.align_valid?"ok":"neutral"}>{alignmentState}</Badge>}><div className="stack" style={{gap:12}}><div><div className="stat-label">PHI_E_OFFSET</div><div className="stat-value mono">{verifiedOffset ?? "—"}</div></div><div className="divider"/><div className="tiny muted">标定完成后保持电机板供电，驱动禁能；机械零点需重新建立。</div></div></Card> : <Card title="对齐结果" sub="FIT RESULT">
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10 }}>
              <div className="grow">
                <div className="stat-label">PHI_E_OFFSET</div>
                {result ? (
                  <div className="stat-value mono">{result.offset}</div>
                ) : (
                  <div className="stat-value">{mainboard ? alignmentState : "未对齐"}</div>
                )}
              </div>
              {result ? (
                <Badge tone={result.r2 > 0.99 ? "ok" : result.r2 > 0.9 ? "warn" : "danger"}>
                  R² {result.r2.toFixed(5)}
                </Badge>
              ) : (
                <Badge tone="neutral">R² —</Badge>
              )}
            </div>
            <KV
              rows={[
                [
                  "0° 时编码器值",
                  <span key="a" className="mono">
                    {result ? fmt(result.intercept % 16384, 1) : "—"}
                  </span>,
                ],
                [
                  "拟合斜率",
                  <span key="b" className="mono">
                    {result ? `${fmt(result.slope, 4)} LSB/°` : "—"}
                  </span>,
                ],
                ["已写回", <span key="c">{result ? (result.written ? "是" : "否") : "—"}</span>],
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
                {(result?.groups ?? PLACEHOLDER_GROUPS).map((g) => {
                  const has = result !== null;
                  return (
                    <tr key={g.deg}>
                      <td className="mono">{g.deg}°</td>
                      <td className="mono">{has ? g.n : "—"}</td>
                      <td className="mono">{has ? fmt(g.avg, 1) : "—"}</td>
                      <td
                        className="mono"
                        style={{ color: has && Math.abs(g.residual) > 80 ? "var(--warn)" : "var(--text-2)" }}
                      >
                        {has ? `${g.residual > 0 ? "+" : ""}${fmt(g.residual, 1)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {result && (
              <Notice tone={result.written && result.r2 > 0.99 ? "ok" : "warn"}>
                {!result.written
                  ? "仅得到拟合结果，偏移未写回；请完成写回校验后再运行。"
                  : result.r2 > 0.99
                  ? "偏移已写回，拟合质量良好。闭环运行或找零前，仍需写入电流环、速度环、位置环参数并确认限幅。"
                  : "拟合质量一般：检查编码器打滑、极对数、SPI 掩码，或增大对齐电流后重试。"}
              </Notice>
            )}
          </div>
        </Card>}

        {!mainboard && <Card title="速度闭环" sub="CLOSED LOOP VELOCITY">
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
                disabled={!app.connected || !runSafety}
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
        </Card>}
      </div>
    </div>
  );
}
