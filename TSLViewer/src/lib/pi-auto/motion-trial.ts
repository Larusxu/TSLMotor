import {semanticMotion} from '../semantic-motion';
import {decodeRtmi} from '../native-rtmi';
import {motionQuality,type MotionPoint,type MotionQuality} from './motion-quality';
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
/** Bounded real motions at 40/60/50% of the homed stroke. No PI or W25 writes. */
export async function measureEndpoint(motor:number,speeds:number[],cancelled:()=>boolean,notice:(text:string)=>void):Promise<MotionQuality[]> {
  const initial=await semanticMotion.command(motor,{kind:'position_state'}),s=initial.motor;
  if(!s?.coordinate_valid||!s.align_valid||!s.logical_span)throw Error('请先完成双端找零，再运行位置直通末段优化');
  if(s.motion_active)throw Error('请先停止当前运动');
  const span=Number(s.logical_span),positive=Number(s.positive_contact),negative=Number(s.negative_contact);
  const raw=(percent:number)=>Math.round(positive+(negative-positive)*percent/100);
  const moves:MotionQuality[]=[];
  for(const rpm of speeds){
    if(cancelled())throw Error('末段优化已取消');
    notice(`位置直通 ${rpm} rpm：中段40% → 60% → 50%，正在采集实际速度及末段响应`);
    await semanticMotion.stop(motor,true);
    await semanticMotion.wait(motor,15000,r=>r.motor?.drive===0&&!r.motor.motion_active);
    await semanticMotion.wait(motor,10000,r=>!!r.motor?.feedback_fresh&&!r.pending);
    await semanticMotion.command(motor,{kind:'task_speed',velocity_raw:Math.round(rpm*305.4198966044444),mode:0});
    await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
    await semanticMotion.configureRtmi(motor,{kind:'rtmi_config',enabled:true,sampling:127,addresses:[0x154,0x153,0x155,0x152,65535,65535,65535],decimation:2});
    await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
    try{
      await semanticMotion.enable(motor);
      const boundary=decodeRtmi((await semanticMotion.command(motor,{kind:'rtmi_state',cursor:0xffffffff})).rtmi??[]);
      let cursor=boundary.cursor;
      for(const percent of [40,60,50]){
        if(cancelled())throw Error('末段优化已取消');
        const before=(await semanticMotion.command(motor,{kind:'position_state'})).motor!;
        const accepted=await semanticMotion.command(motor,{kind:'logical_move',position:String(Math.round(span*percent/100))});
        const points:MotionPoint[]=[];let completed=0,last=0,poll=0,final=0;
        const deadline=Date.now()+90000;
        while(true){
          if(cancelled())throw Error('末段优化已取消');
          const reply=await semanticMotion.command(motor,{kind:'rtmi_state',cursor});
          if(reply.boot_id!==initial.boot_id)throw Error('主控重启，末段验证停止');
          const b=decodeRtmi(reply.rtmi??[]);cursor=b.cursor;
          if(!b.enabled||b.generation!==boundary.generation||b.lost||b.errors!==boundary.errors)throw Error('运动RTMI中断，不能计算候选评分');
          for(const p of b.samples){last=p.at;points.push({at:p.at,channel:p.ch,raw:p.raw});}
          if(!completed&&Date.now()-poll>=100){
            const r=await semanticMotion.command(motor,{kind:'position_state'}),state=r.motor!;
            if(state.fault||state.last_error||!state.coordinate_valid)throw Error(`运动已停止：fault=${state.fault}, error=${state.last_error}`);
            if(!state.motion_active&&state.arrival_phase===4){completed=r.timestamp_ms;final=Number(state.position);}
            poll=Date.now();
          }
          if(completed&&last>=completed)break;
          if(Date.now()>deadline)throw Error('末段验证等待到位超时');
          await delay(2);
        }
        const q=motionQuality(points,accepted.timestamp_ms,completed,Number(before.position),raw(percent),span,rpm,final);
        moves.push(q);notice(`${rpm} rpm → ${percent}%：末10%及稳定 ${q.tailMs} ms，峰值 ${q.peakRpm.toFixed(0)} rpm，位置超调 ${q.overshootPercent.toFixed(4)}%`);
      }
    }finally{
      await semanticMotion.stop(motor,true);
      await semanticMotion.wait(motor,15000,r=>r.motor?.drive===0&&!r.motor.motion_active);
      await semanticMotion.command(motor,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});
      await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
    }
  }
  return moves;
}
