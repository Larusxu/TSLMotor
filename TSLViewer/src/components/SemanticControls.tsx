import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../lib/app-store";
import { useMotorConfiguration } from "../lib/motor-configuration";
import { semanticFresh } from "../lib/semantic-state";
import { applyMotorConfiguration, readMotorRamp, readMotorProfile, pidFromProfile, motionFromProfile, COUNTS_PER_RPM } from "../lib/motor-profile-ui";
import { rampEnabled, rampTask, rampSupplement } from "../lib/motor-ramp";
import { semanticMotion } from "../lib/semantic-motion";
import { PercentJog } from "../lib/percent-jog";
import { HoldMotionButton } from "./HoldMotionButton";
import { Badge, Button, Card, Field, Notice, NumField, SelectField, Icon, Toggle } from "./ui";

/** Mainboard controls never call the legacy PC motion executor. */
export function SemanticControls({ children }: { children: ReactNode }) {
  const app = useApp(); const draft = useMotorConfiguration(app.motor); const cfg = draft.task;
  const s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [holding, setHolding] = useState(false);
  const percent = app.positionTargetPercent;
  const setPercent = app.setPositionTargetPercent;
  const percentRef = useRef(percent), targetEdited = useRef(false);
  percentRef.current=percent;
  const setTarget = (value:number) => { percentRef.current=value; targetEdited.current=true; setPercent(value); };
  const sliderChange = useRef<(value:number)=>void>(()=>{});
  const percentLimit = useRef<(value:number)=>void>(()=>{});
  const percentJog = useRef<PercentJog | null>(null);
  if(!percentJog.current)percentJog.current=new PercentJog(value=>sliderChange.current(value),value=>percentLimit.current(value));
  const targetEpoch = useRef(0);
  const [a, setA] = useState(25), [b, setB] = useState(75), [dwellSeconds, setDwellSeconds] = useState(0), [cycles, setCycles] = useState(1);
  const rampOn=rampEnabled(cfg.mode), positionRamp=cfg.mode==="position_ramp";
  const mode = cfg.mode==="position_ramp"?1:0;
  useEffect(()=>{if(cfg.mode==="velocity_direct"||cfg.mode==="velocity_ramp")draft.setTask(c=>({...c,mode:"position_direct"}));},[app.motor,cfg.mode]);
  const taskRaw = () => {
    const maximum=28730;
    if(!Number.isFinite(cfg.max_rpm)||cfg.max_rpm<=0||cfg.max_rpm>maximum)
      throw Error(`本次任务转速 ${cfg.max_rpm} rpm 超出输入范围 ${maximum} rpm；实际由已保存的长期转速限幅校验，输入保持不变`);
    return Math.floor(cfg.max_rpm * COUNTS_PER_RPM);
  };
  const motionCommand = (command: Parameters<typeof semanticMotion.taskCommand>[3]) => semanticMotion.taskCommand(app.motor, mode, taskRaw(), command);
  const [workType, setWorkType] = useState("repeat");
  const [, setApplied] = useState<typeof cfg | null>(null);
  const [applying, setApplying] = useState<"motion" | "longTerm" | null>(null);
  const limitNotice=useRef("");
  const showLimit=()=>{
    const key=`${app.semantic.bootId}:${app.motor}:${app.semantic.taskId??0}`;
    if(limitNotice.current!==key){limitNotice.current=key;app.toast("warn","到达行程限位");}
    percentJog.current?.cancel(); ++targetEpoch.current;
    dragging.current=false;
    latest.current=null; // discard a queued slider target when the MCU ends the task
  };
  const dragging = useRef(false), latest = useRef<number | null>(null), sending = useRef(false);
  const can = app.connected && !busy && !!s && (s.drive === 0 || s.drive === 2) && s.config_verified && !s.fault && s.feedback_fresh;
  const interrupted = !app.connected || (!!s && (!!s.fault));
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
  const stop = (disable = false) => { percentJog.current?.cancel(); ++targetEpoch.current; dragging.current = false; latest.current = null; void semanticMotion.stop(app.motor, disable).catch(e => setError(String(e))); };
  // MCU has already scheduled the endpoint stop. A toast must not
  // enqueue a second stop and disturb that immutable hardware sequence.
  useEffect(()=>{if(s?.last_error===15)showLimit();},[s?.last_error,app.semantic.taskId,app.motor,app.semantic.bootId]);
  // Load saved inputs only on explicit read. Verification/reconnects must not replace drafts.

  useEffect(() => {
    percentJog.current?.cancel(); ++targetEpoch.current; targetEdited.current=false;
    dragging.current=false; latest.current=null; setApplied(null);
    return () => { percentJog.current?.cancel(); ++targetEpoch.current; latest.current=null; };
  }, [app.connected, app.motor, app.semantic.bootId]);
  useEffect(() => {
    setError("");
    const interrupt = () => { if (dragging.current) stop(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { stop(true);  } };
    const hide = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt); window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("blur", interrupt); window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", hide); if(dragging.current)stop(); };
  }, [app.motor]);
  useEffect(() => { if (!app.connected) { dragging.current = false; latest.current = null;
    if (semanticMotion.owned()) void semanticMotion.close(); } }, [app.connected]);
  useEffect(()=>{if(interrupted||!range){percentJog.current?.cancel(); ++targetEpoch.current; latest.current=null;}},[interrupted,s?.coordinate_valid]);
  const sendLatest = async () => {
    if (sending.current || latest.current == null) return;
    sending.current = true;
    const epoch=targetEpoch.current;
    try {
      while (latest.current != null && epoch===targetEpoch.current) {
        await new Promise(resolve => setTimeout(resolve, 40));
        if(latest.current == null || epoch!==targetEpoch.current) break;
        const p = latest.current; latest.current = null;
        await semanticMotion.taskCommand(app.motor,mode,taskRaw(),{kind:"logical_move",position:count(p)},()=>epoch===targetEpoch.current);
      }
    } catch (e) {
      if(epoch===targetEpoch.current){percentJog.current?.cancel();latest.current=null;setError(String(e));}
    } finally {
      sending.current=false;
      if(epoch!==targetEpoch.current&&latest.current!==null)void sliderSend.current();
    }
  };
  const sliderSend=useRef(sendLatest); sliderSend.current=sendLatest;
  const changeSlider=(value:number)=>{
    setTarget(value);
    latest.current=value;void sendLatest();
  };
  sliderChange.current=changeSlider;
  percentLimit.current=value=>{
    app.toast("info",`行程目标已到 ${value}%，已停止点动累计`);
    app.hostLog("info","motor/position",`M${app.motor} 行程目标 ${value}%，停止累计；保持最后绝对位置目标`);
  };
  const beginPercentJog=async(direction:-1|1)=>{
    // On first use seed the slider from measured position, not its UI default 50%.
    if(!targetEdited.current&&range&&s?.logical_position!=null){
      const raw=BigInt(s.logical_position);
      setTarget(Math.max(0,Math.min(100,Number(raw-range[0])/Number(range[1]-range[0])*100)));
    }
    setError("");percentJog.current!.start(percentRef.current,direction);
  };
  return <>
    <Card title="电机控制" className="homing-motor-card" bodyClass="stack" right={<Badge tone={s?.drive === 2 ? "ok" : "neutral"}>M{app.motor} · {s ? ["驱动禁能","准备中","驱动使能","故障"][s.drive] ?? "未确认" : "未确认"}</Badge>}>
      <div className="motor-config-stack">
        <section className="motor-config-section" aria-label="运动与保护参数">
          <div className="grid motor-config-row" style={{gap:10}}>
        <Field label="运动模式"><SelectField value={cfg.mode} disabled={busy} onChange={v => draft.setTask(c => ({ ...c, mode: v as typeof c.mode }))} options={[
          { value: "position_direct", label: "位置直通" }, { value: "position_ramp", label: "位置插补 · Ramp" },
]} /></Field>
        <Field label="转速限制"><NumField clampOnCommit={false} value={cfg.max_rpm} onChange={v => draft.setTask(c => ({ ...c, max_rpm: v }))} unit="rpm" min={1} max={28730} /></Field>
        <Field label="电流限制 |Iq|"><NumField value={cfg.trip_ma} onChange={v => draft.setTask(c => ({ ...c, trip_ma: v }))} unit="mA" min={50} max={1050} /></Field>
        <Field label="过流动作"><SelectField value={cfg.fault_action} onChange={v => draft.setTask(c => ({ ...c, fault_action: v as typeof c.fault_action }))} options={[{ value: "disable", label: "禁能" }, { value: "controlled_stop", label: "受控停止并保持" }]} /></Field>
          <div className="config-apply-actions"><Button variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={busy || !app.connected || !!s?.fault} onClick={() => void run(async () => {
            setApplying("motion");
            try {
              app.hostLog("info","motor/config",`M${app.motor} 应用运动配置 ${JSON.stringify(cfg)}`);
              await applyMotorConfiguration(app.motor,draft.pid,rampTask(cfg,draft.ramp),rampSupplement(cfg,draft.ramp));
              app.hostLog("ok","motor/config",`M${app.motor} TMC/W25 校验通过；编辑任务转速保持 ${cfg.max_rpm} rpm`);
              setApplied({...cfg}); // Verification must preserve the submitted input draft.
              app.toast("ok",`M${app.motor}：运动与保护已应用并回读`);
            } finally { setApplying(null); }
          })}>{applying === "motion" ? "应用中…" : "应用"}</Button>
          <Button variant="ghost" icon={<Icon.Refresh width={14} height={14}/>} disabled={busy || !app.connected} onClick={()=>void run(async()=>{
            const r=await readMotorProfile(app.motor);
            const saved=pidFromProfile(r.data);
            draft.setPid(current=>({...current,vel_limit_rpm:saved.vel_limit_rpm}));
            const loaded=motionFromProfile(r.data,cfg);
            draft.setTask(current=>motionFromProfile(r.data,current));
            draft.setRamp(await readMotorRamp(app.motor,{...draft.ramp,acceleration_s:loaded.max_rpm*6/loaded.accel_deg_s2,deceleration_s:loaded.max_rpm*6/loaded.decel_deg_s2}));
          })}>读取配置</Button></div></div>

        </section>
        <section className="motor-config-section ramp-inline" aria-label="Ramp 配置">
          <div className={`motor-config-heading homing-ramp-indicator ${rampOn ? "is-on" : ""}`} role="status" aria-label={`RAMP ${rampOn ? "开启" : "关闭"}`}>RAMP</div>
          <fieldset className="motor-ramp-fields" disabled={!rampOn||busy}>
            <div className="grid cols-4 motor-config-row" style={{gap:10}}>
              <Field label={cfg.mode==="velocity_ramp"?"加减速时间":"加速时间"}><NumField value={draft.ramp.acceleration_s*1000} onChange={v=>draft.setRamp(c=>({...c,acceleration_s:v/1000}))} unit="ms" min={1} max={600000} step={1}/></Field>
              <Field label="减速时间"><NumField disabled={!positionRamp} value={draft.ramp.deceleration_s*1000} onChange={v=>draft.setRamp(c=>({...c,deceleration_s:v/1000}))} unit="ms" min={1} max={600000} step={1}/></Field>
              <Field label="位置容差"><NumField disabled={!positionRamp} value={draft.ramp.tolerance_deg} onChange={v=>draft.setRamp(c=>({...c,tolerance_deg:v}))} unit="±°" min={0} max={360} step={.1}/></Field>
              <Field label="容差延时"><NumField disabled={!positionRamp} value={draft.ramp.delay_ms} onChange={v=>draft.setRamp(c=>({...c,delay_ms:v}))} unit="ms" min={0} max={2621.4}/></Field>
            </div>
            <label className="row tiny">速度前馈 <Toggle disabled={!positionRamp} checked={draft.ramp.velocity_ff} onChange={v=>draft.setRamp(c=>({...c,velocity_ff:v}))} label="速度前馈"/></label>
          </fieldset>

        </section>
      </div>
      {error && <div className="motion-message-slot" role="status"><Notice tone="warn">{error}</Notice></div>}
    </Card>
    {children}
    <div className="grid cols-2 position-work-grid">
      <Card title="绝对位置" bodyClass="stack" right={<Badge>归零坐标</Badge>}>
        <div className="arrival-feedback" role="status" aria-live="polite">
          <b>到位状态：{!s?.feedback_fresh ? "反馈未确认" : s.arrival_phase==null ? "等待主控到位状态" : ["尚无位置任务","轨迹进行中","轨迹结束，等待进入容差","容差内稳定确认中","主控已确认到位"][s.arrival_phase] ?? "未确认"}</b>
          <span>轨迹结束 {s?.arrival_flags!=null ? (s.arrival_flags&1 ? "✓" : "—") : "—"} · 误差进入容差 {s?.arrival_flags!=null ? (s.arrival_flags&2 ? "✓" : "—") : "—"} · 持续稳定 {s?.arrival_ms!=null ? `${Math.min(s.arrival_ms,s.arrival_dwell_ms??0)} / ${s.arrival_dwell_ms} ms` : "—"}</span>
        </div>
        <div className="row-wrap" style={{gap:8}}>
          {[0,50,100].map(p=><Button key={p} disabled={!can||!range||holding} onClick={()=>{setTarget(p);void run(()=>motionCommand({kind:"logical_move",position:count(p)}));}}>{p===0?"0% · 负端":p===50?"50% · 中点":"100% · 正端"}</Button>)}
          {([-1,1] as const).map(direction=><HoldMotionButton key={`${app.motor}:${direction}`} canStart={can&&!!range&&!holding}
            interrupted={interrupted||!range} onHolding={setHolding} onError={e=>setError(String(e))}
            start={()=>beginPercentJog(direction)} stop={()=>percentJog.current?.release()}>
            {direction<0?"负向点动":"正向点动"}
          </HoldMotionButton>)}
          <Badge>15% / s</Badge>
        </div>
        <div className="homing-position-target">
          <input aria-label="行程百分比" type="range" min={0} max={100} step={.1}
            value={percent} disabled={!can || !range || holding}
            onChange={e => changeSlider(Number(e.target.value))} />
          <Field label="目标"><NumField label="目标百分比" value={percent}
            onChange={v => {
              // Numeric edits only update the draft. Motion is sent by 前往;
              // Slider drag sends merged latest targets; numeric edits remain draft-only.
              if (!Number.isFinite(v)) return;
              setTarget(v);
            }} unit="%" min={0} max={100} step={.1} clampOnCommit={false}
            disabled={!can || !range || holding}/></Field>
          <Button variant="primary" disabled={!can || !range || holding}
            onClick={() => void run(() => motionCommand({kind:"logical_move",position:count(percent)}))}>前往</Button>
        </div>
        <div className="homing-position-foot">
          <span className="tiny muted">编辑目标 {percent.toFixed(1)}% · 实际 {s?.coordinate_valid && s.feedback_fresh && s.logical_span && s.logical_position != null ? (Number(s.logical_position)/Number(s.logical_span)*100).toFixed(2)+"%" : "未确认"} · 归零位置 {s?.feedback_fresh && s.coordinate_valid ? s.logical_position : "未确认"} Count</span>
        </div>
      </Card>
    <Card title="工况运行" bodyClass="stack">
      <Field label="工况类型"><SelectField value={workType} onChange={setWorkType} options={[{value:"repeat",label:"循环往复"},{value:"once",label:"单次往返"},{value:"center",label:"前往中心"},{value:"hold",label:"保持当前位置"}]}/></Field>
      <div className="grid cols-4" style={{gap:10}}><Field label="A"><NumField value={a} onChange={setA} min={0} max={100} unit="%" /></Field>
        <Field label="B"><NumField value={b} onChange={setB} min={0} max={100} unit="%" /></Field>
        <Field label="到位间隔"><NumField value={dwellSeconds} onChange={setDwellSeconds} min={0} max={3600} step={.1} unit="s" /></Field>
        <Field label="循环数"><NumField value={cycles} onChange={setCycles} min={1} max={10000} /></Field></div>
      <div className="row-wrap"><Button variant="primary" disabled={!can || !range} onClick={() => void run(() => workType==="hold" ? semanticMotion.stop(app.motor) : workType==="center" ? motionCommand({kind:"logical_move",position:count(50)}) : motionCommand({ kind: "logical_work", a: count(a), b: count(b), dwell_ms: Math.round(dwellSeconds * 1000), cycles:workType==="once"?1:cycles }))}>执行工况</Button>
      <Button variant="ghost" onClick={() => stop()}>取消工况并停止</Button></div>

    </Card></div>
  </>;
}
