import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useApp } from "../lib/app-store";
import { FAVORITES, GROUP_LABELS, REGISTERS, REG_META, regLabel, regName } from "../lib/registers";
import {
  Badge,
  BitGrid,
  Button,
  Card,
  Field,
  HexField,
  Icon,
  Notice,
  Segmented,
  SelectField,
} from "../components/ui";
import { bin, hex } from "../lib/units";
import type { RegisterGroup } from "../lib/registers";

const ALL_GROUPS: (RegisterGroup | "ALL")[] = [
  "ALL",
  "CHIP",
  "MCC_CONFIG",
  "FOC",
  "FEEDBACK",
  "MCC_ADC",
  "ADC",
  "RAMPER",
  "UART",
  "IO_CONTROLLER",
  "ABN",
  "ABN2",
  "HALL",
  "BIQUAD",
  "EXT_CTRL",
  "CLK_CTRL",
];

export default function RegistersPage() {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<(typeof ALL_GROUPS)[number]>("ALL");
  const [onlyFav, setOnlyFav] = useState(false);
  const [selected, setSelected] = useState(0x009);
  const [values, setValues] = useState<Record<number, number | null>>({});
  const [draft, setDraft] = useState(0);
  const [bitMode, setBitMode] = useState<"favorites" | "all">("favorites");
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return REGISTERS.filter((r) => {
      if (onlyFav && !FAVORITES.includes(r.addr)) return false;
      if (group !== "ALL" && r.group !== group) return false;
      if (!q) return true;
      const label = (REG_META[r.addr]?.label ?? "").toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        label.includes(q) ||
        r.addr.toString(16).toLowerCase().includes(q) ||
        hex(r.addr, 3).toLowerCase().includes(q)
      );
    });
  }, [query, group, onlyFav]);

  const readAll = useCallback(async () => {
    if (!app.connected) return;
    setBusy(true);
    try {
      const addrs = list.map((r) => r.addr);
      const out: Record<number, number | null> = {};
      // chunk to keep a single transaction short and responsive
      for (let i = 0; i < addrs.length; i += 24) {
        const chunk = addrs.slice(i, i + 24);
        const items = await api.readMany(chunk);
        items.forEach((it) => {
          out[it.addr] = it.value;
        });
      }
      setValues((prev) => ({ ...prev, ...out }));
      app.toast("ok", `已读取 ${addrs.length} 个寄存器`);
    } catch (e) {
      app.toast("error", String(e));
    } finally {
      setBusy(false);
    }
  }, [app, list]);

  const readOne = useCallback(
    async (addr: number) => {
      try {
        const v = await api.readReg(addr);
        setValues((prev) => ({ ...prev, [addr]: v }));
        setDraft(v);
        return v;
      } catch (e) {
        app.toast("error", String(e));
        return null;
      }
    },
    [app]
  );

  useEffect(() => {
    if (app.connected) void readOne(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, app.connected]);

  const meta = REG_META[selected];
  const current = values[selected] ?? null;
  const dirty = current !== null && draft !== current;

  return (
    <div className="grid flow-1-2" style={{ gap: 14 }}>
      <div className="col-stack">
      <Card
        title="寄存器列表"
        sub={`${list.length} / ${REGISTERS.length}`}
        right={
          <div className="row" style={{ gap: 6 }}>
            <Segmented
              value={bitMode}
              onChange={setBitMode}
              options={[
                { value: "favorites", label: "常用" },
                { value: "all", label: "全部" },
              ]}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon.Refresh width={12} height={12} />}
              disabled={!app.connected || busy}
              onClick={() => void readAll()}
            >
              刷新
            </Button>
          </div>
        }
      >
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <div className="input-wrap grow">
              <span className="prefix">
                <Icon.Search width={13} height={13} />
              </span>
              <input
                value={query}
                placeholder="名称 / 地址 / 中文标签，例如 0x242、STATUS、速度"
                onChange={(e) => setQuery(e.target.value)}
                style={{ fontFamily: "var(--font-ui)" }}
              />
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <SelectField
              value={group}
              onChange={setGroup}
              options={ALL_GROUPS.map((g) => ({
                value: g,
                label: g === "ALL" ? "全部模块" : GROUP_LABELS[g as RegisterGroup] ?? g,
              }))}
            />
            <Button
              size="sm"
              variant={onlyFav ? "primary" : "ghost"}
              onClick={() => {
                setOnlyFav((v) => !v);
                setBitMode(onlyFav ? "all" : "favorites");
              }}
            >
              仅常用
            </Button>
          </div>

          <div className="scroll-y" style={{ maxHeight: "calc(100vh - 330px)", marginRight: -6, paddingRight: 6 }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 64 }}>地址</th>
                  <th>名称 / 标签</th>
                  <th style={{ width: 96 }}>值</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const v = values[r.addr];
                  return (
                    <tr
                      key={r.addr}
                      className={`clickable ${selected === r.addr ? "selected" : ""}`}
                      onClick={() => setSelected(r.addr)}
                    >
                      <td className="mono" style={{ color: "var(--accent)" }}>
                        {hex(r.addr, 3)}
                      </td>
                      <td>
                        <div style={{ fontSize: 11.5 }}>{REG_META[r.addr]?.label ?? r.name}</div>
                        <div className="tiny muted mono">{r.name}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 10.5 }}>
                        {v === undefined ? "—" : v === null ? "?" : hex(v)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!list.length && <div className="empty">没有匹配的寄存器</div>}
          </div>
        </div>
      </Card>
      </div>

      <div className="col-stack">
        <Card
          title={
            <span className="row" style={{ gap: 8 }}>
              <span className="mono" style={{ color: "var(--accent)" }}>{hex(selected, 3)}</span>
              {regLabel(selected)}
              {meta?.ro && <Badge tone="neutral">只读</Badge>}
            </span>
          }
          sub={`${REG_META[selected]?.desc ?? ""} · ${regName(selected)}`}
          right={
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="ghost" disabled={!app.connected} onClick={() => void readOne(selected)}>
                读取
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!app.connected || !app.armed || meta?.ro || !dirty}
                onClick={async () => {
                  try {
                    const ok = await api.writeReg(selected, draft, true);
                    app.toast(ok ? "ok" : "warn", ok ? `0x${selected.toString(16)} ← ${hex(draft)}` : "写入校验失败");
                    void readOne(selected);
                  } catch (e) {
                    app.toast("error", String(e));
                  }
                }}
              >
                写入
              </Button>
            </div>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="row-wrap" style={{ gap: 12, alignItems: "flex-end" }}>
              <Field label="当前值" hint="读回" style={{ flex: "1 1 150px" }}>
                <div className="input-wrap" style={{ width: "100%" }}>
                  <input className="mono" readOnly value={current === null ? "—" : hex(current)} />
                </div>
              </Field>
              <Field label="待写入" hint="十六进制" style={{ flex: "1 1 150px" }}>
                <HexField value={draft} onChange={setDraft} disabled={meta?.ro} width="100%" />
              </Field>
              <Field label="十进制" hint="有符号 / 无符号" style={{ flex: "1 1 170px" }}>
                <div className="input-wrap" style={{ width: "100%" }}>
                  <input className="mono" readOnly value={`${draft | 0} / ${draft >>> 0}`} />
                </div>
              </Field>
              <div className="row" style={{ gap: 6, paddingBottom: 6 }}>
                {dirty && <Badge tone="warn">未写入</Badge>}
                {!dirty && current !== null && <Badge tone="ok">与芯片一致</Badge>}
              </div>
            </div>

            <Field label="二进制" hint="点击位翻转">
              <BitGrid
                value={draft}
                onChange={(v) => !meta?.ro && setDraft(v)}
                readonly={meta?.ro}
              />
            </Field>

            <div className="row" style={{ gap: 6 }}>
              {[31, 15, 7, 0].map((b) => (
                <span key={b} className="tiny muted mono">
                  bit{b} = {(draft >>> b) & 1}
                </span>
              ))}
              <span className="grow" />
              <span className="tiny muted mono" style={{ opacity: 0.7 }}>
                {bin(draft)}
              </span>
            </div>

            {meta?.bits && (
              <>
                <div className="divider" />
                <div className="scroll-y" style={{ maxHeight: 240, marginRight: -6, paddingRight: 6 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>位域</th>
                        <th>名称</th>
                        <th>值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meta.bits.map(([hi, lo, name]) => {
                        const width = hi - lo + 1;
                        const v = (draft >>> lo) & ((1 << width) - 1);
                        return (
                          <tr key={name}>
                            <td className="mono">
                              [{hi}:{lo}]
                            </td>
                            <td className="mono">{name}</td>
                            <td className="mono" style={{ color: v ? "var(--accent)" : "var(--text-3)" }}>
                              {v} <span className="tiny muted">({hex(v, 1)})</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {!app.armed && <Notice tone="warn">写入需要解锁 ARM（顶部开关）。</Notice>}
            {meta?.ro && <Notice>该寄存器在手册中标注为只读（R），写入会被忽略。</Notice>}
          </div>
        </Card>

        <Card title="批量操作" sub="SNAPSHOT">
          <div className="row-wrap" style={{ gap: 8 }}>
            <Button variant="ghost" size="sm" disabled={!app.connected || busy} onClick={() => void readAll()}>
              读取当前筛选（{list.length}）
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!app.connected}
              onClick={async () => {
                const addrs = [0x000, 0x001, 0x002, 0x009, 0x00a, 0x0c3, 0x100, 0x101, 0x103, 0x140, 0x142, 0x143, 0x145, 0x146, 0x149, 0x14a, 0x14b, 0x240, 0x242, 0x250];
                const items = await api.readMany(addrs);
                const out: Record<number, number | null> = {};
                items.forEach((it) => (out[it.addr] = it.value));
                setValues((prev) => ({ ...prev, ...out }));
                app.toast("ok", "关键寄存器快照完成");
              }}
            >
              关键 20 项快照
            </Button>
            <span className="tiny muted">地址范围 0x000–0x385，共 {REGISTERS.length} 项，来自手册 Register Map。</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
