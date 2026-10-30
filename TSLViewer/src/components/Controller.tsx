import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { Badge, Button, Card } from "./ui";

const MOTORS = Array.from({ length: 16 }, (_, i) => i + 1);
/** Rows per column: 16 motors split into two balanced halves. */
const HALF = 8;

type TmcState = { online: boolean; tries: number };

export default function Controller() {
  const app = useApp();
  const [rows, setRows] = useState<number[][]>([]);
  const [tmc, setTmc] = useState<Record<number, TmcState>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [firmware, setFirmware] = useState("");

  useEffect(() => {
    setRows([]);
    setTmc({});
    setFirmware("");
    setProgress("");
  }, [app.connected, app.mode]);

  async function act(m: number, op: number, data: number[] = []) {
    setBusy(true);
    setProgress("正在等待主控确认…");
    try {
      await api.mainControl(m, op, data);
      app.toast("ok", op === 6 ? "主控已执行全部逻辑供电关闭" : `M${m} 命令已完成`);
    } catch (e) {
      app.toast("error", String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  /** CHIP.ID probe: powered chips answer, unpowered ones stay "掉线". */
  async function probe(list: number[]) {
    if (app.streaming) {
      app.toast("warn", "请先停止采集再检测 TMC");
      return;
    }
    try {
      setTmc({});
      for (const [i, motor] of list.entries()) {
        setProgress(`正在检测 TMC ${i + 1}/${list.length} · M${motor}`);
        const res = await api.probeTmc([motor], 1);
        setTmc((prev) => {
          const next = { ...prev };
          res.forEach((r) => {
            next[r.motor] = { online: r.online, tries: r.tries };
          });
          return next;
        });
      }
    } catch (e) {
      app.toast("error", String(e));
    }
  }

  async function scan() {
    setBusy(true);
    setProgress("正在读取固件信息…");
    try {
      const version = await api.mainControl(0, 10, [8, 32]);
      setFirmware(String.fromCharCode(...version).replace(/\0/g, " ").trim());
      const next: number[][] = [];
      for (const m of MOTORS) {
        setProgress(`正在读取映射 ${m}/16`);
        next.push(await api.mainControl(m, 4));
      }
      setRows(next);
      app.toast("ok", "16 路映射已读取；检测电机请点击“检测 TMC”");
    } catch (e) {
      app.toast("error", String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function rescanTmc() {
    setBusy(true);
    try {
      await probe(MOTORS);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const online = Object.values(tmc).filter((t) => t.online).length;
  const probed = Object.keys(tmc).length;

  function cell(n: number, r: number[]) {
    const t = tmc[n];
    const ready = !!r[5];
    const powerKnown = !!r[7];
    const powered = powerKnown && !!(r[8] && (r[9] & (1 << (r[2] - 1))));
    return (
      <tr key={n} className={n === app.motor ? "selected" : ""}>
        <td>
          <b className="mono">M{n}</b>
        </td>
        <td className="mono" style={{ color: ready ? "var(--text-2)" : "var(--text-4)" }}>
          UART{r[0]}-{ready ? "就绪" : "未就绪"}
        </td>
        <td style={{ color: !powerKnown ? "var(--text-3)" : powered ? "var(--ok)" : "var(--text-3)" }}>
          {!powerKnown ? "未知" : powered ? "已使能" : "关闭"}
        </td>
        <td>
          {!t ? (
            <span style={{ color: "var(--text-4)" }}>—</span>
          ) : t.online ? (
            <span style={{ color: "var(--ok)" }}>在线</span>
          ) : (
            <span style={{ color: "var(--danger)" }}>掉线</span>
          )}
        </td>
      </tr>
    );
  }

  function half(from: number) {
    return (
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 54 }}>电机</th>
            <th>主控 UART</th>
            <th style={{ width: 78 }}>逻辑供电</th>
            <th style={{ width: 64 }}>TMC</th>
          </tr>
        </thead>
        <tbody>{rows.slice(from, from + HALF).map((r, i) => cell(from + i + 1, r))}</tbody>
      </table>
    );
  }

  return (
    <Card
      title={`TeslaHand 主控 · 当前 M${app.motor}`}
      sub="16 路映射 · TMC 探活"
      right={
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          {firmware && (
            <span className="tiny mono" style={{ color: "var(--text-3)", textTransform: "none" }}>
              {firmware}
            </span>
          )}
          {probed > 0 && (
            <Badge tone={online ? "ok" : "neutral"} dot={online ? "on" : undefined}>
              {online}/{probed} 在线
            </Badge>
          )}
        </div>
      }
    >
      <div className="row-wrap" style={{ gap: 8, marginBottom: rows.length ? 12 : 0 }}>
        <Button disabled={!app.connected || busy} onClick={() => void scan()}>
          读取 16 路映射
        </Button>
        <Button disabled={!app.connected || busy} onClick={() => void rescanTmc()}>
          检测 TMC
        </Button>
        <Button disabled={!app.connected || !app.armed || busy} onClick={() => void act(app.motor, 5, [1])}>
          当前电机逻辑上电
        </Button>
        <Button disabled={!app.connected || busy} onClick={() => void act(app.motor, 5, [0])}>
          当前电机逻辑断电
        </Button>
        <Button variant="danger" disabled={!app.connected || busy} onClick={() => void act(0, 6)}>
          全部逻辑断电
        </Button>
        {progress && <span role="status" aria-live="polite" style={{ color: "var(--text-3)", alignSelf: "center" }}>{progress}</span>}
      </div>
      {app.connected && rows.length > 0 && (
        <div className="map-split">
          {half(0)}
          {half(HALF)}
        </div>
      )}
    </Card>
  );
}
