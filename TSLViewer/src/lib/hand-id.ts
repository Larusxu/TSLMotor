/** MCU identity 1..1296 maps bijectively to TS-00..TS-ZZ. Zero remains unset. */
export function formatHandId(id:number|null){return id!==null&&id>=1&&id<=1296?`TS-${(id-1).toString(36).toUpperCase().padStart(2,"0")}`:"—";}
export function parseHandId(value:string){const text=value.trim().toUpperCase();if(!/^TS-[0-9A-Z]{2}$/.test(text))throw Error("手编号格式为 TS-XX，X 为 0–9 或 A–Z");return parseInt(text.slice(3),36)+1;}
