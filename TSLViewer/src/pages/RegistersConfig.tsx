import ControllerRegisters from "./ControllerRegisters";
import {useArrivalTolerance,readMotionTravel,saveArrivalTolerance} from "../lib/motion-travel";
import HomePolicy from "./HomePolicy";
import {applyDefaultBatch,type DefaultGroup} from "../lib/default-batch";
import {HOME_CONFIG_FIELDS} from "../lib/home-config";
import MotorArchives from "./MotorArchives";
import CylinderConfig from "./CylinderConfig";
import type {CylinderModel} from "../lib/cylinder";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {useApp} from "../lib/app-store";
import {Badge,Button,Card,NumField,SelectField,Icon} from "../components/ui";
import {useSharedDefaults,useSharedHome,ensureSharedDefaults,readSharedDefaults,saveSharedDefaults,readSharedHome,writeSharedHome,editDefaults} from "../lib/shared-settings";
import {word,putWord,MA_PER_RAW,COUNTS_PER_RPM} from "../lib/motor-profile-ui";

type Category="registers"|"encoder"|"motion"|"pi"|"cylinders"|"archives";
type Row={name:string;unit?:string;value:ReactNode;description:string};
type Spec={name:string;off:number;unit?:string;reg:string;description:string;shift?:number;mask?:number;scale?:number;min?:number;max?:number;choices?:{value:number;label:string}[];mirror?:number};
const categories:[Category,string,string][]=[["registers","寄存器","主控状态与有效控制值"],["encoder","编码器与找零","公共 Flash 配置"],["motion","TMC 运动","公共运动保护"],["pi","电机初始配置","空白电机与批量初始化"],["cylinders","电缸","五路电缸配置"],["archives","电机档案","M1–M16 · W25"]];
const encoderFields:Spec[]=[
 {name:"极对数",off:80,mask:65535,reg:"0x250 · OUTPUT_CONF",description:"机械角度到电角度的倍率",min:1,max:127},
 {name:"编码器步数 CPR",off:56,reg:"0x240 · CONF_CH_A",description:"每机械圈计数，用于计算 CPR_INV",min:2,max:16777216},
 {name:"帧长度",off:76,mask:255,reg:"0x381 · IO_CONTROLLER_COMMAND",description:"SSI 角度帧长度（14 或 24 bit）",unit:"bit",choices:[{value:14,label:"14"},{value:24,label:"24"}]},
 {name:"SPI 模式",off:76,shift:8,mask:255,reg:"0x381 · IO_CONTROLLER_COMMAND",description:"SSI 时钟极性和采样相位",min:0,max:3},
 {name:"SCK 频率",off:60,unit:"Hz",reg:"0x381 · IO_CONTROLLER_COMMAND",description:"SSI 通信时钟频率",min:117188,max:2000000},
 {name:"CSN 高电平",off:76,shift:16,mask:255,reg:"0x381 · IO_CONTROLLER_COMMAND",description:"两帧之间的空闲时钟数",min:0,max:255},
 {name:"发送数据",off:68,reg:"0x383 · RESPONSE_1",description:"SSI 传输发送字",min:0,max:4294967295},
 {name:"数据掩码",off:72,reg:"0x384 · RESPONSE_2",description:"提取角度数据的掩码；随帧长度自动更新",min:0,max:4294967295},
 {name:"PWM MAX_COUNT",off:64,reg:"0x103 · PWM_PERIOD",description:"PWM 周期计数，决定功率级 PWM 频率",min:2400,max:12000},
 {name:"CSA 增益",off:76,shift:24,mask:255,reg:"0x0C3 · ADC_CSA_GAIN",description:"电流采样放大器增益档位 0～3",min:0,max:3},
];
const rampFields:Spec[]=[
 {name:"加速时间",off:92,unit:"ms",reg:"0x1C6 · RAMPER.A_MAX",description:"从静止加速至任务转速的时间",min:1,max:600000},
 {name:"减速时间",off:96,unit:"ms",reg:"0x1C9 · RAMPER.D_MAX",description:"从任务转速减速至静止的时间",min:1,max:600000},
 {name:"位置容差",off:100,unit:"±°",scale:360/65536,reg:"0x147 · PID_POSITION_TOLERANCE",description:"Ramp 位置终点的允许误差",min:0,max:360},
 {name:"容差延时",off:104,unit:"ms",scale:1/25,reg:"0x148 · PID_POSITION_TOLERANCE_DELAY",description:"终点容差的确认延时",min:0,max:2621.4},
];
function Table({title,tag,rows,actions,children}:{title:string;tag?:string;rows:Row[];actions?:ReactNode;children?:ReactNode}) {return <Card title={title} right={<div className="row">{tag&&<Badge>{tag}</Badge>}{actions}</div>}><div className="table-scroll"><table className="table config-table"><thead><tr><th>名称</th><th>值</th><th>单位</th><th>说明</th></tr></thead><tbody>{rows.map(r=><tr key={r.name}><td>{r.name}</td><td>{r.value}</td><td className="muted">{r.unit||"—"}</td><td className="muted">{r.description}</td></tr>)}</tbody></table></div>{children}</Card>;}
export default function RegistersConfig({cylinders}:{cylinders:CylinderModel}){
 const app=useApp(),defaults=useSharedDefaults(),home=useSharedHome();
 const arrivalTolerance=useArrivalTolerance(),[arrivalDraft,setArrivalDraft]=useState(arrivalTolerance);
 useEffect(()=>setArrivalDraft(arrivalTolerance),[arrivalTolerance]);
 const [category,setCategory]=useState<Category>("registers"),[busy,setBusy]=useState(false),[note,setNote]=useState("");
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const data=defaults.data;
 const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setNote("");try{await fn();if(alive.current)setNote("完成");}catch(e){if(alive.current){setNote(String(e));app.toast("error",String(e));}}finally{if(alive.current)setBusy(false);}};
 const read=async(explicit=true)=>{
  if(["registers","archives","cylinders"].includes(category))return;
  if(explicit)await readSharedDefaults(true);else await ensureSharedDefaults();
  if(category==="encoder"&&explicit)await readSharedHome(1,!!home.saved);
  if(category==="motion")await readMotionTravel();

 };
 useEffect(()=>{if(app.connected&&!["registers","archives","cylinders"].includes(category))void run(()=>read(false));},[app.connected,category]);
 const specs=(fields:Spec[]):Row[]=>!data?[]:fields.map(f=>{
  const shift=f.shift??0,mask=f.mask??0xffffffff,scale=f.scale??1;
  const value=((word(data,f.off)>>>shift)&mask)>>>0;
  const change=(v:number)=>editDefaults(p=>{
   const raw=Math.round(v/scale);putWord(p,f.off,((word(p,f.off)&~(mask<<shift))|((raw&mask)<<shift))>>>0);
   if(f.mirror!=null)putWord(p,f.mirror,word(p,f.off));
   if(f.off===76&&shift===0)putWord(p,72,raw===24?0xfffc00:16383);
  });
  return {name:f.name,unit:f.unit,description:`TMC ${f.reg} · ${f.description}`,value:f.choices?
   <SelectField value={value} options={f.choices} disabled={busy} onChange={v=>{change(v);void run(saveSharedDefaults);}}/>:
   <NumField aria-label={f.name} value={Number((value*scale).toFixed(f.unit==="±°"?2:0))} min={f.min} max={f.max} disabled={busy} clampOnCommit={false} onChange={change} onCommit={()=>void run(saveSharedDefaults)}/>};
 });
 const batchButtons=(group:DefaultGroup)=>category!=="pi"?undefined:<><Button size="sm" disabled={!app.connected||busy||!data} onClick={()=>void run(()=>applyDefaultBatch([...data!],group,false,setNote))}>临时写入TMC</Button><Button size="sm" disabled={!app.connected||busy||!data} onClick={()=>void run(()=>applyDefaultBatch([...data!],group,true,setNote))}>写入电机档案</Button></>;
 const write=async()=>{await saveSharedDefaults();if(category==="motion")await saveArrivalTolerance(arrivalDraft);};
 const piSpecs:Spec[]=[
  {name:"电流环 d/q · P",mirror:32,off:28,shift:16,mask:65535,reg:"0x142 · PID_FLUX_COEFF",description:"磁链电流环比例增益",min:0,max:32767},
  {name:"电流环 d/q · I",mirror:32,off:28,mask:65535,reg:"0x142 · PID_FLUX_COEFF",description:"磁链电流环积分增益",min:0,max:32767},
  {name:"速度环 · P",off:36,shift:16,mask:65535,reg:"0x145 · PID_VELOCITY_COEFF",description:"速度环比例增益",min:0,max:32767},
  {name:"速度环 · I",off:36,mask:65535,reg:"0x145 · PID_VELOCITY_COEFF",description:"速度环积分增益",min:0,max:32767},
  {name:"位置环 · P",off:40,shift:16,mask:65535,reg:"0x146 · PID_POSITION_COEFF",description:"位置环比例增益",min:0,max:32767},
  {name:"位置环 · I",off:40,mask:65535,reg:"0x146 · PID_POSITION_COEFF",description:"位置环积分增益",min:0,max:32767},
 ];
 
 return <div className="register-config-layout"><nav className="register-config-nav" aria-label="配置分类">{categories.map(([id,name,sub])=><button key={id} type="button" className={category===id?"active":""} aria-current={category===id?"page":undefined} disabled={busy} onClick={()=>setCategory(id)}><b>{name}</b><span>{sub}</span></button>)}</nav>
 <div className="register-config-content"><div className="register-config-actions"><div><b>{categories.find(c=>c[0]===category)![1]}</b><span className="tiny muted">{category==="registers"?"整机寄存器" :category==="pi"?"初始化默认值 · 不影响正在运行的电机":"整机配置"}</span></div><div className="row" style={{display:["registers","archives","cylinders"].includes(category)?"none":undefined}}><Button icon={<Icon.Save/>} variant="primary" disabled={!app.connected||busy||["registers","archives","cylinders"].includes(category)||!data} onClick={()=>void run(write)}>写入</Button><Button icon={<Icon.Refresh/>} disabled={!app.connected||busy} onClick={()=>void run(read)}>读取</Button></div></div>
 <div className="config-result" role="status" aria-live="polite">{busy?"正在读写…":note||(!app.connected?"连接主控后读取配置":"")}</div>
 {category==="registers"&&<ControllerRegisters/>}
 {category==="archives"&&<MotorArchives/>}
 {category==="cylinders"&&<CylinderConfig model={cylinders}/>}
 {!["registers","archives","cylinders"].includes(category)&&!data&&<Card title="尚未读取配置">连接主控后点击读取。</Card>}
 {data&&(category==="encoder"||category==="pi")&&<Table actions={batchButtons("encoder")} title="编码器配置" tag="公共 Flash · 空白电机初始化" rows={specs(encoderFields)}/>}
 {data&&category==="encoder"&&<Table title="找零参数-方法1（腕部双电机找零）" tag="公共 Flash · 所有电机共用" rows={HOME_CONFIG_FIELDS.map(({index,name,unit,description,min,max,scale=1})=>({name,unit,description,value:<NumField label={name} disabled={busy} value={home.config[index]/scale} min={min/scale} max={max/scale} step={1/scale} clampOnCommit={false} onChange={v=>home.setConfig(home.config.map((x,j)=>j===index?Math.round(v*scale):x))} onCommit={()=>void run(()=>writeSharedHome(1))}/>}))}><HomePolicy method={1} embedded/></Table>}
 {data&&category==="encoder"&&<HomePolicy method={2}/>}
 {data&&category==="pi"&&<><Table actions={batchButtons("limits")} title="长期约束" tag="公共 Flash · 初始化默认值" rows={specs([
 {name:"转矩电流限幅",off:44,shift:16,mask:32767,scale:MA_PER_RAW,unit:"mA",reg:"0x14A · PID_TORQUE_FLUX_LIMITS",description:"q 轴电流上限",min:1,max:1050},
 {name:"磁链电流限幅",off:44,mask:32767,scale:MA_PER_RAW,unit:"mA",reg:"0x14A · PID_TORQUE_FLUX_LIMITS",description:"d 轴电流上限",min:0,max:1050},
 {name:"电压限幅",off:52,reg:"0x149 · PIDOUT_UQ_UD_LIMITS",description:"电压输出限幅",min:1,max:65535},
 {name:"转速限幅",off:48,scale:1/COUNTS_PER_RPM,unit:"rpm",reg:"0x14B · PID_VELOCITY_LIMIT",description:"长期速度上限",min:1,max:28730},
 {name:"默认转速限制",off:112,unit:"rpm",reg:"0x14B",description:"空白电机运行速度",min:1,max:28730},
 {name:"默认电流限制",off:116,unit:"mA",reg:"0x153",description:"主控运行电流监测阈值",min:50,max:1050},
 ])}/><Table actions={batchButtons("ramp")} title="Ramp 初始值" tag="空白电机档案" rows={specs(rampFields)}/></>}
 {data&&(category==="motion"||category==="pi")&&<><Table actions={batchButtons("protection")} title="运动保护" tag="公共 Flash" rows={[
 ...([ [20,"持续过流时间"],[22,"保护采样周期"]] as [number,string][]).map(([off,name])=>({name,unit:"ms",description:"主控保护参数",value:<NumField label={name} value={data[off]|data[off+1]<<8} disabled={busy} onChange={v=>editDefaults(p=>{p[off]=v&255;p[off+1]=v>>>8;})} onCommit={()=>void run(saveSharedDefaults)}/>})),
 ...specs([{name:"反馈超时",off:108,unit:"ms",reg:"主控",description:"主控等待有效反馈的时间",min:100,max:5000}])
 ]}/></>}
 {category==="motion"&&<Table title="绝对位置到位" tag="公共 Flash · 实时生效" rows={[{name:"绝对位置到位容差",unit:"%",description:"主控以已标定总行程的此百分比判定到位，默认0.5%；保留200 ms稳定确认，独立于行程边界和TMC Ramp寄存器容差。",value:<NumField label="绝对位置到位容差" value={arrivalDraft} min={.01} max={10} step={.01} disabled={!app.connected||busy} clampOnCommit={false} onChange={setArrivalDraft} onCommit={v=>void run(()=>saveArrivalTolerance(v))}/>} ]}/>}
 {data&&category==="pi"&&<><Table actions={batchButtons("pi")} title="PI 初始值" tag="空白电机 · 独立于当前 PI" rows={specs(piSpecs)}/><Table actions={batchButtons("pi")} title="PI 数值格式" tag="随初始 PI 配置保存" rows={specs([
 ...([['电流 P 小数位',2,1,[0,8]],['电流 I 小数位',3,1,[0,8]],['速度 P 小数位',4,3,[0,8,16,24]],['速度 I 小数位',6,3,[8,16,24,32]],['位置 P 小数位',8,3,[0,8,16,24]],['位置 I 小数位',10,3,[8,16,24,32]]] as [string,number,number,number[]][]).map(([name,shift,mask,values])=>({name,off:24,shift,mask,unit:"bit",reg:"0x140 · PID_CONFIG",description:"PI 增益定点小数位数",choices:values.map((n,value)=>({value,label:String(n)}))})),
 {name:"平滑切换",off:24,shift:1,mask:1,reg:"0x140 · PID_CONFIG",description:"平滑切换控制",choices:[{value:0,label:"关闭"},{value:1,label:"开启"}]},
 {name:"速度积分缩放",off:24,shift:12,mask:15,reg:"0x140 · PID_CONFIG",description:"速度积分输出的二进制缩放档位",min:0,max:15},
 {name:"位置采样间隔",off:24,shift:16,mask:127,unit:"周期",reg:"0x140 · PID_CONFIG",description:"位置环采样间隔配置",min:0,max:127},
 ])}/></>}
 </div></div>;
}
