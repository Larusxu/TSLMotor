import {useEffect,useRef,useState} from "react";
import {useApp} from "../lib/app-store";
import {SIGNALS} from "../lib/presets";
import {useMotorConfiguration} from "../lib/motor-configuration";
import {semanticFresh} from "../lib/semantic-state";
import {semanticMotion} from "../lib/semantic-motion";
import {COUNTS_PER_RPM} from "../lib/motor-profile-ui";
import {Scope} from "./Scope";
import {Badge,Button,Card,Field,Segmented,SelectField} from "./ui";
export default function TelemetryPanels(){
 const app=useApp();const [paused,setPaused]=useState(false);const [picker,setPicker]=useState(0);
 const task=useMotorConfiguration(app.motor).task;
 const state=app.connected&&app.semantic.motor===app.motor&&semanticFresh(app.semantic)?app.semantic.state:null;
 const spanValid=!!state?.coordinate_valid&&!!state.span_valid&&state.margin_counts!=null&&
   state.logical_span!=null&&BigInt(state.logical_span)>2n*BigInt(state.margin_counts);
 const range=spanValid&&state?.logical_span!=null&&state.margin_counts!=null
   ?[BigInt(state.margin_counts),BigInt(state.logical_span)-BigInt(state.margin_counts)] as const:null;
 const enabled=app.mode!=="direct"&&app.connected&&!!range&&!!state?.permit&&
   (state.drive===0||state.drive===2)&&state.config_verified&&state.feedback_fresh&&!state.fault;
 const validMode=task.mode==="position_direct"||task.mode==="position_ramp";
 const canMove=enabled&&validMode&&Number.isFinite(task.max_rpm)&&task.max_rpm>0&&task.max_rpm<=28730;
 const latest=useRef<number|null>(null),sending=useRef(false),epoch=useRef(0);
 const [positionError,setPositionError]=useState("");
 const current=range&&state?.logical_position!=null&&state.feedback_fresh
   ?Math.max(0,Math.min(100,Number((BigInt(state.logical_position)-range[0])*10000n/(range[1]-range[0]))/100)):null;
 const movePercent=async(p:number,token:number)=>{
   if(!canMove||!range||!Number.isFinite(p)||p<0||p>100)throw Error("当前电机未满足有效行程与运动授权条件");
   const target=(range[0]+(range[1]-range[0])*BigInt(Math.round(p*1000))/100000n).toString();
   await semanticMotion.taskCommand(app.motor,task.mode==="position_ramp"?1:0,
      Math.floor(task.max_rpm*COUNTS_PER_RPM),{kind:"logical_move",position:target},()=>token===epoch.current);
 };
 const flush=async()=>{
   if(sending.current)return;
   sending.current=true;
   const token=epoch.current;
   try{
     while(token===epoch.current&&latest.current!=null){
       await new Promise(resolve=>setTimeout(resolve,40));
       if(token!==epoch.current||latest.current==null)break;
       const value=latest.current;latest.current=null;
       await movePercent(value,token);
     }
   }catch(e){if(token===epoch.current){latest.current=null;setPositionError(String(e));}}
   finally{sending.current=false;if(token!==epoch.current&&latest.current!=null)void flushRef.current();}
 };
 const flushRef=useRef(flush);flushRef.current=flush;
 useEffect(()=>{++epoch.current;latest.current=null;setPositionError("");},[app.motor,app.connected,app.semantic.bootId,enabled,validMode]);
 useEffect(()=>()=>{++epoch.current;latest.current=null;},[]);
 const onPositionChange=(p:number)=>{
   if(!canMove)return;
   app.setPositionTargetPercent(p);
   latest.current=p;setPositionError("");void flush();
 };
 const assigned=app.channels.map((id,ch)=>({ch,sig:SIGNALS.find(s=>s.id===id)??null}));
 return (
      <div className="grid split-2-1" style={{ alignItems: "stretch" }}>
        <Card
          className="fill telemetry-scope-card"
          title="实时遥测"
          sub="LIVE TELEMETRY"
          right={
            <div className="row" style={{ gap: 6 }}>
              <Segmented
                value={String(app.windowMs)}
                onChange={(v) => app.setWindowMs(Number(v))}
                options={[
                  { value: "2000", label: "2s" },
                  { value: "5000", label: "5s" },
                  { value: "15000", label: "15s" },
                  { value: "60000", label: "60s" },
                ]}
              />
              <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>
                {paused ? "继续" : "暂停"}
              </Button>
              {app.streaming ? (
                <Button size="sm" variant="ghost" onClick={() => void app.stopStream().catch(e=>app.toast("warn",String(e)))}>
                  停止
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={!app.connected} onClick={() => void app.startStream()}>
                  开始采集
                </Button>
              )}
            </div>
          }
        >
          <Scope
            store={app.scope}
            channels={assigned.filter((a) => a.sig).map((a) => a.ch)}
            windowMs={app.windowMs}
            paused={paused}
            height="fill"
            onToggleChannel={(ch) => app.setChannel(ch, null)}
          />

        </Card>

        <div className="stack">
          <Card title="信号通道" sub="RTMI CHANNELS" right={<Badge tone="neutral">7 可用</Badge>}>
            <div className="stack" style={{ gap: 8 }}>
              {[0, 1, 2, 3].map((ch) => (
                <div className="row" key={ch} style={{ gap: 8 }}>
                  <span className="mono tiny" style={{ width: 26, color: "var(--text-4)" }}>
                    CH{ch}
                  </span>
                  <SelectField
                    value={app.channels[ch] ?? ""}
                    onChange={(v) => app.setChannel(ch, v === "" ? null : v)}
                    options={[
                      { value: "", label: "— 未使用 —" },
                      ...SIGNALS.map((s) => ({ value: s.id, label: `${s.label} (${s.unit})` })),
                    ]}
                  />
                </div>
              ))}
              <div className="row" style={{ gap: 8 }}>
                <Field label="采样率">
                  <SelectField
                    value={app.sampleHz}
                    onChange={app.setSampleHz}
                    options={[100, 250, 500, 1000, 2000, 4000].map((v) => ({
                      value: v,
                      label: `${v} Hz`,
                    }))}
                  />
                </Field>
                <Field label="同步">
                  <SelectField value={"pwm_z"} onChange={() => undefined} options={[{ value: "pwm_z", label: "PWM_Z 起点" }]} />
                </Field>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span className="tiny muted">信号极性</span>
                <Segmented value={String(app.cal.polarity)} onChange={v=>app.setCal({polarity:Number(v)})}
                  options={[{value:"1",label:"正向"},{value:"-1",label:"反向"}]} />
                <span style={{flex:1}} />
                <label className="tiny muted" htmlFor="telemetry-channel-picker">CH</label>
                <select id="telemetry-channel-picker" value={picker} onChange={e=>setPicker(Number(e.target.value))}
                  className="mono" style={{background:"var(--inset)",border:"1px solid var(--line)",borderRadius:6,padding:"2px 4px"}}>
                  {assigned.map(a=><option key={a.ch} value={a.ch}>CH{a.ch}</option>)}
                </select>
              </div>
              <div className="telemetry-position-control">
                <div className="row" style={{justifyContent:"space-between",gap:8}}>
                  <span className="tiny muted">绝对位置 · 行程目标</span>
                  <span className="mono tiny">{app.positionTargetPercent.toFixed(1)}%{current==null?"":" · 实际 "+current.toFixed(1)+"%"}</span>
                </div>
                <input type="range" aria-label="绝对位置行程百分比" min={0} max={100} step={0.1}
                  value={app.positionTargetPercent} disabled={!canMove}
                  onChange={e=>onPositionChange(Number(e.target.value))}/>
                {positionError&&<div className="tiny" role="alert" style={{color:"var(--danger)"}}>{positionError}</div>}
              </div>
            </div>
          </Card>

        </div>
      </div>
 );
}
