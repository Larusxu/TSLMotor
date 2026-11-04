import { useEffect, useState } from "react";
import { useApp } from "../lib/app-store";
import { semanticMotion } from "../lib/semantic-motion";
import { semanticFresh } from "../lib/semantic-state";
import { SemanticStatus } from "../components/SemanticStatus";
import { SemanticControls } from "../components/SemanticControls";
import { Button, Card, Check, Field, NumField, SelectField, Badge, Icon } from "../components/ui";

export default function SemanticHoming() {
  const app = useApp(), s = app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic) ? app.semantic.state : null;
  const [config, setConfig] = useState([400, 1050, 50, 500, 2000, 0, 0, 60]);
  const [saved,setSaved]=useState<number[]|null>(null);
  const dirty=!saved||config.some((x,i)=>x!==saved[i]);
  const [direction, setDirection] = useState(0), [safe, setSafe] = useState(false);
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const patch = (i: number, v: number) => { setConfig(c => c.map((x, j) => i === j ? v : x)); setSafe(false); };
  useEffect(()=>{
    let alive=true;setSaved(null);setSafe(false);
    if(app.connected)void semanticMotion.command(app.motor,{kind:"homing_config_read"}).then(r=>{
      if(!r.homing_config)throw Error("主控未返回找零参数");
      if(alive){setConfig(r.homing_config);setSaved(r.homing_config);setNote("已读取主控当前找零参数");}
    }).catch(e=>{if(alive)setNote(String(e));});
    return ()=>{alive=false;};
  },[app.connected,app.motor,app.semantic.bootId]);
  const writeConfig=async()=>{
    setBusy(true);setNote("");
    try{
      if(config.some(x=>!Number.isInteger(x)||x<0||x>65535)||config[3]<=config[0]*config[1]/1000)
        throw Error("找零参数无效；限流必须大于接触阈值");
      const current=await semanticMotion.command(app.motor,{kind:"get_state"});
      if(current.motor?.motion_active||current.motor?.drive!==0)throw Error("请先停止运行并禁能，再写找零参数");
      const written=await semanticMotion.command(app.motor,{kind:"homing_config_write",config});
      const read=await semanticMotion.command(app.motor,{kind:"homing_config_read"});
      if(!written.homing_config||!read.homing_config||config.some((x,i)=>x!==written.homing_config![i]||x!==read.homing_config![i]))
        throw Error("主控找零参数回读不一致，禁止开始");
      setSaved([...config]);setSafe(false);
      setNote("共用找零参数已写入片内 Flash 参数区并独立回读；重启自动加载");
    }catch(e){setSaved(null);setNote(String(e));}finally{setBusy(false);}
  };
  const start = async () => {
    setBusy(true); setNote("");
    try {
      if(dirty)throw Error("请先写入配置并回读主控找零参数");
      await app.stopStream();
      if(s?.drive===2){await semanticMotion.stop(app.motor,true);await semanticMotion.wait(app.motor,10000,r=>r.motor?.drive===0);}
      if(!s?.config_verified)await semanticMotion.initialize(app.motor);
      await semanticMotion.command(app.motor, { kind: "homing_start", direction: direction === 1 ? 0 : 1,
        step_unit: 100, dual: direction === 0 });
      setSafe(false); setNote("主控已接收找零任务；以状态卡与双端有效标志判断结果");
    } catch (e) { setNote(String(e)); app.toast("error",`M${app.motor} 找零启动失败：${String(e)}`); } finally { setBusy(false); }
  };
  return <div className="grid" style={{ gap: 14 }}><SemanticStatus /><SemanticControls>
    <Card title="找零控制" right={<Badge tone={s?.motion_owner===2?"accent":"neutral"}>{s?.motion_owner===2?"正在找零":"主控执行"}</Badge>}>
      <div className="grid cols-2" style={{gap:14}}>
        <div className="stack" style={{gap:12}}>
          <div className="row-wrap"><span className="stat-label" style={{margin:0}}>找零参数</span><span className="tiny muted">16 路共用 · Flash 保存</span></div>
          <div className="grid cols-2" style={{gap:10}}>{[
          [0, "判定系数 ×1000", "", 100, 2000], [1, "额定电流", "mA", 100, 1050], [2, "连续确认", "ms", 10, 1000],
          [3, "找零电流上限", "mA", 100, 1050], [4, "推进速度上限", "rpm", 100, 2000], [7, "每端超时", "s", 5, 300],
        ].map(([index, label, unit, min, max]) => <Field key={index} label={String(label)}><NumField value={config[Number(index)]} onChange={v => patch(Number(index), v)} unit={String(unit)} min={Number(min)} max={Number(max)} disabled={busy || !!s?.motion_active} /></Field>)}</div>
          <div className="tiny muted">接触阈值 <span className="mono">{(config[0] * config[1] / 1000).toFixed(0)} mA</span>；触限确认即记录零点，不退开。双端直接反向寻找另一端，结束后恢复临时限幅并停止输出。</div>
          <div className="row-wrap"><Button variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={!app.connected||busy||!!s?.motion_active||s?.drive!==0} onClick={()=>void writeConfig()}>{busy?"正在写入…":"写入配置"}</Button><span className="tiny muted">{dirty?"编辑值尚未写入主控":"与主控已存参数一致"}</span></div>
        </div>
        <div className="stack" style={{gap:12}}>
          <Field label="找零方向" hint="双端或单端调试"><SelectField value={direction} onChange={v => { setDirection(Number(v)); setSafe(false); }} disabled={busy || !!s?.motion_active} options={[
            { value: 0, label: "双端找零：负端 → 正端" }, { value: -1, label: "负向单端调试" }, { value: 1, label: "正向单端调试" }]} /></Field>
          <div className="tiny muted">使用主控已存找零参数，以及初始化时从 W25 写入 TMC 的 PI；双端均有效才开放绝对位置和工况。</div>
          <div className="divider" />
          <Check checked={safe} onChange={setSafe}>机构允许对应行程；人员和异物已离开行程</Check>
          <div className="row-wrap">
            <Button variant="primary" icon={<Icon.Target width={14} height={14}/>} disabled={dirty || !safe || busy || !app.armed || !s?.permit || !s.align_valid || !s.config_verified || s.drive === 1 || s.motion_active} onClick={() => void start()}>开始找零</Button>
            <Button variant="ghost" disabled={!s?.motion_active && !busy} onClick={() => void semanticMotion.close().catch(e => setNote(String(e)))}>取消找零</Button>
          </div>
          <div className="homing-message-slot" role="status" aria-live="polite">
            <div className="tiny muted">{!app.connected ? "串口未连接" : !app.armed || !s?.permit ? "需开启 ARM 与运动授权" : "ARM 与运动授权已开启"}</div>
            <div className="tiny muted">{s?.motion_owner===2 ? "主控正在找零，请观察实时位置、电流及端点状态" : s?.span_valid && s.config_verified && s.limits_valid ? "双端找零完成，供电保持；已恢复运行配置，可直接点动或定位" : s?.span_valid ? "双端接触已完成，正在恢复并验证运行配置" : ""}</div>
            <div className="tiny muted">{note}</div>
          </div>
        </div>
      </div>
    </Card>
  </SemanticControls></div>;
}
