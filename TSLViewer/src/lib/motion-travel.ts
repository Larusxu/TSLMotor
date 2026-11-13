import {useSyncExternalStore} from "react";
import {storageJob} from "./split-storage";
import {crc32,putWord,word} from "./motor-profile-ui";
export type TravelRange={min:number;max:number};
let ranges:TravelRange[]=Array.from({length:21},()=>({min:0,max:100}));
let arrivalTolerance=.5;
const listeners=new Set<()=>void>();
const publish=(next:TravelRange[])=>{ranges=next;listeners.forEach(f=>f());};
export const useMotionTravel=()=>useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>ranges);
export const useArrivalTolerance=()=>useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>arrivalTolerance);
export const getMotionTravel=()=>ranges.map(r=>({...r}));
function decode(p:number[]):TravelRange[]{
 if(p.length!==128||String.fromCharCode(...p.slice(0,4))!=="TRV1"||word(p,120)!==crc32(p.slice(0,120)))throw Error("行程限制格式或CRC错误");
 const tolerance=p[4]|p[5]<<8;
 if(tolerance>1000)throw Error("绝对位置到位容差配置无效");
 arrivalTolerance=(tolerance||50)/100;
 return Array.from({length:21},(_,i)=>({min:(p[8+4*i]|p[9+4*i]<<8)/100,max:(p[10+4*i]|p[11+4*i]<<8)/100}));
}
let queue:Promise<unknown>=Promise.resolve();
export function readMotionTravel(){
 const job=queue.catch(()=>{}).then(async()=>publish(decode((await storageJob(0,14)).data)));
 queue=job;return job;
}
export function saveMotionTravel(row:number,range:TravelRange){
 const job=queue.catch(()=>{}).then(async()=>{
  if(!Number.isInteger(row)||row<0||row>=21||!Number.isFinite(range.min)||!Number.isFinite(range.max)||range.min<0||range.min>100||range.max>655.35||range.max<=range.min)throw Error("最小行程需在0～100%，最大行程需大于最小行程且不超过655.35%");
  // Read-modify-write the shared record so an edit preserves all other axes.
  const p=(await storageJob(0,14)).data;
  decode(p);
  const lo=Math.round(range.min*100),hi=Math.round(range.max*100);
  if(hi<=lo)throw Error("行程间隔至少为0.01%");
  p[8+4*row]=lo&255;p[9+4*row]=lo>>>8;p[10+4*row]=hi&255;p[11+4*row]=hi>>>8;
  putWord(p,120,crc32(p.slice(0,120)));
  await storageJob(0,15,p);
  const actual=(await storageJob(0,14)).data;
  if(actual.some((v,i)=>v!==p[i]))throw Error("行程限制回读不一致");
  publish(decode(actual));
 });queue=job;return job;
}
export function saveArrivalTolerance(percent:number){
 const job=queue.catch(()=>{}).then(async()=>{
  if(!Number.isFinite(percent)||percent<.01||percent>10)throw Error("绝对位置到位容差应为0.01～10%");
  const p=(await storageJob(0,14)).data;decode(p);
  const value=Math.round(percent*100);p[4]=value&255;p[5]=value>>>8;
  putWord(p,120,crc32(p.slice(0,120)));
  await storageJob(0,15,p);
  const actual=(await storageJob(0,14)).data;
  if(actual.some((v,i)=>v!==p[i]))throw Error("到位容差回读不一致");
  publish(decode(actual));
 });queue=job;return job;
}
