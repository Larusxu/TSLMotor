import {Card,NumField,Button} from "../components/ui";
import type {CylinderModel} from "../lib/cylinder";
import {cylinderDisplayName} from "../lib/cylinder-names";
import {useApp} from "../lib/app-store";
export default function CylinderConfig({model}:{model:CylinderModel}){
 const app=useApp();
 return <Card title="电缸配置 · C1–C5"><div className="table-scroll"><table className="table config-table"><thead><tr><th>接口</th><th>设备地址</th><th>过流阈值 / mA</th><th>过温阈值 / °C</th><th>回温阈值 / °C</th><th>行程下限</th><th>行程上限</th><th>初始位置</th><th>行程状态</th><th>操作</th></tr></thead><tbody>{model.rows.map((r,i)=>{
 const ch=i+1;
 const field=(key:"current"|"temperature"|"restart"|"lower"|"upper"|"initial",label:string)=> <NumField label={`C${ch} ${label}`} value={r[key]} disabled={!app.connected||r.busy||!r.status} onChange={v=>model.update(ch,{[key]:v})} onCommit={v=>{const next={...r,[key]:v};void model.command(ch,["current","temperature","restart"].includes(key)?{kind:"protection",id:r.id,current_ma:next.current,temperature_c:next.temperature,restart_c:next.restart}:{kind:"travel",id:r.id,lower:next.lower,upper:next.upper,initial:next.initial});}}/>;
 return <tr key={ch}><td><b>{cylinderDisplayName(ch)}</b><div className="tiny" role="status">{r.error}</div></td><td><NumField label={`C${ch} 设备地址`} value={r.id} min={1} max={254} onChange={v=>model.update(ch,{id:v})}/></td><td>{field("current","过流阈值")}</td><td>{field("temperature","过温阈值")}</td><td>{field("restart","回温阈值")}</td><td>{field("lower","行程下限")}</td><td>{field("upper","行程上限")}</td><td>{field("initial","初始位置")}</td><td>{r.status?.travel_valid?"行程有效":"行程无效"}</td><td><Button size="sm" disabled={!app.connected||r.busy} onClick={()=>void model.command(ch,{kind:"read",id:r.id},true)}>读取</Button></td></tr>;
 })}</tbody></table></div></Card>;
}
