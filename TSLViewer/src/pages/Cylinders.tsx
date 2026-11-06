import "../styles/cylinders.css";
import { useApp } from "../lib/app-store";
import type { CylinderModel } from "../lib/cylinder";
import { Badge,Button,Card,Field,Icon,NumField,SelectField } from "../components/ui";

function LabeledNumber(props:Parameters<typeof NumField>[0]) {
  return <Field label={props.label}><NumField {...props}/></Field>;
}

export function CylinderToolbar({model}:{model:CylinderModel}) {
  const app=useApp(),ch=model.selected,r=model.rows[ch-1];
  const enabled=app.connected&&app.mode!=="direct"&&!app.acquiring;
  return <div className="motor-toolbar" aria-label="电缸操作">
    <span className="motor-toolbar-label">当前电缸</span>
    <SelectField value={ch} onChange={model.setSelected} width={150}
      options={model.rows.map((_,i)=>({value:i+1,label:`C${i+1} · UART${i+18}`}))}/>
    <Button disabled={!enabled||r.busy} variant={r.status?.permit?"primary":"default"}
      onClick={()=>void model.command(ch,{kind:"permit",id:r.id,enabled:!r.status?.permit},false,true)}>
      {r.status?.permit?"取消运动授权":"开启运动授权"}</Button>
    <Button disabled={!app.connected} icon={<Icon.Stop/>} onClick={()=>void model.stop(ch)}>停止运行</Button>
    <span className="motor-toolbar-status">{r.status?.online?"通信在线":"等待电缸响应"}</span>
    <Button disabled={!app.connected} variant="danger" onClick={()=>{for(let i=1;i<=5;i++)void model.stop(i);}}>全部停止</Button>
  </div>;
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
      return <Card key={ch} className={`cylinder-card ${model.selected===ch?"selected":""}`}
        title={<button className="cylinder-heading" onClick={()=>model.setSelected(ch)}>C{ch}<span>电缸 · UART{i+18}</span></button>}
        right={<Badge tone={s?.online?(s.fault?"danger":"ok"):"neutral"}>{s?.online?(s.fault?`故障 ${s.fault}`:"在线"):"离线"}</Badge>}>
        <div className="cylinder-stats">
          <div><span>反馈电流</span><strong>{s?.online?s.current_ma:"—"}<small> mA</small></strong></div>
          <div><span>回温启动值</span><strong>{s?.online?s.restart_c:"—"}<small> °C</small></strong></div>
          <div><span>实际行程</span><strong>{s?.online?s.position:"—"}<small> 步</small></strong></div>
        </div>
        <div className="cylinder-fields">
          <LabeledNumber label="过流阈值" unit="mA" value={r.current} min={0} max={65535} onChange={current=>model.update(ch,{current})}/>
          <LabeledNumber label="过温阈值" unit="°C" value={r.temperature} min={0} max={150} onChange={temperature=>model.update(ch,{temperature})}/>
          <LabeledNumber label="通信 ID" value={r.id} min={1} max={254} onChange={id=>model.update(ch,{id,status:null})}/>
        </div>
        <div className="cylinder-actions">
          <Button disabled={!ready} onClick={()=>run("read")}>读取</Button>
          <Button disabled={!ready} onClick={()=>void model.command(ch,{kind:"protection",id:r.id,current_ma:r.current,temperature_c:r.temperature})}>写入</Button>
          <Button disabled={!ready} onClick={()=>run("clear")}>清除故障</Button>
        </div>
        <div className="cylinder-travel">
          <div className="cylinder-target"><span>目标行程</span><b>{r.target}<small> 步</small></b>
            <span>{s?.permit?"已授权":"未授权"}</span></div>
          <input type="range" aria-label={`C${ch}目标行程`} min={s?.lower??0} max={s?.upper??2000} step={1}
            value={r.target} disabled={!available||!s?.permit||!s.online}
            onChange={e=>model.setTarget(ch,Number(e.target.value))}/>
          <div className="cylinder-scale"><span>{s?.lower??0}</span><span>{s?.upper??2000}</span></div>
        </div>
        <div className="cylinder-fields">
          <LabeledNumber label="行程上限" value={r.upper} min={0} max={2000} onChange={upper=>model.update(ch,{upper})}/>
          <LabeledNumber label="行程下限" value={r.lower} min={0} max={2000} onChange={lower=>model.update(ch,{lower})}/>
          <LabeledNumber label="初始位置" value={r.initial} min={0} max={2000} onChange={initial=>model.update(ch,{initial})}/>
        </div>
        <div className="cylinder-actions">
          <Button disabled={!ready} onClick={()=>void model.readTravel(ch)}>读取</Button>
          <Button disabled={!ready||!valid} onClick={()=>void model.command(ch,{kind:"travel",id:r.id,lower:r.lower,upper:r.upper,initial:r.initial})}>写入</Button>
          <Button disabled={!ready||!s?.permit||!s.online} onClick={()=>run("initial")}>到初始位</Button>
          {r.busy&&<span role="status">处理中…</span>}
        </div>
        {!valid&&<p className="cylinder-error">初始位置需位于行程上下限内。</p>}
        {r.error&&<p className="cylinder-error" role="alert">{r.error}</p>}
      </Card>;
    })}</div>
  </div>;
}
