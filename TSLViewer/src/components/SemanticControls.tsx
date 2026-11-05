import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../lib/app-store";
import { useMotorConfiguration } from "../lib/motor-configuration";
import { semanticFresh } from "../lib/semantic-state";
import { applyMotorConfiguration, applyMotorLongTermConstraints, readMotorProfile, pidFromProfile, motionFromProfile, COUNTS_PER_RPM } from "../lib/motor-profile-ui";
import { semanticMotion } from "../lib/semantic-motion";
import { HoldMotionButton } from "./HoldMotionButton";
import { Badge, Button, Card, Check, Field, Notice, NumField, SelectField, Icon } from "./ui";

/** Mainboard controls never call the legacy PC motion executor. */
export function SemanticControls({ children }: { children: ReactNode }) {
  const app = useApp(); const draft = useMotorConfiguration(app.motor); const cfg = draft.task;
  const s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [holding, setHolding] = useState(false);
  const [percent, setPercent] = useState(50);
  const [a, setA] = useState(25), [b, setB] = useState(75), [seconds, setSeconds] = useState(6), [cycles, setCycles] = useState(1);
  const [live, setLive] = useState(true);
  const mode = ["position_direct","position_ramp","velocity_direct","velocity_ramp"].indexOf(cfg.mode);
  const taskRaw = () => {
    const maximum=28730;
    if(!Number.isFinite(cfg.max_rpm)||cfg.max_rpm<=0||cfg.max_rpm>maximum)
      throw Error(`本次任务转速 ${cfg.max_rpm} rpm 超出输入范围 ${maximum} rpm；实际由已保存的长期转速限幅校验，输入保持不变`);
    return Math.floor(cfg.max_rpm * COUNTS_PER_RPM);
  };
  const motionCommand = (command: Parameters<typeof semanticMotion.taskCommand>[3]) => semanticMotion.taskCommand(app.motor, mode, taskRaw(), command);
  const [precise, setPrecise] = useState("0");
  const [workType, setWorkType] = useState("repeat");
  const [applied, setApplied] = useState<typeof cfg | null>(null);
  const [longTermApplied, setLongTermApplied] = useState(false);
  const [applying, setApplying] = useState<"motion" | "longTerm" | null>(null);
  const limitNotice=useRef("");
  const showLimit=()=>{
    const key=`${app.semantic.bootId}:${app.motor}:${app.semantic.taskId??0}`;
    if(limitNotice.current!==key){limitNotice.current=key;app.toast("warn","到达行程限位");}
    dragging.current=false;
    latest.current=null; // discard a queued slider target when the MCU ends the task
  };
  const jogError=(e:unknown)=>{app.hostLog("error","motor/jog",`M${app.motor} 点动准备/执行失败 rpm=${cfg.max_rpm}: ${String(e)}`);setError(String(e));if(String(e).includes("到达行程限位"))showLimit();};
  const dragging = useRef(false), latest = useRef<number | null>(null), sending = useRef(false);
  const can = app.connected && app.armed && !busy && !!s?.permit && (s.drive === 0 || s.drive === 2) && s.config_verified && !s.fault && s.feedback_fresh;
  const interrupted = !app.connected || !app.armed || (!!s && (!!s.fault || !s.permit));
  const range = s?.coordinate_valid && s.logical_span && s.margin_counts != null
    ? [BigInt(s.margin_counts), BigInt(s.logical_span) - BigInt(s.margin_counts)] : null;
  // MCU owns the boot-local mechanism frame and its actual safety margin.
  const count = (p: number) => {
    if (!range || !Number.isFinite(p) || p < 0 || p > 100) throw Error("需要本次启动的有效双端行程");
    return (range[0] + (range[1] - range[0]) * BigInt(Math.round(p * 1000)) / 100000n).toString();
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError("");
    try { await fn(); } catch (e) { app.hostLog("error","motor/config",`M${app.motor} ${String(e)}`);setError(String(e)); } finally { setBusy(false); }
  };
  const stop = (disable = false) => { dragging.current = false; latest.current = null; void semanticMotion.stop(app.motor, disable).catch(e => setError(String(e))); };
  // MCU has already scheduled endpoint deceleration/hold. A toast must not
  // enqueue a second stop and disturb that immutable hardware sequence.
  useEffect(()=>{if(s?.last_error===15)showLimit();},[s?.last_error,app.semantic.taskId,app.motor,app.semantic.bootId]);
  // Load saved inputs only on explicit read. Verification/reconnects must not replace drafts.

  useEffect(() => { dragging.current = false; latest.current = null; setApplied(null); setLongTermApplied(false); }, [app.connected, app.motor, app.semantic.bootId]);
  useEffect(() => {
    setError("");
    const interrupt = () => { if (dragging.current) stop(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { stop(true); app.setArmed(false); } };
    const hide = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt); window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("blur", interrupt); window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", hide); if(dragging.current)stop(); };
  }, [app.motor]);
  useEffect(() => { if (!app.connected || !app.armed) { dragging.current = false; latest.current = null;
    if (semanticMotion.owned()) void semanticMotion.close(); } }, [app.connected, app.armed]);
  useEffect(()=>{if(!can||!range){latest.current=null;}},[can,s?.coordinate_valid]);
  const sendLatest = async () => {
    if (sending.current || latest.current == null) return;
    sending.current = true;
    try {
      while (latest.current != null) {
        await new Promise(resolve => setTimeout(resolve, 40));
        if(latest.current == null) break;
        const p = latest.current; latest.current = null;
        await motionCommand({ kind: "logical_move", position: count(p) });
      }
    } catch (e) { latest.current = null; setError(String(e)); } finally { sending.current = false; }
  };
  return <>
    <Card title="电机控制" bodyClass="stack" right={<Badge tone={s?.drive === 2 ? "ok" : "neutral"}>M{app.motor} · {s ? ["驱动禁能","准备中","驱动使能","故障"][s.drive] ?? "未确认" : "未确认"}</Badge>}>
      <div className="row-wrap" style={{ gap: 8 }}>
        <Button className={!s?.permit ? "permit-on" : ""} variant={s?.permit ? "danger" : "default"} disabled={!app.connected || !app.armed || busy || !s} onClick={() => void run(() => semanticMotion.permit(app.motor, !s?.permit))}>{s?.permit ? "取消运动授权" : "开启运动授权"}</Button>
        <Button icon={<Icon.Stop width={14} height={14}/>} onClick={() => stop()}>停止运行</Button><Button variant="ghost" onClick={() => stop(true)}>断使能</Button>
        <Button variant="ghost" disabled={!s?.fault || busy} onClick={() => void run(() => semanticMotion.clearFault(app.motor))}>清除故障</Button>
        <div className="grow"/><Button variant="danger" onClick={() => void semanticMotion.emergency(app.motor).catch(e => setError(String(e)))}>急停</Button>
      </div>
      <div className="motor-config-split">
        <section className="motor-config-section" aria-label="运动与保护参数">
          <div className="motor-config-heading">运动与保护</div>
          <div className="grid cols-2" style={{gap:10}}>
        <Field label="运动模式"><SelectField value={cfg.mode} disabled={busy} onChange={v => draft.setTask(c => ({ ...c, mode: v as typeof c.mode }))} options={[
          { value: "position_direct", label: "位置直通" }, { value: "position_ramp", label: "位置插补 · Ramp" },
          { value: "velocity_direct", label: "速度直通" }, { value: "velocity_ramp", label: "速度斜坡 · Ramp" }]} /></Field>
        <Field label="本次任务转速" hint={mode===0?"PD-1：明确修改位置模式上限，并持续生效":mode===1?"位置 Ramp · 0x1CE，受已保存的长期转速限幅约束":"速度目标 · 0x150，方向由任务决定"}><NumField clampOnCommit={false} value={cfg.max_rpm} onChange={v => draft.setTask(c => ({ ...c, max_rpm: v }))} unit="rpm" min={1} max={28730} /></Field>
        <Field label="加速度"><NumField value={cfg.accel_deg_s2} onChange={v => draft.setTask(c => ({ ...c, accel_deg_s2: v }))} unit="°/s²" min={1} max={1000000} /></Field>
        <Field label="减速度"><NumField value={cfg.decel_deg_s2} onChange={v => draft.setTask(c => ({ ...c, decel_deg_s2: v }))} unit="°/s²" min={1} max={1000000} /></Field>
        <Field label="持续过流 |Iq|"><NumField value={cfg.trip_ma} onChange={v => draft.setTask(c => ({ ...c, trip_ma: v }))} unit="mA" min={50} max={1050} /></Field>
        <Field label="持续时间"><NumField value={cfg.over_ms} onChange={v => draft.setTask(c => ({ ...c, over_ms: v }))} unit="ms" min={20} max={10000} /></Field>
        <Field label="保护采样周期" hint="主控反馈 / 持续过流，非 RTMI"><NumField value={cfg.sample_ms} onChange={v => draft.setTask(c => ({ ...c, sample_ms: v }))} unit="ms" min={20} max={1000} /></Field>
        <Field label="反馈超时"><NumField value={cfg.comm_timeout_ms} onChange={v => draft.setTask(c => ({ ...c, comm_timeout_ms: v }))} unit="ms" min={100} max={5000} /></Field>
        <Field label="过流动作"><SelectField value={cfg.fault_action} onChange={v => draft.setTask(c => ({ ...c, fault_action: v as typeof c.fault_action }))} options={[{ value: "disable", label: "禁能" }, { value: "controlled_stop", label: "受控停止并保持" }]} /></Field>
          </div>
          <div className="row-wrap"><Button variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={busy || !app.connected || !!s?.fault} onClick={() => void run(async () => {
            setApplying("motion");
            try {
              app.hostLog("info","motor/config",`M${app.motor} 应用运动配置 ${JSON.stringify(cfg)}`);
              await applyMotorConfiguration(app.motor,draft.pid,cfg);
              app.hostLog("ok","motor/config",`M${app.motor} TMC/W25 校验通过；编辑任务转速保持 ${cfg.max_rpm} rpm`);
              setApplied({...cfg}); // Verification must preserve the submitted input draft.
              app.toast("ok",`M${app.motor}：运动与保护已应用并回读`);
            } finally { setApplying(null); }
          })}>{applying === "motion" ? "应用并回读中…" : "应用并回读"}</Button>
          <Button variant="ghost" icon={<Icon.Refresh width={14} height={14}/>} disabled={busy || !app.connected} onClick={()=>void run(async()=>{
            const r=await readMotorProfile(app.motor);
            const saved=pidFromProfile(r.data);
            draft.setPid(current=>({...current,vel_limit_rpm:saved.vel_limit_rpm}));
            draft.setTask(current=>motionFromProfile(r.data,current));
          })}>读取已保存配置</Button></div>
          <div className="tiny muted">{applied?"运动与保护已回读；修改后请重新应用。":"编辑后点击“应用并回读”生效。"}仅处理左侧参数，保留已保存的长期约束。</div>
        </section>
        <section className="motor-config-section" aria-label="长期约束">
          <div className="motor-config-heading">长期约束</div>
          <div className="grid cols-2" style={{gap:10}}>
            <Field label="转矩电流限幅" hint="0x14A · Iq"><NumField value={draft.pid.torque_limit_ma} onChange={v => draft.setPid(c => ({ ...c, torque_limit_ma: v }))} unit="mA" min={50} max={1050} /></Field>
            <Field label="磁链电流限幅" hint="0x14A · Id"><NumField value={draft.pid.flux_limit_ma} onChange={v=>draft.setPid(c=>({...c,flux_limit_ma:v}))} unit="mA" min={0} max={1050}/></Field>
            <Field label="电压限幅" hint="0x149"><NumField value={draft.pid.uq_ud_limit} onChange={v=>draft.setPid(c=>({...c,uq_ud_limit:v}))} unit="raw" min={1} max={65535}/></Field>
            <Field label="转速限幅" hint="所有运动模式共用的长期上限"><NumField value={draft.pid.velocity_mode_limit_rpm ?? 28730} onChange={v=>draft.setPid(c=>({...c,velocity_mode_limit_rpm:v}))} unit="rpm" min={1} max={28730}/></Field>
          </div>
          <div className="row-wrap"><Button variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={busy || !app.connected || !!s?.fault} onClick={() => void run(async () => {
            setApplying("longTerm");
            try {
              await applyMotorLongTermConstraints(app.motor,draft.pid);
              setLongTermApplied(true);
              app.toast("ok",`M${app.motor}：长期约束已应用并回读`);
            } finally { setApplying(null); }
          })}>{applying === "longTerm" ? "应用并回读中…" : "应用并回读"}</Button></div>
          <div className="tiny muted">随当前电机档案保存到 W25，初始化时一并写入 TMC。</div>
          {longTermApplied && <div className="tiny muted" role="status">长期约束已回读；修改后请重新应用。保留已保存的运动与保护参数。</div>}
        </section>
      </div>
      <div className="tiny muted">应用时安全停机，不自动使能；正常停止保持供电。</div>
      <div className="motion-message-slot" role="status">{error && <Notice tone="warn">{error}。先读取状态或停止运行，再应用并回读配置；不会自动重发运动。</Notice>}</div>
    </Card>
    {children}
    <div className="motion-travel-layout">
      <Card title="手动点动" bodyClass="stack" right={<Badge>{["位置直通","位置插补","速度直通","速度斜坡"][mode]}</Badge>}>
        <Field label="本次任务转速" hint="与电机控制共用转速和模式；受长期约束校验"><NumField clampOnCommit={false} value={cfg.max_rpm} onChange={v=>draft.setTask(c=>({...c,max_rpm:v}))} min={1} max={28730} unit="rpm" /></Field>
        <div className="row-wrap" style={{ gap: 8 }}>
          {[-1, 1].map(sign => <HoldMotionButton key={`${app.motor}:${sign}`} canStart={can && !!s?.span_valid && !holding}
            interrupted={interrupted} onHolding={setHolding} onError={jogError} stop={()=>stop()}
            start={()=>semanticMotion.jog(app.motor,-sign*taskRaw(),mode)}>
            {sign < 0 ? "负向点动" : "正向点动"}</HoldMotionButton>)}
          <Button onClick={() => stop()}>保持当前位置</Button>
        </div><div className="tiny muted">按住运行，松开、失焦或掉线停止；到达行程限位时保持位置并提示。</div>
      </Card>
      <Card title="绝对位置" bodyClass="stack" right={<Badge>归零坐标</Badge>}>
        <div className="arrival-feedback" role="status" aria-live="polite">
          <b>到位状态：{!s?.feedback_fresh ? "反馈未确认" : s.arrival_phase==null ? "等待主控到位状态" : ["尚无位置任务","轨迹进行中","轨迹结束，等待进入容差","容差内稳定确认中","主控已确认到位"][s.arrival_phase] ?? "未确认"}</b>
          <span>轨迹结束 {s?.arrival_flags!=null ? (s.arrival_flags&1 ? "✓" : "—") : "—"} · 误差进入容差 {s?.arrival_flags!=null ? (s.arrival_flags&2 ? "✓" : "—") : "—"} · 持续稳定 {s?.arrival_ms!=null ? `${Math.min(s.arrival_ms,s.arrival_dwell_ms??0)} / ${s.arrival_dwell_ms} ms` : "—"}</span>
        </div>
        <div className="row-wrap">{[0,50,100].map(p=><Button key={p} disabled={!can||!range} onClick={()=>{setPercent(p);void run(()=>motionCommand({kind:"logical_move",position:count(p)}));}}>{p===0?"0% · 负端":p===50?"50% · 中点":"100% · 正端"}</Button>)}</div>
        <input aria-label="行程百分比" type="range" min={0} max={100} step={.1} value={percent} disabled={!can || !range}
          onChange={e => { const p = Number(e.target.value); setPercent(p); if (live) { latest.current = p; void sendLatest(); } }} style={{ width: "100%" }} />
        <div>编辑目标 {percent.toFixed(1)}% · 实际 {s?.coordinate_valid && s.feedback_fresh && s.logical_span && s.logical_position ? (Number(s.logical_position)/Number(s.logical_span)*100).toFixed(2)+"%" : "未确认"} · 归零位置 {s?.feedback_fresh && s.coordinate_valid ? s.logical_position : "未确认"} Count</div>
        <div className="tiny muted">实测全行程 {s?.coordinate_valid ? s.logical_span : "未找零"} Count；可命令区间 {range ? `${range[0]}–${range[1]}` : "未确认"} Count。滑条 0–100% 映射到退开余量后的可用行程。</div>
        <div className="tiny muted">目标 {range ? count(percent) : "—"} Count · 目标误差 {range && s?.feedback_fresh && s.logical_position ? (BigInt(count(percent))-BigInt(s.logical_position)).toString() : "—"} Count。0/100%对应端点内侧保护位置，不以高速撞击挡块。</div>
        <details><summary>精确目标 Count</summary><input className="input" aria-label="精确归零目标" value={precise} onChange={e=>setPrecise(e.target.value)}/><Button disabled={!can||!range} onClick={()=>void run(async()=>{if(!/^-?\d+$/.test(precise)||!range||BigInt(precise)<range[0]||BigInt(precise)>range[1])throw Error("目标超出可用行程");await motionCommand({kind:"logical_move",position:precise});})}>前往精确目标</Button></details>
        <Check checked={live} onChange={setLive}>实时发送（合并为最新目标）</Check>
        <div className="row-wrap"><Button variant="primary" icon={<Icon.Target width={14} height={14}/>} disabled={!can || !range} onClick={() => void run(() => motionCommand({ kind: "logical_move", position: count(percent) }))}>前往</Button>
        <Button variant="ghost" onClick={() => stop()}>停止</Button></div>
      </Card>
    </div>
    <Card title="工况运行" bodyClass="stack">
      <Field label="工况类型"><SelectField value={workType} onChange={setWorkType} options={[{value:"repeat",label:"循环往复"},{value:"once",label:"单次往返"},{value:"center",label:"前往中心"},{value:"hold",label:"保持当前位置"}]}/></Field>
      <div className="grid cols-4" style={{gap:10}}><Field label="A"><NumField value={a} onChange={setA} min={0} max={100} unit="%" /></Field>
        <Field label="B"><NumField value={b} onChange={setB} min={0} max={100} unit="%" /></Field>
        <Field label="往返周期"><NumField value={seconds} onChange={setSeconds} min={.2} max={600} unit="s" /></Field>
        <Field label="循环数"><NumField value={cycles} onChange={setCycles} min={1} max={10000} /></Field></div>
      <div className="row-wrap"><Button variant="primary" disabled={!can || !range} onClick={() => void run(() => workType==="hold" ? semanticMotion.stop(app.motor) : workType==="center" ? motionCommand({kind:"logical_move",position:count(50)}) : motionCommand({ kind: "logical_work", a: count(a), b: count(b), half_period_ms: Math.round(seconds * 500), cycles:workType==="once"?1:cycles }))}>执行工况</Button>
      <Button variant="ghost" onClick={() => stop()}>取消工况并停止</Button></div>
      <div className="tiny muted">到位后按设定周期继续；正弦轨迹暂未开放。正常停止/断使能保留 MAX20087 供电。</div>
    </Card>
  </>;
}
