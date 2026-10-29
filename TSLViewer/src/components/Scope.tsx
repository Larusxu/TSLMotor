import { useEffect, useRef, useState } from "react";
import type { ScopeStore } from "../lib/scope";

interface Props {
  store: ScopeStore;
  channels: number[];
  /** Fixed plot height in px, or "fill" to grow with the parent card. */
  height?: number | "fill";
  windowMs: number;
  paused?: boolean;
  onToggleChannel?: (ch: number) => void;
}

/**
 * Canvas oscilloscope. Redraws on rAF but throttled to ~45 fps so the JS thread
 * stays free for React updates coming from the serial link.
 */
export function Scope({ store, channels, height = 320, windowMs, paused, onToggleChannel }: Props) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const fill = height === "fill";
  const fixed = typeof height === "number" ? height : 320;
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ t: number; values: { ch: number; v: number; color: string; label: string }[] } | null>(null);

  useEffect(() => {
    store.windowMs = windowMs;
  }, [store, windowMs]);

  useEffect(() => {
    let raf = 0;
    let last = 0;

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (paused) return;
      if (ts - last < 22) return;
      last = ts;

      const cv = canvas.current;
      const box = wrap.current;
      if (!cv || !box) return;
      const w = box.clientWidth;
      const h = fill ? Math.max(160, box.clientHeight) : fixed;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        if (!fill) cv.style.height = `${h}px`;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 52;
      const padR = 12;
      const padT = 10;
      const padB = 22;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;

      const { min, max } = store.bounds(channels);
      const yFor = (v: number) => padT + plotH - ((v - min) / (max - min)) * plotH;
      const now = store.now();
      const xFor = (t: number) => padL + ((t - (now - windowMs)) / windowMs) * plotW;

      // grid
      ctx.strokeStyle = ink().grid;
      ctx.lineWidth = 1;
      ctx.font = '10px "Cascadia Code", Consolas, monospace';
      ctx.fillStyle = ink().label;
      for (let i = 0; i <= 5; i++) {
        const y = padT + (plotH / 5) * i;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        const val = max - ((max - min) / 5) * i;
        ctx.fillText(formatTick(val), 6, y + 3);
      }
      const vTicks = 5;
      for (let i = 0; i <= vTicks; i++) {
        const x = padL + (plotW / vTicks) * i;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        const tLabel = -(windowMs / 1000) + (windowMs / 1000) * (i / vTicks);
        const label = `${tLabel.toFixed(1)}s`;
        const tw = ctx.measureText(label).width;
        ctx.fillText(label, Math.min(x + 3, padL + plotW - tw), h - 7);
      }

      // zero line
      if (min < 0 && max > 0) {
        const y0 = yFor(0);
        ctx.strokeStyle = ink().axis;
        ctx.beginPath();
        ctx.moveTo(padL, y0);
        ctx.lineTo(padL + plotW, y0);
        ctx.stroke();
      }

      // series
      for (const ch of channels) {
        const s = store.series.get(ch);
        if (!s || s.count === 0) continue;
        ctx.beginPath();
        let started = false;
        store.forEachInWindow(ch, (t, v) => {
          const x = xFor(t);
          const y = yFor(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        });
        if (!started) continue;
        ctx.strokeStyle = resolveColor(s.color);
        ctx.lineWidth = 1.6;
        ctx.lineJoin = "round";
        ctx.stroke();

        // barely-there area under the first trace: reads as depth, not decoration
        if (ch === channels[0]) {
          ctx.lineTo(padL + plotW, padT + plotH);
          ctx.lineTo(padL, padT + plotH);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
          g.addColorStop(0, hexA(s.color, 0.1));
          g.addColorStop(1, hexA(s.color, 0));
          ctx.fillStyle = g;
          ctx.fill();
        }
      }

      // cursor
      if (hover && hover.x > padL - 4 && hover.x < padL + plotW + 4) {
        ctx.strokeStyle = ink().cursor;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hover.x, padT);
        ctx.lineTo(hover.x, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // live dot
      for (const ch of channels) {
        const s = store.series.get(ch);
        if (!s || s.count === 0) continue;
        const v = store.latest.get(ch);
        if (v === undefined) continue;
        const y = yFor(v);
        if (!Number.isFinite(y)) continue;
        ctx.beginPath();
        ctx.arc(padL + plotW - 1, y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = resolveColor(s.color);
        ctx.shadowColor = resolveColor(s.color);
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, channels, fixed, fill, windowMs, paused, hover]);

  // a filled scope must redraw when the card resizes
  useEffect(() => {
    if (!fill) return;
    const box = wrap.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const cv = canvas.current;
      if (cv && box.clientHeight > 0) cv.height = Math.round(box.clientHeight * Math.min(2, window.devicePixelRatio || 1));
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [fill]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setHover({ x, y: e.clientY - rect.top });
    const padL = 52;
    const padR = 12;
    const w = rect.width;
    const plotW = w - padL - padR;
    if (x < padL || x > padL + plotW) {
      setCursor(null);
      return;
    }
    const now = store.now();
    const t = now - windowMs + ((x - padL) / plotW) * windowMs;
    const values: { ch: number; v: number; color: string; label: string }[] = [];
    for (const ch of channels) {
      const s = store.series.get(ch);
      if (!s) continue;
      let best = Infinity;
      let bv = 0;
      store.forEachInWindow(ch, (st, v) => {
        const d = Math.abs(st - t);
        if (d < best) {
          best = d;
          bv = v;
        }
      });
      values.push({ ch, v: bv, color: s.color, label: s.signal.label });
    }
    setCursor({ t, values });
  };

  return (
    <div className={`scope${fill ? " fill" : ""}`} ref={wrap}>
      <canvas
        ref={canvas}
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null);
          setCursor(null);
        }}
      />
      <div className="scope-legend">
        {channels.length === 0 && <span className="tiny muted">未选择信号</span>}
        {channels.map((ch) => {
          const s = store.series.get(ch);
          const v = store.latest.get(ch);
          return (
            <button
              key={ch}
              className="chip on"
              onClick={() => onToggleChannel?.(ch)}
              title="点击可移除该通道"
            >
              <span className="swatch" style={{ background: s?.color ?? "var(--text-4)" }} />
              {s?.signal.label ?? `CH${ch}`}
              <span className="val">
                {v === undefined ? "—" : formatValue(v)} {s?.signal.unit}
              </span>
            </button>
          );
        })}
        {cursor && (
          <span className="chip" style={{ marginLeft: "auto" }}>
            <span className="muted">游标</span>
            <span className="val">
              {cursor.values
                .map((c) => `${c.label} ${formatValue(c.v)}`)
                .join(" · ")}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function formatTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 10000) return (v / 1000).toFixed(1) + "k";
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

/** Canvas cannot resolve CSS custom properties, so channel tokens map to hex.
 *  Light mode uses a darker set to keep contrast on a pale screen. */
const CH_DARK: Record<string, string> = {
  "var(--ch-0)": "#2ee6e6",
  "var(--ch-1)": "#f5b544",
  "var(--ch-2)": "#a78bfa",
  "var(--ch-3)": "#3ddc84",
  "var(--ch-4)": "#6ea8fe",
  "var(--ch-5)": "#ff8fab",
  "var(--ch-6)": "#9ae6b4",
};

const CH_LIGHT: Record<string, string> = {
  "var(--ch-0)": "#0a97a3",
  "var(--ch-1)": "#b3760f",
  "var(--ch-2)": "#6d4fd8",
  "var(--ch-3)": "#128a52",
  "var(--ch-4)": "#2f6fe0",
  "var(--ch-5)": "#c53f6a",
  "var(--ch-6)": "#4c8a5e",
};

const isLight = () => document.documentElement.dataset.theme === "light";

function resolveColor(color: string): string {
  const table = isLight() ? CH_LIGHT : CH_DARK;
  return table[color] ?? color;
}

/** Grid / axis / cursor tints follow the theme. */
function ink() {
  return isLight()
    ? { grid: "rgba(16,24,40,0.10)", label: "rgba(60,74,92,0.75)", axis: "rgba(16,24,40,0.22)", cursor: "rgba(16,24,40,0.40)" }
    : { grid: "rgba(255,255,255,0.055)", label: "rgba(160,175,195,0.5)", axis: "rgba(255,255,255,0.16)", cursor: "rgba(255,255,255,0.28)" };
}

/** Turn a channel colour into rgba with alpha. */
function hexA(color: string, alpha: number): string {
  const hex = resolveColor(color);
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
