import {useSyncExternalStore} from "react";
import type {StepState} from "../components/ui";

export type AlignmentProgress = {stage:"start"|"accepted"|"scanning"|"verifying"|"completed"|"failed"|"cancelled";detail?:string};
export type AlignmentView = {
  fluxMa:number;poles:number;settle:number;stepDeg:number;endDeg:number;
  writeBack:boolean;dryRun:boolean;busy:boolean;note:string;offset:number|null;steps:StepState[];
};
const views=new Map<number,AlignmentView>(),listeners=new Set<()=>void>();
export function alignmentView(motor:number,poles=1):AlignmentView {
  if(!views.has(motor))views.set(motor,{fluxMa:300,poles,settle:700,stepDeg:90,endDeg:720,
    writeBack:true,dryRun:false,busy:false,note:"",offset:null,steps:[]});
  return views.get(motor)!;
}
export function patchAlignment(motor:number,patch:Partial<AlignmentView>) {
  views.set(motor,{...alignmentView(motor),...patch});listeners.forEach(fn=>fn());
}
export function alignmentProgress(motor:number,progress:AlignmentProgress) {
  const previous=alignmentView(motor).steps;
  const names=["启动电角度标定","主控扫描执行","偏移写回及回读","标定结果确认"];
  const idx={start:1,accepted:2,scanning:2,verifying:3,completed:4,failed:4,cancelled:4}[progress.stage];
  const steps:StepState[]=progress.stage==="start"?[]:previous.map(item=>item.idx<idx&&item.status==="run"?{...item,status:"ok"}:item);
  const entry:StepState={idx,total:4,label:names[idx-1],
    status:progress.stage==="failed"?"fail":progress.stage==="cancelled"?"info":progress.stage==="completed"?"ok":"run",
    detail:progress.detail??""};
  const at=steps.findIndex(item=>item.idx===idx);
  if(at>=0)steps[at]=entry;else steps.push(entry);
  patchAlignment(motor,{steps});
}
const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
/** Page lifetime is independent of an MCU task. Motor-keyed snapshots are
 * retained while unmounted, including the original inputs and final result. */
export function useAlignmentView(motor:number,poles:number) {
  return useSyncExternalStore(subscribe,()=>alignmentView(motor,poles));
}
