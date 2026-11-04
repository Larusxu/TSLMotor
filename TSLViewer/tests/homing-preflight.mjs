import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/homing.ts", import.meta.url), "utf8");
const exports = {};
new Function("exports", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(exports);
const { M9_HOMING, M9_SEEK, missingHomingPid, checkHomingStart } = exports;
const pid = { flux_coeff: 0x00400030, torque_coeff: 0x00400030, vel_coeff: 0x01f400fa, pos_coeff: 0x01f40000 };
const noop = () => {};

test("M9 preset matches successful run, including timed seek and direction", () => {
  assert.deepEqual(M9_HOMING, { k_x1000: 400, rated_ma: 1050, confirm_ms: 50, limit_ma: 500,
    max_rpm: 2000, retreat_deg: 360, settle_ms: 2000, timeout_s: 60 });
  assert.deepEqual(M9_SEEK, { dir: -1, step_unit: 100, timed_seek: true });
  assert.equal(M9_HOMING.k_x1000 * M9_HOMING.rated_ma / 1000, 420);
});
test("alignment-only coefficients reject homing with both missing loops identified", async () => {
  const incomplete = { ...pid, vel_coeff: 0, pos_coeff: 0 };
  assert.deepEqual(missingHomingPid(incomplete), ["速度环 0x145", "位置环 0x146"]);
  await assert.rejects(checkHomingStart({ homingReadConfig: async () => M9_HOMING,
    readPid: async () => incomplete }, 9, M9_HOMING, noop, noop), /0x145.*0x146/);
  assert.deepEqual(missingHomingPid(pid), []); // Position I=0 is valid.
});
test("controller reset/config mismatch stops before PID reads", async () => {
  let pidReads = 0;
  let actual;
  await assert.rejects(checkHomingStart({ homingReadConfig: async () => ({ ...M9_HOMING, limit_ma: 600 }),
    readPid: async () => { pidReads++; return pid; } }, 9, M9_HOMING, noop, v => { actual = v; }), /主控参数已变化/);
  assert.equal(pidReads, 0);
  assert.equal(actual.limit_ma, 600);
});
test("read failures and motor changes prevent further steps", async () => {
  await assert.rejects(checkHomingStart({ homingReadConfig: async () => { throw Error("timeout"); },
    readPid: async () => { assert.fail("must not read PID"); } }, 9, M9_HOMING, noop, noop), /timeout/);
  let currentMotor = 9;
  await assert.rejects(checkHomingStart({ homingReadConfig: async () => { currentMotor = 1; return M9_HOMING; },
    readPid: async () => { assert.fail("must not read another motor"); } }, 9, M9_HOMING,
    () => { if (currentMotor !== 9) throw Error("motor changed"); }, noop), /motor changed/);
});
test("configured M9 passes read-only preflight using explicit motor ID", async () => {
  const calls = [];
  await checkHomingStart({ homingReadConfig: async motor => { calls.push(motor); return M9_HOMING; },
    readPid: async () => { calls.push("pid"); return pid; } }, 9, M9_HOMING, noop, noop);
  assert.deepEqual(calls, [9, "pid"]);
});
