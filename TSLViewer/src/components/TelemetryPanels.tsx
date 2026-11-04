import {useState} from "react";
import {useApp} from "../lib/app-store";
import {SIGNALS} from "../lib/presets";
import {Scope} from "./Scope";
import {Badge,Button,Card,Field,Notice,Segmented,SelectField} from "./ui";
export default function TelemetryPanels(){
 const app=useApp();const [paused,setPaused]=useState(false);const [picker,setPicker]=useState(0);
 const assigned=app.channels.map((id,ch)=>({ch,sig:SIGNALS.find(s=>s.id===id)??null}));
 return (
      <div className="grid split-2-1" style={{ alignItems: "stretch" }}>
        <Card
          className="fill"
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
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <Badge tone={app.streaming ? "accent" : "neutral"} dot={app.streaming ? "live" : undefined}>
              {app.streaming ? `${(app.mode === "direct" ? app.stats?.frame_rate ?? 0 : app.traceRate).toFixed(0)} 帧/s` : "未采集"}
            </Badge>
            <span className="tiny muted">
              {app.mode === "direct" ? `触发 ${app.sampleHz} Hz · sampling=${app.sampling} · 丢弃 ${app.stats?.rtmi_dropped ?? 0} 字节` : app.traceStatus || "主控 RTMI · PWM 同步"}
            </span>
          </div>
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
              <Notice tone="warn">
                {app.mode === "direct" ? "串口 115200 下 4 通道 × 5 字节 ≈ 1.7 ms，触发周期需大于它。想上 1 kHz 请用 921600 以上。" : "主控转发芯片原生 RTMI，CRC 校验。半双工通信限制触发率不超过约 100 Hz；485 每 2 组、CAN 每 12 组转发一组，保留实际采样时刻。实际 sampling 与丢帧见曲线下方。请在驱动禁能时开始、停止或修改采集配置。"}
              </Notice>
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
            </div>
          </Card>

        </div>
      </div>
 );
}
