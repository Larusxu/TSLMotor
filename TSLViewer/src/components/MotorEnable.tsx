import { useState } from "react";

import { useApp } from "../lib/app-store";

/**
 * One-click "power this motor and confirm the TMC answers".
 * Red = not enabled, green = CHIP.ID answered after power-on.
 */
export default function MotorEnable() {
  const app = useApp();
  const [running, setRunning] = useState(false);
  const on = app.motorTmc === "online";

  const disabled = !app.connected || !app.armed || app.busy || running;
  const title = !app.connected
    ? "先连接主控"
    : !app.armed
      ? "需先解锁 ARM 再上电"
      : on
        ? `M${app.motor} 已使能：CHIP.ID 已响应`
        : `给 M${app.motor} 上电并轮询 CHIP.ID`;

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
      {running ? "使能中" : on ? "已使能" : "未使能"}
    </button>
  );
}
