/** UI preference only: never opens a port, grants a permit or restores drive state. */
export type ConnectionMode = "direct" | "main485" | "maincan";
const KEY = "tsl.workspace.connection-mode";
export function connectionMode(value: string | null): ConnectionMode {
  return value === "direct" || value === "maincan" ? value : "main485";
}
export function loadConnectionMode(): ConnectionMode {
  try { return connectionMode(localStorage.getItem(KEY)); }
  catch { return "main485"; }
}
export function saveConnectionMode(value: string) {
  try { localStorage.setItem(KEY, connectionMode(value)); } catch { /* unavailable storage */ }
}
