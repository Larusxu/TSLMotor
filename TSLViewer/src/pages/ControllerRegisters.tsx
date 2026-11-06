import {useEffect,useState} from "react";
import {useApp} from "../lib/app-store";
import {api} from "../lib/api";
import {formatHandId,parseHandId} from "../lib/hand-id";
import {Card,Button} from "../components/ui";
function meaning(a:number):string {
 const names:Record<number,string>={0:"协议标识",1:"协议版本",2:"设备地址",3:"运行时间 / s",4:"快照序号高位",5:"快照序号低位",6:"采样时间高位",7:"采样时间低位",70:"升级待确认",71:"升级能力",72:"最近升级结果",73:"手编号",74:"编码器有效位图",75:"找零有效位图",256:"升级命令（命令接口）",257:"升级确认（命令接口）",258:"回滚（命令接口）",259:"手编号 · Flash"};
 if(names[a])return names[a];
 if(a>=8&&a<64)return `${a<16?"固件版本":a<40?"构建信息":a<52?"业务名称":"芯片名称"} · 字 ${a}`;
 if(a>=64&&a<70)return `模块状态 ${a-64+1}`;
 if(a>=80&&a<128)return `MAX${Math.floor((a-80)/12)+1} · ${["状态有效","芯片 ID","配置","诊断有效","状态 1","状态 2A","状态 2B","访问结果","输入电压 ADC","逻辑电压 ADC","限流配置 ADC","保留"][(a-80)%12]}`;
 if(a>=128&&a<256)return `M${Math.floor((a-128)/8)+1} · ${["串口","供电芯片","输出通道","电流 / 3mA","电压 / 70mV","供电状态","供电状态有效","通信与电压标志"][(a-128)%8]}`;
 return "保留";
}
export default function ControllerRegisters(){
 const app=useApp(),[values,setValues]=useState<number[]>([]),[id,setId]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>setId(formatHandId(app.handId)),[app.handId]);
 const read=async()=>{setBusy(true);setError("");try{const words:number[]=[];for(let start=0;start<256;start+=64){const p=await api.mainControl(0,10,[start,64]);if(p.length!==128)throw Error("主控寄存器快照长度不完整");for(let i=0;i<p.length;i+=2)words.push(p[i]*256+p[i+1]);}setValues(words);}catch(e){setError(String(e));}finally{setBusy(false);}};
 useEffect(()=>{if(app.connected)void read();},[app.connected]);
 const save=async()=>{if(id===formatHandId(app.handId))return;setBusy(true);try{await app.updateHandId(parseHandId(id));setError("");}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <><Card title="主控寄存器 · 整机" right={<Button size="sm" disabled={!app.connected||busy} onClick={()=>void read()}>读取全部</Button>}><div className="row"><label htmlFor="hand-register">手编号 · 259</label><input id="hand-register" className="input" value={id} maxLength={5} disabled={!app.connected||busy} onChange={e=>setId(e.target.value.toUpperCase())} onBlur={()=>void save()} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();}}/><span className="tiny muted">TS-00–TS-ZZ · 主控 Flash</span></div><div role="status" className="config-result">{busy?"正在读写…":error}</div></Card>
 {([[0,80,"主控与模块"],[80,128,"四路供电管理芯片"],[128,256,"M1–M16 接口状态"],[256,260,"主控保持寄存器"]] as const).map(([start,end,title])=><Card key={start} title={title}><div className="table-scroll"><table className="table"><thead><tr><th>地址</th><th>名称</th><th>值</th><th>访问</th></tr></thead><tbody>{Array.from({length:end-start},(_,i)=>i+start).map(a=><tr key={a}><td className="mono">{a}</td><td>{meaning(a)}</td><td className="mono">{a===259||a===73?formatHandId(app.handId):a>=256?"命令入口":values[a]??"—"}</td><td>{a===259?"读写 · 上方编辑":a>=256?"专用升级流程":"只读"}</td></tr>)}</tbody></table></div></Card>)}</>;
}
