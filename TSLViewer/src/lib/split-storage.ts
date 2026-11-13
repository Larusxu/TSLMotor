import { invokeCommand } from "./api";

export type StorageReply = {
  id: number; phase: number; result: number; motor: number; operation: number;
  generation: number; hand_id: number; flags: number; offset: number; data: number[];
};
let lastId = 0;
function nextId() {
  lastId = Math.max(lastId + 1, Date.now() % 0xffffffff);
  if (lastId >= 0xffffffff) throw new Error("存储请求编号已耗尽，请重连并检查设备状态");
  return lastId;
}
async function send(motor: number, operation: number, id: number, offset = 0, data: number[] = []) {
  const reply=await invokeCommand<StorageReply>("motor_storage", { motor, request: { id, operation, offset, data } });
  return reply;
}
const errors: Record<number, string> = {
  [-2]: "通信超时", [-4]: "没有有效档案或备份", [-6]: "配置参数或存储请求无效，请检查输入值",
  [-7]: "存储或共享总线忙，请稍后重试", [-8]: "存储读写或恢复失败", [-10]: "存储设备未就绪",
};
export class StorageError extends Error {
  constructor(public readonly result: number, public readonly flags: number) {
    super(`${errors[result] ?? "主控拒绝操作"} (${result})${flags ? `；恢复标志=${flags}` : ""}`);
  }
}
async function executeStorageJob(motor: number, operation: 1 | 3 | 4 | 5 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15, payload?: number[]) {
  const id = nextId();
  if (operation === 3 || operation === 8 || operation === 11 || operation === 13 || operation === 15) {
    if (!payload || payload.length !== 128) throw new Error("W25 档案必须是 128 字节 ENC1/ENC2/MTR1 记录");
    for (const offset of [0, 106]) {
      const r = await send(motor, 2, id, offset, payload.slice(offset, offset + 106));
      if (r.result || r.phase !== 1) throw new Error(`暂存失败：${r.result}`);
    }
  }
  let r = await send(motor, operation, id);
  // A rejected READ has not started any work. Only these passive operations
  // may wait for a short-lived shared-flash transaction; never replay saves.
  const readDeadline = Date.now()+1200;
  while ([1,7,9,12,14].includes(operation) && r.result===-7 && r.phase===5 && Date.now()<readDeadline) {
    await new Promise(resolve=>setTimeout(resolve,80));
    r=await send(motor,operation,id);
  }
  const deadline = Date.now() + 60000;
  while (r.phase === 2 || r.phase === 3) {
    if (Date.now() >= deadline) throw new Error("等待超时：结果未知，请查询设备，勿重复下发保存");
    await new Promise(resolve => setTimeout(resolve, 80));
    try { r = await send(motor, 6, id); }
    catch(error) {
      // Internal Flash can briefly delay a reply. Query only this accepted
      // job again; never replay staging, save, or a motor command.
      if(!/timeout|timed out|\u8d85\u65f6/i.test(String(error)))throw error;
    }
  }
  if (r.result || r.phase !== 4) {
    throw new StorageError(r.result, r.flags);
  }
  const tail = await send(motor, 6, id, 106);
  if (tail.result || tail.phase !== 4 || tail.generation !== r.generation || tail.hand_id !== r.hand_id ||
      r.offset !== 0 || tail.offset !== 106 || r.data.length !== 106 || tail.data.length !== 22) {
    throw new Error("档案分片身份或代数发生变化");
  }
  return { ...r, data: [...r.data, ...tail.data] };
}

export function decodeBackup(data: number[], hand: number, motor: number) {
  if (data.length < 16) throw new Error("备份长度不足");
  let crc = 0xffff;
  for (const b of data.slice(0, 12)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  if (data[0] !== 0x4d || data[1] !== 1 || data[2] !== motor || data[3] !== 1 ||
      (data[4] | data[5] << 8) === 0 || crc !== (data[12] | data[13] << 8) ||
      data[14] !== 0xa5 || data[15] !== 0x5a) throw new Error("备份格式、CRC 或编号不匹配");
  return { handId: hand, motor, offset: data[6] | data[7] << 8,
    generation: new DataView(Uint8Array.from(data.slice(8, 12)).buffer).getUint32(0, true) };
}

// The MCU exposes one staged storage job. Serialize callers across pages.
let storageQueue: Promise<unknown> = Promise.resolve();
export function storageJob(motor:number,operation:1|3|4|5|7|8|9|10|11|12|13|14|15,payload?:number[]) {
 const job=storageQueue.then(()=>executeStorageJob(motor,operation,payload));
 storageQueue=job.catch(()=>{});return job;
}
