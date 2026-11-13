import {useSyncExternalStore} from "react";
import {storageJob} from "./split-storage";
import {crc32,putWord,word} from "./motor-profile-ui";
export type HomePolicy={linked:string;motors:string;rpm:number;complex:boolean;middle:boolean;positive:boolean;direction:number};
let current:HomePolicy={linked:"15,16",motors:"1,2,3,4,5,6,9,10,11,12,13,14",rpm:4000,complex:true,middle:true,positive:true,direction:2};
let revision=0;
// Factory restoration may temporarily hold automatic startup. Ordinary edits
// must preserve that state rather than silently start an unverified hand.
let maintenanceHold=0;
let pendingRead:Promise<void>|null=null;
let saveQueue:Promise<unknown>=Promise.resolve();
const listeners=new Set<()=>void>();
const subscribe=(f:()=>void)=>{listeners.add(f);return()=>{listeners.delete(f);};};
export const updateHomePolicy=(patch:Partial<HomePolicy>)=>{revision++;current={...current,...patch};listeners.forEach(f=>f());};
export const useHomePolicy=()=>useSyncExternalStore(subscribe,()=>current);
export function motorMask(text:string){if(!text.trim())return 0;let mask=0;for(const token of text.split(',')){if(!/^\s*(?:[1-9]|1[0-6])\s*$/.test(token))throw Error("电机编号为1–16，以英文逗号分隔");mask|=1<<(Number(token)-1);}return mask;}
const list=(n:number)=>Array.from({length:16},(_,i)=>i+1).filter(m=>n&(1<<(m-1))).join(',');
async function loadPolicy(){const rev=revision;const p=(await storageJob(0,12)).data;if(p.length!==128||String.fromCharCode(...p.slice(0,4))!=="HPL1"||word(p,120)!==crc32(p.slice(0,120)))throw Error("找零编排配置版本或CRC无效");maintenanceHold=p[16];if(revision!==rev)return;updateHomePolicy({linked:list(p[8]|p[9]<<8),motors:list(p[10]|p[11]<<8),rpm:p[12]|p[13]<<8,complex:!!(p[14]&1),middle:!!(p[14]&2),positive:!!(p[14]&4),direction:p[15]});}
async function commitPolicy(current:HomePolicy){const a=motorMask(current.linked),b=motorMask(current.motors);if(a&b)throw Error("两种方法的电机列表不能重叠");if(current.rpm<500||current.rpm>60000)throw Error("方法2转速范围500–60000 rpm");const p=Array(128).fill(0);"HPL1".split('').forEach((c,i)=>p[i]=c.charCodeAt(0));p[4]=1;for(const [i,n] of [[8,a],[10,b],[12,current.rpm]]){p[i]=n&255;p[i+1]=n>>>8;}p[14]=+current.complex|(+current.middle<<1)|(+current.positive<<2);p[15]=current.direction;p[16]=maintenanceHold;putWord(p,120,crc32(p.slice(0,120)));await storageJob(0,13,p);const actual=(await storageJob(0,12)).data;if(actual.some((v,i)=>p[i]!==v))throw Error("找零编排配置回读不一致");}

export function readHomePolicy(){if(!pendingRead)pendingRead=loadPolicy().finally(()=>{pendingRead=null;});return pendingRead;}

export function saveHomePolicy(){const submitted={...current};const job=saveQueue.then(()=>commitPolicy(submitted));saveQueue=job.catch(()=>{});return job;}
