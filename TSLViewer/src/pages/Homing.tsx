import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { Badge, Button, Card, Check, Field, Icon, KV, Notice, NumField, SelectField } from "../components/ui";
import type { HomingState } from "../lib/types";

/** 主控固件的找零常量：上位机只展示，不参与判定（见 doc/TODO/TODO-01-机械找零.md）。 */
const HOMING_FW = {
  thresholdMa: 320, // 0.4 × 额定 800 mA
  confirmMs: 50,
  limitMa: 600,
  maxRpm: 2000,
  timeoutS: 60,
  retreatDeg: 360,
  settleMs: 2000,
};

function HomingStageBadge({ stage }: { stage: number }) {
  if (stage === 1) return <Badge tone="accent" dot="live">进行中</Badge>;
  if (stage === 2) return <Badge tone="ok">成功</Badge>;
  if (stage === 3) return <Badge tone="warn">失败</Badge>;
  return <Badge tone="neutral">空闲</Badge>;
}

/**
 * 机械找零（撞限位回零）。上位机只下发方向与步进、显示主控上报的状态；
 * 门控、推进、电流判据、超时与零点写入全部在主控固件里（TODO-01）。
 */
export default function HomingPage() {
  const app = useApp();
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [stepDeg, setStepDeg] = useState(15);
  const [safety, setSafety] = useState(false);
  const [hom, setHom] = useState<HomingState | null>(null);
  const [note, setNote] = useState("");
  const running = hom?.stage === 1;

  useEffect(() => {
    if (!app.connected) {
      setHom(null);
      setNote("");
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.homingState(app.motor);
        if (alive) {
          setHom(s);
          setNote("");
        }
      } catch (e) {
        if (alive) setNote(String(e));
      }
    };
    void tick();
    const t = window.setInterval(tick, 400);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [app.connected, app.motor]);

  const start = async () => {
    try {
      await api.homingStart({ dir, step_unit: Math.round(stepDeg * 100) }, app.motor);
      setSafety(false);
      app.toast("ok", "已请求找零：主控将裁决门控并开始推进");
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const cancel = async () => {
    try {
      await api.homingCancel(app.motor);
      app.toast("warn", "已请求取消找零");
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>

      <Card
        title="找零控制"
        sub="HOMING · HARD-STOP"
        right={<Badge tone="neutral">主控执行</Badge>}
      >
        <div className="grid cols-2" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 12 }}>
            <Notice tone="neutral">
              这是<b>撞限位回零</b>：电机朝限位方向持续推进，主控用「q 轴电流超阈 + <b>连续</b> 50 ms」判定接触，
              记录实测位置为行程零点后反向退开一圈。上位机只下发方向与步进、显示状态；
              门控、判据、超时与零点写入全部由主控固件裁决。
            </Notice>
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label="找零方向" hint="符号决定朝哪端">
                <SelectField
                  value={dir}
                  onChange={(v) => setDir(v as -1 | 1)}
                  options={[
                    { value: -1, label: "负方向（缩回侧）" },
                    { value: 1, label: "正方向（伸出侧）" },
                  ]}
                />
              </Field>
              <Field label="每拍步进" hint="电机端角度">
                <NumField
                  value={stepDeg}
                  onChange={setStepDeg}
                  min={1}
                  max={60}
                  step={1}
                  unit="°"
                />
              </Field>
            </div>
            <div className="tiny muted">
              下发值 = <span className="mono">{dir < 0 ? "−" : "+"}{Math.round(stepDeg * 100)}</span>
              （0.01° 单位，即 <span className="mono">{dir < 0 ? "−" : "+"}{stepDeg}°</span>/拍）。
              方向填反会撞向另一端，<b>以机构实测为准</b>。
            </div>
            <div className="divider" />
            <Check checked={safety} onChange={setSafety}>
              我已确认行程内无人员、无异物，且找零方向指向正确的限位端
            </Check>
            <div className="row-wrap" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Target width={14} height={14} />}
                disabled={
                  !app.connected || !app.armed || app.mode === "direct" || !safety || running
                }
                onClick={() => void start()}
              >
                开始找零
              </Button>
              <Button variant="ghost" disabled={!running} onClick={() => void cancel()}>
                取消找零
              </Button>
              {app.mode === "direct" && <span className="tiny muted">需切到主控模式（485 / CAN）</span>}
              {app.connected && app.mode !== "direct" && !app.armed && (
                <span className="tiny muted">需解锁 ARM</span>
              )}
            </div>
            {!app.connected && <div className="tiny muted">串口未连接</div>}
            {note && <div className="tiny muted">{note}</div>}
          </div>

          <div className="stack" style={{ gap: 12 }}>
            <KV
              rows={[
                ["找零状态", <HomingStageBadge key="s" stage={hom?.stage ?? 0} />],
                [
                  "行程零点",
                  hom?.zero_valid ? (
                    <Badge key="z" tone="ok">
                      有效
                    </Badge>
                  ) : (
                    <Badge key="z" tone="warn">
                      需找零
                    </Badge>
                  ),
                ],
                [
                  "i_q 实测",
                  <span key="i" className="mono">
                    {(hom?.iq_ma ?? 0).toFixed(0)} mA
                    <span className="muted tiny"> / 阈值 {HOMING_FW.thresholdMa}</span>
                  </span>,
                ],
                [
                  "已用时",
                  <span key="t" className="mono">
                    {((hom?.elapsed_ms ?? 0) / 1000).toFixed(1)} s
                    <span className="muted tiny"> / 超时 {HOMING_FW.timeoutS} s</span>
                  </span>,
                ],
              ]}
            />
            {hom?.message && <div className="tiny muted">主控：{hom.message}</div>}
            <div className="divider" />
            <div className="tiny muted">主控固件常量（上位机只展示，不可改）</div>
            <KV
              rows={[
                ["判定阈值", <span key="a" className="mono">0.4 × 额定 = {HOMING_FW.thresholdMa} mA</span>],
                ["连续确认", <span key="b" className="mono">{HOMING_FW.confirmMs} ms</span>],
                ["找零电流上限", <span key="c" className="mono">{HOMING_FW.limitMa} mA（须 &gt; 阈值）</span>],
                ["推进速度上限", <span key="d" className="mono">{HOMING_FW.maxRpm} RPM</span>],
                ["退开量 / 稳定", <span key="e" className="mono">{HOMING_FW.retreatDeg}° / {HOMING_FW.settleMs} ms</span>],
                ["超时", <span key="f" className="mono">{HOMING_FW.timeoutS} s</span>],
              ]}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}