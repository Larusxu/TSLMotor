import React, { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ icons */

const S = (p: React.SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const Icon = {
  Gauge: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      <path d="m13.4 10.6 3.6-3.6" />
      <path d="M20.3 17a9 9 0 1 0-16.6 0" />
    </svg>
  ),
  Encoder: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6" />
    </svg>
  ),
  Align: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" />
    </svg>
  ),
  Tuning: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M4 7h9M17 7h3M4 17h4M12 17h8" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  ),
  Registers: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M9 9.5V20" />
    </svg>
  ),
  Sequence: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.8l6 3.2-6 3.2V8.8Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  Logs: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="m6.5 9 3 3-3 3M12.5 15h5" />
    </svg>
  ),
  Bolt: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M13 2.5 5.5 13.5H11l-1 8 7.5-11H12l1-8Z" />
    </svg>
  ),
  Stop: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  Power: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M12 3v9" />
      <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
    </svg>
  ),
  Refresh: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 4.5V11h-6.3" />
    </svg>
  ),
  Search: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.1 4.1" />
    </svg>
  ),
  Chevron: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  ),
  Check: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  ),
  Alert: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M12 3.5 21 20H3l9-16.5Z" />
      <path d="M12 9.5v4.2M12 16.8v.2" />
    </svg>
  ),
  Info: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8v.2" />
    </svg>
  ),
  Save: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M5 4h11l3 3v13H5V4Z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </svg>
  ),
  Cpu: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M10 2.8v2.7M14 2.8v2.7M10 18.5v2.7M14 18.5v2.7M2.8 10h2.7M2.8 14h2.7M18.5 10h2.7M18.5 14h2.7" />
    </svg>
  ),
  Folder: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l2 2.4h7.8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.5Z" />
    </svg>
  ),
  Target: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 2.2v3.4M12 18.4v3.4M2.2 12h3.4M18.4 12h3.4" />
    </svg>
  ),
  Gear: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.6v2.3M12 19.1v2.3M4.1 7.5l2 1.15M17.9 15.35l2 1.15M4.1 16.5l2-1.15M17.9 8.65l2-1.15" />
    </svg>
  ),
  Sun: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.55 1.55M17.25 17.25 18.8 18.8M18.8 5.2l-1.55 1.55M6.75 17.25 5.2 18.8" />
    </svg>
  ),
  Moon: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" />
    </svg>
  ),
  Close: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  Ruler: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="m3.6 14.6 11-11 5.8 5.8-11 11-5.8-5.8Z" />
      <path d="m7.2 11 1.8 1.8M10 8.2l1.8 1.8M12.8 5.4l1.8 1.8" />
    </svg>
  ),
  Grid: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </svg>
  ),
  List: (p: React.SVGProps<SVGSVGElement>) => (
    <svg {...S(p)}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ atoms */

export function Card({
  title,
  right,
  children,
  className = "",
  bordered = true,
  bodyClass = "",
}: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bordered?: boolean;
  bodyClass?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className={`card-head ${bordered ? "bordered" : ""}`}>
          <div className="grow">{title && <div className="card-title">{title}</div>}</div>
          {right}
        </header>
      )}
      {children && <div className={`card-body ${bodyClass}`}>{children}</div>}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  style,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="field" style={style}>
      <label>
        <span className="lb">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function NumField({
  value,
  onChange,
  unit,
  step = 1,
  min,
  max,
  disabled,
  placeholder,
  width,
  label,
  readOnly,
  clampOnCommit = true,
  onCommit,
}: {
  value: number | string;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  placeholder?: string;
  width?: number | string;
  /** 可访问名称（`Field` 的 label 与输入框没有 association，需要时单独给）。 */
  label?: string;
  readOnly?: boolean;
  /** Keep configuration edits visible; validation can reject instead of silently clamping. */
  clampOnCommit?: boolean;
  onCommit?: (value:number)=>void;
}) {
  const [text, setText] = useState(String(value));
  const [focus, setFocus] = useState(false);
  const focusValue=useRef(value);
  useEffect(() => {
    if (!focus) setText(String(value));
  }, [value, focus]);

  const commit = (raw: string) => {
    if (readOnly) return;
    const n = Number(raw);
    if (Number.isFinite(n)) {
      let v = n;
      if (clampOnCommit && min !== undefined) v = Math.max(min, v);
      if (clampOnCommit && max !== undefined) v = Math.min(max, v);
      onChange(v);
      setText(String(v));
      if(onCommit && v!==Number(focusValue.current)){focusValue.current=v;onCommit(v);}
    } else {
      setText(String(value));
    }
  };

  return (
    <div className="input-wrap" style={{ width }}>
      <input
        value={text}
        inputMode="decimal"
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        readOnly={readOnly}
        onFocus={() => {focusValue.current=value;setFocus(true);}}
        onBlur={() => {
          setFocus(false);
          commit(text);
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n) && e.target.value !== "" && e.target.value !== "-") onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp") {
            e.preventDefault();
            commit(String(Number(text) + step));
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            commit(String(Number(text) - step));
          }
        }}
      />
      {unit && <span className="suffix">{unit}</span>}
    </div>
  );
}

export function HexField({
  value,
  onChange,
  width,
  disabled,
  bits = 32,
  onClick,
}: {
  value: number;
  onChange?: (v: number) => void;
  width?: number | string;
  disabled?: boolean;
  bits?: 16 | 32;
  /** 只读框的被点击提示：给了就没有可编辑性，点击只回调这里。 */
  onClick?: () => void;
}) {
  const fmt = (v: number) =>
    "0x" + (v >>> 0).toString(16).toUpperCase().padStart(bits / 4, "0");
  const [text, setText] = useState(fmt(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmt(value));
  }, [value, focus, bits]);

  const commit = (raw: string) => {
    const clean = raw.trim().replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "");
    const n = parseInt(clean, 16);
    if (Number.isFinite(n)) {
      onChange?.(bits === 16 ? n & 0xffff : n >>> 0);
      setText(fmt(bits === 16 ? n & 0xffff : n >>> 0));
    } else setText(fmt(value));
  };

  return (
    <div className="input-wrap" style={{ width }}>
      <input
        className="mono"
        value={text}
        disabled={disabled}
        readOnly={!onChange}
        onClick={onClick}
        style={onClick ? { cursor: "not-allowed" } : undefined}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false);
          commit(text);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        spellCheck={false}
      />
    </div>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number | string;
}) {
  return (
    <div className="input-wrap" style={{ width }}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontFamily: "var(--font-ui)" }}
      />
    </div>
  );
}

export function SelectField<T extends string | number>({
  value,
  onChange,
  options,
  width,
  disabled,
  label,
  onClick,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  width?: number | string;
  disabled?: boolean;
  label?: string;
  /** 固定项的被点击提示：给了就不展开下拉，点击只回调这里。 */
  onClick?: () => void;
}) {
  return (
    <div className="input-wrap" style={{ width, position: "relative" }}>
      <select
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        onMouseDown={(e) => {
          if (onClick) e.preventDefault();
        }}
        onClick={onClick}
        style={onClick ? { cursor: "not-allowed" } : undefined}
        onChange={(e) => {
          const found = options.find((o) => String(o.value) === e.target.value);
          if (found) onChange(found.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="select-caret">
        <Icon.Chevron width={13} height={13} />
      </span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  size,
  disabled,
  icon,
  block,
  title,
  className = "",
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm";
  disabled?: boolean;
  icon?: React.ReactNode;
  block?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      className={`btn ${variant} ${size ?? ""} ${block ? "block" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  dot,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent";
  dot?: "on" | "live" | "err" | "warn";
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className={`led ${dot}`} />}
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** Sliding on/off switch for a single MAX20087 output channel. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "danger" | "ok";
  children: React.ReactNode;
}) {
  const icon =
    tone === "danger" || tone === "warn" ? <Icon.Alert /> : tone === "ok" ? <Icon.Check /> : <Icon.Info />;
  return (
    <div className={`notice ${tone}`}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

/* --------------------------------------------------------------- sparkline */

export function Sparkline({
  data,
  color = "var(--accent)",
  height = 34,
  fill = true,
}: {
  data: number[];
  color?: string;
  height?: number;
  fill?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 120;
    const h = height;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) return;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const x = (i: number) => (i / (data.length - 1)) * w;
    const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
    ctx.beginPath();
    data.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(46,230,230,0.20)");
      g.addColorStop(1, "rgba(46,230,230,0)");
      ctx.fillStyle = g;
      ctx.fill();
    }
  }, [data, color, height, fill]);
  return <canvas ref={ref} className="stat-spark" style={{ height }} />;
}

/* ----------------------------------------------------------------- stepper */

export interface StepState {
  idx: number;
  total: number;
  label: string;
  status: "run" | "ok" | "fail" | "info";
  detail: string;
}

/**
 * 流程步骤列表：高度固定（不随内容增长），超出后自己滚。
 * 默认自动跟随最新一步；用户用滚轮往上翻时暂停跟随，滚回底部自动恢复。
 */
/**
 * 步骤框里的 detail 只显示"标题级"短语：遇到第一个标点就截断。
 * 完整原文仍然写进运行日志（见 app-store 的 job 日志），这里只求框内读得下。
 */
function shortDetail(detail: string): string {
  const d = detail.trim();
  if (!d) return "";
  const cut = d.split(/[，,；;、（(]/)[0].trim();
  return cut || d;
}

export function Steps({
  steps,
  height = 232,
  emptyText = "尚未执行",
}: {
  steps: StepState[];
  height?: number;
  emptyText?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [paused, setPaused] = useState(false);

  const atBottom = (el: HTMLDivElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= 6;

  useEffect(() => {
    const el = boxRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [steps]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const bottom = atBottom(el);
    followRef.current = bottom;
    setPaused(!bottom);
  };

  const jumpToLatest = () => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setPaused(false);
  };

  return (
    <div className="steps-box" style={{ height }}>
      <div
        className="steps-scroll"
        ref={boxRef}
        onScroll={onScroll}
        onWheel={(e) => {
          // 往上翻即暂停跟随，避免"正看着被拽走"
          if (e.deltaY < 0) {
            followRef.current = false;
            setPaused(true);
          }
        }}
      >
        {steps.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : (
          <div className="steps">
            {steps.map((s, i) => (
              <div key={`${s.idx}-${i}`} className={`step ${s.status}`}>
                <span className="idx">{String(s.idx).padStart(2, "0")}</span>
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  <span className="dot" />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.label}
                  </span>
                </span>
                <span className="detail">{shortDetail(s.detail)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {paused && steps.length > 0 && (
        <button className="steps-paused" onClick={jumpToLatest} title="回到底部并恢复自动跟随">
          已暂停跟随 · 跳到最新
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- bits */

export function BitGrid({
  value,
  onChange,
  readonly,
  from = 31,
  to = 0,
}: {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
  from?: number;
  to?: number;
}) {
  const bits: number[] = [];
  for (let i = from; i >= to; i--) bits.push(i);
  return (
    <div className="bits">
      {bits.map((i) => {
        const on = ((value >>> i) & 1) === 1;
        return (
          <button
            key={i}
            className={`bit ${on ? "on" : ""} ${readonly ? "ro" : ""}`}
            onClick={() => {
              if (readonly || !onChange) return;
              onChange((value ^ (1 << i)) >>> 0);
            }}
            title={`bit ${i}`}
            style={on ? { boxShadow: "inset 0 0 0 1px rgba(46,230,230,.25)" } : undefined}
          >
            <span className="n">{i}</span>
            {on ? 1 : 0}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ toasts */

export interface ToastItem {
  id: number;
  tone: "ok" | "warn" | "error" | "info";
  text: string;
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!items.length) return;
    const timers = items.map((t) => window.setTimeout(() => onDismiss(t.id), 4200));
    return () => timers.forEach(clearTimeout);
  }, [items, onDismiss]);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone==="error"?"alert":"status"} onClick={() => onDismiss(t.id)}>
          <span className="bar" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- misc */

export function Stat({
  label,
  value,
  unit,
  delta,
  spark,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: React.ReactNode;
  spark?: number[];
  tone?: string;
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {delta !== undefined && <div className="stat-delta">{delta}</div>}
      {spark && spark.length > 2 && <Sparkline data={spark} />}
    </div>
  );
}

export function KV({
  rows,
  cols = 1,
}: {
  rows: [React.ReactNode, React.ReactNode][];
  /** Lay the pairs out in N columns so a wide card doesn't stretch them. */
  cols?: number;
}) {
  return (
    <dl className={`kv${cols > 1 ? ` kv-${cols}` : ""}`}>
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
