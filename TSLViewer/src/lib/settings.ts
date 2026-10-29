/**
 * User preferences: work mode and theme.
 *
 * Kept in localStorage so a line operator's choice survives restarts. Nothing
 * here touches the motor — it only changes what the UI exposes.
 */

export type WorkMode = "op" | "prod";
export type ThemeMode = "dark" | "light";

export interface Settings {
  /** "op" = 调试/操作模式（全部页面），"prod" = 生产模式（只留产测相关页面） */
  mode: WorkMode;
  theme: ThemeMode;
}

const KEY = "tsl.settings.v1";

export const DEFAULT_SETTINGS: Settings = { mode: "op", theme: "dark" };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      mode: p.mode === "prod" ? "prod" : "op",
      theme: p.theme === "light" ? "light" : "dark",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

/** Theme lives on <html data-theme> so every token override applies at once. */
export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}
