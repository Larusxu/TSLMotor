import "../styles/cylinders.css";
import { useApp } from "../lib/app-store";
import type { CylinderModel } from "../lib/cylinder";
import { cylinderDisplayName } from "../lib/cylinder-names";
import { Badge,Button,Card,Field,NumField,Toggle } from "../components/ui";

function LabeledNumber(props:Parameters<typeof NumField>[0]) {
  return <Field label={props.label}><NumField {...props}/></Field>;
}

export default function Cylinders({model}:{model:CylinderModel}) {
  const app=useApp();const available=app.connected&&app.mode!=="direct"&&!app.acquiring;
  return <div className="cylinder-page">
    <div className="cylinder-summary">
      <span><b>5</b> 独立通道</span><span><b>{model.rows.filter(r=>r.status?.online).length}</b> 在线电缸</span>
      <span>LA 系列 · 921600 bit/s</span><span>行程单位：步 · 全行程 2000 步</span>
    </div>
    {app.mode==="direct"&&<p role="status">请连接主控网关模式以访问电缸。</p>}
    <div className="cylinder-grid">{model.rows.map((r,i)=>{
      const ch=i+1,s=r.status,ready=available&&!r.busy;
      const valid=r.lower>=0&&r.upper<=2000&&r.lower<=r.initial&&r.initial<=r.upper;
      const run=(kind:"read"|"clear"|"initial")=>void model.command(ch,{kind,id:r.id},kind==="read");
      return <Card key={ch} className="cylinder-card"
        title={<div className="cylinder-heading">{cylinderDisplayName(ch)}<span>电缸 · UART{i+18}</span></div>}
        right={<Badge tone={s?.online?(s.fault?"danger":"ok"):"neutral"}>{s?.online?(s.fault?`故障 ${s.fault}`:"在线"):"离线"}</Badge>}>
        <div className="cylinder-actions">
          <span>使能</span><Toggle checked={!!s?.enabled} label={`${cylinderDisplayName(ch)}使能`} disabled={!ready||!s?.online} onChange={enabled=>void model.setEnabled(ch,enabled)}/>
          <span className="muted">{s?.enabled?"已使能":"未使能"}</span>
          <Button disabled={!available} onClick={()=>void model.stop(ch)}>停止</Button>
        </div>
        <div className="cylinder-stats">
          <div><span>反馈电流</span><strong>{s?.online?s.current_ma:"—"}<small> mA</small></strong></div>
          <div><span>回温启动值</span><strong>{s?.online?s.restart_c:"—"}<small> °C</small></strong></div>
          <div><span>实际行程</span><strong>{s?.online?s.position:"—"}<small> 步</small></strong></div>
        </div>
        <div className="cylinder-fields">
          <LabeledNumber label="过流阈值" unit="mA" value={r.current} min={0} max={65535} onChange={current=>model.update(ch,{current})}/>
          <LabeledNumber label="过温阈值" unit="°C" value={r.temperature} min={0} max={150} onChange={temperature=>model.update(ch,{temperature})}/>
          <LabeledNumber label="回温阈值" unit="°C" value={r.restart} min={0} max={149} onChange={restart=>model.update(ch,{restart})}/>
          <LabeledNumber label="通信 ID" value={r.id} min={1} max={254} onChange={id=>model.update(ch,{id,status:null})}/>
        </div>
        <div className="cylinder-actions">
          <Button disabled={!ready} onClick={()=>run("read")}>读取</Button>
          <Button disabled={!ready} onClick={()=>void model.command(ch,{kind:"protection",id:r.id,current_ma:r.current,temperature_c:r.temperature,restart_c:r.restart})}>写入</Button>
          <Button disabled={!ready} onClick={()=>run("clear")}>清除故障</Button>
        </div>
        <div className="cylinder-travel">
          <div className="cylinder-target"><span>目标行程</span><b>{r.target}<small> 步</small></b>
            </div>
          <input type="range" aria-label={`C${ch}目标行程`} min={s?.lower??0} max={s?.upper??2000} step={1}
            value={r.target} disabled={!available||!s?.online||!s.enabled}
            onChange={e=>model.setTarget(ch,Number(e.target.value))}/>
          <div className="cylinder-scale"><span>{s?.lower??0}</span><span>{s?.upper??2000}</span></div>
        </div>
        <div className="cylinder-fields">
          <LabeledNumber label="行程上限" value={r.upper} min={0} max={2000} onChange={upper=>model.update(ch,{upper})}/>
          <LabeledNumber label="行程下限" value={r.lower} min={0} max={2000} onChange={lower=>model.update(ch,{lower})}/>
          <LabeledNumber label="初始位置" value={r.initial} min={0} max={2000} onChange={initial=>model.update(ch,{initial})}/>
        </div>
        <Badge tone={s?.travel_valid?"ok":"neutral"}>{s?.travel_valid?"行程有效":"行程无效"}</Badge>
        <div className="cylinder-actions">
          <Button disabled={!ready} onClick={()=>void model.readTravel(ch)}>读取</Button>
          <Button disabled={!ready||!valid} onClick={()=>void model.command(ch,{kind:"travel",id:r.id,lower:r.lower,upper:r.upper,initial:r.initial})}>写入</Button>
          <Button disabled={!ready||!s?.online||!s.enabled} onClick={()=>run("initial")}>到初始位</Button>
          {r.busy&&<span role="status">处理中…</span>}
        </div>
        {!valid&&<p className="cylinder-error">初始位置需位于行程上下限内。</p>}
        {r.error&&<p className="cylinder-error" role="alert">{r.error}</p>}
      </Card>;
    })}</div>
  </div>;
}
