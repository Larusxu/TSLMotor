import { useMemo, useRef, useEffect, useState } from "react";

import { useApp } from "../lib/app-store";
import { Badge, Button, Card, Icon, Segmented, TextField } from "../components/ui";

type Level = "all" | "info" | "warn" | "error";

export default function LogsPage() {
  const app = useApp();
  const [level, setLevel] = useState<Level>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return app.logs.filter((l) => {
      if (level !== "all" && l.level !== level) return false;
      if (!q) return true;
      return (
        l.message.toLowerCase().includes(q) ||
        l.source.toLowerCase().includes(q) ||
        l.level.includes(q)
      );
    });
  }, [app.logs, level, query]);

  useEffect(() => {
    if (!follow) return;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, follow]);

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0, ok: 0 };
    app.logs.forEach((l) => (c[l.level] = (c[l.level] ?? 0) + 1));
    return c;
  }, [app.logs]);

  return (
    <Card
      title="运行日志"
      sub={`${app.logs.length} 条 · 错误 ${counts.error} · 警告 ${counts.warn}`}
      right={
        <div className="row" style={{ gap: 8 }}>
          <Segmented
            value={level}
            onChange={setLevel}
            options={[
              { value: "all", label: "全部" },
              { value: "info", label: "信息" },
              { value: "warn", label: "警告" },
              { value: "error", label: "错误" },
            ]}
          />
          <div style={{ width: 200 }}>
            <TextField value={query} onChange={setQuery} placeholder="过滤关键字" />
          </div>
          <Button size="sm" variant="ghost" onClick={() => setFollow((f) => !f)}>
            {follow ? "跟随中" : "已暂停"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon.Save width={12} height={12} />}
            onClick={() => {
              void navigator.clipboard?.writeText(
                rows.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.source}: ${l.message}`).join("\n")
              );
              app.toast("ok", "已复制到剪贴板");
            }}
          >
            复制
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void app.clearLogs()}>
            清空
          </Button>
        </div>
      }
    >
      <div
        className="log scroll-y"
        ref={box}
        style={{ height: "calc(100vh - 210px)", borderTop: "1px solid var(--line-soft)" }}
      >
        {rows.length === 0 && <div className="empty">暂无日志</div>}
        {rows.map((l, i) => (
          <div key={`${l.ts}-${i}`} className={`log-row ${l.level}`}>
            <span className="t">{new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })}</span>
            <span className="lv">{l.level}</span>
            <span className="msg">
              <span className="muted">[{l.source}]</span> {l.message}
            </span>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <Badge tone="neutral">信息 {counts.info ?? 0}</Badge>
        <Badge tone="ok">完成 {counts.ok ?? 0}</Badge>
        <Badge tone="warn">警告 {counts.warn ?? 0}</Badge>
        <Badge tone="danger">错误 {counts.error ?? 0}</Badge>
        <span className="grow" />
        <span className="tiny muted">日志最多保留 2500 条，避免长跑占用内存。</span>
      </div>
    </Card>
  );
}
