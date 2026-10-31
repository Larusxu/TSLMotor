import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { Badge, Button, Card, Check, Field, Icon, Notice, NumField, SelectField, Stat } from "../components/ui";
import type { HomingState } from "../lib/types";

/**
 * 找零参数默认值（= 固件参考实现，见 doc/TODO/TODO-01-机械找零.md）。
 * 现在可编辑但还不下发：等主控固件支持 `op 12` 的可选参数段后，一次写进主控。
 */
const HOMING_DEFAULT = {
  /** 判定系数 k：阈值 = k × 额定电流 */
  k: 0.4,
  /** 额定电流刻度，mA */
  ratedMa: 800,
  /** 连续超阈确认时间 */
  confirmMs: 50,
  /** 找零期间电流上限，mA */
  limitMa: 600,
  /** 推进速度上限，RPM */
  maxRpm: 2000,
  /** 到位后反向退开量（电机端角度） */
  retreatDeg: 360,
  /** 退开后稳定等待，ms */
  settleMs: 2000,
  /** 找零超时，s */
  timeoutS: 60,
};

function HomingStageBadge({ stage }: { stage: number }) {
  if (stage === 1) return <Badge tone="accent" dot="live">进行中</Badge>;
  if (stage === 2) return <Badge tone="ok">成功</Badge>;
  if (stage === 3) return <Badge tone="warn">失败</Badge>;
  return <Badge tone="neutral">空闲</Badge>;
}

/**
 * 机械找零（撞限位回零）。上位机下发方向/步进与工艺参数、显示主控上报的状态；
 * 门控、推进、电流判据、超时与零点写入全部在主控固件里（TODO-01）。
 */
export default function HomingPage() {
  const app = useApp();
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [stepDeg, setStepDeg] = useState(15);
  const [safety, setSafety] = useState(false);
  const [hom, setHom] = useState<HomingState | null>(null);
  const [note, setNote] = useState("");
  const [cfg, setCfg] = useState(HOMING_DEFAULT);
  const running = hom?.stage === 1;
  const thresholdMa = Math.round(cfg.k * cfg.ratedMa);

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
              这是<b>撞限位回零</b>：电机朝限位方向持续推进，主控用「q 轴电流超阈 + <b>连续</b> 确认时间」判定接触，
              记录实测位置为行程零点后反向退开一圈。上位机下发方向、步进与右侧工艺参数并显示状态；
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
            <div className="row" style={{ gap: 8 }}>
              <span className="stat-label" style={{ margin: 0 }}>找零参数</span>
              <span className="tiny muted">待写入主控 · 现在只改界面</span>
            </div>
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label="判定系数 k" hint={`阈值 = ${thresholdMa} mA`}>
                <NumField
                  value={cfg.k}
                  onChange={(v) => setCfg({ ...cfg, k: v })}
                  min={0.1}
                  max={2}
                  step={0.05}
                />
              </Field>
              <Field label="额定电流" hint="判据基准">
                <NumField
                  value={cfg.ratedMa}
                  onChange={(v) => setCfg({ ...cfg, ratedMa: v })}
                  min={100}
                  max={3000}
                  step={50}
                  unit="mA"
                />
              </Field>
              <Field label="连续确认" hint="抗瞬态">
                <NumField
                  value={cfg.confirmMs}
                  onChange={(v) => setCfg({ ...cfg, confirmMs: v })}
                  min={10}
                  max={1000}
                  step={10}
                  unit="ms"
                />
              </Field>
              <Field
                label="找零电流上限"
                hint={cfg.limitMa <= thresholdMa ? "必须 > 阈值" : `> 阈值 ${thresholdMa}`}
              >
                <NumField
                  value={cfg.limitMa}
                  onChange={(v) => setCfg({ ...cfg, limitMa: v })}
                  min={100}
                  max={2000}
                  step={50}
                  unit="mA"
                />
              </Field>
              <Field label="推进速度上限">
                <NumField
                  value={cfg.maxRpm}
                  onChange={(v) => setCfg({ ...cfg, maxRpm: v })}
                  min={100}
                  max={6000}
                  step={100}
                  unit="RPM"
                />
              </Field>
              <Field label="找零超时">
                <NumField
                  value={cfg.timeoutS}
                  onChange={(v) => setCfg({ ...cfg, timeoutS: v })}
                  min={5}
                  max={300}
                  step={5}
                  unit="s"
                />
              </Field>
              <Field label="退开量" hint="电机端">
                <NumField
                  value={cfg.retreatDeg}
                  onChange={(v) => setCfg({ ...cfg, retreatDeg: v })}
                  min={0}
                  max={1080}
                  step={30}
                  unit="°"
                />
              </Field>
              <Field label="退开稳定等待">
                <NumField
                  value={cfg.settleMs}
                  onChange={(v) => setCfg({ ...cfg, settleMs: v })}
                  min={0}
                  max={10000}
                  step={100}
                  unit="ms"
                />
              </Field>
            </div>
            {cfg.limitMa <= thresholdMa && (
              <Notice tone="warn">
                找零电流上限 {cfg.limitMa} mA 不大于判定阈值 {thresholdMa} mA，判据永远无法满足，找零一定超时。
              </Notice>
            )}
            {hom?.message && <div className="tiny muted">主控：{hom.message}</div>}
          </div>
        </div>
      </Card>

      <div className="grid cols-3" style={{ gap: 14 }}>
        <Stat label="找零状态" value={<HomingStageBadge stage={hom?.stage ?? 0} />} delta="0 空闲 / 1 进行中 / 2 成功 / 3 失败" />
        <Stat
          label="行程零点"
          value={hom?.zero_valid ? <Badge tone="ok">有效</Badge> : <Badge tone="warn">需找零</Badge>}
          delta="上电必清，需每次重新找零"
        />
        <Stat
          label="i_q 实测"
          value={(hom?.iq_ma ?? 0).toFixed(0)}
          unit="mA"
          delta={`判定阈值 ${thresholdMa} mA`}
        />
      </div>
    </div>
  );
}