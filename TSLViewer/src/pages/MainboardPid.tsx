import { useState } from "react";
import { useApp } from "../lib/app-store";
import { useMotorConfiguration } from "../lib/motor-configuration";
import { readMotorProfile, pidFromProfile, applyMotorPi, tuneMotorPi } from "../lib/motor-profile-ui";
import { Button, Card, Field, NumField, SelectField, Badge, KV, Icon } from "../components/ui";
import { coefToGain, pFrac, iFrac, composePidConfig, CUR_NORM_LABELS, NORM_P_LABELS, NORM_I_LABELS } from "../lib/units";
import type { PidCfgPayload } from "../lib/types";

export default function MainboardPid() {
  const app=useApp(), draft=useMotorConfiguration(app.motor), p=draft.pid;
  const [busy,setBusy]=useState(false), [note,setNote]=useState("");
  const set=(key:keyof PidCfgPayload,v:number)=>{draft.setPid(old=>({...old,[key]:v}));};
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setNote("");try{await fn();}catch(e){setNote(String(e));}finally{setBusy(false);}};
  const liveButton=(group:0|1|2)=><div style={{display:"flex",justifyContent:"flex-end",marginTop:"auto",paddingTop:10}}><Button size="sm" disabled={!app.connected||busy} onClick={()=>void run(async()=>{setNote(await tuneMotorPi(app.motor,group,p));})}>写入</Button></div>;
  const numeric=(key:keyof PidCfgPayload,label:string)=><Field label={label} style={{flex:1}}><NumField value={p[key] as number} onChange={v=>set(key,v)} min={0} max={32767} disabled={busy} width="100%"/></Field>;
  const norm=(key:keyof PidCfgPayload,label:string,labels:string[])=><Field label={label}><SelectField value={p[key] as number} onChange={v=>set(key,Number(v))} options={labels.map((label,value)=>({label,value}))} width="100%" disabled={busy}/></Field>;
  const gain=(pk:keyof PidCfgPayload,ik:keyof PidCfgPayload,np:keyof PidCfgPayload,ni:keyof PidCfgPayload,current=false)=><span className="pid-gain">Kp={coefToGain(p[pk] as number,pFrac(p[np] as number)).toFixed(4)} · Ki={coefToGain(p[ik] as number,iFrac(p[ni] as number,current)).toFixed(4)}</span>;
  return <div className="grid split-2-1 pi-merged-parameters">
    <Card title="PI 参数" right={<div className="row-wrap pid-toolbar pi-merged-toolbar"><Badge>PID_CONFIG 0x{composePidConfig(p).toString(16).toUpperCase().padStart(8,"0")}</Badge>
      <Button size="sm" variant="ghost" disabled={!app.connected||busy} onClick={()=>void run(async()=>{const r=await readMotorProfile(app.motor);draft.setPid(pidFromProfile(r.data));setNote(`M${app.motor} W25 已读回 · 代数 ${r.generation}`);})}>读取本电机档案</Button>
      <Button size="sm" variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={!app.connected||busy} onClick={()=>{
        if(!window.confirm("确认停止运行并禁能后，将当前 PI 配置写入 TMC / W25 并回读？不会自动启动运动。"))return;
        void run(async()=>{const r=await applyMotorPi(app.motor,p);setNote(`M${app.motor} W25 与 TMC 应用并回读完成 · 代数 ${r.generation}`);});
      }}>{busy?"正在写入并回读…":"写入配置"}</Button></div>}>
      <div className="stack" style={{gap:12}}><div className="pid-grid">
        <div className="pid-col accent"><div className="pid-head">电流环 · 力矩 / 磁链<span className="pid-gain">0x142 / 0x143</span></div>
          <div className="row" style={{gap:6}}>{numeric("torque_p","Iq P · 0x143")}{numeric("torque_i","Iq I · 0x143")}</div>
          <div className="row" style={{gap:6}}>{numeric("flux_p","Id P · 0x142")}{numeric("flux_i","Id I · 0x142")}</div>
          {norm("cur_norm_p","P 归一化",CUR_NORM_LABELS)}{norm("cur_norm_i","I 归一化",CUR_NORM_LABELS)}
          {gain("torque_p","torque_i","cur_norm_p","cur_norm_i",true)}{gain("flux_p","flux_i","cur_norm_p","cur_norm_i",true)}
          {liveButton(0)}
        </div>
        <div className="pid-col"><div className="pid-head">速度环<span className="pid-gain">0x145</span></div>
          <div className="row" style={{gap:6}}>{numeric("vel_p","P")}{numeric("vel_i","I")}</div>
          {norm("vel_norm_p","P 归一化",NORM_P_LABELS)}{norm("vel_norm_i","I 归一化",NORM_I_LABELS)}{gain("vel_p","vel_i","vel_norm_p","vel_norm_i")}
          {liveButton(1)}
        </div>
        <div className="pid-col"><div className="pid-head">位置环<span className="pid-gain">0x146</span></div>
          <div className="row" style={{gap:6}}>{numeric("pos_p","P")}{numeric("pos_i","I")}</div>
          {norm("pos_norm_p","P 归一化",NORM_P_LABELS)}{norm("pos_norm_i","I 归一化",NORM_I_LABELS)}{gain("pos_p","pos_i","pos_norm_p","pos_norm_i")}
          {liveButton(2)}
        </div>
      </div>
      <div className="grid cols-4" style={{gap:10}}>
        <Field label="速度输出右移" hint="0x140[15:12]"><NumField value={p.vel_shift} onChange={v=>set("vel_shift",v)} min={0} max={15}/></Field>
        <Field label="位置降采样" hint="0x140[22:16]"><NumField value={p.pos_sampling} onChange={v=>set("pos_sampling",v)} min={0} max={127}/></Field>
        <Field label="平滑切换" hint="OVERWRITE_TARGET · 0x140[1]"><SelectField value={p.overwrite_target?"1":"0"} onChange={v=>{draft.setPid(old=>({...old,overwrite_target:v==="1"}));}} disabled={busy} options={[{value:"0",label:"关闭"},{value:"1",label:"开启"}]}/></Field>
        <Field label="写实际位置不改目标" hint="KEEP_POS_TARGET · 0x140[0]"><SelectField value={p.keep_pos_target?"1":"0"} onChange={v=>{draft.setPid(old=>({...old,keep_pos_target:v==="1"}));}} disabled={busy} options={[{value:"0",label:"关闭"},{value:"1",label:"开启"}]}/></Field>
      </div>
      <div className="tiny muted" role="status" aria-live="polite">{note}</div></div>
    </Card>
    <div className="col-stack"><Card title="单位换算"><KV rows={[["PWM 频率","25.00 kHz"],["电流分辨率","0.20131 mA/LSB"],["4× 满量程","8192 LSB = 1.65 A"],["速度换算","305.4 LSB/RPM"],["位置换算","65536 LSB / 圈"],["调制满幅","18900 = 100%"]]}/></Card>
      <div id="pi-endpoint-slot" className="pi-endpoint-slot" aria-label="位置直通末段优化"/>
    </div>
  </div>;
}
