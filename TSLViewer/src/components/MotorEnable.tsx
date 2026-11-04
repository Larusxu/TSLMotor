import { useState } from "react";

import { semanticFresh } from "../lib/semantic-state";
import { useApp } from "../lib/app-store";

/**
 * One-click "power this motor and confirm the TMC answers".
 * Red = not enabled, green = CHIP.ID answered after power-on.
 */
export default function MotorEnable() {
  const app = useApp();
  const [running, setRunning] = useState(false);
  const known = app.mode === "direct" || (app.connected && app.semantic.motor === app.motor && semanticFresh(app.semantic));
  const on = app.mode === "direct" ? app.motorTmc === "online" : semanticFresh(app.semantic) && app.semantic.motor === app.motor && !!app.semantic.state?.logic_power && !!app.semantic.state?.config_verified && !app.semantic.state?.fault;
  const initializing = app.mode !== "direct" && semanticFresh(app.semantic) && app.semantic.motor === app.motor && app.semantic.state?.drive === 1;

  const disabled = !app.connected || !app.armed || app.busy || running || initializing;
  const title = !app.connected
    ? "先连接主控"
    : !app.armed
      ? "需先解锁 ARM 再上电"
      : on
        ? app.mode === "direct" ? `M${app.motor} CHIP.ID 已响应` : `M${app.motor} 逻辑供电与配置已就绪；运动仍需授权`
        : app.mode === "direct" ? `检查 M${app.motor} CHIP.ID` : `初始化 M${app.motor} 并校验配置，不启动运动`;

  async function run() {
    setRunning(true);
    try {
      await app.enableMotor();
    } finally {
      setRunning(false);
    }
  }

  return (
    <button
      className={`enable-pill ${on ? "on" : "off"}`}
      onClick={() => void run()}
      disabled={disabled}
      title={title}
    >
      {`M${app.motor} · ${running || initializing ? "使能中" : !known ? "未确认" : on ? "已使能" : "未使能"}`}
    </button>
  );
}
