import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { ENCODER_PRESETS, PHI_E_OFFSETS, STORAGE_PRESETS, TESLA_PROFILE } from "../lib/presets";
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
  SelectField,
  Steps,
} from "../components/ui";
import { decodeMt6701, hex, mgText, spiHalfPeriod, spiHzFromHalf, ssiFrameSeconds } from "../lib/units";
import type { EncoderCfgPayload, HomingState } from "../lib/types";

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

function Gauge({ angle, label, sub }: { angle: number; label: string; sub?: string }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const frac = ((angle % 360) + 360) % 360 / 360;
  return (
    <div className="gauge-wrap">
      <svg width="128" height="128" viewBox="0 0 128 128">
        <defs>
          <linearGradient id="gg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2ee6e6" />
            <stop offset="100%" stopColor="#6ea8fe" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="6" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="url(#gg)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 64 64)"
          style={{ filter: "drop-shadow(0 0 6px rgba(46,230,230,.5))", transition: "stroke-dasharray 160ms linear" }}
        />
        <g transform={`rotate(${angle} 64 64)`}>
          <line x1="64" y1="64" x2="64" y2="26" stroke="#f5b544" strokeWidth="2" strokeLinecap="round" />
          <circle cx="64" cy="26" r="3" fill="#f5b544" />
        </g>
        <circle cx="64" cy="64" r="3.4" fill="#2ee3e3" />
        <text x="64" y="104" textAnchor="middle" fontSize="15" fontFamily="Cascadia Code, Consolas, monospace" fill="#e8eef7">
          {angle.toFixed(1)}°
        </text>
        <text x="64" y="118" textAnchor="middle" fontSize="8.5" fill="#6d7b8e" letterSpacing="1.6">
          {label}
        </text>
      </svg>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

export default function EncoderPage() {
  const app = useApp();
  const preset0 = ENCODER_PRESETS[0];
  const [presetId, setPresetId] = useState(preset0.id);
  const preset = ENCODER_PRESETS.find((p) => p.id === presetId) ?? preset0;
  /** 板上那颗 EEPROM（只声明硬件，不改编码器寄存器）。 */
  const [storageId, setStorageId] = useState(STORAGE_PRESETS[0].id);
  const storage = STORAGE_PRESETS.find((p) => p.id === storageId) ?? STORAGE_PRESETS[0];

  const [frameBits, setFrameBits] = useState(preset.frameBits);
  const [spiMode, setSpiMode] = useState(preset.spiMode);
  const [spiHz, setSpiHz] = useState(preset.spiHz);
  const [idle, setIdle] = useState(preset.idleCycles);
  const [sendData, setSendData] = useState(parseInt(preset.sendData, 16));
  /** 片选固定走 ENC_N（本板硬接线），不再做成开关。 */
  const csnEncN = preset.csnViaEncN;
  const [cpr, setCpr] = useState(app.cal.cpr);
  const [poles, setPoles] = useState(app.cal.poles);
  const [offset, setOffset] = useState(app.cal.poles ? 48000 - 1 : 48000);
  const [pwmCount, setPwmCount] = useState(app.cal.pwmMaxCount);
  const [csa, setCsa] = useState(app.cal.csaGain);
  const [writeVel, setWriteVel] = useState(false);
  const [velFrq, setVelFrq] = useState(0x000da71e);
  const [velPer, setVelPer] = useState(0xfff00001);
  const [confirmWrite, setConfirmWrite] = useState(false);
  /** 偏置来源：__calib = 初次标定（本步不写 0x242）；"" = 手动；TMC_xx = 预设偏移。 */
  const [offsetSrc, setOffsetSrc] = useState<string>("__calib");
  const firstCalib = offsetSrc === "__calib";
  const [live, setLive] = useState<{ raw: number; conv: number; phiE: number; frame?: ReturnType<typeof decodeMt6701> } | null>(null);
  const [snapshot, setSnapshot] = useState<Record<number, number>>({});

  // ---- 机械找零：上位机只下发方向与步进，状态全部由主控上报 --------------
  const [homingDir, setHomingDir] = useState<-1 | 1>(-1);
  const [homingStepDeg, setHomingStepDeg] = useState(15);
  const [homingSafety, setHomingSafety] = useState(false);
  const [hom, setHom] = useState<HomingState | null>(null);
  const [homNote, setHomNote] = useState("");
  const homingRunning = hom?.stage === 1;

  /** 掩码由帧长度唯一决定，不再手工填：只保留本帧读到的位。 */
  const mask = frameBits > 14 ? 0x00ff_ffff : 0x0000_3fff;

  const applyPreset = (id: string) => {
    const p = ENCODER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setFrameBits(p.frameBits);
    setSpiMode(p.spiMode);
    setSpiHz(p.spiHz);
    setIdle(p.idleCycles);
    setSendData(parseInt(p.sendData, 16));
    setCpr(p.cpr);
    app.setCal({ cpr: p.cpr });
  };

  // first mount: sync from the machine constants
  useEffect(() => {
    setCpr(app.cal.cpr);
    setPoles(app.cal.poles);
    setPwmCount(app.cal.pwmMaxCount);
    setCsa(app.cal.csaGain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readLive = useCallback(async () => {
    if (!app.connected) return;
    try {
      const items = await api.readMany([0x24d, 0x247, 0x251, 0x240, 0x250, 0x242, 0x0c3, 0x103, 0x244, 0x245]);
      const map: Record<number, number> = {};
      items.forEach((i) => {
        if (i.value !== null) map[i.addr] = i.value;
      });
      setSnapshot(map);
      const raw = map[0x24d] ?? 0;
      const word = raw & 0xffffff;
      setLive({
        raw,
        conv: map[0x247] ?? 0,
        phiE: (map[0x251] ?? 0) & 0xffff,
        frame: frameBits > 14 ? decodeMt6701(word) : undefined,
      });
    } catch {
      /* keep last */
    }
  }, [app.connected, frameBits]);

  useEffect(() => {
    void readLive();
    if (!app.connected) return;
    const t = window.setInterval(() => void readLive(), 260);
    return () => window.clearInterval(t);
  }, [app.connected, readLive]);

  /** 轮询主控上报的找零状态；固件未实现时静默（界面显示「未读到主控状态」）。 */
  useEffect(() => {
    if (!app.connected) {
      setHom(null);
      setHomNote("");
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.homingState(app.motor);
        if (alive) {
          setHom(s);
          setHomNote("");
        }
      } catch (e) {
        if (alive) setHomNote(String(e));
      }
    };
    void tick();
    const t = window.setInterval(tick, 400);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [app.connected, app.motor]);

  const startHoming = async () => {
    try {
      await api.homingStart(
        { dir: homingDir, step_unit: Math.round(homingStepDeg * 100) },
        app.motor
      );
      setHomingSafety(false);
      app.toast("ok", "已请求找零：主控将裁决门控并开始推进");
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const cancelHoming = async () => {
    try {
      await api.homingCancel(app.motor);
      app.toast("warn", "已请求取消找零");
    } catch (e) {
      app.toast("error", String(e));
    }
  };

  const payload: EncoderCfgPayload = useMemo(
    () => ({
      preset: preset.label,
      frame_bits: frameBits,
      spi_mode: spiMode,
      spi_hz: spiHz,
      idle_cycles: idle,
      data_mask: mask,
      send_data: sendData,
      csn_via_enc_n: csnEncN,
      cpr,
      poles,
      phi_e_offset: offset,
      write_phi_e_offset: !firstCalib,
      pwm_max_count: pwmCount,
      csa_gain: csa,
      vel_frq_conf: velFrq,
      vel_per_conf: velPer,
      write_velocity_cfg: writeVel,
    }),
    [preset.label, frameBits, spiMode, spiHz, idle, sendData, csnEncN, cpr, poles, offset, firstCalib, pwmCount, csa, velFrq, velPer, writeVel]
  );

  const cprInv = Math.floor((1 << 24) / Math.max(1, cpr));
  const half = spiHalfPeriod(spiHz);
  const actualSck = spiHzFromHalf(half);
  /** 采样率：一帧 = 帧内 N 个 SCK 周期 + CSN 间隔（同一套 half 计数） */
  const frameHz = 1 / Math.max(1e-9, ssiFrameSeconds(frameBits, half, idle));
  const frameRateText = frameHz >= 1e6 ? `${(frameHz / 1e6).toFixed(2)} MHz` : `${(frameHz / 1e3).toFixed(1)} kHz`;
  const angleDeg = live ? ((live.raw & (frameBits > 14 ? 0x3fff : 0x3fff)) / 16384) * 360 : 0;

  const checks: [number, string, number | null][] = [
    [0x240, "CONF_CH_A", 0x07000000 | cprInv],
    [0x250, "OUTPUT_CONF", 0x00400000 | poles],
    [0x242, "PHI_E_OFFSET", firstCalib ? null : offset & 0xffff],
    [0x0c3, "CSA_GAIN", csa],
    [0x103, "PWM_PERIOD (lo16)", pwmCount],
  ];

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid flow-2-1">
        <div className="col-stack">
        <Card
          title="编码器参数"
          sub="MT6701 · SSI"
          right={<Badge tone="neutral">{preset.label}</Badge>}
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid cols-2" style={{ gap: 10 }}>
              <Field label="编码器" hint="选择后自动填充">
                <SelectField
                  value={presetId}
                  onChange={applyPreset}
                  options={ENCODER_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                />
              </Field>
              <Field label="板上存储" hint={storage.spec}>
                <SelectField
                  value={storageId}
                  onChange={setStorageId}
                  options={STORAGE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                />
              </Field>
            </div>

            <div className="grid cols-4" style={{ gap: 10 }}>
              <Field label="极对数" hint="PHI_E_MUL_FACTOR">
                <NumField value={poles} onChange={(v) => { setPoles(v); app.setCal({ poles: v }); }} min={1} max={127} />
              </Field>
              <Field label="编码器步数 CPR">
                <NumField value={cpr} onChange={(v) => { setCpr(v); app.setCal({ cpr: v }); }} min={16} max={1 << 22} />
              </Field>
              <Field label="电角度偏置" hint="0x242">
                <NumField
                  value={firstCalib ? "" : offset}
                  onChange={setOffset}
                  disabled={firstCalib}
                  placeholder="待对齐"
                  min={0}
                  max={65535}
                />
              </Field>
              <Field label="写入已知偏移" hint="预设偏移">
                <SelectField
                  value={offsetSrc}
                  onChange={(v) => {
                    setOffsetSrc(v);
                    const row = PHI_E_OFFSETS.find((x) => x.name === v);
                    if (row) setOffset(row.offset);
                  }}
                  options={[
                    { value: "__calib", label: "初次电角度偏置标定" },
                    { value: "", label: "— 手动 —" },
                    ...PHI_E_OFFSETS.map((x) => ({ value: x.name, label: `${x.name} · ${x.offset}` })),
                  ]}
                />
              </Field>
            </div>

            <div className="grid cols-4" style={{ gap: 10 }}>
              <Field label="帧长度" hint="SPI_BIT_CNT">
                <SelectField
                  value={frameBits}
                  onChange={setFrameBits}
                  options={[
                    { value: 14, label: "14 bit · 角度" },
                    { value: 24, label: "24 bit · 全帧" },
                  ]}
                />
              </Field>
              <Field label="SPI 模式" hint="CPOL/CPHA">
                <SelectField
                  value={spiMode}
                  onChange={setSpiMode}
                  onClick={() => app.toast("info", "MT6701 编码器固定配置")}
                  options={[0, 1, 2, 3].map((v) => ({ value: v, label: `模式 ${v}` }))}
                />
              </Field>
              <Field label="SCK 频率" hint={`half=${half} → ${(actualSck / 1e6).toFixed(2)} MHz`}>
                <NumField value={spiHz} onChange={setSpiHz} min={117_188} max={3_000_000} step={100_000} unit="Hz" />
              </Field>
              <Field label="CSN 高电平" hint={`≈${frameRateText} 读取率`}>
                <NumField value={idle} onChange={setIdle} min={0} max={255} />
              </Field>
            </div>

            <div className="grid cols-4" style={{ gap: 10 }}>
              <Field label="数据掩码" hint="RESPONSE_2 · 随帧长度">
                <HexField value={mask} disabled />
              </Field>
              <Field label="发送数据" hint="RESPONSE_1">
                <HexField value={sendData} onClick={() => app.toast("info", "MT6701 编码器固定配置")} />
              </Field>
              <Field label="PWM MAX_COUNT" hint="fPWM = 120 MHz / n">
                <NumField value={pwmCount} onChange={(v) => { setPwmCount(v); app.setCal({ pwmMaxCount: v }); }} min={600} max={20000} step={10} />
              </Field>
                <Field label="CSA 增益" hint={`0=1x · 3=4x · ${TESLA_PROFILE.maPerCount.toFixed(3)} mA/LSB`}>
                  <SelectField
                    value={csa}
                    onChange={(v) => { setCsa(v); app.setCal({ csaGain: v }); }}
                    options={[
                      { value: 0, label: "1× · 6.60 A" },
                      { value: 1, label: "2× · 3.30 A" },
                      { value: 2, label: "3× · 2.20 A" },
                      { value: 3, label: "4× · 1.65 A" },
                    ]}
                  />
                </Field>
            </div>

            <div className="row" style={{ gap: 14, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
              <Check checked={writeVel} onChange={setWriteVel}>
                同时写入测速配置
              </Check>
              <Check checked={firstCalib} onChange={(v) => setOffsetSrc(v ? "__calib" : "")}>
                电角度偏置待标定（本次不写 0x242）
              </Check>
            </div>
            {writeVel && (
              <div className="row" style={{ gap: 10 }}>
                <Field label="0x244 VELOCITY_FRQ_CONF" style={{ flex: 1 }}>
                  <HexField value={velFrq} onChange={setVelFrq} />
                </Field>
                <Field label="0x245 VELOCITY_PER_CONF" style={{ flex: 1 }}>
                  <HexField value={velPer} onChange={setVelPer} />
                </Field>
              </div>
            )}

            <div className="divider" />
            <Check checked={confirmWrite} onChange={setConfirmWrite}>
              确认写入 <b>IO_MATRIX / IO Controller / FEEDBACK</b>（会立即改变换相行为）
            </Check>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Save width={14} height={14} />}
                disabled={!app.connected || !app.armed || !confirmWrite || app.jobRunning}
                onClick={() => void app.runJob("encoder", payload)}
              >
                写入编码器配置
              </Button>
              <Button variant="ghost" disabled={!app.connected} onClick={() => void readLive()}>
                刷新回读
              </Button>
              {!app.armed && <span className="tiny muted">需解锁 ARM</span>}
            </div>
          </div>
        </Card>

        <Card title="配置流程" sub="WRITE SEQUENCE" right={<Badge tone={app.jobRunning ? "accent" : "neutral"} dot={app.jobRunning ? "live" : undefined}>{app.jobRunning ? "执行中" : "空闲"}</Badge>}>
          <div className="scroll-y" style={{ maxHeight: 300 }}>
            <Steps steps={app.steps} />
          </div>
        </Card>
        </div>

        <div className="col-stack">
          <Card title="角度回读" sub="FEEDBACK · LIVE">
            <div className="row" style={{ gap: 8 }}>
              <Gauge angle={angleDeg} label="MECHANICAL" sub={`PHI_EXT_A = 0x${(live?.raw ?? 0).toString(16).toUpperCase().padStart(6, "0")}`} />
              <Gauge angle={((live?.phiE ?? 0) / 65536) * 360} label="ELECTRICAL" sub={`PHI_E = ${live?.phiE ?? 0}`} />
            </div>
            <div className="divider" />
            <KV
              rows={[
                ["PHI_EXT_A 原始", <span key="a" className="mono">{hex(live?.raw ?? 0, 6)}</span>],
                ["缩放后 16-bit", <span key="b" className="mono">{live?.conv ?? 0}</span>],
                ["电角度 16-bit", <span key="c" className="mono">{live?.phiE ?? 0}</span>],
                ["CPR_INV", <span key="d" className="mono">{cprInv}</span>],
                ["PHI_E_MUL_FACTOR", <span key="e" className="mono">{(snapshot[0x250] ?? 0) & 0xff}</span>],
              ]}
            />
            {frameBits > 14 && live?.frame && (
              <>
                <div className="divider" />
                <KV
                  rows={[
                    ["角度 D[13:0]", <span key="a" className="mono">{live.frame.angle}</span>],
                    ["状态 Mg[3:0]", <span key="b" className="mono">{`0b${live.frame.mg.toString(2).padStart(4, "0")} · ${mgText(live.frame.mg)}`}</span>],
                    ["CRC-6", <span key="c" className="mono" style={{ color: live.frame.crcOk ? "var(--ok)" : "var(--warn)" }}>{live.frame.crc} {live.frame.crcOk ? "✓" : "?"}</span>],
                  ]}
                />
              </>
            )}
            <div className="divider" />
            <Notice tone={live && live.raw !== 0 ? "ok" : "warn"}>
              {live && live.raw !== 0
                ? "已读到角度：用手转一圈，机械角应从 0° 走到 360° 再回 0°。"
                : "PHI_EXT_A 为 0：检查 SCK/SDO/CSN 接线与预置数据。"}
            </Notice>
          </Card>

          <Card title="写入校验" sub="EXPECTED vs ACTUAL">
            <table className="table">
              <thead>
                <tr>
                  <th>寄存器</th>
                  <th>期望</th>
                  <th>实际</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {checks.map(([addr, name, want]) => {
                  const got = snapshot[addr];
                  const pending = want === null;
                  const ok = got !== undefined && want !== null && (addr === 0x103 ? (got & 0xffff) === want : got === want);
                  return (
                    <tr key={addr}>
                      <td className="mono">
                        {hex(addr, 3)} <span className="muted tiny">{name}</span>
                      </td>
                      <td className="mono">{pending ? "—" : hex(want)}</td>
                      <td className="mono">{got === undefined ? "—" : hex(got)}</td>
                      <td>
                        {pending ? (
                          <Badge tone="neutral">待对齐</Badge>
                        ) : ok ? (
                          <Badge tone="ok">OK</Badge>
                        ) : (
                          <Badge tone="warn">差异</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>


        </div>
      </div>

      <Card
        title="机械找零"
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
                  value={homingDir}
                  onChange={(v) => setHomingDir(v as -1 | 1)}
                  options={[
                    { value: -1, label: "负方向（缩回侧）" },
                    { value: 1, label: "正方向（伸出侧）" },
                  ]}
                />
              </Field>
              <Field label="每拍步进" hint="电机端角度">
                <NumField
                  value={homingStepDeg}
                  onChange={setHomingStepDeg}
                  min={1}
                  max={60}
                  step={1}
                  unit="°"
                />
              </Field>
            </div>
            <div className="tiny muted">
              下发值 = <span className="mono">{homingDir < 0 ? "−" : "+"}{Math.round(homingStepDeg * 100)}</span>
              （0.01° 单位，即 <span className="mono">{homingDir < 0 ? "−" : "+"}{homingStepDeg}°</span>/拍）。
              方向填反会撞向另一端，<b>以机构实测为准</b>。
            </div>
            <div className="divider" />
            <Check checked={homingSafety} onChange={setHomingSafety}>
              我已确认行程内无人员、无异物，且找零方向指向正确的限位端
            </Check>
            <div className="row-wrap" style={{ gap: 8 }}>
              <Button
                variant="primary"
                icon={<Icon.Target width={14} height={14} />}
                disabled={
                  !app.connected || !app.armed || app.mode === "direct" || !homingSafety || homingRunning
                }
                onClick={() => void startHoming()}
              >
                开始找零
              </Button>
              <Button variant="ghost" disabled={!homingRunning} onClick={() => void cancelHoming()}>
                取消找零
              </Button>
              {app.mode === "direct" && <span className="tiny muted">需切到主控模式（485 / CAN）</span>}
              {app.connected && app.mode !== "direct" && !app.armed && (
                <span className="tiny muted">需解锁 ARM</span>
              )}
            </div>
            {!app.connected && <div className="tiny muted">串口未连接</div>}
            {homNote && <div className="tiny muted">{homNote}</div>}
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
