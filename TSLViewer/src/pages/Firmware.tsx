import { useEffect, useState } from "react";
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
  useEffect(()=>{
    let alive=true;
    const refresh=()=>invoke<Progress>("firmware_status").then(s=>{if(alive)setStatus(s);}).catch(e=>{if(alive)setError(String(e));});
    void refresh(); const timer=setInterval(refresh,500);
    return ()=>{alive=false;clearInterval(timer);};
  },[]);
  async function start(action:"build"|"build_dfu") {
    setStarting(true);setError("");
    try {
      localStorage.setItem("tsl-firmware-root",root);
      if(action==="build_dfu" && app.connected) await app.disconnect();
      await invoke("firmware_start",{root,action,port:app.port});
      setStatus({...EMPTY,running:true,phase:"build"});
    } catch(e) {setError(String(e));} finally {setStarting(false);}
  }
  const busy=starting||status.running;
  return <div className="firmware-workbench">
    <section className="card firmware-setup">
      <div className="firmware-heading"><Icon.Save/><h2>固件工作台</h2><span role="status" className={`firmware-state ${status.result===false?"is-error":""}`}>{PHASES[status.phase]??status.phase}</span></div>
      <label className="firmware-path">L.OS 工程目录<input value={root} disabled={busy} onChange={e=>setRoot(e.target.value)} spellCheck={false}/></label>
      <div className="firmware-actions">
        <Button disabled={busy} onClick={()=>void start("build")}>编译固件</Button>
        <Button disabled={busy||!app.port} onClick={()=>void start("build_dfu")}>编译并 DFU 升级</Button>
        <span>RS485 · {app.port || "未选择串口"}</span>
      </div>
      <p>使用工程的目标、构建和 DFU 配置。升级前自动断开连接；编译失败会停止升级。</p>
      {error && <p role="alert" className="firmware-error">{error}</p>}
      {status.action==="build_dfu"&&status.result===true&&<div className="firmware-reconnect"><span>传输结束。重新连接可刷新主控版本与状态。</span><Button disabled={app.connected} onClick={()=>void app.connect()}>重新连接并读取版本</Button><strong>{app.fwVersion}</strong></div>}
    </section>
    <section className="card firmware-output">
      <div className="firmware-heading"><Icon.Logs/><h2>构建与升级输出</h2><span>{status.lines.length} 行</span></div>
      <pre aria-label="构建与升级输出" tabIndex={0}>{status.lines.join("\n") || "等待执行。任务在后台运行，切换页面不会中断。"}</pre>
    </section>
  </div>;
}
