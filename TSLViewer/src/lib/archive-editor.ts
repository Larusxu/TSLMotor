import {storageJob,StorageError} from "./split-storage";
import {word,putWord,crc32,readMotorProfile,COUNTS_PER_RPM,MA_PER_RAW} from "./motor-profile-ui";
export interface ArchiveDraft {main:number[];extra:number[];empty:boolean}
export interface ArchiveField {label:string;offset:number;extra?:boolean;shift?:number;mask?:number;bytes?:number;scale?:number;unit?:string;max?:number;choices?:string[]}
export const archiveGroups:Record<string,ArchiveField[]>={
 "运动":[{label:"工作模式",offset:104,choices:["位置直通","位置插补","速度直通","速度插补"]},{label:"转速限制",offset:112,scale:1/COUNTS_PER_RPM,unit:"rpm"},{label:"电流限制 |Iq|",offset:80,scale:MA_PER_RAW,unit:"mA"},{label:"过流动作",offset:108,choices:["—","受控停止","禁能"]},{label:"位置模式速度上限",offset:52,scale:1/COUNTS_PER_RPM,unit:"rpm"},{label:"速度模式速度上限",offset:60,scale:1/COUNTS_PER_RPM,unit:"rpm"}],
 "PI 与限幅":[...[["d P",32,16],["d I",32,0],["q P",36,16],["q I",36,0],["速度 P",40,16],["速度 I",40,0],["位置 P",44,16],["位置 I",44,0]].map(([label,offset,shift])=>({label:String(label),offset:Number(offset),shift:Number(shift),mask:65535,max:32767})),{label:"Iq 限幅",offset:48,shift:16,mask:32767,scale:MA_PER_RAW,unit:"mA"},{label:"Id 限幅",offset:48,mask:32767,scale:MA_PER_RAW,unit:"mA"},{label:"电压限幅",offset:56,max:65535}],
 "PI 格式":[{label:"覆盖目标",offset:28,mask:1,choices:["关闭","开启"]},{label:"保持位置目标",offset:28,shift:1,mask:1,choices:["关闭","开启"]},...[["电流 P 小数位",2,1],["电流 I 小数位",3,1],["速度 P 格式",4,3],["速度 I 格式",6,3],["位置 P 格式",8,3],["位置 I 格式",10,3],["速度积分缩放",12,15],["位置采样间隔",16,127]].map(([label,shift,mask])=>({label:String(label),offset:28,shift:Number(shift),mask:Number(mask),max:Number(mask)}))],
 "编码器":[{label:"极对数",offset:32,extra:true,max:127},{label:"CPR",offset:8,extra:true,max:16777216},{label:"SPI 时钟",offset:12,extra:true,unit:"Hz"},{label:"PWM 周期",offset:16,extra:true},{label:"发送数据",offset:20,extra:true},{label:"数据掩码",offset:24,extra:true},{label:"帧长度",offset:28,extra:true,mask:255},{label:"SPI 模式",offset:28,extra:true,shift:8,mask:255,max:3},{label:"CSN 间隔",offset:28,extra:true,shift:16,mask:255},{label:"CSA 增益",offset:28,extra:true,shift:24,mask:255,max:3},{label:"频率测速配置",offset:36,extra:true},{label:"周期测速配置",offset:40,extra:true}],
 "校准":[{label:"电角度偏移",offset:20,max:65535},{label:"偏移有效",offset:16,bytes:2,mask:1,choices:["无效","有效"]},{label:"PI 有效",offset:16,bytes:2,shift:1,mask:1,choices:["无效","有效"]},{label:"校准质量",offset:24},{label:"传感器方向",offset:19,bytes:1,max:1}],
 "Ramp":[{label:"加速时间",offset:44,extra:true,unit:"ms"},{label:"减速时间",offset:48,extra:true,unit:"ms"},{label:"位置容差",offset:52,extra:true,scale:360/65536,unit:"°"},{label:"容差延时",offset:56,extra:true,scale:1/25,unit:"ms"},{label:"速度前馈",offset:60,extra:true,choices:["关闭","开启"]},{label:"Ramp 补充有效",offset:64,extra:true,choices:["关闭","开启"]},{label:"结束速度",offset:116,unit:"raw"}],
 "保护":[{label:"持续过流时间",offset:84,unit:"ms"},{label:"保护采样周期",offset:88,unit:"ms"},{label:"反馈超时",offset:92,unit:"ms"},{label:"停止超时",offset:96,unit:"ms"},{label:"行程边距",offset:100,unit:"Count"}],
};
export function fieldValue(d:ArchiveDraft,f:ArchiveField){const p=f.extra?d.extra:d.main;let v=f.bytes===1?p[f.offset]:f.bytes===2?p[f.offset]|p[f.offset+1]<<8:word(p,f.offset);v=(v>>>(f.shift??0))&(f.mask??0xffffffff);return Number(((v>>>0)*(f.scale??1)).toFixed(f.unit==="°"?2:0));}
export function editArchive(d:ArchiveDraft,f:ArchiveField,value:number):ArchiveDraft{
 const next={...d,main:[...d.main],extra:[...d.extra]},p=f.extra?next.extra:next.main;
 const raw=Math.round(value/(f.scale??1)),shift=f.shift??0,mask=f.mask??0xffffffff;
 if(!Number.isFinite(value)||raw<0||raw>(mask>>>0))throw Error(`${f.label} 超出可表示范围`);
 const previous=f.bytes===1?p[f.offset]:f.bytes===2?p[f.offset]|p[f.offset+1]<<8:word(p,f.offset);
 const v=((previous&~(mask<<shift))|((raw&mask)<<shift))>>>0;
 if(f.bytes===1)p[f.offset]=v;else if(f.bytes===2){p[f.offset]=v&255;p[f.offset+1]=v>>>8;}else putWord(p,f.offset,v);
 if(f.extra&&f.offset===32)next.main[18]=raw;
 if((f.extra&&(f.offset===44||f.offset===48))||(!f.extra&&f.offset===112))updateAcceleration(next);
 return next;
}
export function seedArchive(motor:number,defaults:number[],common:number[]):ArchiveDraft{
 const main=Array(128).fill(0),extra=Array(128).fill(0),canonical=Array(128).fill(0);
 "ENC1".split("").forEach((c,i)=>canonical[i]=c.charCodeAt(0));putWord(canonical,4,0x00800001);common.slice(8,64).forEach((v,i)=>canonical[8+i]=v);putWord(canonical,36,2000);
 "MTR1".split("").forEach((c,i)=>main[i]=c.charCodeAt(0));putWord(main,4,0x00800001);main[12]=motor;main[14]=motor;main[16]=2;main[18]=word(defaults,80);
 for(let i=0;i<8;i++)putWord(main,28+i*4,word(defaults,24+i*4));
 putWord(main,60,word(main,52));putWord(main,64,crc32(canonical.slice(0,120)));putWord(main,68,0x324e5552);
 putWord(main,80,Math.floor(word(defaults,116)/MA_PER_RAW));putWord(main,84,defaults[20]|defaults[21]<<8);putWord(main,88,defaults[22]|defaults[23]<<8);
 putWord(main,92,word(defaults,108));putWord(main,96,5000);putWord(main,100,65536);putWord(main,104,0);putWord(main,108,2);
 putWord(main,112,Math.floor(Math.min(word(defaults,112)*COUNTS_PER_RPM,word(main,52))));putWord(main,116,1);putWord(main,124,0x31544d43);
 "MEX1".split("").forEach((c,i)=>extra[i]=c.charCodeAt(0));defaults.slice(56,108).forEach((v,i)=>extra[8+i]=v);putWord(extra,64,1);
 const draft={main,extra,empty:true};updateAcceleration(draft);return sealArchive(draft);
}
function updateAcceleration(d:ArchiveDraft){for(const [dst,src] of [[72,44],[76,48]]){const ms=word(d.extra,src);if(!ms)throw Error("Ramp 时间必须大于零");putWord(d.main,dst,Math.max(1,Math.floor(word(d.main,112)*131072000/(60000000*ms))));}}
export function sealArchive(d:ArchiveDraft){const next={...d,main:[...d.main],extra:[...d.extra]};
 putWord(next.main,120,crc32(next.main.slice(0,120)));putWord(next.extra,120,crc32(next.extra.slice(0,120)));return next;
}
export async function loadArchive(m:number,defaults:number[],common:number[]){let seed=seedArchive(m,defaults,common);try{seed={...seed,main:(await readMotorProfile(m)).data,empty:false};}catch(e){if(!(e instanceof StorageError)||e.result!==-4)throw e;}
 if(!seed.empty)try{seed.extra=(await storageJob(m,9)).data;}catch(e){if(!(e instanceof StorageError)||e.result!==-4)throw e;seed.extra[32]=seed.main[18];}
 return seed;
}
export async function saveArchive(m:number,d:ArchiveDraft){const submitted=sealArchive(d);
 // Main record first: validates bindings and PI before changing the extension.
 await storageJob(m,3,submitted.main);await storageJob(m,11,submitted.extra);
 const main=(await readMotorProfile(m)).data,extra=(await storageJob(m,9)).data;
 if(main.some((v,i)=>v!==submitted.main[i])||extra.some((v,i)=>v!==submitted.extra[i]))throw Error("档案回读不一致；编辑值保留");
 return {...submitted,empty:false};
}
