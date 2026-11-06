import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useMotorConfiguration } from "../lib/motor-configuration";
import type { MotionMode, ParameterState } from "../lib/motor-control";
import { useApp } from "../lib/app-store";
import { controlApi, type ControlConfig, type ControlState, type ControlCommand } from "../lib/motor-control";
import { Badge, Button, Card, Check, Field, Notice, NumField, SelectField, Stat } from "./ui";

export function MotorControls({ homing }: { homing: boolean }) {
  const app = useApp();
  const draft = useMotorConfiguration(app.motor);
  const cfg = draft.task, setCfg = draft.setTask;
  const [params, setParams] = useState<ParameterState | null>(null);
  const [velocity, setVelocity] = useState(60);
  const velocityMode = cfg.mode.startsWith("velocity");
  const [state, setState] = useState<ControlState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [safe, setSafe] = useState(false);
  const [target, setTarget] = useState(360);
  const [jog, setJog] = useState(60);
  const [sendMode, setSendMode] = useState("release");
  const [profile, setProfile] = useState("recip");
  const [a, setA] = useState(360);
  const [b, setB] = useState(720);
  const [amplitude, setAmplitude] = useState(180);
  const [period, setPeriod] = useState(6);
  const [cycles, setCycles] = useState(1);
  const alive = useRef(true);
  const active = useRef(false);
  const jogHeld = useRef(false);
  const revision = useRef(0);
  const lastSlider = useRef(0);
  const rangeSeen = useRef<number | null>(null);
  const enabled = !!state?.enabled && !!state?.active;
  const connected = app.connected && app.mode !== "direct";
  const locked = app.motionActive || busy || homing || app.jobRunning;
  const canMove = connected && enabled && safe && !busy && !homing && !error && state?.safety_phase !== "FAULT_LATCHED";
  const show = (value: number | null | undefined, digits = 1) => value == null ? "—" : value.toFixed(digits);
  const stop = useCallback(async () => {
    revision.current++; jogHeld.current = false; active.current = false;
    try { await controlApi.stop(); } catch (e) { if (alive.current) setError(String(e)); }
  }, []);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(String(e)); app.toast("error", String(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => { setSafe(false); setState(null); setError(""); }, [app.motor]);
  useEffect(() => {
    alive.current = true;
    const interrupt = () => { if (active.current) void stop(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") {
      void stop(); void api.emergencyStop();
    } };
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt); window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      window.removeEventListener("blur", interrupt); window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", visibility);
      if (active.current) void stop();
      app.setMotionActive(false);
    };
  }, [stop]);
  useEffect(() => {
    if (!connected) { setState(null); app.setMotionActive(false); if (active.current) void stop(); return; }
    let disposed = false, pending = false;
    const tick = async () => {
      if (pending || app.jobRunning || homing) return;
      pending = true;
      try {
        if (active.current && !connected) await stop();
        if (active.current) await controlApi.pulse();
        const control = await controlApi.state();
        const parameters = await controlApi.parameters(app.motor);
        if (!disposed) setParams(parameters);
        if (disposed) return;
        if (control.active || active.current) {
          setState(control); app.setMotionActive(control.active); active.current = control.active;
          if (!control.active) setError(control.message);
        } else {
          const s = await controlApi.read(app.motor);
          if (!disposed) { setState(s); setError(""); }
        }
      } catch (e) { if (!disposed) setError(String(e)); }
      finally { pending = false; }
    };
    void tick(); const timer = window.setInterval(tick, 250);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [connected, app.motor, app.jobRunning, homing, stop]);
  useEffect(() => {
    if (!state?.zero_valid) { rangeSeen.current = null; return; }
    if (!state.active && state.travel_deg != null && rangeSeen.current !== state.travel_deg) {
      rangeSeen.current = state.travel_deg;
      setCfg(c => ({ ...c, min_deg: 0, max_deg: state.travel_deg! }));
      setSafe(false);
    }
  }, [state?.zero_valid, state?.active, state?.travel_deg]);
  const command = async (kind: ControlCommand["kind"], value = target, rpm = 0) => {
    await controlApi.command({ kind, target: value, b, amplitude, period_s: period, cycles, rpm });
  };
  const enable = () => run(async () => {
    if (!safe) throw Error("请确认安全条件");
    await app.stopStream();
    await controlApi.start({ ...cfg, motor: app.motor, poles: app.cal.poles });
    active.current = true; app.setMotionActive(true);
  });
  const startJog = async (sign: number) => {
    if (!canMove || jogHeld.current) return;
    const token = ++revision.current; jogHeld.current = true;
    try {
      await command("jog", target, sign * jog);
      if (token !== revision.current || !jogHeld.current) await command("hold");
    } catch (e) { setError(String(e)); await stop(); }
  };
  const endJog = () => {
    if (!jogHeld.current) return;
    jogHeld.current = false; revision.current++;
    void command("hold").catch(() => stop());
  };
  const sendTarget = (value: number) => {
    if (canMove) void run(() => command("goto", value));
  };
  const patch = (key: keyof ControlConfig, value: number | boolean | string) => { setSafe(false); setCfg(c => ({ ...c, [key]: value })); };
  return <div className="grid" style={{ gap: 14 }}>
    <Card bodyClass="stack" title="电机控制" sub={`M${app.motor} · 主控485 / CAN → TMC6460`} right={<Badge tone={enabled ? "warn" : "neutral"}>{enabled ? "输出使能" : "输出关闭"}</Badge>}>
      <div className="row-wrap" style={{ gap: 8 }}>
        <Button disabled={!connected || locked} onClick={() => void run(app.enableMotor)}>逻辑上电</Button>
        <Button variant="primary" disabled={!connected || locked || !safe || !state?.zero_valid || !params?.consistent || state?.safety_phase === "FAULT_LATCHED"} onClick={enable}>启动电机（使能输出）</Button>
        <Button onClick={() => void stop()}>停止电机（断使能）</Button>
        <Button disabled={!enabled || !cfg.mode.endsWith("ramp")} onClick={() => void run(() => command("decel_stop"))}>正常减速停止</Button>
        <Button disabled={!connected || locked || state?.safety_phase !== "FAULT_LATCHED"} onClick={() => void run(() => controlApi.clearSafety(app.motor))}>清除软件故障</Button>
        <Button variant="danger" onClick={() => { void stop(); void api.emergencyStop();  }}>急停 · ESC</Button>
      </div>
      <div className="grid cols-4" style={{ gap: 10 }}>
        <Field label="运动模式"><div className="input-wrap"><select aria-label="运动模式" disabled={locked} value={cfg.mode} onChange={e => { setSafe(false); setCfg(c => ({ ...c, mode: e.target.value as MotionMode, planning: "limits" })); }}>
          <optgroup label="闭环运动">
            <option value="position_direct">位置直通 · POSITION</option><option value="position_ramp">位置插补 · 原生 Ramp</option>
            <option value="velocity_direct">速度直通 · VELOCITY</option><option value="velocity_ramp">速度斜坡 · 原生 Ramp</option>
          </optgroup>
          <optgroup label="芯片其它模式 · 仅列示，使用专用调试流程">
            <option disabled>PWM_OFF · 断使能按钮</option><option disabled>PWM_ON · 固定50%占空比</option>
            <option disabled>TORQUE · 转矩直通</option><option disabled>VOLTAGE_EXT · 开环电压</option><option disabled>PWM_EXT · 外部占空比</option>
            <option disabled>PRBS_UD / FLUX / TORQUE / VELOCITY / POSITION · 环路辨识</option>
          </optgroup>
        </select></div></Field>
        {cfg.mode === "position_ramp" && <Field label="规划方式"><SelectField disabled={locked} value={cfg.planning} onChange={v => patch("planning", v)} options={[{ value: "limits", label: "速度 / 加减速度（默认）" }, { value: "time", label: "指定时间（运动学估算）" }]} /></Field>}
        <Field label="任务速度限制" hint="与PID驱动器上限取较小值"><NumField disabled={locked} value={cfg.max_rpm} onChange={v => patch("max_rpm", v)} min={1} max={6000} unit="RPM" /></Field>
        <Field label="任务转矩电流限制"><NumField disabled={locked} value={cfg.limit_ma} onChange={v => patch("limit_ma", v)} min={50} max={1050} unit="mA" /></Field>
        <Field label="持续过流阈值" hint="abs(Iq)，0x153高16位"><NumField disabled={locked} value={cfg.trip_ma} onChange={v => patch("trip_ma", v)} min={50} max={1200} unit="mA" /></Field>
        {cfg.mode === "position_ramp" && cfg.planning === "time" && <Field label="位置过渡时间"><NumField disabled={locked} value={cfg.duration_ms} onChange={v => patch("duration_ms", v)} min={1} max={10000} unit="ms" /></Field>}
        {cfg.mode.endsWith("ramp") && <>
          <Field label="最大加速度"><NumField disabled={locked} value={cfg.accel_deg_s2} onChange={v => patch("accel_deg_s2", v)} min={1} max={1000000} unit="°/s²" /></Field>
          <Field label="最大减速度" hint={cfg.mode === "velocity_ramp" ? "速度Ramp须与加速度相同" : "位置Ramp的D_MAX"}><NumField disabled={locked} value={cfg.decel_deg_s2} onChange={v => patch("decel_deg_s2", v)} min={1} max={1000000} unit="°/s²" /></Field>
        </>}
        <Field label="过流持续时间"><NumField disabled={locked} value={cfg.over_ms} onChange={v => patch("over_ms", v)} min={10} max={10000} unit="ms" /></Field>
        <Field label="保护采样周期" hint="期望周期，实际包含串口往返"><NumField disabled={locked} value={cfg.sample_ms} onChange={v => patch("sample_ms", v)} min={20} max={1000} unit="ms" /></Field>
        <Field label="通信超时"><NumField disabled={locked} value={cfg.comm_timeout_ms} onChange={v => patch("comm_timeout_ms", v)} min={100} max={5000} unit="ms" /></Field>
        <Field label="软件保护动作"><SelectField disabled={locked} value={cfg.fault_action} onChange={v => patch("fault_action", v)} options={[{ value: "disable", label: "锁存并安全禁能" }, { value: "controlled_stop", label: "受控减速后禁能（Ramp）" }]} /></Field>
        <Field label="实际生效电流 · 只读"><div className="mono">{show(state?.active ? state.effective_current_ma : params?.effective_current_ma)} mA</div></Field>
        <Field label="实际生效速度 · 只读"><div className="mono">{show(state?.active ? state.effective_velocity_rpm : params?.effective_velocity_rpm)} RPM</div></Field>
      </div>
      <div className="row-wrap" style={{ gap: 10 }}>
        <Button disabled={!connected || locked || !params?.driver} onClick={() => void run(async () => { await controlApi.limits({ ...cfg, motor: app.motor, poles: app.cal.poles }); setParams(await controlApi.parameters(app.motor)); app.toast("ok", "任务参数已应用并读回；输出仍关闭"); })}>应用参数（不启动运动）</Button>
        <Button disabled={!connected || locked} onClick={() => void run(async () => { await api.readPid(); setParams(await controlApi.parameters(app.motor)); })}>读取驱动器档案</Button>
        <span className="tiny muted">机构正向对应芯片负向；65536计数/圈。插补/斜坡由芯片Ramp执行，模式修改需先断使能。</span>
      </div>
      <div className="tiny muted">驱动器档案：{params?.consistent ? "已核对" : "未核对 / 不一致"} · {params?.message || "先在PID页读取或应用档案"} · 软件保护：{state?.safety_phase ?? "NORMAL"}</div>
      <Notice tone="warn">持续过流监测运行在桌面后端，依赖通信与采样延迟；上位机退出后不再持续采样。主控已有5秒会话断电保护，不能替代芯片硬件OCP、短路和过温保护。</Notice>
      {cfg.planning === "time" && <Notice tone="warn">目标时间只做静止起点的运动学可行性估算；不保证带载精确到位，不会自动提高任何限幅。</Notice>}
      <Check checked={safe} onChange={setSafe}>已核对方向、实际行程及限流，机构空间安全</Check>
      {!state?.zero_valid && <Notice tone="warn">行程零点无效：先在本页完成找零；历史对齐结果不能代替当前零点。</Notice>}
      {error && <div role="alert"><Notice tone="warn">{error}</Notice></div>}
    </Card>
    <div className="grid cols-3">
      <Stat label="位置 · 电机端" value={show(state?.position)} unit="°" />
      <Stat label="机械转速（方向已适配）" value={show(state?.rpm)} unit="RPM" />
      <Stat label="q轴电流" value={show(state?.iq_ma)} unit="mA" />
    </div>
    <div className="row-wrap tiny muted" style={{ gap: 16 }}>
      <span>故障：{state?.fault == null ? "不可读" : `0x${state.fault.toString(16).toUpperCase()}`}</span>
      <span>电角度偏移：{state?.offset ?? "—"}</span><span>零点：{state?.zero_valid ? "有效" : "无效"}</span>
      <span>母线电压 / 温度：当前协议未提供</span><span>{state?.message}</span>
    </div>
    <div className="homing-split">
      <Card bodyClass="stack" title="手动点动" sub={velocityMode ? "按住速度目标 · 松开速度归零" : "按住推进 · 松开保持当前位置"}>
        <Field label="点动速度"><NumField disabled={enabled && state?.kind === "jog"} value={jog} onChange={setJog} min={1} max={cfg.max_rpm} unit="RPM" /></Field>
        <div className="row-wrap" style={{ gap: 8 }}>
          {([-1, 1] as const).map(sign => <button key={sign} type="button" className="btn" disabled={!canMove}
            onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); void startJog(sign); }}
            onPointerUp={endJog} onPointerCancel={endJog} onLostPointerCapture={endJog}
            onKeyDown={e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); void startJog(sign); } }}
            onKeyUp={endJog} onBlur={endJog}>{sign > 0 ? "正向 +" : "负向 −"}（按住）</button>)}
          <Button onClick={() => void run(() => command("hold"))} disabled={!enabled}>{velocityMode ? "速度目标归零" : "保持当前位置"}</Button>
        </div>
        <div className="tiny muted">目标超前量不超过5拍行程（最少3°）。失焦、隐藏页面或页面心跳超过1秒时停止输出。</div>
      </Card>
      {velocityMode && <Card title="速度运动" sub="目标与速度限制分开">
        <Field label="速度目标"><NumField value={velocity} onChange={setVelocity} min={-cfg.max_rpm} max={cfg.max_rpm} unit="RPM" /></Field>
        <Button variant="primary" disabled={!canMove} onClick={() => void run(() => command("velocity", 0, velocity))}>发送速度目标</Button>
      </Card>}
      {!velocityMode && <Card bodyClass="stack" title="绝对位置" sub="相对机械零点 · 电机端角度">
        <div className="grid cols-4" style={{ gap: 10 }}>
          <Field label="位置目标"><NumField value={target} onChange={setTarget} min={cfg.min_deg} max={cfg.max_deg} unit="°" /></Field>
          <Field label="发送方式"><SelectField value={sendMode} onChange={v => setSendMode(String(v))} options={[{ value: "release", label: "松开后发送" }, { value: "live", label: "实时发送（合并最新目标）" }]} /></Field>
        </div>
        <input aria-label="绝对位置目标滑条" type="range" min={cfg.min_deg} max={cfg.max_deg} step={0.01} value={target} disabled={!canMove} style={{ width: "100%" }}
          onChange={e => { const v = Number(e.target.value); setTarget(v); if (sendMode === "live" && performance.now() - lastSlider.current >= 60) { lastSlider.current = performance.now(); sendTarget(v); } }}
          onPointerUp={e => sendTarget(Number(e.currentTarget.value))} onKeyUp={e => sendTarget(Number(e.currentTarget.value))} />
        <div className="row-wrap" style={{ gap: 8 }}><Button variant="primary" disabled={!canMove} onClick={() => sendTarget(target)}>前往</Button>
          <span className="tiny muted">电机端 {show(target)}°；超过行程的数值由后端拒绝。</span></div>
      </Card>}
    </div>
    <Card bodyClass="stack" title="工况运行" sub="实际电机运动 · 停止工况后仍有保持力矩">
      <div className="grid cols-4" style={{ gap: 10 }}>
        <Field label="工况"><SelectField value={profile} onChange={v => setProfile(String(v))} options={[{ value: "goto", label: "保持位置" }, { value: "recip", label: "往复" }, { value: "sine", label: "正弦" }]} /></Field>
        <Field label="A / 保持 / 中心"><NumField value={a} onChange={setA} unit="°" /></Field>
        {profile === "recip" && <Field label="B"><NumField value={b} onChange={setB} unit="°" /></Field>}
        {profile === "sine" && <Field label="幅值"><NumField value={amplitude} onChange={setAmplitude} min={0} unit="°" /></Field>}
        {profile !== "goto" && <Field label="完整周期"><NumField value={period} onChange={setPeriod} min={0.2} max={3600} unit="s" /></Field>}
        {profile !== "goto" && <Field label="循环数（0=无限）"><NumField value={cycles} onChange={setCycles} min={0} max={100000} /></Field>}
      </div>
      <div className="row-wrap" style={{ gap: 8 }}>
        <Button variant="primary" disabled={!canMove || velocityMode || (profile === "sine" && cfg.mode !== "position_direct")} onClick={() => void run(() => command(profile as ControlCommand["kind"], a))}>启动工况</Button>
        <Button disabled={!enabled} onClick={() => void run(() => command("stop_profile"))}>停止工况（保持最后目标）</Button>
        <span className="tiny muted">{state?.kind ?? "idle"} · 已完成 {state?.cycles ?? 0} 周期</span>
      </div>
    </Card>
  </div>;
}
