export default function Gauge({ angle, label, sub }: { angle: number; label: string; sub?: string }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const frac = ((angle % 360) + 360) % 360 / 360;
  return (
    <div className="gauge-wrap">
      <svg width="128" height="128" viewBox="0 0 128 128">
        <defs>
          <linearGradient id="gg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2ee6e6" />
            <stop offset="100%" stopColor="#6ea8fe" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="6" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="url(#gg)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 64 64)"
          style={{ filter: "drop-shadow(0 0 6px rgba(46,230,230,.5))", transition: "stroke-dasharray 160ms linear" }}
        />
        <g transform={`rotate(${angle} 64 64)`}>
          <line x1="64" y1="64" x2="64" y2="26" stroke="#f5b544" strokeWidth="2" strokeLinecap="round" />
          <circle cx="64" cy="26" r="3" fill="#f5b544" />
        </g>
        <circle cx="64" cy="64" r="3.4" fill="#2ee3e3" />
        <text x="64" y="104" textAnchor="middle" fontSize="15" fontFamily="Cascadia Code, Consolas, monospace" fill="#e8eef7">
          {angle.toFixed(1)}°
        </text>
        <text x="64" y="118" textAnchor="middle" fontSize="8.5" fill="#6d7b8e" letterSpacing="1.6">
          {label}
        </text>
      </svg>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

