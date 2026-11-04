import { storageJob } from "./split-storage";
import { crc32, putWord, word } from "./motor-profile-ui";

export const RATED_RPM = 28730;
export function checkedCommon(data: number[]) {
  if (data.length !== 128 || !["ENC1", "ENC2"].includes(String.fromCharCode(...data.slice(0, 4))) ||
      word(data, 120) !== crc32(data.slice(0, 120)) || word(data, 124) !== 0x31544d43 ||
      word(data, 36) < 1 || word(data, 36) > RATED_RPM) throw Error("主控公共转速配置无效");
  return data;
}
export function withRatedRpm(data: number[], rpm: number) {
  if (!Number.isInteger(rpm) || rpm < 1 || rpm > RATED_RPM) throw Error(`额定转速范围为 1～${RATED_RPM} rpm`);
  const next = [...checkedCommon(data)];
  putWord(next, 36, rpm); putWord(next, 120, crc32(next.slice(0, 120)));
  return next;
}
export async function readRatedRpm() {
  return word(checkedCommon((await storageJob(0, 1)).data), 36);
}
export async function saveRatedRpm(rpm: number) {
  const before = checkedCommon((await storageJob(0, 1)).data);
  const next = withRatedRpm(before, rpm);
  await storageJob(0, 3, next);
  const after = checkedCommon((await storageJob(0, 1)).data);
  if (after.slice(8, 64).some((v, i) => v !== next[i + 8])) throw Error("公共配置读回不一致，请重新读取");
  return word(after, 36);
}
