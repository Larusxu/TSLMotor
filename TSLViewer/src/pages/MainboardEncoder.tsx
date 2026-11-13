import {useEffect,useRef,useState} from "react";
import {useSharedEncoder,ensureSharedDefaults,readSharedDefaults,saveSharedDefaults} from "../lib/shared-settings";
import {useApp} from "../lib/app-store";
import {readMotorProfile} from "../lib/motor-profile-ui";
import {storageJob} from "../lib/split-storage";
import {semanticMotion} from "../lib/semantic-motion";
import {semanticFresh,readEncoderSnapshot} from "../lib/semantic-state";
import {Badge,Button,Card,Field,NumField,Steps,Icon,SelectField,HexField,KV} from "../components/ui";
import {ENCODER_PRESETS,STORAGE_PRESETS,TESLA_PROFILE} from "../lib/presets";
import {hex,spiHalfPeriod,spiHzFromHalf,ssiFrameSeconds} from "../lib/units";
import {encoderView,encoderCheck} from "../lib/encoder-view";
import Gauge from "../components/EncoderGauge";
import {AlignmentPanels} from "./Align";
import {useAlignmentView} from "../lib/alignment-view";

export default function MainboardEncoder(){
 const app=useApp(),s=semanticFresh(app.semantic)&&app.semantic.motor===app.motor?app.semantic.state:null;
 const [busy,setBusy]=useState(false),[note,setNote]=useState("");
 const alignment=useAlignmentView(app.motor,app.cal.poles),alignmentSteps=alignment.steps;
 const [image,setImage]=useState<number[]|null>(null),[common,setCommon]=useState<number[]|null>(null);
 const [actual,setActual]=useState<number[]|null>(null),[live,setLive]=useState(false);
 const [cfg,setCfg]=useSharedEncoder(app.motor);
 const [storage,setStorage]=useState("m24c02");
 const edited=useRef(false);
 const edit=(key:keyof typeof cfg,v:number|null)=>{edited.current=true;setCfg(c=>({...c,[key]:v}));};
 const pending=useRef(false),epoch=useRef(0),autoRead=useRef("");
 useEffect(()=>{epoch.current++;autoRead.current="";edited.current=false;setImage(null);setCommon(null);setActual(null);setNote("");setLive(false);setBusy(false);},[app.motor,app.connected,app.semantic.bootId]);
 const run=async(fn:()=>Promise<void>)=>{const at=epoch.current;setBusy(true);setNote("");try{await fn();}catch(e){if(at===epoch.current)setNote(String(e));}finally{if(at===epoch.current)setBusy(false);}};
 const readActual=async()=>{const at=epoch.current,r=await readEncoderSnapshot(app.motor);if(at===epoch.current&&r.boot_id===app.semantic.bootId)setActual(r.encoder?.[1]?r.encoder:null);};
 const read=async(explicit=true)=>{
   const at=epoch.current;
   if(explicit)await readSharedDefaults();else await ensureSharedDefaults();
   const c=await storageJob(0,1);if(at!==epoch.current)return;setCommon(c.data);
   const m=await readMotorProfile(app.motor);if(at!==epoch.current)return;
   setImage(m.data);if(!edited.current)setCfg(c=>({...c,offset:encoderView(null,m.data).offset}));app.setCal({poles:cfg.poles,cpr:cfg.cpr,pwmMaxCount:cfg.pwm,csaGain:cfg.csa});await readActual();
 };
 useEffect(()=>{
   if(!app.connected||!s||!s.config_verified||s.motion_active||busy||alignment.busy)return;
   const key=`${app.motor}:${app.semantic.bootId}`;if(autoRead.current===key)return;
   autoRead.current=key;void run(()=>read(false));
 },[app.connected,app.motor,app.semantic.bootId,s?.config_verified,s?.drive,s?.motion_active,alignment.busy]);
 useEffect(()=>{if(!s?.config_verified)setActual(null);},[s?.config_verified]);
 useEffect(()=>{
   if(!live||!app.connected)return;let alive=true;
   const tick=async()=>{if(pending.current||busy)return;pending.current=true;
     try{const r=await readEncoderSnapshot(app.motor);if(alive)setActual(r.boot_id===app.semantic.bootId&&r.encoder?.[1]?r.encoder:null);}
     catch{if(alive)setActual(null);}finally{pending.current=false;}};
   void tick();const timer=setInterval(()=>void tick(),260);return()=>{alive=false;clearInterval(timer);};
 },[live,app.connected,app.motor,busy,app.semantic.bootId]);
 const offset=cfg.offset;
 const angleActual=live?actual:null;
 const half=spiHalfPeriod(cfg.spiHz),actualSck=spiHzFromHalf(half);
 const frameHz=1/Math.max(1e-9,ssiFrameSeconds(cfg.frameBits,half,cfg.idle));
 const frameRateText=frameHz>=1e6?`${(frameHz/1e6).toFixed(2)} MHz`:`${(frameHz/1e3).toFixed(1)} kHz`;
 const value=(label:string,key:keyof typeof cfg,hint?:string)=><Field label={label} hint={hint}><NumField value={cfg[key]??""} onChange={v=>edit(key,v)} disabled={busy} placeholder="待对齐"/></Field>;
 const mask=cfg.frameBits===24?0xfffc00:0x3fff;
 const ioCommand=(0xf2000000|(cfg.spiMode<<26)|(cfg.idle<<16)|((0x80|(cfg.frameBits-1))<<8)|half)>>>0;
 const checks:[number,string,number|null,number,number][]=[
   [0x240,"CONF_CH_A",0x07000000|Math.floor(2**24/Math.max(1,cfg.cpr)),2,0x0fffffff],
   [0x250,"OUTPUT_CONF",cfg.poles,3,255],
   [0x242,"PHI_E_OFFSET",offset,4,65535],[0x0c3,"CSA_GAIN",cfg.csa,5,3],
   [0x103,"PWM_PERIOD (lo16)",cfg.pwm,6,65535],
   [0x381,"SSI 配置",ioCommand,12,0xffffffff],
   [0x383,"发送数据",cfg.send,13,0xffffffff],[0x384,"数据掩码",mask,14,0xffffffff],
 ];
 return <div className="grid" style={{gap:14}}>
   <div className="grid flow-2-1"><div className="col-stack">
     <Card title="编码器参数" sub="MT6701 · SSI" right={<Badge>{ENCODER_PRESETS[0].label}</Badge>}>
       <div className="stack" style={{gap:12}}>
         <div className="grid cols-2" style={{gap:10}}>
           <Field label="编码器" hint="SSI 预设"><SelectField value={cfg.frameBits===24?"mt6701-24":"mt6701-14"} onChange={id=>{const p=ENCODER_PRESETS.find(p=>p.id===id)!;edited.current=true;setCfg(c=>({...c,frameBits:p.frameBits,spiMode:p.spiMode,spiHz:p.spiHz,idle:p.idleCycles,cpr:p.cpr,send:parseInt(p.sendData)}));}} options={ENCODER_PRESETS.map(p=>({value:p.id,label:p.label}))}/></Field>
           <Field label="板上存储" hint={STORAGE_PRESETS[0].spec}><SelectField value={storage} onChange={setStorage} options={STORAGE_PRESETS.map(p=>({value:p.id,label:p.label}))}/></Field>
         </div>
         <div className="grid cols-4" style={{gap:10}}>{value("极对数","poles","PHI_E_MUL_FACTOR")}{value("编码器步数 CPR","cpr","CPR_INV = 2²⁴ / CPR")}{value("电角度偏置","offset","0x242 · 十进制")}
           <Field label="写入已知偏移" hint="偏移来源"><SelectField value={offset===null?"pending":"archive"} onChange={v=>edit("offset",v==="pending"?null:encoderView(common,image).offset??0)} options={[{value:"pending",label:"初次电角度偏置标定"},{value:"archive",label:"W25 / M24 校准备份"}]}/></Field></div>
         <div className="grid cols-4" style={{gap:10}}>
           <Field label="帧长度" hint="SPI_BIT_CNT"><SelectField value={cfg.frameBits} onChange={v=>edit("frameBits",v)} options={[{value:14,label:"14 bit · 角度"},{value:24,label:"24 bit · 全帧"}]}/></Field>
           <Field label="SPI 模式" hint="CPOL/CPHA"><SelectField value={cfg.spiMode} onChange={v=>edit("spiMode",v)} options={[0,1,2,3].map(v=>({value:v,label:`模式 ${v}`}))}/></Field>
           {value("SCK 频率","spiHz",`half=${half} → ${(actualSck/1e6).toFixed(2)} MHz`)}{value("CSN 高电平","idle",`≈${frameRateText} 读取率`)}
         </div>
         <div className="grid cols-4" style={{gap:10}}><Field label="数据掩码" hint="RESPONSE_2 · 随帧长度"><HexField value={mask} disabled/></Field><Field label="发送数据" hint="RESPONSE_1"><HexField value={cfg.send} onChange={v=>edit("send",v)}/></Field>
           {value("PWM MAX_COUNT","pwm","fPWM = 120 MHz / n")}<Field label="CSA 增益" hint={`0=1x · 3=4x · ${TESLA_PROFILE.maPerCount.toFixed(3)} mA/LSB`}><SelectField value={cfg.csa} onChange={v=>edit("csa",v)} options={[{value:0,label:"1× · 6.60 A"},{value:1,label:"2× · 3.30 A"},{value:2,label:"3× · 2.20 A"},{value:3,label:"4× · 1.65 A"}]}/></Field></div>
         <div className="encoder-config-footer"><div className="tiny muted">{common&&image?`M${app.motor} · 已读取 W25 档案`:"显示默认预设，尚未读取当前电机档案"}。写入应用到当前 TMC，回读只校验，不覆盖输入。</div>
         <div className="row"><Button size="sm" variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={busy||!app.connected||!!s?.motion_active||!!s?.fault} onClick={()=>void run(async()=>{const at=epoch.current;
             await app.stopStream();
             const config=[cfg.cpr,cfg.poles,cfg.frameBits,cfg.spiMode,cfg.spiHz,cfg.idle,cfg.send,mask,cfg.pwm,cfg.csa,offset??0xffffffff];
             if(config.some(v=>!Number.isInteger(v)||v<0||v>0xffffffff))throw Error("编码器配置必须为非负整数");
             await semanticMotion.stop(app.motor,true);
             await semanticMotion.wait(app.motor,15000,r=>r.motor?.drive===0);
             await semanticMotion.command(app.motor,{kind:"encoder_config",config});
             await semanticMotion.wait(app.motor,15000,r=>!!r.motor?.config_verified);
             app.setCal({poles:cfg.poles,cpr:cfg.cpr,pwmMaxCount:cfg.pwm,csaGain:cfg.csa});
             const reply=await readEncoderSnapshot(app.motor);
             if(at!==epoch.current)return;
             if(reply.boot_id!==app.semantic.bootId||!reply.encoder?.[1])throw Error("编码器独立读回无效");
             setActual(reply.encoder);
             const differences=checks.filter(([, ,want,index,mask])=>want!==null&&encoderCheck(want,reply.encoder![index],mask).text!=="OK");
             if(differences.length)throw Error(`写入校验不一致：${differences.map(x=>x[1]).join("、")}；输入显示保留`);
             await saveSharedDefaults();
             setNote("OK · 编码器已写入 TMC，当前档案及公共 Flash 配置已保存；输入保持不变。");})}>应用</Button>
           <Button size="sm" variant="ghost" disabled={busy||!app.connected||!!s?.motion_active} onClick={()=>void run(readActual)}>读取</Button></div></div>
         <div className="tiny muted" role="status">{busy?"正在配置与回读…":note}</div>
       </div>
     </Card>
   </div><div className="col-stack">
     <Card title="写入校验"><div className="table-scroll"><table className="table"><thead><tr><th>寄存器</th><th>期望</th><th>校验</th></tr></thead><tbody>
       {checks.map(([addr,name,want,index,mask])=>{const got=actual?actual[index]:null,status=encoderCheck(want,got,mask);return <tr key={addr}><td className="mono">{hex(addr,3)} <span className="muted tiny">{name}</span></td><td className="mono">{want===null?"—":hex(want)}</td><td><Badge tone={status.tone}>{status.text}</Badge></td></tr>;})}
     </tbody></table></div></Card>
   </div></div>
   <AlignmentPanels onCompleted={()=>read()}/>
   <div className="grid flow-2-1 encoder-monitor-row">
     <div className="col-stack">
     <Card title="配置流程" className="encoder-process-card" sub="WRITE · ALIGN" right={<Badge>{busy||s?.drive===1?"执行中":"空闲"}</Badge>}>
       <div className="grid cols-2 encoder-process-grid" style={{gap:12}}><div className="encoder-process-column"><div className="stat-label">编码器写入</div><Steps steps={app.stepsByKind.encoder??[]} height={232}/></div>
       <div className="encoder-process-column"><div className="stat-label">电角度对齐</div><Steps steps={alignmentSteps.length ? alignmentSteps : app.stepsByKind.calibrate??[]} height={232}/></div></div>
     </Card>
     </div>
     <div className="col-stack">
     <Card title="角度回读" sub="FEEDBACK · LIVE" right={<Button size="sm" variant={live?"danger":"primary"} disabled={!app.connected} title={live?"当前：开启（正在连续回读）· 点击关闭":"当前：关闭 · 点击开启连续回读"} onClick={()=>setLive(v=>!v)}>{live?"关闭":"开启"}</Button>}>
       <div className="grid cols-2" style={{gap:8}}><div style={{display:"flex",justifyContent:"center"}}><Gauge angle={((angleActual?.[9]??0)&16383)*360/16384} label="MECHANICAL" sub={`PHI_EXT_A = ${hex(angleActual?.[9]??0,6)}`}/></div><div style={{display:"flex",justifyContent:"center"}}><Gauge angle={((angleActual?.[11]??0)&65535)*360/65536} label="ELECTRICAL" sub={`PHI_E = ${(angleActual?.[11]??0)&65535}`}/></div></div>
       <div className="divider"/><KV rows={[
         ["PHI_EXT_A 原始",<span key="a" className="mono">{hex(angleActual?.[9]??0,6)}</span>],
         ["缩放后 16-bit",<span key="b" className="mono">{(angleActual?.[10]??0)&65535}</span>],
         ["电角度 16-bit",<span key="c" className="mono">{(angleActual?.[11]??0)&65535}</span>],
         ["CPR_INV",<span key="d" className="mono">{Math.floor(2**24/Math.max(1,cfg.cpr))}</span>],
         ["PHI_E_MUL_FACTOR",<span key="e" className="mono">{(angleActual?.[3]??0)&255}</span>],
       ]}/><div className="tiny muted" style={{marginTop:8}}>{live?"实时角度采集中":"尚未开启实时角度；写入校验不显示回读数值"}</div>
     </Card>
     </div>
   </div>
 </div>;
}
