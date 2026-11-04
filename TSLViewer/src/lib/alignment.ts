import type { CalibResult, JobDone } from "./types";

/** Results belong to one motor in the current connection, independently of pages. */
export function applyAlignmentResult(
  previous: Record<number, CalibResult>, motor: number, done: JobDone
): Record<number, CalibResult> {
  if (!done.ok || !done.data) return previous;
  const kind = done.job.split(":")[0];
  const r = kind === "calibrate" ? done.data as CalibResult : kind === "commission"
    ? (done.data as { calibration?: CalibResult }).calibration : undefined;
  if (!r) return previous;
  if (!Number.isInteger(r.offset) || r.offset < 0 || r.offset > 65535 ||
      !Number.isFinite(r.r2) || !Array.isArray(r.groups)) return previous;
  return { ...previous, [motor]: r };
}
