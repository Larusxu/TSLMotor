import { useEffect, useMemo, useRef, useState } from "react";

import { AppProvider, useApp } from "./lib/app-store";
import { BAUD_RATES } from "./lib/presets";
import { pwmHz } from "./lib/units";
import { Badge, Button, Icon, SelectField, Toasts } from "./components/ui";
import { SettingsDialog } from "./components/Settings";

import Cylinders, { CylinderToolbar } from "./pages/Cylinders";
import { useCylinders } from "./lib/cylinder";
import MotorToolbar from "./components/MotorToolbar";
import HandIdentity from "./components/HandIdentity";
import Overview from "./pages/Overview";
import Encoder from "./pages/Encoder";
import Homing from "./pages/Homing";
import Tuning from "./pages/Tuning";
import RegistersConfig from "./pages/RegistersConfig";
import ParameterTuning from "./pages/ParameterTuning";
import MainboardPid from "./pages/MainboardPid";
import TelemetryPanels from "./components/TelemetryPanels";
import LoopTest from "./pages/LoopTest";
import Sequence from "./pages/Sequence";
import Logs from "./pages/Logs";
import Storage from "./pages/Storage";

type Page =
  | "overview"
  | "cylinders"
  | "encoder"
  | "homing"
  | "registers"
  | "tuning"
  | "looptest"
  | "storage"
  | "sequence"
  | "logs";

/** Pages that only matter while commissioning; hidden in production mode. */
const OP_ONLY = new Set<Page>(["encoder", "homing", "tuning", "registers", "looptest", "storage"]);

const NAV: {
  group: string;
  items: { id: Page; label: string; hint: string; icon: React.ReactNode }[];
}[] = [
  {
    group: "工作区",
    items: [
      { id: "overview", label: "运行概览", hint: "RUN", icon: <Icon.Gauge /> },
      { id: "cylinders", label: "电缸控制", hint: "LA", icon: <Icon.Ruler /> },
      { id: "encoder", label: "编码器与对齐", hint: "SSI", icon: <Icon.Encoder /> },
      { id: "homing", label: "电机控制与找零", hint: "MOTION", icon: <Icon.Target /> },
    ],
  },
  {
    group: "调校",
    items: [
      { id: "tuning", label: "PI整定", hint: "TUNE", icon: <Icon.Tuning /> },
      { id: "registers", label: "寄存器与配置", hint: "CONFIG", icon: <Icon.Registers /> },
      { id: "looptest", label: "环路测试", hint: "LOOP", icon: <Icon.Gauge /> },
      { id: "storage", label: "板载存储", hint: "W25 / M24", icon: <Icon.Save /> },
    ],
  },
  {
    group: "生产",
    items: [
      { id: "sequence", label: "自动测试", hint: "QA", icon: <Icon.Sequence /> },
      { id: "logs", label: "运行日志", hint: "LOG", icon: <Icon.Logs /> },
    ],
  },
];

const TITLES: Record<Page, { title: string; desc: string; crumb: string }> = {
  cylinders: { title: "电缸控制", desc: "五路独立电缸的行程、保护参数与实时状态。", crumb: "LINEAR ACTUATORS" },
  overview: {
    title: "运行概览",
    desc: "实时遥测、驱动状态与手动运行。所有数值来自芯片寄存器，不经过任何估算。",
    crumb: "OVERVIEW",
  },
  encoder: {
    title: "编码器与对齐",
    desc: "MT6701 SSI 的引脚复用与反馈通道配置，随后做开环电角度对齐，最后用编码器闭环验证。",
    crumb: "ENCODER · ALIGN",
  },
  homing: {
    title: "机械找零",
    desc: "撞限位建立行程零点。上位机下发方向、步进与工艺参数并显示状态；推进与判据在主控固件。",
    crumb: "HOMING",
  },
  tuning: {
    title: "PI整定",
    desc: "PI 参数、PRBS 系统辨识、整定结果及实时曲线与通道配置。",
    crumb: "PI TUNING",
  },
  registers: {title:"寄存器与配置",desc:"主控控制状态、公共配置及空白电机初始化参数。",crumb:"REGISTERS · CONFIGURATION"},
  looptest: {
    title: "环路测试",
    desc: "在受保护的行程内做恒 Iq / 恒速度探测、速度 PI 自动辨识与位置环跟随测试，并看波形。",
    crumb: "LOOP TEST",
  },
  storage: {
    title: "板载存储",
    desc: "主控 W25 保存完整配置，电机 M24C02 保存编号与电角度偏移备份；保存后由主控读回校验。",
    crumb: "W25 / M24",
  },
  sequence: {
    title: "自动测试",
    desc: "按档位运行并记录转速、电流、温度，导出 CSV 到报告目录。",
    crumb: "SEQUENCE",
  },
  logs: {
    title: "运行日志",
    desc: "串口与任务的完整记录，排障从这里开始。",
    crumb: "LOGS",
  },
};

function Shell() {
  const [page, setPage] = useState<Page>("overview");
  const [tuningVisited, setTuningVisited] = useState(false);
  useEffect(() => { if (page === "tuning") setTuningVisited(true); }, [page]);
  const app = useApp();
  const cylinders = useCylinders(app.connected, page === "cylinders" || page === "overview" || page === "registers", app.acquiring || app.streaming, app.toast);
  const [fps, setFps] = useState(0);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setFps(app.stats?.frame_rate ?? 0);
  }, [app.stats]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);

  const baudOptions = BAUD_RATES.map((b) => ({ value: b, label: `${b.toLocaleString("en-US")} bit/s` }));
  const portOptions = app.ports.length
    ? app.ports.map((p) => ({ value: p.name, label: p.name }))
    : [{ value: app.port, label: app.port }];

  // production mode hides the tuning / calibration pages from the rail
  const nav = useMemo(() => {
    if (app.settings.mode === "op") return NAV;
    return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !OP_ONLY.has(i.id)) })).filter(
      (g) => g.items.length > 0
    );
  }, [app.settings.mode]);

  useEffect(() => {
    if (app.settings.mode !== "op" && OP_ONLY.has(page)) setPage("sequence");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.settings.mode]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="8.6" stroke="#2ee6e6" strokeOpacity="0.55" strokeWidth="1.6" />
              <path d="M4 12c2.2-4.6 5.1-4.6 8 0s5.8 4.6 8 0" stroke="#f5b544" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">TSL Viewer</div>
            <div className="brand-sub">TMC6460 Studio</div>
          </div>
        </div>

        {nav.map((g) => (
          <div key={g.group}>
            <div className="rail-group">{g.group}</div>
            {g.items.map((it) => (
              <button
                key={it.id}
                className={`nav-item ${page === it.id ? "active" : ""}`}
                onClick={() => setPage(it.id)}
              >
                {it.icon}
                <span>{it.label}</span>
                <small>{it.hint}</small>
              </button>
            ))}
          </div>
        ))}

        <div className="rail-foot">
          <HandIdentity />
          <div className="rail-meta">
            <span>链路</span>
            <b style={{ color: app.connected ? "var(--ok)" : "var(--text-3)" }}>
              {app.connected ? `${app.stats?.port ?? "—"}` : "离线"}
            </b>
          </div>
          <div className="rail-meta">
            <span>帧率</span>
            <b>{app.streaming ? `${fps.toFixed(0)}/s` : "—"}</b>
          </div>
          <div className="rail-meta">
            <span>PWM</span>
            <b>{(pwmHz(app.cal.pwmMaxCount) / 1000).toFixed(2)} kHz</b>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>TSL</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <b>{TITLES[page].crumb}</b>
          </div>

          <div className="topbar-spacer" />

          <Badge tone={app.connected ? "ok" : "neutral"} dot={app.connected ? "on" : undefined}>
            {app.connected ? "已连接" : "离线"}
          </Badge>

          <div style={{ width: 168 }}>
            <SelectField label="连接模式" value={app.mode} onChange={app.setMode} disabled={app.connected || app.busy}
              options={[{value:"direct",label:"直连电机板"},{value:"main485",label:"主控 · RS485"},{value:"maincan",label:"主控 · USB-CAN-A"}]} />
          </div>
          <div style={{ width: 116 }}>
            <SelectField
              value={app.port}
              onChange={app.setPort}
              options={portOptions}
              disabled={app.connected}
            />
          </div>
          <div style={{ width: 140 }}>
            <SelectField
              value={app.mode==="main485"?1500000:app.mode==="maincan"?2000000:app.baud}
              onChange={app.setBaud}
              options={baudOptions}
              disabled={app.connected || app.mode!=="direct"}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon.Refresh width={13} height={13} />}
            onClick={() => void app.refreshPorts()}
            disabled={app.connected}
            title="刷新串口列表"
          />
          {app.connected ? (
            <Button variant="ghost" onClick={() => void app.disconnect()}>
              断开
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void app.connect()} disabled={app.busy}>
              {app.busy ? "连接中…" : "连接"}
            </Button>
          )}

          <div style={{ width: 1, height: 22, background: "var(--line)" }} />

          <Button
            size="sm"
            variant="ghost"
            className="set-btn"
            icon={<Icon.Gear width={15} height={15} />}
            onClick={() => app.setSettingsOpen(true)}
            title="设置（工作模式 / 主题）"
          />
        </header>

        {/* 页头固定在顶行：任何页面滚动时标题与说明都不会消失 */}
        <div className="subbar">
          <h1 className="page-title">{TITLES[page].title}</h1>
          <p className="page-desc">{TITLES[page].desc}</p>
        </div>

        {page === "cylinders" ? <CylinderToolbar model={cylinders}/> : page !== "registers" ? <MotorToolbar /> : null}

        <main className="content" ref={contentRef}>
          <div className="page-enter" key={page}>
            {page === "overview" && <Overview cylinders={cylinders}/>}
            {page === "cylinders" && <Cylinders model={cylinders}/>}
            {page === "encoder" && <Encoder />}
            {page === "homing" && <Homing />}
            {page === "registers" && <RegistersConfig cylinders={cylinders} />}
            {page === "looptest" && <LoopTest />}
            {page === "storage" && <Storage />}
            {page === "sequence" && <Sequence />}
            {page === "logs" && <Logs />}
          </div>
          {/* Keep PRBS state across navigation, but never retain an off-screen PID editor
              or telemetry surface. The editor is mounted exactly once for the selected
              motor; changing motors cannot leave visual copies of the old cards. */}
          {(tuningVisited || page === "tuning") && (
            <div className="persistent-tuning" hidden={page !== "tuning"}>
              {app.mode === "direct"
                ? (page === "tuning" ? <Tuning key={app.motor} /> : null)
                : <div className="pi-merged-workspace">
                    {page === "tuning" && <MainboardPid key={app.motor} />}
                    <ParameterTuning key={app.motor} />
                    {page === "tuning" && <TelemetryPanels />}
                  </div>}
            </div>
          )}
        </main>
      </div>

      <SettingsDialog
        open={app.settingsOpen}
        settings={app.settings}
        onChange={app.setSettings}
        onClose={() => app.setSettingsOpen(false)}
      />

      <Toasts items={app.toasts} onDismiss={app.dismissToast} />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
