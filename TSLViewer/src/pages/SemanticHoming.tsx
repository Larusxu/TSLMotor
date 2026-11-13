import { useEffect, useState, useSyncExternalStore } from "react";
import { useApp } from "../lib/app-store";
import { semanticMotion } from "../lib/semantic-motion";
import { semanticFresh } from "../lib/semantic-state";
import { SemanticControls } from "../components/SemanticControls";
import { fmt, tempC } from "../lib/units";
import { Button, Card, Field, SelectField, Badge, Icon, Stat, NumField, Notice } from "../components/ui";
import {api} from "../lib/api";
import type {HomingState} from "../lib/types";
import {HOME_CONFIG_FIELDS} from "../lib/home-config";
import {readSharedHome,writeSharedHome,useSharedHome} from "../lib/shared-settings";
import {LinkedHoming,defaultHomePartner,homeTargets} from "../lib/linked-homing";
import {useHomePolicy,readHomePolicy} from "../lib/home-policy";

const linkedHoming=new LinkedHoming(semanticMotion,motor=>api.homingState(motor));
const linkedOptions=new Map<number,{enabled:boolean;text:string}>();
const homeFlowOptions=new Map<number,{complex:boolean;middle:boolean}>();

const homeCache=new Map<number,HomingState>();
const speedCache=new Map<number,number>();
const adaptiveLabels=["待开始","正端找零","记录正端","建立稳定运动基线","检测负端受力转折","负端候选已记录","返回正端","稳定与坐标确认","完成"];
const loadLabels=["采集稳定运动窗口","建立局部基线","稳定运动基线有效","负载转折候选"];

/** Mainboard telemetry only. Missing optional firmware fields must never be guessed. */
function LiveStats() {
  const app = useApp();
  const s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const sampled = !!s?.feedback_fresh;
  const speed = sampled && app.streaming ? app.scope.latest.get(0) : null;
  const torque = sampled && app.streaming ? app.scope.latest.get(2) : null;
  const rpm = speed ?? (sampled ? -s!.velocity_raw / app.cal.countsPerRpm : null);
  const iq = torque ?? (sampled ? s!.iq_raw * app.cal.maPerCount : null);
  const temperature = sampled && s?.temperature_raw != null
    ? tempC(s.temperature_raw * 65536, app.cal.tempOffset) : null;
  const voltage = sampled && s?.bus_voltage_mv != null && Number.isFinite(s.bus_voltage_mv)
    ? s.bus_voltage_mv / 1000 : null;
  const position = sampled && s?.coordinate_valid && s.logical_position != null ? s.logical_position : null;
  const target = sampled && s?.coordinate_valid && s.target_logical_position != null ? s.target_logical_position : null;
  const percentError = (() => {
    if (!position || !target || !s?.span_valid || !s.logical_span) return null;
    try {
      const span = BigInt(s.logical_span);
      if (span <= 0n) return null;
      const difference = BigInt(target) - BigInt(position);
      // Bound conversion before Number to avoid rounding overflow on large counters.
      const basisPoints = (difference < 0n ? -difference : difference) * 10000n / span;
      return Number(basisPoints) / 100;
    } catch { return null; }
  })();
  const arrivalLabels = ["无位置任务", "轨迹进行中", "等待容差", "稳定确认中", "已到位"];
  const arrival = sampled && s?.arrival_phase != null
    ? arrivalLabels[s.arrival_phase] ?? "未确认" : "未确认";
  return <div className="homing-telemetry-grid">
    <Stat label="母线电压" value={voltage == null ? "—" : fmt(voltage, 1)} unit="V" />
    <Stat label="实际转速" value={rpm == null ? "—" : fmt(rpm, 0)} unit="RPM" />
    <Stat label="力矩电流 Iq" value={iq == null ? "—" : fmt(iq, 0)} unit="mA"
      tone={iq != null && Math.abs(iq) > 700 ? "var(--warn)" : undefined} />
    <Stat label="温度" value={temperature == null ? "—" : fmt(temperature, 1)} unit="°C" />
    <Stat label="实际位置" value={position ?? "—"} unit="Count" />
    <Stat label="目标位置" value={target ?? "—"} unit="Count" />
    <Stat label="位置误差" value={percentError == null ? "—" : fmt(percentError, 2)} unit="%" />
    <Stat label="到位状态" value={arrival} tone={arrival === "已到位" ? "var(--ok)" : undefined} />
  </div>;
}

export default function SemanticHoming() {
  const policy=useHomePolicy();
  const app = useApp(), s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const [direction,setDirection]=useState(0);
  const [linkedEnabled,setLinkedEnabled]=useState(linkedOptions.get(app.motor)?.enabled??false);
  const [linkedText,setLinkedText]=useState(linkedOptions.get(app.motor)?.text??defaultHomePartner(app.motor));
  const [flow,setFlow]=useState(homeFlowOptions.get(app.motor)??{complex:false,middle:false});
  const updateFlow=(next:typeof flow)=>{setFlow(next);homeFlowOptions.set(app.motor,next);};
  const linked=useSyncExternalStore(linkedHoming.subscribe,linkedHoming.getSnapshot);
  let linkedMotors:number[]=[],linkedError="";
  try{linkedMotors=homeTargets(app.motor,linkedEnabled,linkedText);}catch(e){linkedError=String(e).replace(/^Error: /,"");}
  useEffect(()=>{
    const members=policy.linked.split(',').map(Number),included=members.includes(app.motor);
    setFlow({complex:included&&policy.complex,middle:included&&policy.middle});
    setLinkedEnabled(included&&members.length>1);
    setLinkedText(included?members.filter(m=>m!==app.motor).join(','):"");
    setDirection(included?policy.direction:0);
  },[app.motor,policy]);
  const [adaptiveRpm,setAdaptiveRpm]=useState(policy.rpm);
  useEffect(()=>setAdaptiveRpm(policy.rpm),[app.motor,policy.rpm]);
  useEffect(()=>{if(app.connected)void readHomePolicy().catch(e=>app.toast("error",String(e)));},[app.connected]);
  const [busy,setBusy]=useState(false),[note,setNote]=useState("");
  const home=useSharedHome();
  const [configBusy,setConfigBusy]=useState(false),[configNote,setConfigNote]=useState("");
  const [result,setResult]=useState<HomingState|null>(null);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    setResult(homeCache.get(app.motor)??null);
    if(!app.connected)return;
    void readSharedHome(1,true).catch(()=>{});
    const poll=async()=>{
      try {
        if(!app.jobRunning) {
          const next=await api.homingState(app.motor);
          if(next.stage===2||next.stage===3)await semanticMotion.command(app.motor,{kind:"get_state"});
          if(!disposed){homeCache.set(app.motor,next);setResult(next);}
        }
      }catch{/* Keep the last confirmed status; connection UI reports link errors. */}
      if(!disposed)timer=setTimeout(poll,400);
    };
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[app.connected,app.motor,app.jobRunning]);
  const parameterAction=async(write:boolean)=>{
    setConfigBusy(true);setConfigNote("");
    try {
      if(write)await writeSharedHome(1);else await readSharedHome(1);
      setConfigNote(write?"已写入公共 Flash 并回读确认；下次找零使用此参数":"已加载公共 Flash 参数");
    }catch(e){setConfigNote(String(e));app.toast("error",String(e));}
    finally{setConfigBusy(false);}
  };
  const start = async (adaptive=false) => {
    setBusy(true); setNote("");
    try {
      await app.stopStream();
      if(!adaptive){
        if(linkedError)throw Error(linkedError);
        await linkedHoming.start(linkedMotors,direction,(home.config[7]*2+15)*1000,{complex:linkedEnabled&&flow.complex,returnMiddle:(direction===0||direction===2)&&flow.middle});
        return;
      }
      const current=await semanticMotion.command(app.motor,{kind:"get_state"});
      if(current.motor?.drive===2){await semanticMotion.stop(app.motor,true);await semanticMotion.wait(app.motor,10000,r=>r.motor?.drive===0);}
      if(!current.motor?.config_verified)await semanticMotion.initialize(app.motor);
      await semanticMotion.command(app.motor,adaptive?{kind:"homing_adaptive",velocity_rpm:adaptiveRpm,return_positive:policy.positive}:{kind:"homing_start",direction:direction===2?2:direction===1?0:1,step_unit:100,dual:direction===0||direction===2});
      setNote("主控已接收找零任务；以状态卡与双端有效标志判断结果");
    } catch (e) { setNote(String(e)); app.toast("error",`M${app.motor} 找零启动失败：${String(e)}`); } finally { setBusy(false); }
  };
  const stateText = (present: boolean | undefined, yes: string, no: string) =>
    !s ? "未确认" : present ? yes : no;
  const homing = !s ? "未确认" : s.motion_owner === 2 ? "进行中" : s.span_valid ? "已完成" : "待找零";
  const arrivalLabels = ["无位置任务", "轨迹进行中", "等待容差", "稳定确认中", "已到位"];
  const arrival = s?.feedback_fresh && s.arrival_phase != null
    ? arrivalLabels[s.arrival_phase] ?? "未确认" : "未确认";
  const id = s?.feedback_fresh && s.id_raw != null
    ? fmt(s.id_raw * app.cal.maPerCount, 1) + " mA" : "—";
  const protectionBits = s?.protection_state;
  const protection = !s ? "未确认" : s.fault ? "故障" : protectionBits == null ? "未确认" :
    protectionBits === 0 ? "正常" : (protectionBits & ~0x2A000000) !== 0 ?
      `故障 0x${protectionBits.toString(16).toUpperCase()}` :
      `预警 0x${protectionBits.toString(16).toUpperCase()}`;
  const markers = [
    { label: "驱动", value: !s ? "未确认" : (["未使能", "初始化", "已使能", "故障"][s.drive] ?? "未确认"), tone: s?.drive === 2 ? "ok" : "warn" },
    { label: "驱动", value: stateText(s?.drive === 2, "已使能", "未使能"), tone: s?.drive === 2 ? "ok" : "warn" },
    { label: "找零", value: homing, tone: s?.span_valid ? "ok" : "warn" },
    { label: "电角度", value: stateText(s?.align_valid, "已对齐", "未对齐"), tone: s?.align_valid ? "ok" : "warn" },
    { label: "配置", value: stateText(s?.config_verified, "已校验", "未校验"), tone: s?.config_verified ? "ok" : "warn" },
    { label: "行程", value: stateText(s?.span_valid, "有效", "未建立"), tone: s?.span_valid ? "ok" : "warn" },
    { label: "保护", value: protection, tone: s?.fault || protection.startsWith("故障") || protection.startsWith("预警") ? "warn" : protection === "正常" ? "ok" : "neutral" },
    { label: "Id 电流", value: id, tone: "neutral" },
    { label: "位置到位", value: arrival, tone: arrival === "已到位" ? "ok" : "neutral" },
    { label: "故障", value: !s ? "未确认" : s.fault || s.last_error ? String(s.fault || s.last_error) : "无", tone: s?.fault || s?.last_error ? "warn" : "neutral" },
  ];
  return <div className="homing-workspace">
    <section className="homing-dashboard" aria-label="当前电机实时状态">
      <LiveStats />
      <div className="homing-state-line" role="status">
        {markers.map(({label,value,tone}) => <span key={label} className="homing-state-item">
          <span className="homing-state-label">{label}：</span>
          <b className={`homing-state-value is-${tone}`}>{value}</b>
        </span>)}
      </div>
    </section>
    <div className="homing-operations"><SemanticControls>
    <div className="homing-methods-grid">
    <Card title="双端自适应找零" bodyClass="stack adaptive-home-body" right={<Badge tone={result?.adaptive&&result.stage===1?"accent":"neutral"}>受力转折识别</Badge>}>
      <div className="adaptive-home-status" role="status" aria-live="polite">
        <span className="tiny muted">M{app.motor} · 当前阶段</span>
        <strong>{!app.connected?"未连接":result?.adaptive?(result.stage===2?"找零完成":result.stage===3?"已停止 · 端点未确认":adaptiveLabels[result.adaptive_phase??0]??"等待状态"):"待开始"}</strong>
        <span>{result?.adaptive?loadLabels[result.load_phase??0]:"正端找零 → 负端识别 → 返回正端"}</span>
      </div>
      <ol className="adaptive-home-steps" aria-label="自适应找零阶段">
        {["正端参考","建立基线","负端候选","返回确认"].map((label,i)=>{
          const phase=result?.adaptive?result.adaptive_phase??0:0;
          const cut=[1,3,4,6][i],next=[3,4,6,8][i];
          return <li key={label} className={phase>=next?"is-complete":phase>=cut?"is-current":""}><span>{i+1}</span>{label}</li>;
        })}
      </ol>
      <div className="adaptive-home-metrics">
        <Stat label="找零电流" value={result?.adaptive?fmt(result.iq_ma,0):"—"} unit="mA"/>
        <Stat label="识别用时" value={result?.adaptive?fmt(result.elapsed_ms/1000,1):"—"} unit="s"/>
        <Stat label="转折得分" value={result?.adaptive?fmt(result.edge_score??0,1):"—"}/>
        <Stat label="候选行程" value={result?.adaptive&&(result.travel_counts??0)>0?fmt((result.travel_counts??0)/65536,2):"—"} unit="圈"/>
      </div>
      {result?.adaptive&&result.stage===3&&<Notice tone="warn">{result.message||"本次未确认可信端点，已停止；未写入新的行程。"}</Notice>}
      <Field label="负端搜索转速"><NumField label="负端搜索转速" value={adaptiveRpm} unit="rpm" min={1} max={60000} disabled={busy||result?.stage===1} onChange={v=>{setAdaptiveRpm(v);speedCache.set(app.motor,v);}}/></Field>
      <div className="adaptive-home-actions">
        <Button variant="primary" disabled={busy||linked.busy||!s||!s.align_valid||!!s.fault||s.drive===1||s.motion_active} onClick={()=>void start(true)}>开始自适应找零</Button>
        <Button variant="ghost" disabled={!s?.motion_active&&!busy} onClick={()=>void semanticMotion.stop(app.motor,true).catch(e=>setNote(String(e)))}>停止</Button>
      </div>
    </Card>
    <Card title="原找零 · 接触电流" bodyClass="stack legacy-home-body" right={<Badge tone={s?.motion_owner===2&&!result?.adaptive?"accent":"neutral"}>公共 Flash 参数</Badge>}>
      <div className="homing-parameter-grid">
        {HOME_CONFIG_FIELDS.map(({index,name,unit,min,max,scale=1})=><Field key={index} label={name}>
          <NumField label={name} value={home.config[index]/scale} unit={unit} min={min/scale} max={max/scale} step={1/scale} disabled={configBusy}
            clampOnCommit={false} onChange={v=>home.setConfig(home.config.map((x,i)=>i===index?Math.round(v*scale):x))}/>
        </Field>)}
      </div>
      <div className="row-wrap homing-parameter-actions">
        <Button disabled={!app.connected||configBusy} onClick={()=>void parameterAction(false)}>加载参数</Button>
        <Button disabled={!app.connected||configBusy} onClick={()=>void parameterAction(true)}>{configBusy?"处理中…":"写入配置"}</Button>
      </div>
      {configNote&&<div className="tiny muted" role="status">{configNote}</div>}
      <div className="row-wrap" style={{gap:12,alignItems:"end"}}>
        <label className="row" style={{gap:8,minHeight:44}}>
          <input type="checkbox" checked={linkedEnabled} disabled={busy||linked.busy||!!s?.motion_active}
            onChange={e=>{setLinkedEnabled(e.target.checked);linkedOptions.set(app.motor,{enabled:e.target.checked,text:linkedText});}}/>
          联动找零
        </label>
        <Field label="附加电机编号">
          <div className="input-wrap" style={{width:180,opacity:!linkedEnabled||busy||linked.busy?0.45:1}}>
            <input aria-label="联动找零附加电机编号" value={linkedText} placeholder="1,5,9"
              disabled={!linkedEnabled||busy||linked.busy||!!s?.motion_active} aria-invalid={linkedEnabled&&!!linkedError}
              aria-describedby={linkedEnabled&&linkedError?"linked-home-error":undefined}
              onChange={e=>{setLinkedText(e.target.value);linkedOptions.set(app.motor,{enabled:linkedEnabled,text:e.target.value});}}/>
          </div>
        </Field>
        {linkedEnabled&&!linkedError&&<span className="tiny muted">{linkedMotors.map(m=>`M${m}`).join(" + ")}</span>}
      </div>
      {linkedEnabled&&linkedError&&<div id="linked-home-error" role="alert" className="tiny" style={{color:"var(--danger)"}}>{linkedError}</div>}
      <div className="row-wrap">
        <label className="row"><input type="checkbox" checked={linkedEnabled&&flow.complex} disabled={!linkedEnabled||linkedMotors.length!==2||busy||linked.busy} onChange={e=>updateFlow({...flow,complex:e.target.checked})}/>复杂工况</label>
        <label className="row"><input type="checkbox" checked={(direction===0||direction===2)&&flow.middle} disabled={(direction!==0&&direction!==2)||busy||linked.busy} onChange={e=>updateFlow({...flow,middle:e.target.checked})}/>找零结束回到行程中点</label>
      </div>
      {linked.motors.length>0&&<div className="row-wrap" role="status" aria-live="polite">
        {linked.motors.map(motor=><Badge key={motor} tone={linked.states[motor]?.stage===2?"ok":linked.states[motor]?.stage===3?"warn":"neutral"}>
          M{motor} · {linked.states[motor]?.stage===2?"完成":linked.states[motor]?.stage===3?"失败":linked.busy?(["找零中","寻找接触","候选点等待","同向复探","端点确认","回退记录","退让卸载","阈值复核"][linked.states[motor]?.pair_phase??0]??"找零中"):"已停止"}
        </Badge>)}
        <span className="tiny muted">{linked.note}</span>
      </div>}
      <div className="grid homing-control-grid" style={{gap:14}}>
        <div className="homing-operation compact-homing" style={{gap:12}}>
          <Field label="找零方向" hint="双端或单端调试"><SelectField value={direction} onChange={v => { setDirection(Number(v)); }} disabled={busy || linked.busy || !!s?.motion_active} options={[
            { value: 0, label: "双端找零：负端 → 正端" }, { value: 2, label: "双端找零：先正端后负端" }, { value: -1, label: "负向单端调试" }, { value: 1, label: "正向单端调试" }]} /></Field>
          <div className="row-wrap">
            <Button variant="primary" icon={<Icon.Target width={14} height={14}/>} disabled={busy || linked.busy || (linkedEnabled&&!!linkedError) || !s || !s.align_valid || !!s.fault || s.drive === 1 || s.motion_active} onClick={() => void start()}>开始找零</Button>
            <Button variant="ghost" disabled={!s?.motion_active && !busy && !linked.busy} onClick={() => void (linked.busy?linkedHoming.stop():semanticMotion.stop(app.motor,true)).catch(e => setNote(String(e)))}>取消找零</Button>
          </div>
          <div className="homing-message-slot" role="status" aria-live="polite">
            <div className="tiny muted">{s?.motion_owner===2 ? "主控正在找零，请观察实时位置、电流及端点状态" : s?.span_valid && s.config_verified && s.limits_valid ? "双端找零完成，供电保持；已恢复运行配置，可直接点动或定位" : s?.span_valid ? "双端接触已完成，正在恢复并验证运行配置" : ""}</div>
            <div className="tiny muted">{note}</div>
          </div>
        </div>
      </div>
    </Card>
    </div>
  </SemanticControls></div></div>;
}
