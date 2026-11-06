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
  const on = app.mode === "direct" ? app.motorTmc === "online" : semanticFresh(app.semantic) && app.semantic.motor === app.motor && !!app.semantic.state?.logic_power;

  const disabled = !app.connected || app.busy || running || app.acquiring;
  const title = !app.connected
    ? "先连接主控"
    : on
        ? app.mode === "direct" ? `M${app.motor} CHIP.ID 已响应` : `点击关闭 M${app.motor} 逻辑供电`
        : app.mode === "direct" ? `检查 M${app.motor} CHIP.ID` : `初始化 M${app.motor} 并校验配置，不启动运动`;

  async function run() {
    setRunning(true);
    try {
      if(on&&app.mode!=="direct")await app.disableMotor();
      else await app.enableMotor();
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
      {`M${app.motor} · ${running ? (on ? "关闭中" : "使能中") : !known ? "未确认" : on ? "已使能" : "未使能"}`}
    </button>
  );
}
