import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { Badge, Button, Card, Check, Field, Icon, KV, Notice, NumField, SelectField } from "../components/ui";
import { fmt } from "../lib/units";
import type { AxisState } from "../lib/types";

/** Parsed travel window in counts, derived from mm.
 *
 * The near end of the window *is* the mechanical origin — that is where the
 * axis sits after homing, so it must stay inside its own guard. The safety
 * margin is taken off the far end, which is the side that can crash.
 */
function windowFromMm(opts: {
  home: number;
  lead: number;
  travel: number;
  margin: number;
  dir: 1 | -1;
  countsPerRev: number;
}) {
  const { home, lead, travel, margin, dir, countsPerRev } = opts;
  const perMm = lead > 0 ? countsPerRev / lead : 0;
  const near = home;
  const far = home + dir * Math.round((travel - margin) * perMm);
  const end = home + dir * Math.round(travel * perMm);
  return {
    perMm,
    min: Math.min(near, far),
    max: Math.max(near, far),
    fullMin: Math.min(near, end),
    fullMax: Math.max(near, end),
    mm: (cnt: number) => (perMm > 0 ? ((cnt - home) * dir) / perMm : 0),
    cnt: (mm: number) => home + dir * Math.round(mm * perMm),
  };
}

export default function AxisPage() {
  const app = useApp();
  const countsPerRev = app.cal.cpr * 4;
  const st: AxisState | null = app.axis;
  const poles = app.cal.poles;

  // screw geometry
  const [lead, setLead] = useState(2);
  const [travel, setTravel] = useState(20);
  const [margin, setMargin] = useState(0.5);
  const [dir, setDir] = useState<1 | -1>(1);
  const [home, setHome] = useState<number | null>(null);
  // guard
  const [enabled, setEnabled] = useState(true);
  const [action, setAction] = useState<"loose" | "brake">("loose");
  const [ch, setCh] = useState(0);

  // motion
  const [jogRpm, setJogRpm] = useState(60);
  const [targetMm, setTargetMm] = useState(10);
  const [moveRpm, setMoveRpm] = useState(120);
  const [accel, setAccel] = useState(400_000);
  const [safety, setSafety] = useState(false);
  const [homeRpm, setHomeRpm] = useState(20);

  const pos = st?.pos ?? 0;
  // lock the origin once we have a first sample; before that the window simply
  // starts at zero so nothing jumps around while the link comes up
  useEffect(() => {
    if (home === null && st) setHome(st.pos);
  }, [st, home]);
  const origin = home ?? 0;
  const geo = useMemo(
    () => windowFromMm({ home: origin, lead, travel, margin, dir, countsPerRev }),
    [origin, lead, travel, margin, dir, countsPerRev]
  );

  const posMm = geo.mm(pos);
  const span = Math.max(1, geo.fullMax - geo.fullMin);
  const toMin = pos - geo.min;
  const toMax = geo.max - pos;
  const warnBand = Math.max(200, Math.round((geo.max - geo.min) * 0.08));
  const atRisk = !!st?.limits.enabled && (toMin < warnBand || toMax < warnBand);
  const inWindow = st?.limits.enabled ? pos >= st.limits.min && pos <= st.limits.max : true;
  const tone = st?.tripped || !inWindow ? "bad" : atRisk ? "warn" : "ok";
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - geo.fullMin) / span) * 100));

  const bus = app.connected;
  const busy = !bus || !app.armed || !safety;

  const apply = async () => {
    try {
      const next = await api.axisSetLimits({ enabled, ch, min: geo.min, max: geo.max, action });
      app.setAxis(next);
      app.toast("ok", `软限位 ${next.limits.min} … ${next.limits.max}`);
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const jog = async (sign: 1 | -1, rpm = jogRpm) => {
    try {
      app.setAxis(await api.axisJog(sign * Math.abs(rpm), poles, app.cal.countsPerRpm));
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const moveTo = async () => {
    try {
      const target = geo.cnt(targetMm);
      app.setAxis(
        await api.axisMove({
          target,
          tol: Math.max(20, Math.round(geo.perMm * 0.03)),
          max_rpm: moveRpm,
          accel,
          cpr: countsPerRev,
          poles,
        })
      );
      app.toast("ok", `定位 → ${fmt(targetMm, 2)} mm (${target})`);
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const hold = async () => {
    try {
      app.setAxis(await api.axisHold(poles));
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const clear = async () => {
    app.setAxis(await api.axisClear());
    app.toast("ok", "软限位已复位");
  };

  const hookFeedback = async () => {
    if (!bus) {
      app.toast("warn", "请先连接串口");
      return;
    }
    app.setChannel(ch, "pos_act");
    await app.startStream({ ch, id: "pos_act" });
  };

  const sendLimits = (on: boolean) =>
    api
      .axisSetLimits({ enabled: on, ch, min: geo.min, max: geo.max, action })
      .then(app.setAxis)
      .catch((e) => app.toast("error", String(e)));

  return (
    <div className="grid" style={{ gap: 14 }}>
      {/* ---------------------------------------------------------- status */}
      <Card
        title="轴状态"
        sub="AXIS STATUS"
        right={
          <div className="row" style={{ gap: 6 }}>
            <Badge
              tone={st?.limits.enabled ? "accent" : "neutral"}
              dot={st?.limits.enabled ? "live" : undefined}
            >
              {st?.limits.enabled ? "软限位已写入" : "软限位未写入"}
            </Badge>
            {st?.tripped && <Badge tone="danger">已触发</Badge>}
            {st?.moving && <Badge tone="warn">运行中</Badge>}
            {st?.done && !st.moving && <Badge tone="ok">到位</Badge>}
            {!app.streaming && <Badge tone="warn">无位置反馈</Badge>}
          </div>
        }
      >
        <div className="axis-hero">
          <div className={`axis-num tone-${tone}`}>
            <b>{fmt(posMm, 3)}</b>
            <span>mm</span>
          </div>
          <div className="axis-side">
            <KV
              cols={3}
              rows={[
                ["编码器位置", <span className="mono">{pos} counts</span>],
                ["距下限 / 上限", <span className="mono">{toMin} / {toMax}</span>],
                ["速度指令", <span className="mono">{fmt(st?.cmd_rpm ?? 0, 1)} RPM</span>],
              ]}
            />
          </div>
          <div className="axis-track-wrap">
            <div className={`axis-track tone-${tone}`}>
              <div
                className="axis-window"
                style={{ left: `${pct(geo.min)}%`, width: `${pct(geo.max) - pct(geo.min)}%` }}
              />
              <div
                className="axis-margin"
                style={{
                  left: `${Math.min(pct(geo.max), pct(geo.fullMax))}%`,
                  width: `${Math.abs(pct(geo.fullMax) - pct(geo.max))}%`,
                }}
              />
              <div className="axis-marker" style={{ left: `${pct(pos)}%` }}>
                <i />
              </div>
            </div>
            <div className="axis-scale">
              <span>0</span>
              <span>{fmt(travel / 2, 2)} mm</span>
              <span>{fmt(travel, 2)} mm</span>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid flow-1-2">
        <div className="col-stack">
          <Card
            title="丝杆换算"
            sub="SCREW GEOMETRY"
            right={
              <Button size="sm" variant="ghost" disabled={!bus} onClick={() => setHome(pos)}>
                <Icon.Target width={13} height={13} /> 设为原点
              </Button>
            }
          >
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label="导程" hint="mm/转">
                <NumField value={lead} onChange={setLead} min={0.1} step={0.5} unit="mm" />
              </Field>
              <Field label="有效行程" hint="mm">
                <NumField value={travel} onChange={setTravel} min={0.5} step={1} unit="mm" />
              </Field>
              <Field label="安全边距" hint="远端">
                <NumField value={margin} onChange={setMargin} min={0} step={0.1} unit="mm" />
              </Field>
              <Field label="计数方向" hint="+1 伸出">
                <SelectField
                  value={dir}
                  onChange={(v) => setDir(v as 1 | -1)}
                  options={[
                    { value: 1, label: "counts↑ = 伸出" },
                    { value: -1, label: "counts↑ = 缩回" },
                  ]}
                />
              </Field>
            </div>
            <div className="divider" />
            <KV
              rows={[
                ["每圈计数", <span className="mono">{countsPerRev}</span>],
                ["每毫米计数", <span className="mono">{fmt(geo.perMm, 1)}</span>],
                ["原点", <span className="mono">{origin}{home === null ? " · 未锁定" : ""}</span>],
                ["软限位", <span className="mono">{geo.min} … {geo.max}</span>],
              ]}
            />
          </Card>

          <Card title="回零向导" sub="FIND STOP">
            <div className="stack" style={{ gap: 10 }}>
              <Notice tone="warn">
                正式找零由<b>主控固件</b>执行（撞限位 + 电流判据），请用
                <b> 编码器页 → 「机械找零」</b>。本卡是固件未实现找零时的手动兜底：
                需要操作者自己判断"顶住了"。
              </Notice>
              <div className="tiny muted">
                让轴低速顶到缩回侧的机械限位，读到的位置就是原点。顺序：
                ① 临时关软限位 → ② 低速缩回 → ③ 顶住后停止 → ④ 设为原点 → ⑤ 重新写入软限位。
              </div>
              <Field label="找零速度" hint="RPM ≤30">
                <NumField value={homeRpm} onChange={setHomeRpm} min={5} max={100} step={5} unit="RPM" />
              </Field>
              <div className="row-wrap" style={{ gap: 8 }}>
                <Button size="sm" variant="ghost" disabled={!bus} onClick={() => void sendLimits(false)}>
                  ① 关闭软限位
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void jog(-1, Math.abs(homeRpm))}
                >
                  ② 低速缩回
                </Button>
                <Button size="sm" variant="ghost" disabled={!bus} onClick={() => void hold()}>
                  ③ 停止
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <div className="col-stack">
          <Card
            title="行程保护"
            sub="TRAVEL GUARD"
            right={
              <Button size="sm" variant="primary" disabled={!bus} onClick={() => void apply()}>
                写入软限位
              </Button>
            }
          >
            <div className="stack" style={{ gap: 12 }}>
              <Notice tone="warn">
                丝杆撞到机械限位会顶坏丝母或丢步。<b>接入位置反馈后</b>芯片每收到一帧位置就检查一次，
                越界立即松力矩——这是软件层最后的防线，不能替代机械限位与硬件限位开关。
              </Notice>
              <div className="grid cols-2" style={{ gap: 10 }}>
                <Field label="反馈通道" hint="RTMI 位置">
                  <SelectField
                    value={ch}
                    onChange={setCh}
                    options={[0, 1, 2, 3, 4, 5, 6].map((i) => ({ value: i, label: `CH${i}` }))}
                  />
                </Field>
                <Field label="越限动作" hint="触发后">
                  <SelectField
                    value={action}
                    onChange={(v) => setAction(v as "loose" | "brake")}
                    options={[
                      { value: "loose", label: "松力矩（保持）" },
                      { value: "brake", label: "刹车 PWM_OFF" },
                    ]}
                  />
                </Field>
              </div>
              <div className="row-wrap" style={{ gap: 10 }}>
                <Check checked={enabled} onChange={setEnabled}>
                  启用软限位
                </Check>
                <Button size="sm" variant="ghost" disabled={!bus} onClick={() => void hookFeedback()}>
                  <Icon.Refresh width={13} height={13} /> 接入位置反馈 0x155
                </Button>
                <Button size="sm" variant="ghost" disabled={!st} onClick={() => void clear()}>
                  复位触发
                </Button>
                {app.streaming && <Badge tone="ok">反馈已就绪</Badge>}
              </div>
              <div className="divider" />
              <KV
                cols={3}
                rows={[
                  ["保护状态", st?.tripped ? "已触发" : "正常"],
                  ["上次触发", st?.tripped ? `${st.pos}` : "—"],
                  ["窗口宽度", `${geo.max - geo.min}`],
                ]}
              />
            </div>
          </Card>

          <Card title="受控运动" sub="GUARDED MOTION">
            <div className="stack" style={{ gap: 12 }}>
              <div className="row-wrap" style={{ gap: 10, alignItems: "flex-end" }}>
                <Field label="点动速度" hint="RPM" style={{ flex: "0 0 120px" }}>
                  <NumField value={jogRpm} onChange={setJogRpm} min={1} max={500} step={10} unit="RPM" />
                </Field>
                <Button disabled={busy} onClick={() => void jog(-1)}>
                  缩回
                </Button>
                <Button disabled={busy} onClick={() => void jog(1)}>
                  伸出
                </Button>
                <Button variant="danger" disabled={!bus} onClick={() => void hold()}>
                  <Icon.Stop width={13} height={13} /> 停止
                </Button>
              </div>

              <div className="divider" />

              <div className="row-wrap" style={{ gap: 10, alignItems: "flex-end" }}>
                <Field label="目标" hint="mm" style={{ flex: "0 0 110px" }}>
                  <NumField value={targetMm} onChange={setTargetMm} step={0.5} unit="mm" />
                </Field>
                <Field label="速度上限" hint="RPM" style={{ flex: "0 0 120px" }}>
                  <NumField value={moveRpm} onChange={setMoveRpm} min={1} max={500} step={10} unit="RPM" />
                </Field>
                <Field label="加速度" hint="counts/s²" style={{ flex: "1 1 150px" }}>
                  <NumField value={accel} onChange={setAccel} min={1000} step={50_000} />
                </Field>
                <Button variant="primary" disabled={busy} onClick={() => void moveTo()}>
                  <Icon.Target width={14} height={14} /> 定位
                </Button>
              </div>

              <div className="row-wrap" style={{ gap: 6 }}>
                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                  const mm = travel * f;
                  return (
                    <Button
                      key={f}
                      size="sm"
                      variant="ghost"
                      disabled={busy || mm > travel - margin}
                      onClick={() => setTargetMm(mm)}
                    >
                      {fmt(mm, 1)} mm
                    </Button>
                  );
                })}
              </div>

              <Check checked={safety} onChange={setSafety}>
                我已确认丝杆无卡滞、联轴器锁紧、软限位已写入
              </Check>
              {!app.armed && <Notice tone="warn">需先在顶栏解锁 ARM，运动指令才会下发。</Notice>}
              {st?.tripped && (
                <Notice tone="danger">
                  软限位已触发，运动指令被拒绝。确认没有顶死机械限位后再点「复位触发」。
                </Notice>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
