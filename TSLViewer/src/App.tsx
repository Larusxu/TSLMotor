import { useEffect, useMemo, useRef, useState } from "react";

import { AppProvider, useApp } from "./lib/app-store";
import { api, HAS_TAURI } from "./lib/api";
import { BAUD_RATES } from "./lib/presets";
import { pwmHz } from "./lib/units";
import { ArmSwitch, Badge, Button, Icon, SelectField, Toasts } from "./components/ui";
import { SettingsDialog } from "./components/Settings";

import MotorEnable from "./components/MotorEnable";
import HandIdentity from "./components/HandIdentity";
import Overview from "./pages/Overview";
import Encoder from "./pages/Encoder";
import Homing from "./pages/Homing";
import Axis from "./pages/Axis";
import Tuning from "./pages/Tuning";
import LoopTest from "./pages/LoopTest";
import Registers from "./pages/Registers";
import Sequence from "./pages/Sequence";
import Logs from "./pages/Logs";
import Storage from "./pages/Storage";

type Page =
  | "overview"
  | "encoder"
  | "homing"
  | "axis"
  | "tuning"
  | "looptest"
  | "storage"
  | "registers"
  | "sequence"
  | "logs";

/** Pages that only matter while commissioning; hidden in production mode. */
const OP_ONLY = new Set<Page>(["encoder", "homing", "axis", "tuning", "looptest", "storage", "registers"]);

const NAV: {
  group: string;
  items: { id: Page; label: string; hint: string; icon: React.ReactNode }[];
}[] = [
  {
    group: "工作区",
    items: [
      { id: "overview", label: "运行概览", hint: "RUN", icon: <Icon.Gauge /> },
      { id: "encoder", label: "编码器与对齐", hint: "SSI", icon: <Icon.Encoder /> },
      { id: "homing", label: "机械找零", hint: "HOME", icon: <Icon.Target /> },
      { id: "axis", label: "机械行程", hint: "AXIS", icon: <Icon.Ruler /> },
    ],
  },
  {
    group: "调校",
    items: [
      { id: "tuning", label: "PID 与限幅", hint: "TUNE", icon: <Icon.Tuning /> },
      { id: "looptest", label: "环路测试", hint: "LOOP", icon: <Icon.Gauge /> },
      { id: "storage", label: "板载存储", hint: "EEPROM", icon: <Icon.Save /> },
      { id: "registers", label: "寄存器", hint: "MAP", icon: <Icon.Registers /> },
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
  axis: {
    title: "机械行程",
    desc: "丝杆导程换算、软限位保护与受控运动。撞机械限位之前，先让软件把闸拉下来。",
    crumb: "TRAVEL GUARD",
  },
  tuning: {
    title: "PID 与限幅",
    desc: "三级级联参数、单位换算与阶跃响应实测。电流归一化选错会让增益差 256 倍。",
    crumb: "TUNING",
  },
  looptest: {
    title: "环路测试",
    desc: "在受保护的行程内做恒 Iq / 恒速度探测、速度 PI 自动辨识与位置环跟随测试，并看波形。",
    crumb: "LOOP TEST",
  },
  storage: {
    title: "板载存储",
    desc: "把标定值写进板上的 M24C02 EEPROM：掉电不丢，换 PC 不用重新对齐。",
    crumb: "EEPROM",
  },
  registers: {
    title: "寄存器",
    desc: "TMC6460 全部 189 个寄存器的读取、位编辑与快照对比。",
    crumb: "REGISTER MAP",
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
  const app = useApp();
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
          <div className="rail-meta">
            <span>构建</span>
            <b>{HAS_TAURI ? "desktop" : "preview"}</b>
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
              value={app.mode==="main485"?460800:app.mode==="maincan"?2000000:app.baud}
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

          <ArmSwitch armed={app.armed} onToggle={app.setArmed} disabled={!app.connected} />
          {app.mode!=="direct" && (
            <>
              <div style={{ width: 86 }}>
                <SelectField
                  label="电机"
                  value={app.motor}
                  onChange={app.setMotor}
                  disabled={app.busy}
                  options={Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `M${i + 1}` }))}
                />
              </div>
              <MotorEnable />
            </>
          )}
          <Button
            variant="danger"
            icon={<Icon.Stop width={13} height={13} />}
            onClick={() => {
              void api.emergencyStop();
              app.setArmed(false);
              app.toast("warn", "已请求急停；请确认运动与供电反馈");
            }}
            title="立即关闭 PWM 与驱动使能"
          >
            急停
          </Button>

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

        <main className="content" ref={contentRef}>
          <div className="page-enter" key={page}>
            {page === "overview" && <Overview />}
            {page === "encoder" && <Encoder />}
            {page === "homing" && <Homing />}
            {page === "axis" && <Axis />}
            {page === "tuning" && <Tuning />}
            {page === "looptest" && <LoopTest />}
            {page === "storage" && <Storage />}
            {page === "registers" && <Registers />}
            {page === "sequence" && <Sequence />}
            {page === "logs" && <Logs />}
          </div>
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
