import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import type { MaxChip, PowerOutput } from "../lib/fleet";
import { STATIC_CHANNEL_MOTORS } from "../lib/fleet";
import type { MotorState } from "../lib/semantic-state";
import type { CylinderModel } from "../lib/cylinder";
import { tempC, fmt } from "../lib/units";
import { Badge, Card, Icon, Toggle } from "./ui";

const modes = ["位置直通", "位置插补", "速度直通", "速度斜坡"];
const CHIP_NAMES = ["U10", "U7", "U14", "U13"];
type View = "cards" | "list";
/** Signal freshness for the corner dot on every card. */
type Tone = "ok" | "warn" | "stale";

const VOLT = (mv: number | null | undefined) => (mv == null ? "—" : `${(mv / 1000).toFixed(2)} V`);
const AMP = (ma: number | null | undefined) => (ma == null ? "—" : `${fmt(ma, 0)} mA`);
const dotTone = (warn: boolean, stale: boolean): Tone => (warn ? "warn" : stale ? "stale" : "ok");

export default function FleetOverview({ cylinders }: { cylinders: CylinderModel }) {
  const app = useApp(), { motors, power, chips, powerAt, firmware } = app.fleet;
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<View>("cards");
  const [switching, setSwitching] = useState<Record<number, boolean>>({});
  const [desired, setDesired] = useState<Record<number,boolean>>({});
  const switchLock = useRef(new Set<number>());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const paused = app.acquiring || app.streaming;
  const fresh = (n: number) => app.connected && !!motors[n]?.at && now - motors[n].at < 8000;
  const supplyFresh = !!powerAt && now - powerAt < 8000 && app.connected;
  const tmcOnline = (id: number) => !!power[id - 1]?.tmcOnline;
  const online = Array.from({ length: 16 }, (_, i) => i + 1).filter(tmcOnline).length;
  const faults = Array.from({ length: 16 }, (_, i) => i + 1)
    .filter((id) => power[id-1]?.enabled === true && (!!power[id - 1]?.fault || !!motors[id]?.state?.fault)).length;

  const toggleSupply = async (id: number, on: boolean) => {
    if(switchLock.current.has(id))return;
    switchLock.current.add(id);
    setSwitching(old=>({...old,[id]:true}));
    setDesired(old=>({...old,[id]:on}));
    try {
      await api.mainControl(id, 5, [on ? 1 : 0]);
      const until=Date.now()+2000;
      while(true){
        const confirmed=await app.fleet.refreshPower();
        if(confirmed[id-1]?.enabled===on)break;
        if(Date.now()>=until)throw Error("供电状态尚未确认，请读取核对");
        await new Promise(resolve=>setTimeout(resolve,30));
      }
    } catch (e) {
      app.toast("error", `M${id} ${on ? "开启" : "关闭"}供电失败：${String(e)}`);
    } finally {
      setSwitching(old=>{const next={...old};delete next[id];return next;});
      setDesired(old=>{const next={...old};delete next[id];return next;});
      switchLock.current.delete(id);
    }
  };

  return <section className="fleet" aria-label="16 路电机概览">
    <div className="fleet-summary">
      <div><span>主控</span><strong>{app.connected ? "已连接" : "未连接"}</strong><small>{app.port} · 1.5 Mbps</small></div>
      <div><span>固件版本</span><strong className="fleet-version">{firmware || "—"}</strong><small>主控只读快照</small></div>
      <div><span>在线电机</span><strong>{online}<em> / 16</em></strong><small>{paused ? "采集优先 · 概览暂停刷新" : "TMC 应答计数"}</small></div>
      <div><span>设备告警</span><strong className={faults ? "fleet-danger" : ""}>{faults}<em> 路</em></strong><small>未读取的设备不计为正常</small></div>
    </div>

    <div className="max-row" aria-label="四颗 MAX20087 电源开关状态">
      {CHIP_NAMES.map((name, i) => <MaxCardView key={name} supplyFresh={supplyFresh}
        chip={chips.find((c) => c.index === i) ?? {
          index: i, name, valid: false, id: 0, config: 0, diagnosticsLive: false,
          stat1: 0, stat2: [0, 0], fault: "", vin_mv: null, vdd_mv: null, viset_mv: null, current_limit_ma:null, channels: [],
        }} />)}
    </div>

    <Card
      title="运动阵列"
      right={<div className="fleet-tools">
        <Badge tone={paused ? "warn" : "neutral"}>{paused ? "显示最近快照" : "5 电缸 · 16 电机"}</Badge>
        <div className="fleet-view" role="group" aria-label="视图切换">
          <button type="button" className={view === "cards" ? "on" : ""} aria-pressed={view === "cards"}
            title="卡片视图" aria-label="卡片视图" onClick={() => setView("cards")}><Icon.Grid width={14} height={14} /></button>
          <button type="button" className={view === "list" ? "on" : ""} aria-pressed={view === "list"}
            title="列表视图" aria-label="列表视图" onClick={() => setView("list")}><Icon.List width={14} height={14} /></button>
        </div>
      </div>}
    >
      <div className="fleet-cylinders" aria-label="五路电缸状态">
        {cylinders.rows.map((row,i)=>{
          const s=row.status,online=!!s?.online&&app.connected,fault=online?s?.fault??0:0;
          const names=[[1,"堵转"],[2,"过温"],[4,"过流"],[8,"电机异常"],[16,"存储异常"]] as const;
          return <article className="fleet-cylinder" key={i}>
            <header><strong>C{i+1}</strong><span className={fault?"fleet-danger":online?"fleet-good":"muted"}>{online?"在线":"离线"}</span><i className={`fleet-dot ${fault?"warn":online?"ok":"stale"}`} aria-hidden="true"/></header>
            <div className="fleet-cylinder-position"><span>实际行程</span><b>{online?(s!.position<<16>>16):"—"}<small> 步</small></b></div>
            <div className="fleet-cylinder-track"><i style={{width:`${online?Math.max(0,Math.min(100,(s!.position<<16>>16)/20)):0}%`}}/></div>
            <dl>
              <div><dt>反馈电流</dt><dd>{online?`${s!.current_ma} mA`:"—"}</dd></div>
              <div><dt>温度</dt><dd>{online?`${s!.temperature_c} °C`:"—"}</dd></div>
              <div><dt>回温启动</dt><dd>{online?`${s!.restart_c} °C`:"—"}</dd></div>
              <div><dt>故障</dt><dd className={fault?"fleet-danger":""}>{!online?"—":fault?names.filter(([bit])=>fault&bit).map(([,name])=>name).join(" / ")||`代码 ${fault}`:"无"}</dd></div>
            </dl>
          </article>;
        })}
      </div>
      {view === "cards" ? (
        <div className="fleet-grid">
          {Array.from({ length: 16 }, (_, i) => {
            const id = i + 1;
            return <MotorCard key={id} id={id} fresh={fresh(id)} supplyFresh={supplyFresh}
              power={power[id-1]&&{...power[id-1],enabled:desired[id]??power[id-1].enabled}} state={motors[id]?.state} switching={!!switching[id]}
              onToggle={(on) => void toggleSupply(id, on)} />;
          })}
        </div>
      ) : (
        <div className="fleet-list" role="table" aria-label="电机阵列列表">
          <div className="fleet-list-head" role="row">
            <span role="columnheader">电机</span><span role="columnheader">TMC</span>
            <span role="columnheader">温度</span><span role="columnheader">力矩电流</span>
            <span role="columnheader">输入电流</span><span role="columnheader">输入电压</span>
            <span role="columnheader">编码器</span><span role="columnheader">找零</span>
            <span role="columnheader">模式</span><span role="columnheader">供电</span>
          </div>
          {Array.from({ length: 16 }, (_, i) => {
            const id = i + 1;
            return <MotorRow key={id} id={id} selected={app.motor === id} fresh={fresh(id)}
              supplyFresh={supplyFresh} power={power[id-1]&&{...power[id-1],enabled:desired[id]??power[id-1].enabled}} state={motors[id]?.state}
              switching={!!switching[id]} onSelect={() => app.setMotor(id)}
              onToggle={(on) => void toggleSupply(id, on)} />;
          })}
        </div>
      )}
    </Card>
  </section>;
}

function MaxCardView({ chip, supplyFresh }: { chip: MaxChip; supplyFresh: boolean }) {
  const channelWarn = chip.channels.some((c) => !!c.fault);
  const tone = dotTone(!!chip.fault || channelWarn, !supplyFresh || !chip.valid);
  const enabled = (chip.config & 15).toString(2).padStart(4, "0").replace(/0/g, "·");
  return <article className="max-card">
    <header className="max-head">
      <strong>MAX · {chip.name}</strong>
      <span className={`max-state ${tone}`}>{chip.valid ? (chip.fault ? "告警" : chip.diagnosticsLive ? "输出中" : "已关闭") : "未确认"}</span>
      <i className={`fleet-dot ${tone}`} aria-hidden="true" />
    </header>
    <dl className="max-info">
      <div><dt>器件 ID</dt><dd className="mono">{chip.valid ? `0x${chip.id.toString(16).padStart(2, "0")}` : "—"}</dd></div>
      <div><dt>CONFIG</dt><dd className="mono">{chip.valid ? `0x${chip.config.toString(16).padStart(2, "0").toUpperCase()}` : "—"}</dd></div>
      <div><dt>使能通道</dt><dd className="mono">{chip.valid ? `OUT ${enabled}` : "—"}</dd></div>
      <div><dt>输入 VIN</dt><dd>{VOLT(chip.vin_mv)}</dd></div>
      <div><dt>逻辑 VDD</dt><dd>{VOLT(chip.vdd_mv)}</dd></div>
      <div title="按 ISET 电压和典型 12.5 µA 换算的每路限流估算"><dt>每路限流（约）</dt><dd>{AMP(chip.current_limit_ma)}</dd></div>
    </dl>
    {chip.fault && <div className="max-fault">{chip.fault}</div>}
    <ul className="max-channels">
      <li className="max-channels-head" aria-hidden="true">
        <i /><span>电机</span><b>电压</b><b>电流</b>
      </li>
      {Array.from({ length: 4 }, (_, o) => {
        const c = chip.channels[o];
        const motor = c?.motor ?? STATIC_CHANNEL_MOTORS[chip.index]?.[o] ?? null;
        return <li key={o}>
          <i className={`fleet-dot mini ${!c ? "stale" : c.fault ? "warn" : c.enabled ? "ok" : "stale"}`} aria-hidden="true" />
          <span>{motor ? `M${String(motor).padStart(2, "0")}` : `OUT${o + 1}`}</span>
          <b>{c ? VOLT(c.voltage_mv) : "—"}</b>
          <b>{c ? AMP(c.current_ma) : "—"}</b>
        </li>;
      })}
    </ul>
  </article>;
}

function supplyText(p: PowerOutput | undefined, supplyFresh: boolean) {
  if (!supplyFresh || !p) return { text: "供电未知", tone: "muted" };
  if (p.enabled === null) return { text: "供电未知", tone: "muted" };
  if (!p.enabled) return { text: "输入未使能", tone: "muted" };
  if (p.fault) return { text: p.fault, tone: "bad" };
  return { text: "输入已使能", tone: "good" };
}

function MotorCard({ id, fresh, supplyFresh, power, state, switching, onToggle }: {
  id: number; fresh: boolean; supplyFresh: boolean; power: PowerOutput | undefined;
  state: MotorState | null; switching: boolean; onToggle: (on: boolean) => void;
}) {
  const app = useApp();
  const online = !!power?.tmcOnline;
  const tmc = online ? { text: "TMC · 在线", cls: "fleet-good" }
    : power?.enabled ? { text: "TMC · 掉线", cls: "fleet-danger" } : { text: "TMC · 未确认", cls: "muted" };
  const supply = supplyText(power, supplyFresh);
  const tone = dotTone(power?.enabled === true && (!!power?.fault || !!state?.fault), !supplyFresh || !fresh || !online);
  const live = fresh && online;
  return <div className={`fleet-motor ${app.motor === id ? "selected" : ""}`} role="button" tabIndex={0}
    aria-pressed={app.motor === id} aria-label={`选择电机 M${id}`}
    onClick={() => app.setMotor(id)}
    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); app.setMotor(id); } }}>
    <div className="fleet-motor-head">
      <strong>M{String(id).padStart(2, "0")}</strong>
      <span className={tmc.cls}>{tmc.text}</span>
      <i className={`fleet-dot ${tone}`} aria-hidden="true" />
    </div>
    <div className={`fleet-power ${supply.tone}`}>
      <i aria-hidden="true" />{supply.text}
      <div className="grow" />
      <div onKeyDown={e=>e.stopPropagation()}><Toggle checked={!!power?.enabled} disabled={!app.connected || switching}
        label={`M${id} 输入供电开关`} onChange={onToggle} /></div>
    </div>
    <div className="fleet-metrics">
      <div><span>温度</span><b>{live && state?.temperature_raw != null ? fmt(tempC(state.temperature_raw * 65536, app.cal.tempOffset), 1) : "—"}<small> °C</small></b></div>
      <div><span>力矩电流</span><b>{live && state ? fmt(state.iq_raw * app.cal.maPerCount, 0) : "—"}<small> mA</small></b></div>
      <div><span>输入电流</span><b>{supplyFresh ? fmt(power?.current_ma ?? 0, 0) : "—"}<small> mA</small></b></div>
      <div><span>输入电压</span><b>{supplyFresh ? VOLT(power?.voltage_mv).replace(" V", "") : "—"}<small> V</small></b></div>
    </div>
    <dl>
      <div><dt>编码器</dt><dd>{!live ? "未确认" : state?.align_valid ? "有效" : "待标定"}</dd></div>
      <div><dt>找零</dt><dd>{!live ? "未确认" : state?.span_valid ? "有效" : "待找零"}</dd></div>
      <div><dt>运动模式</dt><dd>{live && state ? modes[state.mode] ?? "未知" : "—"}</dd></div>
    </dl>
  </div>;
}

function MotorRow({ id, selected, fresh, supplyFresh, power, state, switching, onSelect, onToggle }: {
  id: number; selected: boolean; fresh: boolean; supplyFresh: boolean;
  power: PowerOutput | undefined; state: MotorState | null;
  switching: boolean; onSelect: () => void; onToggle: (on: boolean) => void;
}) {
  const app = useApp();
  const online = !!power?.tmcOnline;
  const tone = dotTone(power?.enabled === true && (!!power?.fault || !!state?.fault), !supplyFresh || !fresh || !online);
  const live = fresh && online;
  return <div className={`fleet-row ${selected ? "selected" : ""}`} role="row" tabIndex={0}
    onClick={onSelect}
    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}>
    <span role="cell" className="fleet-row-id"><i className={`fleet-dot ${tone}`} aria-hidden="true" />M{String(id).padStart(2, "0")}</span>
    <span role="cell" className={online ? "fleet-good" : power?.enabled ? "fleet-danger" : "muted"}>{online ? "在线" : power?.enabled ? "掉线" : "未确认"}</span>
    <span role="cell">{live && state?.temperature_raw != null ? `${fmt(tempC(state.temperature_raw * 65536, app.cal.tempOffset), 1)} °C` : "—"}</span>
    <span role="cell">{live && state ? `${fmt(state.iq_raw * app.cal.maPerCount, 0)} mA` : "—"}</span>
    <span role="cell">{supplyFresh ? AMP(power?.current_ma) : "—"}</span>
    <span role="cell">{supplyFresh ? VOLT(power?.voltage_mv) : "—"}</span>
    <span role="cell">{!live ? "未确认" : state?.align_valid ? "有效" : "待标定"}</span>
    <span role="cell">{!live ? "未确认" : state?.span_valid ? "有效" : "待找零"}</span>
    <span role="cell">{live && state ? modes[state.mode] ?? "未知" : "—"}</span>
    <span role="cell" className="fleet-row-switch">
      <div onKeyDown={e=>e.stopPropagation()}><Toggle checked={!!power?.enabled} disabled={!app.connected || switching}
        label={`M${id} 输入供电开关`} onChange={onToggle} /></div>
    </span>
  </div>;
}
