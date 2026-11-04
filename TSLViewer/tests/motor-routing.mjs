import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const js = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test("real Tauri homing API preserves all 16 motor IDs, including M9", async () => {
  const source = read("../src/lib/api.ts");
  const start = source.indexOf("const real = {");
  const end = source.indexOf("\n};", start) + 3;
  const calls = [];
  const real = new Function("invoke", js(source.slice(start, end)) + "\nreturn real;")(
    async (command, args) => { calls.push({ command, args }); }
  );
  for (let motor = 1; motor <= 16; motor++) {
    const params = { dir: -1, step_unit: 1500 };
    const cfg = { k_x1000: 400 };
    await real.homingStart(params, motor);
    await real.homingState(motor);
    await real.homingCancel(motor);
    await real.homingWriteConfig(cfg, motor);
    await real.homingReadConfig(motor);
    assert.deepEqual(calls.splice(0), [
      { command: "homing_start", args: { params, motor } },
      { command: "homing_state", args: { motor } },
      { command: "homing_cancel", args: { motor } },
      { command: "homing_write_config", args: { cfg, motor } },
      { command: "homing_read_config", args: { motor } },
    ]);
  }
});

const exports = {};
new Function("exports", js(read("../src/lib/alignment.ts")))(exports);
const { applyAlignmentResult } = exports;
const result = { offset: 48000, r2: 0.999, written: true, groups: [] };
const done = { job: "calibrate:1", ok: true, data: result };
test("alignment survives unrelated jobs and stays isolated between M1 and M9", () => {
  const m9 = applyAlignmentResult({}, 9, done);
  assert.equal(m9[9].offset, 48000);
  assert.equal(m9[1], undefined);
  const afterPid = applyAlignmentResult(m9, 9, { job: "pid:2", ok: true, data: {} });
  assert.strictEqual(afterPid, m9);
  const m1 = applyAlignmentResult(afterPid, 1, { ...done, data: { ...result, offset: 0 } });
  assert.equal(m1[1].offset, 0);
  assert.equal(m1[9].offset, 48000);
});
test("failed/malformed calibration never replaces a confirmed result", () => {
  const previous = { 9: result };
  assert.strictEqual(applyAlignmentResult(previous, 9, { ...done, ok: false }), previous);
  assert.strictEqual(applyAlignmentResult(previous, 9, { ...done, data: { offset: "0xBB80" } }), previous);
});
