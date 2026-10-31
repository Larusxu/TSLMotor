import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { Badge, Button, Card, Check, Field, HexField, Icon, KV, Notice, NumField } from "../components/ui";
import { hex } from "../lib/units";
import type { EepromLoad, EepromProbe, EepromSave, StoreParams } from "../lib/types";

const blank: StoreParams = {
  cpr: 16_384,
  poles: 1,
  csa_gain: 3,
  pwm_max_count: 4800,
  phi_e_offset: 0,
  torque_limit_ma: 800,
  flux_limit_ma: 0,
  vel_limit_rpm: 25_000,
  uq_ud_limit: 0x5a81,
  cur_p: 64,
  cur_i: 48,
  vel_p: 500,
  vel_i: 250,
  pos_p: 500,
  pos_i: 0,
  flags: 0,
  motor_id: 1,
  axis_origin: 0,
  axis_min: 0,
  axis_max: 0,
  lead_um: 2000,
  counts_per_rpm_x10: 3054,
  ma_per_count_ua: 201,
};

const BLOCK_A = 0x00;
const BLOCK_B = 0x70;
const BLOCK_LEN = 112;

/** Which block a given byte belongs to (for colouring the dump). */
function region(i: number): "A" | "B" | "scratch" | "free" {
  if (i >= BLOCK_A && i < BLOCK_A + BLOCK_LEN) return "A";
  if (i >= BLOCK_B && i < BLOCK_B + BLOCK_LEN) return "B";
  if (i === 0xfe) return "scratch";
  return "free";
}

export default function StoragePage() {
  const app = useApp();
  const [params, setParams] = useState<StoreParams>(blank);
  const [probe, setProbe] = useState<EepromProbe | null>(null);
  const [saved, setSaved] = useState<EepromSave | null>(null);
  const [loaded, setLoaded] = useState<EepromLoad | null>(null);
  const [image, setImage] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [safety, setSafety] = useState(false);

  /** Pull the live machine constants into the form (CPR / poles / CSA / PWM). */
  const fromCal = useCallback(() => {
    setParams((p) => ({
      ...p,
      cpr: app.cal.cpr,
      poles: app.cal.poles,
      csa_gain: app.cal.csaGain,
      pwm_max_count: app.cal.pwmMaxCount,
      counts_per_rpm_x10: Math.round(app.cal.countsPerRpm * 10),
      ma_per_count_ua: Math.round(app.cal.maPerCount * 1000),
    }));
  }, [app.cal]);

  useEffect(() => {
    fromCal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      app.toast("error", `${label}失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doProbe = () =>
    run("自检", async () => {
      const r = await api.eepromProbe();
      setProbe(r);
      app.toast(r.ok ? "ok" : "error", r.message);
    });

  const doDump = () =>
    run("读取", async () => {
      const r = await api.eepromDump();
      setImage(r);
    });

  const doSave = () =>
    run("保存", async () => {
      const r = await api.eepromSave(params);
      setSaved(r);
      await doDump();
      app.toast(r.verified ? "ok" : "warn", `已写入 EEPROM：seq=${r.seq}（${r.elapsed_ms} ms）`);
    });

  const doLoad = () =>
    run("读取参数", async () => {
      const r = await api.eepromLoad();
      setLoaded(r);
      if (r.params) setParams(r.params);
      app.toast(r.found ? "ok" : "warn", r.message);
    });

  const doErase = () =>
    run("作废", async () => {
      const n = await api.eepromErase();
      setLoaded(null);
      setSaved(null);
      await doDump();
      app.toast("warn", `已清空参数块（${n} 字节写入）`);
    });

  /** Put the stored values where the other pages read them from. */
  const applyToUi = () => {
    app.setCal({
      cpr: params.cpr,
      poles: params.poles,
      csaGain: params.csa_gain,
      pwmMaxCount: params.pwm_max_count,
      countsPerRpm: params.counts_per_rpm_x10 / 10,
      maPerCount: params.ma_per_count_ua / 1000,
    });
    app.toast("ok", "已应用到界面常量（CPR / 极对数 / CSA / PWM / 换算系数）");
  };

  const writeOffset = async () => {
    try {
      await api.writeReg(0x242, params.phi_e_offset & 0xffff, true);
      app.toast("ok", `0x242 ← ${hex(params.phi_e_offset & 0xffff, 4)}`);
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const num = (k: keyof StoreParams) => (
    <NumField
      value={params[k] as number}
      onChange={(v) => setParams({ ...params, [k]: Math.round(v) })}
      min={0}
      max={k === "phi_e_offset" || k === "uq_ud_limit" ? 0xffff : 65_535}
    />
  );

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid flow-2-1">
        <div className="col-stack">
          <Card
            title="存储芯片"
            sub="M24C02 · 256 B · I²C"
            right={
              <Badge tone={probe?.ok ? "ok" : probe ? "danger" : "neutral"} dot={busy ? "live" : undefined}>
                {busy ? "执行中" : probe ? (probe.ok ? "可读可写" : "自检失败") : "未自检"}
              </Badge>
            }
          >
            <div className="stack" style={{ gap: 12 }}>
              <Notice tone="warn">
                这颗 EEPROM 挂在 TMC6460 的 <b>HALL_U(SDA) / HALL_V(SCL)</b> 上——这是芯片唯一的 I²C
                引脚。启用后<b>霍尔/第二路反馈就不可用了</b>；本页会顺手把 IO_MATRIX 改掉，并把桥臂切到 PWM_OFF。
              </Notice>

              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Button variant="primary" icon={<Icon.Check width={14} height={14} />} disabled={!app.connected || busy} onClick={() => void doProbe()}>
                  自检（写读 0xFE）
                </Button>
                <Button variant="ghost" disabled={!app.connected || busy} onClick={() => void doDump()}>
                  读取全部 256 B
                </Button>
                <Button variant="ghost" disabled={!app.connected || busy} onClick={() => void doLoad()}>
                  读取参数块
                </Button>
                <Button variant="ghost" disabled={!app.connected || busy} onClick={() => void doErase()}>
                  作废参数块
                </Button>
              </div>

              {probe ? (
                <KV
                  cols={2}
                  rows={[
                    ["结论", <span key="m">{probe.message}</span>],
                    ["I²C 时钟", <span key="hz" className="mono">{(probe.i2c_hz / 1000).toFixed(0)} kHz</span>],
                    ["IO_MATRIX", <span key="mx" className="mono">{hex(probe.matrix_before)} → {hex(probe.matrix_after)}</span>],
                    ["测试字节", <span key="t" className="mono">@0x{probe.addr.toString(16).toUpperCase()} 原值 0x{probe.saved.toString(16).toUpperCase().padStart(2, "0")}</span>],
                    ["写入 → 回读", <span key="p" className="mono">{probe.written.map((v) => v.toString(16).toUpperCase()).join("/")} → {probe.read_back.map((v) => v.toString(16).toUpperCase()).join("/")}</span>],
                    ["块 A / 块 B", <span key="b" className="mono">0x00–0x6F / 0x70–0xDF</span>],
                  ]}
                />
              ) : (
                <div className="tiny muted">先点「自检」确认真能读写，再保存参数。</div>
              )}
            </div>
          </Card>

          <Card title="参数块" sub="PARAMETER BLOCK">
            <div className="stack" style={{ gap: 12 }}>
              <div className="grid cols-4" style={{ gap: 10 }}>
                <Field label="编码器步数 CPR">{num("cpr")}</Field>
                <Field label="极对数">{num("poles")}</Field>
                <Field label="CSA 增益" hint="0=1x · 3=4x">{num("csa_gain")}</Field>
                <Field label="PWM MAX_COUNT">{num("pwm_max_count")}</Field>
              </div>

              <div className="grid cols-4" style={{ gap: 10 }}>
                <Field label="电角度偏置" hint="0x242">
                  <HexField value={params.phi_e_offset} onChange={(v) => setParams({ ...params, phi_e_offset: v })} bits={16} />
                </Field>
                <Field label="力矩限幅" hint="mA">{num("torque_limit_ma")}</Field>
                <Field label="磁链限幅" hint="mA">{num("flux_limit_ma")}</Field>
                <Field label="速度限幅" hint="RPM">{num("vel_limit_rpm")}</Field>
              </div>

              <div className="grid cols-4" style={{ gap: 10 }}>
                <Field label="Uq/Ud 限幅" hint="0x149">
                  <HexField value={params.uq_ud_limit} onChange={(v) => setParams({ ...params, uq_ud_limit: v })} bits={16} />
                </Field>
                <Field label="电机编号">{num("motor_id")}</Field>
                <Field label="丝杆导程" hint="µm">{num("lead_um")}</Field>
                <Field label="原点 counts">{num("axis_origin")}</Field>
              </div>

              <div className="grid cols-4" style={{ gap: 10 }}>
                <Field label="电流 P">{num("cur_p")}</Field>
                <Field label="电流 I">{num("cur_i")}</Field>
                <Field label="速度 P">{num("vel_p")}</Field>
                <Field label="速度 I">{num("vel_i")}</Field>
              </div>

              <div className="grid cols-4" style={{ gap: 10 }}>
                <Field label="位置 P">{num("pos_p")}</Field>
                <Field label="位置 I">{num("pos_i")}</Field>
                <Field label="软限位下限">{num("axis_min")}</Field>
                <Field label="软限位上限">{num("axis_max")}</Field>
              </div>

              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                <Check
                  checked={(params.flags & 1) !== 0}
                  onChange={(v) => setParams({ ...params, flags: v ? params.flags | 1 : params.flags & ~1 })}
                >
                  电角度已标定
                </Check>
                <Button size="sm" variant="ghost" onClick={fromCal}>
                  从界面常量取值
                </Button>
                <Button size="sm" variant="ghost" onClick={applyToUi}>
                  应用到界面常量
                </Button>
                <Button size="sm" variant="ghost" disabled={!app.connected} onClick={() => void writeOffset()}>
                  写入 0x242
                </Button>
              </div>

              <div className="divider" />
              <Check checked={safety} onChange={setSafety}>
                我知道这会改写板上保存的标定值（A/B 双份同时覆盖）
              </Check>
              <div className="row" style={{ gap: 8 }}>
                <Button
                  variant="primary"
                  icon={<Icon.Save width={14} height={14} />}
                  disabled={!app.connected || !safety || busy}
                  onClick={() => void doSave()}
                >
                  保存到 EEPROM
                </Button>
                <Button variant="ghost" disabled={!app.connected || busy} onClick={() => void doLoad()}>
                  从 EEPROM 读取
                </Button>
                {saved && (
                  <span className="tiny muted">
                    seq={saved.seq} · {saved.bytes_written} B · {saved.elapsed_ms} ms ·{" "}
                    {saved.verified ? "回读一致" : "回读不一致"}
                  </span>
                )}
              </div>

              {loaded && (
                <Notice tone={loaded.found ? "ok" : "warn"}>
                  {loaded.message}
                  {loaded.found && (
                    <span className="mono">
                      {" "}
                      · A:{loaded.crc_a ? "✓" : "✗"} B:{loaded.crc_b ? "✓" : "✗"}
                    </span>
                  )}
                </Notice>
              )}
            </div>
          </Card>
        </div>

        <div className="col-stack">
          <Card
            title="EEPROM 内容"
            sub="HEX DUMP"
            right={
              <Button size="sm" variant="ghost" disabled={!app.connected || busy} onClick={() => void doDump()}>
                刷新
              </Button>
            }
          >
            {!image ? (
              <div className="empty">
                <Icon.Save width={22} height={22} />
                点「读取全部 256 B」
              </div>
            ) : (
              <div className="mono tiny" style={{ maxHeight: 460, overflow: "auto" }}>
                {Array.from({ length: 16 }, (_, row) => {
                  const base = row * 16;
                  return (
                    <div key={row} style={{ whiteSpace: "pre", display: "flex", gap: 10 }}>
                      <span className="muted">{hex(base, 4)}</span>
                      <span>
                        {image.slice(base, base + 16).map((b, i) => {
                          const r = region(base + i);
                          const color =
                            r === "A" ? "var(--accent)" : r === "B" ? "var(--ok)" : r === "scratch" ? "var(--warn)" : undefined;
                          return (
                            <span key={i} style={{ color }}>
                              {b.toString(16).toUpperCase().padStart(2, "0")}
                              {i === 15 ? "" : " "}
                            </span>
                          );
                        })}
                      </span>
                    </div>
                  );
                })}
                <div className="divider" />
                <div className="muted">
                  青=块 A(0x00–0x6F) 绿=块 B(0x70–0xDF) 黄=自检字节(0xFE) 灰=未用
                </div>
              </div>
            )}
          </Card>

          <Card title="说明" sub="NOTES">
            <div className="stack" style={{ gap: 8 }}>
              <Notice>
                参数块 = <span className="mono">"TSL1" + 版本 + 序号 + 23×u32 + CRC-8</span>，共 112 B，
                A/B 各一份；读取时取序号大且 CRC 通过的那份。
              </Notice>
              <div className="tiny muted">
                写入走 I²C_WRITE 单字节命令，每字节 6 ms（EEPROM 写周期 ≤5 ms），整块约 0.7 s；
                写前桥臂已切 PWM_OFF。上电后仍需点「从 EEPROM 读取」再写进芯片，自动加载要等固件支持。
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
