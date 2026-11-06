from pathlib import Path
p=Path('src/pages/RegistersConfig.tsx');s=p.read_text(encoding='utf-8')
s='import ControllerRegisters from "./ControllerRegisters";\nimport MotorArchives from "./MotorArchives";\nimport CylinderConfig from "./CylinderConfig";\nimport type {CylinderModel} from "../lib/cylinder";\n'+s
s=s.replace('type Category="registers"|"encoder"|"motion"|"pi";','type Category="registers"|"encoder"|"motion"|"pi"|"cylinders"|"archives";')
s=s.replace('["pi","PI 初始值","空白电机初始化"]','["pi","PI 初始值","空白电机初始化"],["cylinders","电缸","五路电缸配置"],["archives","电机档案","M1–M16 · W25"]')
s=s.replace('export default function RegistersConfig(){','export default function RegistersConfig({cylinders}:{cylinders:CylinderModel}){')
s=s.replace(' if(category==="registers"){const r=await semanticMotion.command(app.motor,{kind:"get_state"});setState(r.motor??null);return;}',' if(["registers","archives","cylinders"].includes(category))return;')
start=s.index('  if(category==="motion"&&(explicit||!loadedMotion.has(app.motor)))')
end=s.index('\n };',start)
s=s[:start]+s[end:]
s=s.replace('[app.connected,app.motor,category]','[app.connected,category]')
s=s.replace('onChange={change}/>:', 'onChange={v=>{change(v);void run(saveSharedDefaults);}}/>:')
s=s.replace('clampOnCommit={false} onChange={change}/>','clampOnCommit={false} onChange={change} onCommit={()=>void run(saveSharedDefaults)}/>')
start=s.index(' const pidRow=');end=s.index(' const piSpecs:',start)
s=s[:start]+''' const write=async()=>{if(category==="encoder")await writeSharedHome(1);await saveSharedDefaults();};
'''+s[end:]
s=s.replace('const s=state;','')
s=s.replace('category==="registers"?`M${app.motor} · 实时控制状态` :category==="pi"?"仅用于空白电机，不覆盖当前 PI":"公共配置与当前电机"','category==="registers"?"整机寄存器" :category==="pi"?"仅用于空白电机，不覆盖当前 PI":"整机配置"')
s=s.replace('||category==="registers"','||["registers","archives","cylinders"].includes(category)')
s=s.replace('<div className="row"><Button icon=', '<div className="row" style={{display:["registers","archives","cylinders"].includes(category)?"none":undefined}}><Button icon=',1)
start=s.index(' {category==="registers"&&<Table');end=s.index(' {data&&category==="encoder"',start)
s=s[:start]+''' {category==="registers"&&<ControllerRegisters/>}
 {category==="archives"&&<MotorArchives/>}
 {category==="cylinders"&&<CylinderConfig model={cylinders}/>}
 {!["registers","archives","cylinders"].includes(category)&&!data&&<Card title="尚未读取配置">连接主控后点击读取。</Card>}
'''+s[end:]
s=s.replace('onChange={v=>home.setConfig(home.config.map((x,j)=>j===i?v:x))}','onChange={v=>home.setConfig(home.config.map((x,j)=>j===i?v:x))} onCommit={()=>void run(()=>writeSharedHome(1))}')
start=s.index(' {data&&category==="motion"');end=s.index(' {data&&category==="pi"',start)
s=s[:start]+''' {data&&category==="motion"&&<><Table title="长期约束" tag="公共 Flash · 初始化默认值" rows={specs([
 {name:"转矩电流限幅",off:44,shift:16,mask:32767,scale:MA_PER_RAW,unit:"mA",reg:"0x14A · PID_TORQUE_FLUX_LIMITS",description:"q 轴电流上限",min:1,max:1050},
 {name:"磁链电流限幅",off:44,mask:32767,scale:MA_PER_RAW,unit:"mA",reg:"0x14A · PID_TORQUE_FLUX_LIMITS",description:"d 轴电流上限",min:0,max:1050},
 {name:"电压限幅",off:52,reg:"0x149 · PIDOUT_UQ_UD_LIMITS",description:"电压输出限幅",min:1,max:65535},
 {name:"转速限幅",off:48,scale:1/COUNTS_PER_RPM,unit:"rpm",reg:"0x14B · PID_VELOCITY_LIMIT",description:"长期速度上限",min:1,max:28730},
 {name:"默认转速限制",off:112,unit:"rpm",reg:"0x14B",description:"空白电机运行速度",min:1,max:28730},
 {name:"默认电流限制",off:116,unit:"mA",reg:"0x153",description:"主控运行电流监测阈值",min:50,max:1050},
 ])}/><Table title="运动保护" tag="公共 Flash" rows={[
 ...([ [20,"持续过流时间"],[22,"保护采样周期"]] as [number,string][]).map(([off,name])=>({name,unit:"ms",description:"主控保护参数",value:<NumField label={name} value={data[off]|data[off+1]<<8} disabled={busy} onChange={v=>editDefaults(p=>{p[off]=v&255;p[off+1]=v>>>8;})} onCommit={()=>void run(saveSharedDefaults)}/>})),
 ...specs([{name:"反馈超时",off:108,unit:"ms",reg:"主控",description:"主控等待有效反馈的时间",min:100,max:5000}])
 ]}/><Table title="Ramp 初始值" tag="空白电机档案" rows={specs(rampFields)}/></>}
'''+s[end:]
# Removed selected-motor dependency: public settings never silently edit an arbitrary Mx.
s=s.replace('import {useMotorConfiguration} from "../lib/motor-configuration";\n','').replace('import {semanticMotion} from "../lib/semantic-motion";\n','').replace('import type {PidCfgPayload} from "../lib/types";\n','').replace('import type {MotorState} from "../lib/semantic-state";\n','')
s=s.replace('const loadedMotion=new Set<number>();\n','').replace('home=useSharedHome(),motor=useMotorConfiguration(app.motor)','home=useSharedHome()').replace(' const [state,setState]=useState<MotorState|null>(null);\n','')
s=s.replace('readSharedHome(app.motor)','readSharedHome(1)')
s=s.replace('word,putWord,MA_PER_RAW,COUNTS_PER_RPM,readMotorProfile,pidFromProfile,motionFromProfile,applyMotorLongTermConstraints,applyMotorConfiguration','word,putWord,MA_PER_RAW,COUNTS_PER_RPM')
p.write_text(s,encoding='utf-8')
