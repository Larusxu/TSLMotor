import {useSyncExternalStore} from "react";
import {storageJob} from "./split-storage";
import {crc32,putWord,word} from "./motor-profile-ui";
import {encoderView} from "./encoder-view";
import {semanticMotion} from "./semantic-motion";

const listeners=new Set<()=>void>();
const notify=()=>listeners.forEach(fn=>fn());
let defaults:number[]|null=null;
let savedDefaults:number[]|null=null;
let home=[400,1050,50,500,5000,0,0,60];
let savedHome:number[]|null=null;
let encoder={...encoderView(null,null),send:0};
const offsets=new Map<number,number|null>();
const encoderCache=new Map<number,typeof encoder>();
const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
function syncEncoder() {
 if(!defaults)return;
 const bits=word(defaults,76);
 encoder={...encoder,cpr:word(defaults,56),spiHz:word(defaults,60),pwm:word(defaults,64),
 send:word(defaults,68),frameBits:bits&255,spiMode:(bits>>>8)&255,idle:(bits>>>16)&255,
 csa:bits>>>24,poles:word(defaults,80),velFrq:word(defaults,84),velPer:word(defaults,88)};
 encoderCache.clear();
}
export function setDefaultWord(offset:number,value:number) {
 if(!defaults)throw Error("请先读取主控公共配置");
 defaults=[...defaults];putWord(defaults,offset,value);syncEncoder();notify();
}
export function editDefaults(update:(image:number[])=>void) {
 if(!defaults)throw Error("请先读取主控公共配置");
 defaults=[...defaults];update(defaults);syncEncoder();notify();
}
export function useSharedDefaults() {
 const data=useSyncExternalStore(subscribe,()=>defaults);
 return {data,saved:savedDefaults,edit:editDefaults,setWord:setDefaultWord};
}
export function acceptDefaults(data:number[]) {
 if(data.length!==128||String.fromCharCode(...data.slice(0,4))!=="MPD3"||word(data,120)!==crc32(data.slice(0,120)))throw Error("公共配置版本或 CRC 无效");
 defaults=[...data];savedDefaults=[...data];
 home=[0,1,2,3,4].map(i=>data[8+i*2]|data[9+i*2]<<8).concat([0,0,data[18]|data[19]<<8]);
 savedHome=[...home];syncEncoder();notify();return defaults;
}
export async function readSharedDefaults() {return acceptDefaults((await storageJob(0,7)).data);}
async function commitSharedDefaults(submitted:number[]) {
 if(!defaults)throw Error("请先读取主控公共配置");
 putWord(submitted,120,crc32(submitted.slice(0,120)));
 await storageJob(0,8,submitted);
 const actual=(await storageJob(0,7)).data;
 if(actual.some((v,i)=>v!==submitted[i]))throw Error("公共 Flash 独立回读不一致；编辑值保留");
 // Verification never replaces edits made while a write was pending.
 savedDefaults=actual;notify();return actual;
}
let defaultsQueue:Promise<unknown>=Promise.resolve();
export function saveSharedDefaults(){
 if(!defaults)return Promise.reject(Error("请先读取主控公共配置"));
 const submitted=[...defaults];
 const job=defaultsQueue.then(()=>commitSharedDefaults(submitted));defaultsQueue=job.catch(()=>{});return job;
}
export function useSharedHome() {
 const config=useSyncExternalStore(subscribe,()=>home);
 return {config,saved:savedHome,setConfig:(values:number[])=>{home=[...values];syncHome();notify();}};
}
function syncHome() {
 if(!defaults)return;
 defaults=[...defaults];
 home.slice(0,5).forEach((x,i)=>{defaults![8+i*2]=x&255;defaults![9+i*2]=x>>>8;});
 defaults[18]=home[7]&255;defaults[19]=home[7]>>>8;
}
export async function readSharedHome(motor:number) {
 const r=await semanticMotion.command(motor,{kind:"homing_config_read"});
 if(!r.homing_config)throw Error("主控未返回找零参数");
 home=[...r.homing_config];savedHome=[...home];syncHome();notify();return home;
}
export async function writeSharedHome(motor:number) {
 const submitted=[...home];
 await semanticMotion.command(motor,{kind:"homing_config_write",config:submitted});
 const r=await semanticMotion.command(motor,{kind:"homing_config_read"});
 if(!r.homing_config||submitted.some((x,i)=>x!==r.homing_config![i]))throw Error("找零参数回读不一致");
 savedHome=[...submitted];
 if(defaults){defaults=[...defaults];submitted.slice(0,5).forEach((x,i)=>{defaults![8+i*2]=x&255;defaults![9+i*2]=x>>>8;});defaults[18]=submitted[7]&255;defaults[19]=submitted[7]>>>8;}
 notify();
}
export function useSharedEncoder(motor:number) {
 const get=()=>{if(!encoderCache.has(motor))encoderCache.set(motor,{...encoder,offset:offsets.get(motor)??null});return encoderCache.get(motor)!;};
 const cfg=useSyncExternalStore(subscribe,get);
 const setCfg=(value:typeof cfg|((old:typeof cfg)=>typeof cfg))=>{
  const next=typeof value==="function"?value(get()):value;
  offsets.set(motor,next.offset);encoder={...next,offset:null};encoderCache.clear();
  if(defaults){defaults=[...defaults];const pairs=[[56,next.cpr],[60,next.spiHz],[64,next.pwm],[68,next.send],
   [72,next.frameBits===24?0xfffc00:16383],[76,next.frameBits|(next.spiMode<<8)|(next.idle<<16)|(next.csa<<24)],
   [80,next.poles],[84,next.velFrq??0],[88,next.velPer??0]];
   pairs.forEach(([o,v])=>putWord(defaults!,o,v));}
  notify();
 };
 return [cfg,setCfg] as const;
}

export async function ensureSharedDefaults(){return defaults??readSharedDefaults();}
