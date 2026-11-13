import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "../lib/app-store";
import { Button, Icon } from "../components/ui";
import "./Firmware.css";

type Progress = {running: boolean; phase: string; action: string; result: boolean | null; lines: string[]};
const EMPTY: Progress = {running:false,phase:"ready",action:"",result:null,lines:[]};
const PHASES: Record<string,string> = {ready:"准备就绪",build:"编译中",dfu:"DFU 升级中",complete:"已完成",failed:"执行失败"};

export default function Firmware() {
  const app = useApp();
  const [root,setRoot] = useState(()=>localStorage.getItem("tsl-firmware-root") ?? "D:\\WorkeSpace\\work\\comp_proj\\TeslaHand");
  const [status,setStatus] = useState<Progress>(EMPTY);
  const [starting,setStarting] = useState(false);
  const [error,setError] = useState("");
  const [image,setImage]=useState<File|null>(null);
  const output=useRef<HTMLPreElement>(null);
  useEffect(()=>{if(output.current)output.current.scrollTop=output.current.scrollHeight;},[status.lines.length,status.lines[status.lines.length-1]]);
  useEffect(()=>{
    let alive=true;
    const refresh=()=>invoke<Progress>("firmware_status").then(s=>{if(alive)setStatus(s);}).catch(e=>{if(alive)setError(String(e));});
    void refresh(); const timer=setInterval(refresh,500);
    return ()=>{alive=false;clearInterval(timer);};
  },[]);
  async function start(action:"build"|"build_dfu"|"dfu") {
    setStarting(true);setError("");
    try {
      localStorage.setItem("tsl-firmware-root",root);
      const bytes=action==="dfu"&&image?Array.from(new Uint8Array(await image.arrayBuffer())):null;
      if(action!=="build" && app.connected) await app.disconnect();
      await invoke("firmware_start",{root,action,port:app.port,image:bytes});
      setStatus({...EMPTY,running:true,phase:action==="dfu"?"dfu":"build",action});
    } catch(e) {setError(String(e));} finally {setStarting(false);}
  }
  const busy=starting||status.running;
  return <div className="firmware-workbench">
    <section className="card firmware-setup">
      <div className="firmware-heading"><Icon.Save/><h2>固件工作台</h2><span role="status" className={`firmware-state ${status.result===false?"is-error":""}`}>{PHASES[status.phase]??status.phase}</span></div>
      <label className="firmware-path">L.OS 工程目录<input value={root} disabled={busy} onChange={e=>setRoot(e.target.value)} spellCheck={false}/></label>
      <div className="firmware-steps" aria-label="升级流程"><span>1 准备固件</span><span className={status.phase==="build"?"active":""}>2 编译（源码升级）</span><span className={status.phase==="dfu"?"active":""}>3 DFU 传输</span><span>4 重连核对版本</span></div>
      <div className="firmware-actions">
        <Button disabled={busy} onClick={()=>void start("build")}>编译固件</Button>
        <Button disabled={busy||!app.port} onClick={()=>void start("build_dfu")}>编译并 DFU 升级</Button>
        <span>RS485 · {app.port || "未选择串口"}</span>
      </div>
      <section className="firmware-image">
        <label className="firmware-path">已有固件 · app.bin<input type="file" accept=".bin" disabled={busy} onChange={e=>{const f=e.target.files?.[0]??null;if(f&&(!f.size||f.size>8*1024*1024)){setError("请选择不超过8MB的app.bin");e.target.value="";setImage(null);}else{setImage(f);setError("");}}}/></label>
        <div className="firmware-actions"><Button disabled={busy||!app.port||!image} onClick={()=>void start("dfu")}>DFU 升级所选固件</Button><span>{image?`${image.name} · ${(image.size/1024).toFixed(1)} KB`:"选择已构建的固件，可直接升级"}</span></div>
      </section>
      <p>使用工程的目标、构建和 DFU 配置。升级前自动断开连接；编译失败会停止升级。</p>
      <p>升级后主控按保存的配置启动；已开启自动找零的设备将自动执行整手找零。</p>
      {error && <p role="alert" className="firmware-error">{error}</p>}
      {status.action!=="build"&&status.result===true&&<div className="firmware-reconnect"><span>传输已完成。重新连接核对主控版本与运行状态。</span><Button disabled={app.connected} onClick={()=>void app.connect().catch(e=>setError(String(e)))}>重新连接并读取版本</Button><strong>{app.fwVersion}</strong></div>}
    </section>
    <section className="card firmware-output">
      <div className="firmware-heading"><Icon.Logs/><h2>构建与升级输出</h2><span>{status.lines.length} 行</span></div>
      <pre ref={output} aria-label="构建与升级输出" tabIndex={0}>{status.lines.join("\n") || "等待执行。任务在后台运行，切换页面不会中断。"}</pre>
    </section>
  </div>;
}
