import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
let code = ts.transpileModule(fs.readFileSync(new URL('../src/lib/fleet.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const stubs = {
  react: 'export const useEffect=()=>{},useState=()=>{},useRef=()=>{};',
  './api': 'export const api={},invokeCommand=()=>{throw Error("offline test must not contact hardware")};',
  './pi-auto/acquisition': 'export const acquisitionLane={busy:()=>false};',
};
code = code.replace(/from ["']([^"']+)["']/g, (_, name) => 'from ' + JSON.stringify(url(stubs[name])));
const { decodePower, decodeChips, words, CHIP_BLOCK, STATIC_CHANNEL_MOTORS } = await import(url(code));
assert.deepEqual(words([0x12, 0x34, 0xff, 0xff], 2), [0x1234, 0xffff]);
assert.throws(() => words([1], 1));
// Snapshot contract: 4 chips x 12 words at 80, 16 motors x 8 words at 128.
assert.deepEqual(CHIP_BLOCK, { offset: 80, count: 48 });

const chips = Array(48).fill(0), motors = Array(128).fill(0);
for (let i = 0; i < 4; i++) { chips[i * 12] = 1; chips[i * 12 + 3] = 1; chips[i * 12 + 8] = 72; }
const row = (motor, chip, output) => motor * 8;
// Deliberately non-linear mapping: UI must use the MCU's route, not M / 4.
for (let i = 0; i < 16; i++) {
  const b = row(i);
  motors[b + 1] = 3 - Math.floor(i / 4);
  motors[b + 2] = 4 - i % 4;
  motors[b + 3] = 10;          // current ADC counts -> 30 mA
  motors[b + 4] = 70;          // output voltage counts -> 4900 mV
  motors[b + 5] = 1; motors[b + 6] = 1;
  motors[b + 7] = 1 | 2 | 4;   // chip answered, TMC online, board rate
}
const base = decodePower(chips, motors);
assert(base.every(v => v.enabled && !v.fault && v.live));
assert(base.every(v => v.current_ma === 30 && v.voltage_mv === 4900));
assert(base.every(v => v.tmcOnline && v.tmcBoardRate));
assert(decodeChips(chips, motors).length === 4);
assert(decodeChips(chips, motors)[0].vin_mv === 72 * 70);
// Every channel card must resolve back to the motor that own it.
for (const chip of decodeChips(chips, motors)) {
  assert(chip.channels.every(c => c.motor !== null && c.current_ma === 30));
}
assert(decodeChips(chips, motors)[0].channels[0].motor === 16);
// Static channel ownership matches boards/hpm6e8y_evk.dts motor-ids.
assert.deepEqual(STATIC_CHANNEL_MOTORS, [[3, 5, 4, 6], [2, 15, 1, 16], [9, 8, 10, 7], [13, 11, 14, 12]]);
// An unclaimed output still falls back to the static motor label.
const chips2 = Array(48).fill(0), motors2 = Array(128).fill(0);
for (let i = 0; i < 4; i++) chips2[i * 12] = 1;
assert.equal(decodeChips(chips2, motors2)[0].channels[0].motor, 3);
// STAT1.ACC is conversion completion, not a fault.
chips[4] = 0x10;
assert(decodePower(chips, motors).every(v => !v.fault));
// Each STAT2 nibble belongs exclusively to one output.
for (let c = 0; c < 4; c++) for (let output = 0; output < 4; output++) {
  const at = c * 12 + 5 + Math.floor(output / 2);
  chips[at] = 4 << (4 * (output % 2));
  const result = decodePower(chips, motors);
  assert.equal(result.filter(v => v.fault).length, 1);
  assert(result[(3 - c) * 4 + 3 - output].fault.includes('过流'));
  chips[at] = 0;
}
chips[4] = 4;
assert.equal(decodePower(chips, motors).filter(v => v.fault).length, 4);
chips[4] = 0;
motors[5] = 0xffff;
assert.equal(decodePower(chips, motors)[0].enabled, null);
motors[6] = 0;
assert.equal(decodePower(chips, motors)[0].live, false);
// An unpowered channel is never reported as TMC-present by the firmware flags.
motors[5] = 0; motors[7] = 1;
assert.equal(decodePower(chips, motors)[0].tmcOnline, false);
assert.throws(() => decodePower([], []));
console.log('PASS 16 non-linear routes, STAT2 output fields, shared faults, ACC exclusion, channel ADC and TMC presence flags');
