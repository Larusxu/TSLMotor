import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand } from "./api";

export interface CylinderSnapshot {
  pending:boolean; result:number; ticket:number; permit:boolean; online:boolean; id:number;
  position:number; target:number; current_ma:number; temperature_c:number; restart_c:number;
  current_limit_ma:number; temperature_limit_c:number; fault:number;
  lower:number; upper:number; initial:number; storage_ready:boolean;
}
export type CylinderRequest = { id:number } & (
  {kind:"snapshot"|"read"|"clear"|"stop"|"initial"} |
  {kind:"permit";enabled:boolean} | {kind:"target";position:number} |
  {kind:"protection";current_ma:number;temperature_c:number} |
  {kind:"travel";lower:number;upper:number;initial:number}
);
export interface CylinderRow {
  id:number; current:number; temperature:number; lower:number; upper:number; initial:number;
  target:number; status:CylinderSnapshot|null; busy:boolean; error:string; received:number;
}
const empty = ():CylinderRow => ({id:1,current:0,temperature:0,lower:0,upper:2000,initial:1000,
  target:1000,status:null,busy:false,error:"",received:0});
export const cylinderApi = (channel:number,request:CylinderRequest) =>
  invokeCommand<CylinderSnapshot>("cylinder_control",{channel,request});

/** One desktop command at a time. Slider keeps only the latest unsent target,
 * including the final pointer/keyboard value. Polling never changes edit fields. */
export function useCylinders(connected:boolean,active:boolean,paused:boolean,toast:(tone:"ok"|"error"|"warn",text:string)=>void) {
  const [rows,setRows]=useState<CylinderRow[]>(()=>Array.from({length:5},empty));
  const [selected,setSelected]=useState(1);
  const rowsRef=useRef(rows);rowsRef.current=rows;
  const connectedRef=useRef(connected);connectedRef.current=connected;
  const generation=useRef(0),chain=useRef<Promise<unknown>>(Promise.resolve());
  const targets=useRef(new Map<number,number>()),pumping=useRef(false);
  const stopping=useRef(new Set<number>());
  const update=useCallback((channel:number,patch:Partial<CylinderRow>)=>setRows(rs=>rs.map((r,i)=>i===channel-1?{...r,...patch}:r)),[]);
  const enqueue=useCallback(<T,>(fn:()=>Promise<T>):Promise<T>=>{
    const next=chain.current.catch(()=>{}).then(fn);chain.current=next;return next;
  },[]);
  useEffect(()=>{
    generation.current++;targets.current.clear();stopping.current.clear();
    setRows(rs=>rs.map(r=>({...r,status:null,busy:false,received:0})));
  },[connected]);
  const command=useCallback(async(channel:number,request:CylinderRequest,fill=false,quiet=false)=>{
    const gen=generation.current;
    update(channel,{busy:true,error:""});
    try {
      const s=await enqueue(()=>{
        if(!connectedRef.current||gen!==generation.current)throw Error("连接已改变，已取消未发送的电缸操作");
        return cylinderApi(channel,request);
      });
      if(gen!==generation.current)return;
      if(request.kind==="permit" && request.enabled)stopping.current.delete(channel);
      update(channel,{status:s,received:Date.now(),...(fill?{id:s.id,current:s.current_limit_ma,temperature:s.temperature_limit_c,
        target:s.position}:{})});
      if(!quiet)toast("ok",`C${channel} ${request.kind==="travel"?"主控行程配置已保存":"操作完成"}`);
      return s;
    }catch(e){if(gen===generation.current){update(channel,{error:String(e)});toast("error",String(e));}}
    finally {if(gen===generation.current)update(channel,{busy:false});}
  },[enqueue,toast,update]);
  useEffect(()=>{
    if(!connected||!active||paused)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const gen=generation.current;
    const poll=async()=>{
      for(let ch=1;ch<=5&&!disposed;ch++){
        if(rowsRef.current[ch-1].busy||targets.current.size)continue;
        try{
          const s=await enqueue(async()=>{
            if(disposed||gen!==generation.current)throw Error("cancelled");
            return cylinderApi(ch,{kind:"snapshot",id:rowsRef.current[ch-1].id});
          });
          if(!disposed&&gen===generation.current)update(ch,{status:s,received:Date.now()});
        }catch{/* A detached view must not turn a transient poll error into a toast storm. */}
      }
      if(!disposed)timer=setTimeout(poll,500);
    };
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[connected,active,paused,enqueue,update]);
  const setTarget=useCallback((ch:number,value:number)=>{
    update(ch,{target:value});
    const row=rowsRef.current[ch-1];
    if(!connectedRef.current||!row.status?.permit||stopping.current.has(ch))return;
    targets.current.set(ch,value);
    if(pumping.current)return;
    pumping.current=true;
    const gen=generation.current;
    void(async()=>{
      try{
        while(targets.current.size&&gen===generation.current){
          const [channel,position]=targets.current.entries().next().value as [number,number];targets.current.delete(channel);
          if(stopping.current.has(channel))continue;
          const row=rowsRef.current[channel-1];
          await command(channel,{kind:"target",id:row.id,position},false,true);
        }
      }finally{pumping.current=false;}
    })();
  },[command,update]);
  const stop=useCallback((ch:number)=>{
    stopping.current.add(ch);
    targets.current.delete(ch);
    return command(ch,{kind:"stop",id:rowsRef.current[ch-1].id},false,true);
  },[command]);
  const readTravel=useCallback(async(ch:number)=>{
    const s=await command(ch,{kind:"snapshot",id:rowsRef.current[ch-1].id},false,true);
    if(s){update(ch,{lower:s.lower,upper:s.upper,initial:s.initial});toast("ok",`C${ch} 主控行程配置已读取`);}
  },[command,update,toast]);
  return {rows,selected,setSelected,update,command,setTarget,stop,readTravel};
}
export type CylinderModel=ReturnType<typeof useCylinders>;
