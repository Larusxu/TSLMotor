import { useEffect, useRef, useState } from "react";
import { useApp } from "../lib/app-store";
import { Badge, Button, Card, Notice, Icon } from "../components/ui";
import { decodeBackup, storageJob, type StorageReply } from "../lib/split-storage";

export default function SplitStorage() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [record, setRecord] = useState<StorageReply | null>(null);
  const [image, setImage] = useState<number[] | null>(null);
  const [object, setObject] = useState(-1);
  const file = useRef<HTMLInputElement>(null);
  const context = useRef(0);
  useEffect(() => {
    context.current++;
    setRecord(null); setImage(null); setMessage("");
    return () => { context.current++; };
  }, [app.motor, app.handId, app.connected, app.mode]);
  const disabled = busy || app.busy || !app.connected || app.mode === "direct";
  async function run(motor: number, op: 1 | 3 | 4 | 5) {
    if (busy) return;
    const epoch = context.current;
    setBusy(true); setMessage("正在等待主控确认…"); setRecord(null);
    try {
      const r = await storageJob(motor, op, op === 3 ? image ?? undefined : undefined);
      if (context.current !== epoch) return;
      if (app.handId !== null && app.handId !== r.hand_id) throw new Error("主控 HandID 已改变，请重新连接后读取");
      setRecord(r);
      if (op === 1 || op === 3) { setImage(r.data); setObject(motor); }
      if (op === 4 || op === 5) {
        const b = decodeBackup(r.data, r.hand_id, motor);
        setMessage(`备份已校验：HandID ${b.handId} · M${b.motor} · 电角度偏移 ${b.offset} · 代数 ${b.generation}；恢复标志 ${r.flags}`);
      } else if (motor === 0 && new TextDecoder().decode(Uint8Array.from(r.data.slice(0, 4))) === "ENC2") {
        const text = (a: number, b: number) => new TextDecoder().decode(Uint8Array.from(r.data.slice(a, b))).split("\0")[0];
        setMessage(`公共区已校验：HandID ${r.data[64] | r.data[65] << 8} · 保存时固件 ${text(72, 88)} · 构建 ${text(88, 112)} · ${text(112, 120)} · 代数 ${r.generation}`);
      } else setMessage(`W25 档案已校验：${motor === 0 ? "公共配置" : `M${motor}`} · HandID ${r.hand_id} · 代数 ${r.generation}`);
    } catch (e) { if (context.current === epoch) { setMessage(String(e)); app.toast("error", String(e)); } }
    finally { setBusy(false); }
  }
  function download() {
    if (!image) return;
    const url = URL.createObjectURL(new Blob([Uint8Array.from(image)], { type: "application/octet-stream" }));
    const a = document.createElement("a"); a.href = url; a.download = `Hand${app.handId}-object${object}.bin`; a.click(); URL.revokeObjectURL(url);
  }
  return <div className="grid" style={{ gap: 14 }}>
    <div className="grid flow-2-1"><div className="col-stack">
    <Card title="主控 W25 配置档案" right={<Badge>公共区 + 16 路电机</Badge>}>
      <div className="stack" style={{ gap: 12 }}>
        <Notice tone="warn">保存只更新档案，不应用寄存器、不使能电机。主控检查会话、禁能状态、CRC、编号与公共配置绑定。公共配置改变后，旧电机档案可能需要重新确认。</Notice>
        {app.mode === "direct" && <Notice tone="warn">请通过主控 485 或 CAN 连接；电机直连模式不支持主控 W25 档案。</Notice>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Button icon={<Icon.Refresh width={14} height={14}/>} disabled={disabled} onClick={() => void run(0, 1)}>读取公共配置</Button>
          <Button disabled={disabled} onClick={() => void run(app.motor, 1)}>读取 M{app.motor} 档案</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => file.current?.click()}>导入档案</Button>
          <Button variant="ghost" disabled={busy || !image} onClick={download}>导出档案</Button>
        </div><div className="divider"/><div className="row-wrap">
          <Button variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={disabled || !image || (object !== 0 && object !== app.motor)} onClick={() => void run(object, 3)}>保存到 W25 并读回</Button>
        </div>
        <input ref={file} type="file" accept=".bin" hidden onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
          try {
            const p = new Uint8Array(await f.arrayBuffer());
            const magic = new TextDecoder().decode(p.slice(0, 4));
            if (p.length !== 128 || !["ENC1", "ENC2", "MTR1"].includes(magic)) throw new Error("仅接受 ENC1/ENC2/MTR1 128 字节档案");
            const motor = magic.startsWith("ENC") ? 0 : p[12] | p[13] << 8;
            if (motor !== 0 && motor !== app.motor) throw new Error("档案电机编号与当前选择不一致");
            setImage([...p]); setObject(motor); setRecord(null); setMessage("已导入编辑缓冲，尚未写入主控；保存时主控会验证 CRC 和配置绑定。");
          } catch (err) { setMessage(String(err)); }
        }} />
        <div className="tiny muted">{image ? `当前缓冲：${object === 0 ? "公共配置" : `M${object}`}，${image.length} B` : "尚未读取或导入档案"}</div>
      </div>
    </Card>
    </div><div className="col-stack">
    <Card title="M24C02 校准备份" right={<Badge>M{app.motor}</Badge>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="tiny muted">备份 HandID、电机编号和电角度偏移，仅使用 0x00–0x0F。保存前核对 W25 与 TMC；中断写入可能使单槽备份失效。</div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Button disabled={disabled} onClick={() => void run(app.motor, 4)}>读取校准备份</Button>
          <Button variant="primary" icon={<Icon.Save width={14} height={14}/>} disabled={disabled} onClick={() => void run(app.motor, 5)}>从 W25 备份并校验</Button>
        </div>
      </div>
    </Card>
    <Card title="操作结果"><div className="stack" style={{gap:8}} role="status" aria-live="polite"><div className="tiny muted">{message || "等待操作"}</div>{record && <div className="mono tiny muted">结果 {record.result} · 请求 {record.id} · 状态 {record.phase}</div>}</div></Card>
    </div></div>
  </div>;
}
