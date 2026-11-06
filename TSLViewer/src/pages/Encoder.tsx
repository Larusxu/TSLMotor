import Gauge from "../components/EncoderGauge";
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
import type { EncoderCfgPayload } from "../lib/types";
import { AlignmentPanels } from "./Align";
import MainboardEncoder from "./MainboardEncoder";

export default function EncoderPage() {
  const app = useApp();
  return app.mode !== "direct" ? <MainboardEncoder key={app.motor}/> : <DirectEncoderPage/>;
}
function DirectEncoderPage() {
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
  const [velFrq, setVelFrq] = useState(app.motor === 9 ? 0x0002bb12 : 0x000da71e);
  const [velPer, setVelPer] = useState(0xfff00001);
  const [confirmWrite, setConfirmWrite] = useState(false);
  /** 偏置来源：__calib = 初次标定（本步不写 0x242）；"" = 手动；TMC_xx = 预设偏移。 */
  const [offsetSrc, setOffsetSrc] = useState<string>("__calib");
  const firstCalib = offsetSrc === "__calib";
  const alignedOffset = app.alignment?.written ? app.alignment.offset : null;
  const [live, setLive] = useState<{ raw: number; conv: number; phiE: number; frame?: ReturnType<typeof decodeMt6701> } | null>(null);
  const [snapshot, setSnapshot] = useState<Record<number, number>>({});

  // A successful automatic alignment write supersedes the initial-setup skip.
  useEffect(() => {
    if (app.alignment?.written) {
      setOffset(app.alignment.offset);
      setOffsetSrc("");
    }
  }, [app.motor, app.alignment?.written, app.alignment?.offset]);

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

  /**
   * 角度实时回读开关：默认关闭。
   * 这是「还没装丝杠、空轴手转验收」时才需要连续读；装上丝杆后关掉，免得白占链路带宽。
   */
  const [liveOn, setLiveOn] = useState(false);

  useEffect(() => {
    if (!app.connected) return;
    if (!liveOn) return;
    const t = window.setInterval(() => void readLive(), 260);
    return () => window.clearInterval(t);
  }, [app.connected, liveOn, readLive]);

  // 关掉实时回读时，任务跑完补一次静态回读，保证「写入校验」表有数
  useEffect(() => {
    if (app.lastDone?.ok) void readLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lastDone]);

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
    [0x0c3, "CSA_GAIN (lo2)", csa],
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
                  value={firstCalib ? alignedOffset ?? "" : offset}
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
              {app.motor === 9 && <Button size="sm" variant="ghost" disabled={app.jobRunning} onClick={() => {
                setVelFrq(0x0002bb12); setVelPer(0xfff00001); setWriteVel(true);
              }}>载入 M9 实测测速配置</Button>}
              <Check checked={firstCalib} onChange={(v) => setOffsetSrc(v ? "__calib" : "")}>
                电角度偏置待标定（本次不写 0x242）
              </Check>
            </div>
            <div className="tiny muted">测速配置用于芯片的速度反馈与速度环更新，不是设置电机转速。不勾选会保留当前 0x244/0x245；首次配置或复位后，请按该电机已验证的参数显式写入。</div>
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
                disabled={!app.connected || !confirmWrite || app.jobRunning}
                onClick={() => void app.runJob("encoder", payload)}
              >
                写入编码器配置
              </Button>
              <Button variant="ghost" disabled={!app.connected || app.jobRunning} onClick={() => void readLive()}>
                刷新回读
              </Button>

            </div>
          </div>
        </Card>

        <Card title="配置流程" sub="WRITE · ALIGN" right={<Badge tone={app.jobRunning ? "accent" : "neutral"} dot={app.jobRunning ? "live" : undefined}>{app.jobRunning ? "执行中" : "空闲"}</Badge>}>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <div className="stack" style={{ gap: 7 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="stat-label" style={{ margin: 0 }}>编码器写入</span>
                <span className="tiny muted">WRITE SEQUENCE</span>
              </div>
              <Steps steps={app.stepsByKind.encoder ?? []} height={232} />
            </div>
            <div className="stack" style={{ gap: 7 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="stat-label" style={{ margin: 0 }}>电角度对齐</span>
                <span className="tiny muted">ALIGN SEQUENCE</span>
              </div>
              <Steps steps={app.stepsByKind.calibrate ?? []} height={232} />
            </div>
          </div>
        </Card>
        </div>

        <div className="col-stack">
          <Card title="写入校验" sub="EXPECTED vs ACTUAL">
            <div className="tiny muted">当前输入与最近回读对照；尚未写入或读取失败不等于写入失败。初次标定模式会跳过 0x242。</div>
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
                  const raw = snapshot[addr];
                  const got = raw === undefined ? undefined : addr === 0x0c3 ? raw & 3 : raw;
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
                          <Badge tone="neutral">本次未写</Badge>
                        ) : got === undefined ? (
                          <Badge tone="neutral">未读回</Badge>
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
          <Card
            title="角度回读"
            sub="FEEDBACK · LIVE"
            right={
              <Button
                size="sm"
                variant={liveOn ? "danger" : "primary"}
                disabled={!app.connected || app.jobRunning}
                title={liveOn ? "当前：开启（正在连续回读）· 点击关闭" : "当前：关闭 · 点击开启连续回读"}
                onClick={() => setLiveOn((v) => !v)}
              >
                {liveOn ? "关闭" : "开启"}
              </Button>
            }
          >
            <div className="grid cols-2" style={{ gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Gauge angle={angleDeg} label="MECHANICAL" sub={`PHI_EXT_A = 0x${(live?.raw ?? 0).toString(16).toUpperCase().padStart(6, "0")}`} />
              </div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Gauge angle={((live?.phiE ?? 0) / 65536) * 360} label="ELECTRICAL" sub={`PHI_E = ${live?.phiE ?? 0}`} />
              </div>
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
            {live && live.raw === 0 && (
              <>
                <div className="divider" />
                <Notice tone="warn">PHI_EXT_A 为 0：检查 SCK/SDO/CSN 接线与预置数据。</Notice>
              </>
            )}
          </Card>

        </div>
      </div>

      <AlignmentPanels />
    </div>
  );
}
