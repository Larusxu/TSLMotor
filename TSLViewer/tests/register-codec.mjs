import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const codec = {};
new Function("exports", ts.transpileModule(readFileSync(new URL("../src/lib/units.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(codec);
test("PID Q selections and shifts survive full field roundtrip", () => {
  for (let p = 0; p < 4; p++) for (let i = 0; i < 4; i++) {
    const bits = { pos_sampling: 127, vel_shift: 15, pos_norm_i: i, pos_norm_p: p,
      vel_norm_i: i, vel_norm_p: p, cur_norm_i: i & 1, cur_norm_p: p & 1,
      overwrite_target: true, keep_pos_target: false };
    assert.deepEqual(codec.parsePidConfig(codec.composePidConfig(bits)), bits);
  }
  assert.equal(codec.coefToGain(256, codec.pFrac(1)), 1);
  assert.equal(codec.coefToGain(256, codec.iFrac(1, true)), 1);
  assert.equal(codec.coefToGain(256, codec.iFrac(0)), 1);
  assert.equal(codec.coefToGain(256, codec.iFrac(3)), 256 / 2 ** 32);
});
test("current and velocity conversion preserve signed feedback within one LSB", () => {
  for (const ma of [-1050, -500, 0, 500, 1050]) {
    assert.ok(Math.abs(codec.maFromCounts(codec.countsFromMa(ma)) - ma) <= codec.MA_PER_COUNT / 2);
  }
  for (const rpm of [-2000, -60, 0, 60, 2000]) {
    assert.ok(Math.abs(codec.rpmFromCounts(codec.countsFromRpm(rpm)) - rpm) <= 1 / codec.COUNTS_PER_RPM);
  }
  assert.equal(codec.s16hi(0xffff1234), -1);
  assert.equal(codec.s16lo(0x12348000), -32768);
});
