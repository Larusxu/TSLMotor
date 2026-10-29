import { useEffect } from "react";

import { Button, Icon, Segmented } from "./ui";
import type { Settings } from "../lib/settings";

/**
 * Settings sheet. Right now it only switches the work mode and the theme, but
 * it is the natural home for future preferences, so it is a real overlay rather
 * than a dropdown.
 */
export function SettingsDialog({
  open,
  settings,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div className="grow">
            <div className="card-title">设置</div>
            <div className="card-sub">PREFERENCES</div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} title="关闭">
            <Icon.Close width={14} height={14} />
          </Button>
        </header>

        <div className="modal-body">
          <section className="set-block">
            <div className="set-label">
              工作模式
              <span className="hint">决定侧栏显示哪些页面</span>
            </div>
            <Segmented
              value={settings.mode}
              onChange={(v) => onChange({ mode: v })}
              options={[
                { value: "op", label: "操作模式" },
                { value: "prod", label: "生产模式" },
              ]}
            />
            <div className="set-note">
              {settings.mode === "op" ? (
                <>
                  <b>操作模式</b>：显示全部 8 个页面（编码器、对齐、行程保护、PID、寄存器…），
                  用于调试、标定与整机验收。
                </>
              ) : (
                <>
                  <b>生产模式</b>：只保留「运行概览 / 自动测试 / 运行日志」，隐藏调参与寄存器页面，
                  防止产线误改参数。安全门禁（ARM、急停、软限位）保持不变。
                </>
              )}
            </div>
          </section>

          <div className="divider" />

          <section className="set-block">
            <div className="set-label">
              主题
              <span className="hint">默认暗色</span>
            </div>
            <Segmented
              value={settings.theme}
              onChange={(v) => onChange({ theme: v })}
              options={[
                { value: "dark", label: "暗色" },
                { value: "light", label: "亮色" },
              ]}
            />
            <div className="set-note">
              亮色适合白天强光环境与投屏；示波器与曲线会同步换成深色描边以保证对比度。
              设置会保存在本机，下次启动自动生效。
            </div>
          </section>
        </div>

        <footer className="modal-foot">
          <span className="tiny muted">TSL Viewer 0.1.0 · TMC6460 Studio</span>
          <span className="grow" />
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </footer>
      </div>
    </div>
  );
}
