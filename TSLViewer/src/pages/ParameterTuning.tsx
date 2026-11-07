import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/app-store";
import { useMotorConfiguration, mergePiTuning } from "../lib/motor-configuration";
import { piAuto, type IdentificationOptions } from "../lib/pi-auto/service";
import { type Capture, type Candidate, type Loop } from "../lib/pi-auto/model";
import { amplitudeText, diagnosticText } from '../lib/pi-auto/capture-policy';
import { spectrum } from '../lib/pi-auto/frequency';
import { IdentificationWaveform } from '../lib/pi-auto/Waveform';
import {emptyCaptureView,updateCaptureView,type CaptureProgress} from '../lib/pi-auto/presentation';
import {identificationPreset,rawAmplitude} from '../lib/pi-auto/presets';
import type {Trial} from '../lib/pi-auto/automatic';
import type {EndpointResult} from '../lib/pi-auto/endpoint';
import { Button, Card, Check, Field, NumField, SelectField, Badge, KV, Icon } from "../components/ui";
const names=["Id · 磁链电流环","Iq · 转矩电流环","速度环","位置环"];
const states=["待开始","正在辨识","采集完成","已停止"];
export default function ParameterTuning(){
  const app=useApp(),draft=useMotorConfiguration(app.motor);
  const [loop,setLoop]=useState<Loop>(1),[shared,setShared]=useState(true),[amplitude,setAmplitude]=useState(200);
  const [duration,setDuration]=useState(1),[range,setRange]=useState("40-60"),[bandwidth,setBandwidth]=useState(100);
  const selectedRange=range.split("-").map(Number);
  const [sampling,setSampling]=useState(7),[excitation,setExcitation]=useState(7);
  const [view,setView]=useState(emptyCaptureView),[candidate,setCandidate]=useState<Candidate|null>(null);
  const capture=view.capture;
  const setCapture=(capture:Capture|null)=>setView(v=>({...v,capture}));
  const [history,setHistory]=useState<{trial:Trial;round:number}[]>([]);
  const progress=(s:CaptureProgress)=>{if(mounted.current)setView(v=>updateCaptureView(v,s));};
  const onTrial=(trial:Trial,round:number)=>{if(mounted.current){setHistory(v=>[...v,{trial,round}]);setTrial(piAuto.hasTrial(app.motor));}};
  const [busy,setBusy]=useState(false),[running,setRunning]=useState(false),[trial,setTrial]=useState(false),[message,setMessage]=useState("");
  const [lowRpm,setLowRpm]=useState(500),[highRpm,setHighRpm]=useState(15000),[endpoint,setEndpoint]=useState<EndpointResult|null>(null);
  const [endpointRunning,setEndpointRunning]=useState(false);
  const mounted=useRef(true);
  const loopSettings=useRef<Partial<Record<Loop,{options:IdentificationOptions;bandwidthHz:number;amplitude:number}>>>({});
  const rememberLoop=()=>{loopSettings.current[loop]={options:{loop,amplitude:rawAmplitude(loop,amplitude),durationMs:Math.round(duration*1000),travelCounts:1,sampling,excitationSampling:excitation},bandwidthHz:bandwidth,amplitude};};
  const [resultLoop,setResultLoop]=useState<Loop>(1);
  const [results,setResults]=useState<{loop:Loop;p:number;i:number;improved:boolean}[]>([]);
  useEffect(()=>{setResults([]);setView(emptyCaptureView());setHistory([]);setCandidate(null);setEndpoint(null);setTrial(piAuto.hasTrial(app.motor));setMessage("");},[app.motor]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;void piAuto.cancel().catch(()=>{});};},[]);
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage("");try{await fn();}catch(e){if(mounted.current)setMessage(String(e));app.toast("error",String(e));}finally{if(mounted.current){setTrial(piAuto.hasTrial(app.motor));setBusy(false);setRunning(false);}}};
  const autoStart=()=>void run(async()=>{
    if(app.mode==='direct')throw Error('自动整定需要通过主控485或CAN连接');
    setRunning(true);setCandidate(null);setHistory([]);setView(v=>({...v,progress:null}));setResults([]);
    const raw=rawAmplitude(loop,amplitude);
    const result=await piAuto.automatic(app.motor,{loop,amplitude:raw,durationMs:Math.round(duration*1000),travelCounts:1,sampling,excitationSampling:excitation,travelPercentRange:selectedRange},bandwidth,shared,progress,text=>{if(mounted.current)setMessage(text);},onTrial);
    if(!mounted.current)return;
    setCapture(result.best.capture);setCandidate(result.candidate);setTrial(piAuto.hasTrial(app.motor));
    setResultLoop(loop);setResults([{loop,p:result.best.p,i:result.best.i,improved:result.improved}]);
    const actual=piAuto.trialValues(app.motor);if(actual)draft.setPid(old=>mergePiTuning(old,actual));
    setMessage(result.improved?`自动整定完成，共 ${result.trials.length} 轮；P=${result.best.p} I=${result.best.i} 已在 TMC 试用并回读，未保存 W25。可继续整定外环，验证低、高速表现后保存。`:'重复测试没有确认改善，已恢复本轮开始时的 PI；此前试用参数与 W25 保持不变。');
  });
  const displayLoop=(v:Loop)=>{const p=identificationPreset(v),saved=loopSettings.current[v];setLoop(v);setAmplitude(saved?.amplitude??p.amplitude);setSampling(saved?.options.sampling??p.sampling);setExcitation(saved?.options.excitationSampling??p.excitationSampling);setDuration((saved?.options.durationMs??p.durationMs)/1000);setBandwidth(saved?.bandwidthHz??p.bandwidthHz);};
  const changeLoop=(v:Loop)=>{rememberLoop();displayLoop(v);};
  const sequenceStart=()=>void run(async()=>{
    if(app.mode==='direct')throw Error('三环整定需要通过主控485或CAN连接');
    setRunning(true);setCandidate(null);setHistory([]);setView(v=>({...v,progress:null}));setResults([]);
    rememberLoop();
    const results=await piAuto.sequence(app.motor,shared,progress,text=>{if(mounted.current)setMessage(text);},v=>{if(mounted.current)displayLoop(v);},onTrial,selectedRange,{...loopSettings.current},(result,currentLoop)=>{
      if(!mounted.current)return;
      setResultLoop(currentLoop);setResults(v=>[...v,{loop:currentLoop,p:result.best.p,i:result.best.i,improved:result.improved}]);
      setCapture(result.best.capture);setCandidate(result.candidate);setTrial(piAuto.hasTrial(app.motor));
      const actual=piAuto.trialValues(app.motor);if(actual)draft.setPid(old=>mergePiTuning(old,actual));
    });
    if(!mounted.current)return;
    setResults(results.map((r,i)=>({loop:(i+1) as Loop,p:r.best.p,i:r.best.i,improved:r.improved})));
    const last=results[results.length-1];setCapture(last.best.capture);setCandidate(last.candidate);
    const actual=piAuto.trialValues(app.motor);if(actual)draft.setPid(old=>mergePiTuning(old,actual));
    setMessage('三环流程完成：'+results.map((r,i)=>`${names[i+1]} ${r.best.p}/${r.best.i}（${r.improved?'确认改善':'保留起始参数'}）`).join('；')+'。TMC已回读，W25未保存；可继续执行低、高速末段优化。');
  });
  const currentSampling=running?view.progress?.capture.sampleHz:capture?.sampleHz;
  const selected=capture?.loop??loop;
  const points=capture?.samples??[];
  const response=useMemo(()=>{try{return capture?.state===2?spectrum(capture):null;}catch{return null;}},[capture]);
  return <div className="pi-auto stack pi-merged-ident">
    <div className="pi-merged-section-title">参数整定</div>
    <div className="grid split-2-1 pi-ident-result-row">
      <Card className="pi-ident-card" title="系统辨识" right={<Badge>TMC PRBS</Badge>}>
        <div className="stack"><div className="pi-ident-status" aria-live="polite">
  <div><span className="tiny muted">整定状态</span><strong>{running?(endpointRunning?"正在末段优化":view.progress?.phase==='downloading'?"正在读取采样":"正在辨识"):capture?states[capture.state]:"待开始"}</strong></div>
  <div><span className="tiny muted">实际采样率</span><strong>{currentSampling?`${currentSampling.toFixed(2)} Hz`:"—"}</strong></div>
  <div><span className="tiny muted">参数状态</span><strong>{running?"整定中 · W25未保存":trial?"TMC试用 · 未保存":"原配置保持"}</strong></div>
</div>
          <Field label="辨识对象" hint="芯片内部激励"><SelectField value={loop} onChange={v=>changeLoop(Number(v) as Loop)} options={names.map((label,value)=>({label,value}))} disabled={busy} width="100%"/></Field>
          <div className="pi-auto-fields">
            <Field label="激励幅值" hint={loop<2?"mA":loop===2?"rpm":"电机端 °"}><NumField value={amplitude} onChange={setAmplitude} min={1} disabled={busy} width="100%"/></Field>
            <Field label="采集时长" hint="秒"><NumField value={duration} onChange={setDuration} min={1} max={7} disabled={busy} width="100%"/></Field>
            <Field label="整定行程范围" hint="全行程百分比"><SelectField value={range} onChange={setRange} options={[{value:"20-80",label:"20%–80%"},{value:"30-70",label:"30%–70%"},{value:"40-60",label:"40%–60%"}]} disabled={busy} width="100%"/></Field>
            <Field label="期望闭环带宽" hint="响应速度目标 · Hz"><NumField value={bandwidth} onChange={v=>{setBandwidth(v);setCandidate(null);}} min={.1} step={.1} disabled={busy} width="100%"/></Field>
          </div>
          <details><summary className="tiny muted">采集与激励时钟</summary><div className="pi-auto-fields" style={{marginTop:12}}>
            <Field label="RTMI 采样分频" hint="PWM / (N+1)"><NumField value={sampling} onChange={setSampling} min={0} max={255} disabled={busy} width="100%"/></Field>
            <Field label="PRBS 激励分频" hint="PWM / (N+1)"><NumField value={excitation} onChange={setExcitation} min={0} max={255} disabled={busy} width="100%"/></Field>
          </div></details>
          <Check checked={shared} onChange={v=>{if(!busy)setShared(v);}}>电流环 Id / Iq 使用同一份 PI 参数</Check>
          <div className="row-wrap">
            <Button variant="primary" disabled={!app.connected||busy} onClick={autoStart} icon={<Icon.Sequence/>}>单环整定</Button>
            <Button disabled={!app.connected||busy} onClick={sequenceStart}>三环整定</Button>
            <Button variant="danger" disabled={!running} onClick={()=>void piAuto.cancel().catch(e=>setMessage(String(e)))} icon={<Icon.Stop/>}>停止</Button>
          </div>
        </div>
      </Card>
    <Card title="整定结果" right={<Badge>自动试用并回读 → 保存</Badge>}>
      <div className="pi-auto-result">
        <div><span className="tiny muted">{names[resultLoop]} P</span><strong>{candidate?.p??"—"}</strong></div>
        <div><span className="tiny muted">{names[resultLoop]} I</span><strong>{candidate?.i??"—"}</strong></div>
        <div><span className="tiny muted">频域相干度</span><strong>{candidate?`${(candidate.model.validationFit*100).toFixed(1)}%`:"—"}</strong></div>
        <div><span className="tiny muted">整定行程范围</span><strong>{`${selectedRange[0]}%–${selectedRange[1]}%`}</strong></div>
      </div>
      {results.length>0&&<table className="table" style={{width:"100%",marginTop:16}}><thead><tr><th>控制环</th><th>P</th><th>I</th><th>结果</th></tr></thead><tbody>{results.map(r=><tr key={r.loop}><td>{names[r.loop]}</td><td>{r.p}</td><td>{r.i}</td><td>{r.improved?'已改善并应用':'保留起始参数'}</td></tr>)}</tbody></table>}
      <div className="row-wrap" style={{marginTop:16}}>
        <Button variant="primary" disabled={busy||!candidate||!app.connected} onClick={()=>void run(async()=>{
          const p=await piAuto.tryResult(app.motor,resultLoop,candidate!.p,candidate!.i,shared,draft.pid);draft.setPid(old=>mergePiTuning(old,p));
          setMessage('本环 PI 已临时写入 TMC 并回读；积分器保持，未保存 W25。');
        })}>试用</Button>
        <Button disabled={busy||!trial||!app.connected} onClick={()=>void run(async()=>{const saved=piAuto.trialValues(app.motor);await piAuto.save(app.motor);if(saved)draft.setPid(old=>mergePiTuning(old,saved));setTrial(false);setMessage("TMC回读通过，已保存到本电机W25档案。");})} icon={<Icon.Save/>}>保存到电机档案</Button>
        <Button variant="ghost" disabled={busy||!trial||!app.connected} onClick={()=>void run(async()=>{await piAuto.restore(app.motor);setTrial(false);setMessage("原PI已恢复并回读，W25保持。");})}>恢复原PI</Button>
      </div>
      <div className="pi-auto-message" role="status" aria-live="polite">{message||"整定完成后自动应用较优参数；P、I 与 PID 与限幅页输入值一致。"}</div>
    </Card>
    </div>
    <div className="pi-ident-response-row">
      <Card title="辨识响应" right={<Badge>{capture?.state===3?'停止现场 · ':''}{points.length} / {capture?.count??0} 组</Badge>}>
        <div className="pi-auto-message" role="status" aria-live="polite">{message||'自动整定包含多轮候选比较与重复验证，每轮结果会保留。'}</div>
        {running&&view.progress&&<div className="tiny muted">{view.progress.phase==='downloading'?`读取采样 ${view.progress.received} / ${view.progress.capture.count} 组` : view.progress.phase==='capturing'?`采集中 · ${view.progress.capture.sampleHz.toFixed(2)} Hz`:'本轮已完成'}{capture&&view.progress.phase!=='complete'?'；下方保留上一轮完整波形':''}</div>}
        {points.length&&capture?<IdentificationWaveform capture={capture}/>:<div className="pi-auto-wave"><div className="pi-auto-empty"><Icon.Gauge width={32} height={32}/><span>完成采集后显示实际响应</span><span className="tiny muted">可选择时间窗口并移动查看原始波形</span></div></div>}
        <div className="row-wrap tiny"><span style={{color:"var(--warn)"}}>-- PRBS参考</span><span style={{color:"var(--accent)"}}>— 实际反馈</span><span className="muted">{names[selected]}</span></div>
        {capture?.appliedAmplitude!==undefined&&<div className="tiny muted">本轮实际激励：{amplitudeText(capture.loop,capture.appliedAmplitude)} · TMC {capture.loop===0?'Id':'Iq'}上限：{amplitudeText(1,capture.loop===0?capture.currentLimits&32767:capture.currentLimits>>>16&32767)}{capture.state===3?' · 中止数据仅用于排障，不能作为完整辨识结果':''}</div>}
        {capture?.diagnostic&&<div className="tiny muted">{diagnosticText(capture)}</div>}
        <KV rows={[["电流 / 速度 / 位置环执行频率",capture?`${capture.pwmHz} / ${capture.velocityHz} / ${(capture.velocityHz/(((capture.pidConfig>>>16)&127)+1)).toFixed(0)} Hz`:"—"],["参考/反馈相干度",response?`${(response.coherence*100).toFixed(1)}%`:"—"],["实测闭环 -3dB 带宽",response?.bandwidthHz?`${response.bandwidthHz.toFixed(1)} Hz`:"尚未可靠测出"],["UART新增事件",capture?`0x${capture.events.toString(16).toUpperCase()}`:"—"]]}/>
        <div className="tiny muted">执行频率表示控制器多久运算一次；闭环带宽表示能跟踪多快的变化，两者不是同一个数值。2431 的 R/L 可作校核，不能用相间参数直接代替 d/q 模型。</div>
      </Card>
    </div>
    {history.length>0&&<Card title="已完成轮次" right={<Badge>{history.length} 轮 · 点击查看波形</Badge>}>
      <div style={{maxHeight:260,overflow:'auto'}}><table className="table" style={{width:'100%',textAlign:'left'}}><thead><tr><th>环 / 轮次</th><th>P / I</th><th>评分（低为优）</th><th title="反馈绝对峰值 ÷ PRBS参考幅值，无单位">响应峰值 / 激励幅值</th><th>波形</th></tr></thead><tbody>{history.map(({trial:t,round},i)=><tr key={i}><td>{names[t.capture.loop]} / {round}</td><td>{t.p} / {t.i}</td><td>{t.score.toFixed(4)}</td><td>{t.peak.toFixed(2)}</td><td><Button disabled={busy} onClick={()=>{setCapture(t.capture);}}>查看</Button></td></tr>)}</tbody></table></div>
      <div className="tiny muted">每轮候选写入TMC后采集，评分不达标仍保留数据。历史波形不代表当前硬件参数，试用时会核对实际PI。</div>
    </Card>}

    <Card title="位置直通末段优化" right={<Badge>低 / 中 / 高速对照</Badge>}>
      <div className="stack">
        <div className="tiny muted">在40% → 60% → 50%行程往复，比较低、中、高速的超调与回拉，在本批最佳组合上继续优化速度环与位置环P/I。结果仅试用，不保存W25。</div>
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
            setEndpoint(result);const p=piAuto.trialValues(app.motor);if(p)draft.setPid(old=>mergePiTuning(old,p));
            setMessage(result.improved?'末段优化完成，本批最佳组合已在TMC试用并回读；W25未保存。':'本批未找到更优组合，保留原PI；W25未改变。');
          })}>开始末段优化</Button>
          <Button variant="danger" disabled={!running} onClick={()=>void piAuto.cancel().catch(e=>setMessage(String(e)))}>停止</Button>
        </div>
        {endpoint&&<KV rows={[["原组合 / 候选评分",`${endpoint.baseline.score.toFixed(3)} / ${endpoint.best.score.toFixed(3)}`],["速度环 P / I",`${endpoint.best.coefficients[2]>>>16} / ${endpoint.best.coefficients[2]&65535}`],["位置环 P / I",`${endpoint.best.coefficients[3]>>>16} / ${endpoint.best.coefficients[3]&65535}`],["最大采样速度",`${Math.max(...endpoint.best.moves.map(m=>m.peakRpm)).toFixed(0)} rpm`],["最大位置超调",`${Math.max(...endpoint.best.moves.map(m=>m.overshootPercent)).toFixed(4)}% 全行程`]]}/>}
        {endpoint&&<KV rows={[["最大反向回拉",`${Math.max(...endpoint.best.moves.map(m=>m.reversePercent??0)).toFixed(4)}% 全行程`]]}/>}
        <div className="tiny muted">评分同时考虑末10%及稳定时间、总耗时、速度峰值和位置超调；更快但超调明显的组合不会仅凭到位速度入选。末10%包含剩余行程的正常运行时间，低速数值大不等于减速拖尾。采样峰值不等于连续时间最大值。结束后PWM关闭，恢复原模式和档案任务转速。</div>
      </div>
    </Card>
  </div>;
}
