import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/app-store";
import { useMotorConfiguration } from "../lib/motor-configuration";
import { piAuto } from "../lib/pi-auto/service";
import { calculate, velocityTrial, type Capture, type Candidate, type Loop } from "../lib/pi-auto/model";
import { compareResponse } from '../lib/pi-auto/response';
import { amplitudeText } from '../lib/pi-auto/capture-policy';
import { frequencyCandidate, spectrum } from '../lib/pi-auto/frequency';
import { IdentificationWaveform } from '../lib/pi-auto/Waveform';
import type {EndpointResult} from '../lib/pi-auto/endpoint';
import { Button, Card, Check, Field, NumField, SelectField, Badge, KV, Notice, Icon } from "../components/ui";
const names=["Id · 磁链电流环","Iq · 转矩电流环","速度环","位置环"];
const states=["待开始","正在辨识","采集完成","已停止"];
export default function ParameterTuning(){
  const app=useApp(),draft=useMotorConfiguration(app.motor);
  const [loop,setLoop]=useState<Loop>(1),[shared,setShared]=useState(true),[amplitude,setAmplitude]=useState(200);
  const [duration,setDuration]=useState(1),[travel,setTravel]=useState(3600),[bandwidth,setBandwidth]=useState(100);
  const [sampling,setSampling]=useState(7),[excitation,setExcitation]=useState(7);
  const [capture,setCapture]=useState<Capture|null>(null),[candidate,setCandidate]=useState<Candidate|null>(null);
  const [busy,setBusy]=useState(false),[running,setRunning]=useState(false),[trial,setTrial]=useState(false),[message,setMessage]=useState("");
  const [lowRpm,setLowRpm]=useState(500),[highRpm,setHighRpm]=useState(15000),[endpoint,setEndpoint]=useState<EndpointResult|null>(null);
  const [endpointRunning,setEndpointRunning]=useState(false);
  const mounted=useRef(true);
  const baseline=useRef<Capture|null>(null);
  useEffect(()=>{baseline.current=null;setCapture(null);setCandidate(null);setEndpoint(null);setTrial(piAuto.hasTrial(app.motor));setMessage("");},[app.motor]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;void piAuto.cancel().catch(()=>{});};},[]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage("");try{await fn();}catch(e){if(mounted.current)setMessage(String(e));app.toast("error",String(e));}finally{if(mounted.current){setTrial(piAuto.hasTrial(app.motor));setBusy(false);setRunning(false);}}};
  const start=()=>void run(async()=>{
    if(app.mode==="direct")throw Error("参数整定需要通过主控485或CAN连接");
    setRunning(true);setCandidate(null);setCapture(null);
    const raw=Math.round(amplitude*(loop<2?1/.20131:loop===2?1099511627776/3600000000:65536/360));
    const result=await piAuto.capture(app.motor,{loop,amplitude:raw,durationMs:Math.round(duration*1000),travelCounts:Math.round(travel*65536/360),sampling,excitationSampling:excitation},s=>{if(mounted.current)setCapture(s);},text=>{if(mounted.current)setMessage(text);});
    if(mounted.current){
      setCapture(result);
      if(baseline.current&&result.loop===2&&piAuto.hasTrial(app.motor)){
        try{const q=compareResponse(baseline.current,result);setMessage(`试用对照：固定一采样延迟的PRBS误差改善 ${(q.improvement*100).toFixed(1)}%；独立拟合 ${(q.after.validationFit*100).toFixed(1)}%；峰值/激励 ${q.after.peakRatio.toFixed(2)}。${q.accepted?'小信号改善，仍需验证工作转速。':'未满足改善条件，建议恢复原PI。'}`);}catch(e){setMessage(`试用对照不可用：${String(e)}；建议恢复原PI。`);}
      }else setMessage(`采集完成：${result.count}组，实际激励${amplitudeText(result.loop,result.appliedAmplitude??raw)}，共${result.attempts??1}轮；原PI保持。点击计算候选参数。`);
    }
  });
  const compute=()=>{try{if(!capture)throw Error("请先采集");let next:Candidate;try{next=calculate(capture,bandwidth);}catch(plantError){try{next=frequencyCandidate(capture,bandwidth);}catch(frequencyError){throw Error(`${String(plantError)}；${String(frequencyError)}`);}}setCandidate(next);setMessage("候选参数已计算，尚未写入TMC；可试用后重新采集对照。");}catch(e){setCandidate(null);setMessage(String(e));}};
  const autoStart=()=>void run(async()=>{
    if(app.mode==='direct')throw Error('自动整定需要通过主控485或CAN连接');
    setRunning(true);setCandidate(null);setCapture(null);baseline.current=null;
    const raw=Math.round(amplitude*(loop<2?1/.20131:loop===2?1099511627776/3600000000:65536/360));
    const result=await piAuto.automatic(app.motor,{loop,amplitude:raw,durationMs:Math.round(duration*1000),travelCounts:Math.round(travel*65536/360),sampling,excitationSampling:excitation},bandwidth,shared,s=>{if(mounted.current)setCapture(s);},text=>{if(mounted.current)setMessage(text);});
    if(!mounted.current)return;
    setCapture(result.best.capture);setCandidate(result.candidate);setTrial(piAuto.hasTrial(app.motor));
    const actual=piAuto.trialValues(app.motor);if(actual)draft.setPid(actual);
    setMessage(result.improved?`自动整定完成，共 ${result.trials.length} 轮；P=${result.best.p} I=${result.best.i} 已在 TMC 试用并回读，未保存 W25。可继续整定外环，验证低、高速表现后保存。`:'重复测试没有确认改善，已恢复本轮开始时的 PI；此前试用参数与 W25 保持不变。');
  });
  const changeLoop=(v:Loop)=>{setLoop(v);setAmplitude(v<2?200:100);setSampling(v<2?7:31);setExcitation(v<2?7:255);setDuration(v<2?1:3);setBandwidth(v<2?100:v===2?30:10);setCandidate(null);};
  const selected=capture?.loop??loop;
  const points=capture?.samples??[];
  const response=useMemo(()=>{try{return capture?.state===2?spectrum(capture):null;}catch{return null;}},[capture]);
  return <div className="pi-auto stack">
    <div className="pi-auto-summary" aria-live="polite">
      <div><span className="tiny muted">当前电机</span><strong>M{app.motor}</strong></div>
      <div><span className="tiny muted">整定状态</span><strong>{running?(endpointRunning?"正在末段优化":"正在辨识"):capture?states[capture.state]:"待开始"}</strong></div>
      <div><span className="tiny muted">实际采样</span><strong>{capture?.sampleHz?`${capture.sampleHz.toFixed(2)} Hz`:"—"}</strong></div>
      <div><span className="tiny muted">参数状态</span><strong>{trial?"TMC试用 · 未保存":"原配置保持"}</strong></div>
    </div>
    <div className="pi-auto-grid">
      <Card title="系统辨识" right={<Badge>TMC PRBS</Badge>}>
        <div className="stack">
          <Field label="辨识对象" hint="芯片内部激励"><SelectField value={loop} onChange={v=>changeLoop(Number(v) as Loop)} options={names.map((label,value)=>({label,value}))} disabled={busy} width="100%"/></Field>
          <div className="pi-auto-fields">
            <Field label="激励幅值" hint={loop<2?"mA":loop===2?"rpm":"电机端 °"}><NumField value={amplitude} onChange={setAmplitude} min={1} disabled={busy} width="100%"/></Field>
            <Field label="采集时长" hint="秒"><NumField value={duration} onChange={setDuration} min={1} max={7} disabled={busy} width="100%"/></Field>
            <Field label="最大偏离当前位置" hint="电机端 °"><NumField value={travel} onChange={setTravel} min={1} max={3600} disabled={busy} width="100%"/></Field>
            <Field label="目标闭环带宽" hint="Hz"><NumField value={bandwidth} onChange={v=>{setBandwidth(v);setCandidate(null);}} min={.1} step={.1} disabled={busy} width="100%"/></Field>
          </div>
          <details><summary className="tiny muted">采集与激励时钟</summary><div className="pi-auto-fields" style={{marginTop:12}}>
            <Field label="RTMI 采样分频" hint="PWM / (N+1)"><NumField value={sampling} onChange={setSampling} min={0} max={255} disabled={busy} width="100%"/></Field>
            <Field label="PRBS 激励分频" hint="PWM / (N+1)"><NumField value={excitation} onChange={setExcitation} min={0} max={255} disabled={busy} width="100%"/></Field>
          </div><div className="tiny muted">观察采样与激励独立设置。电流环默认3125 Hz、外环781.25 Hz，可自行修改。提高采样率不等于提高闭环带宽。</div></details>
          <Check checked={shared} onChange={v=>{if(!busy)setShared(v);}}>电流环 Id / Iq 使用同一份 PI 参数</Check>
          <div className="tiny muted">勾选后，每次试用将同一组 P、I 一并写入 Id 和 Iq，并分别回读验证；保存时两组一起落盘。取消后只调整所选电流环。速度和位置环独立。</div>
          <Notice>建议先完成双端找零，再移到行程中点。不要在滑块顶住机械限位时辨识，避免接触力和反馈饱和影响结果。</Notice>
          <div className="tiny muted">辨识期间独占RTMI配置，普通曲线采集自动暂停；主控只保留必要的位移、电流及电气状态检查，会话续期和停止始终可用。结束后普通曲线可手动重新开始。</div>
          {loop===3&&<Notice>位置PRBS围绕采集起点正负激励。主控临时平移位置偏置，结束或取消后恢复；最大偏移相对本次采集起点计算。</Notice>}
          <div className="row-wrap">
            <Button variant="primary" disabled={!app.connected||busy} onClick={autoStart} icon={<Icon.Sequence/>}>自动整定</Button>
            <Button disabled={!app.connected||busy} onClick={start}>仅采集辨识</Button>
            <Button variant="danger" disabled={!running} onClick={()=>void piAuto.cancel().catch(e=>setMessage(String(e)))} icon={<Icon.Stop/>}>停止</Button>
          </div>
          <div className="tiny muted">按填写的激励幅值执行；超出TMC当前限幅时显示请求值、上限和调整位置，不自动降幅或重试。触及位移边界后停止并保留现场数据。结束后PWM禁能、逻辑供电保持。</div>
        </div>
      </Card>
      <Card title="辨识响应" right={<Badge>{capture?.state===3?'停止现场 · ':''}{points.length} / {capture?.count??0} 组</Badge>}>
        {points.length&&capture?<IdentificationWaveform capture={capture}/>:<div className="pi-auto-wave"><div className="pi-auto-empty"><Icon.Gauge width={32} height={32}/><span>完成采集后显示实际响应</span><span className="tiny muted">可选择时间窗口并移动查看原始波形</span></div></div>}
        <div className="row-wrap tiny"><span style={{color:"var(--warn)"}}>-- PRBS参考</span><span style={{color:"var(--accent)"}}>— 实际反馈</span><span className="muted">原始寄存器单位 · {names[selected]}</span></div>
        {capture?.appliedAmplitude!==undefined&&<div className="tiny muted">本轮实际激励：{amplitudeText(capture.loop,capture.appliedAmplitude)} · 第{capture.attempts}轮{capture.state===3?' · 中止数据仅用于排障，不能作为完整辨识结果':''}</div>}
        <KV rows={[["电流 / 速度 / 位置环执行频率",capture?`${capture.pwmHz} / ${capture.velocityHz} / ${(capture.velocityHz/(((capture.pidConfig>>>16)&127)+1)).toFixed(0)} Hz`:"—"],["参考/反馈相干度",response?`${(response.coherence*100).toFixed(1)}%`:"—"],["实测闭环 -3dB 带宽",response?.bandwidthHz?`${response.bandwidthHz.toFixed(1)} Hz`:"尚未可靠测出"],["UART新增事件",capture?`0x${capture.events.toString(16).toUpperCase()}`:"—"]]}/>
        <div className="tiny muted">执行频率表示控制器多久运算一次；闭环带宽表示能跟踪多快的变化，两者不是同一个数值。2431 的 R/L 可作校核，不能用相间参数直接代替 d/q 模型。</div>
      </Card>
    </div>
    <Card title="候选 PI 与应用" right={<Badge>计算 → 试用 → 保存</Badge>}>
      <div className="pi-auto-result">
        <div><span className="tiny muted">P 原码</span><strong>{candidate?.p??"—"}</strong></div>
        <div><span className="tiny muted">I 原码</span><strong>{candidate?.i??"—"}</strong></div>
        <div><span className="tiny muted">{candidate?.method?'频域相干度':'独立模型验证'}</span><strong>{candidate?`${(candidate.model.validationFit*100).toFixed(1)}%`:"—"}</strong></div>
        <div><span className="tiny muted">对象时间常数</span><strong>{candidate?.model.tauSeconds?`${(candidate.model.tauSeconds*1000).toFixed(2)} ms`:"—"}</strong></div>
      </div>
      <div className="row-wrap" style={{marginTop:16}}>
        <Button disabled={busy||capture?.state!==2} onClick={compute}>计算候选参数</Button>
        {capture?.loop===2&&<Button disabled={busy||capture.state!==2} onClick={()=>{try{setCandidate(velocityTrial(capture));setMessage('已生成P增加10%、I保持的实验候选。试用后用同幅值重新采集；不代表最优PI。');}catch(e){setCandidate(null);setMessage(String(e));}}}>生成速度小步候选</Button>}
        <Button variant="primary" disabled={busy||!app.connected||!candidate} onClick={()=>void run(async()=>{const p=await piAuto.apply(app.motor,capture!,candidate!,shared);baseline.current=capture;draft.setPid(p);setTrial(true);setMessage("候选PI已写入并回读；未清积分器、未保存W25。可用现有运动页面验证响应。");})}>试用并回读</Button>
        <Button disabled={busy||!trial||!app.connected} onClick={()=>void run(async()=>{await piAuto.save(app.motor);setTrial(false);setMessage("TMC回读通过，已保存到本电机W25档案。");})} icon={<Icon.Save/>}>保存到电机档案</Button>
        <Button variant="ghost" disabled={busy||!trial||!app.connected} onClick={()=>void run(async()=>{await piAuto.restore(app.motor);setTrial(false);setMessage("原PI已恢复并回读，W25保持。");})}>恢复原PI</Button>
      </div>
      <div className="pi-auto-message" role="status" aria-live="polite">{message||"先采集真实响应，再计算候选参数；试用不会自动开始运动。"}</div>
      {candidate&&<div className="tiny muted">{candidate.warnings.join(" · ")}</div>}
    </Card>
    <Card title="位置直通末段优化" right={<Badge>真实低速 / 高速对照</Badge>}>
      <div className="stack">
        <div className="tiny muted">先用PRBS整定内环，再比较位置直通接近目标时的减速。会在已找零行程的40% → 60% → 50%之间真实往复；比较速度环P、较小或零积分、位置环P，并重复验证胜出组合。不改找零参数，不保存W25。</div>
        <div className="pi-auto-fields">
          <Field label="低速工况" hint="rpm"><NumField value={lowRpm} onChange={setLowRpm} min={1} disabled={busy} width="100%"/></Field>
          <Field label="高速工况" hint="rpm"><NumField value={highRpm} onChange={setHighRpm} min={1} disabled={busy} width="100%"/></Field>
        </div>
        <div className="row-wrap">
          <Button variant="primary" disabled={busy||!app.connected} onClick={()=>void run(async()=>{
            if(app.mode==='direct')throw Error('末段优化需要通过主控485或CAN连接');
            setRunning(true);setEndpointRunning(true);setEndpoint(null);
            let result:EndpointResult;
            try{result=await piAuto.endpoint(app.motor,[lowRpm,highRpm],text=>{if(mounted.current)setMessage(text);});}
            finally{if(mounted.current)setEndpointRunning(false);}
            if(!mounted.current)return;
            setEndpoint(result);const p=piAuto.trialValues(app.motor);if(p)draft.setPid(p);
            setMessage(result.improved?'末段优化完成，候选已在TMC试用并回读；原PI可恢复，W25未保存。':'未确认重复改善，已恢复本轮开始时的PI；W25未改变。');
          })}>开始末段优化</Button>
          <Button variant="danger" disabled={!running} onClick={()=>void piAuto.cancel().catch(e=>setMessage(String(e)))}>停止</Button>
        </div>
        {endpoint&&<KV rows={[["原组合 / 候选评分",`${endpoint.baseline.score.toFixed(3)} / ${endpoint.best.score.toFixed(3)}`],["速度环 P / I",`${endpoint.best.coefficients[2]>>>16} / ${endpoint.best.coefficients[2]&65535}`],["位置环 P / I",`${endpoint.best.coefficients[3]>>>16} / ${endpoint.best.coefficients[3]&65535}`],["最大采样速度",`${Math.max(...endpoint.best.moves.map(m=>m.peakRpm)).toFixed(0)} rpm`],["最大位置超调",`${Math.max(...endpoint.best.moves.map(m=>m.overshootPercent)).toFixed(4)}% 全行程`]]}/>}
        <div className="tiny muted">评分同时考虑末10%及稳定时间、总耗时、速度峰值和位置超调；更快但超调明显的组合不会仅凭到位速度入选。末10%包含剩余行程的正常运行时间，低速数值大不等于减速拖尾。采样峰值不等于连续时间最大值。结束后PWM关闭，恢复原模式和档案任务转速。</div>
      </div>
    </Card>
  </div>;
}
