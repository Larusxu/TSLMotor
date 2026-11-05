/** Position-direct endpoint quality in motor coordinates. Pure, no transport. */
export interface MotionPoint {at:number;channel:number;raw:number}
export interface MotionQuality {
  rpm:number;elapsedMs:number;tailMs:number;peakRpm:number;peakIqMa:number;
  overshootPercent:number;finalErrorPercent:number;speedExcess:number;
}
export function motionQuality(points:MotionPoint[],start:number,end:number,from:number,target:number,span:number,rpm:number,final:number):MotionQuality {
  if(!(span>0&&rpm>0&&end>=start))throw Error('运动测量范围无效');
  const valid=points.filter(p=>p.at>=start&&p.at<=end),positions=valid.filter(p=>p.channel===2);
  const velocities=valid.filter(p=>p.channel===0),currents=valid.filter(p=>p.channel===1);
  if(positions.length<4||velocities.length<4||!currents.length)throw Error('运动采样不足，不能据此接受候选PI');
  const direction=Math.sign(target-from),distance=Math.abs(target-from);
  if(!direction)throw Error('运动测量需要非零行程');
  const tail=positions.find(p=>Math.abs(p.raw-from)>=distance*.9);
  const peakRpm=Math.max(...velocities.map(p=>Math.abs(p.raw)/305.4198966044444));
  return {rpm,elapsedMs:end-start,tailMs:tail?end-tail.at:end-start,peakRpm,
    peakIqMa:Math.max(...currents.map(p=>Math.abs(p.raw>>16)*.20131)),
    overshootPercent:100*Math.max(0,...positions.map(p=>(p.raw-target)*direction))/span,
    finalErrorPercent:100*Math.abs(final-target)/span,speedExcess:Math.max(0,peakRpm/rpm-1)};
}
export function motionScore(moves:MotionQuality[]) {
  if(!moves.length)throw Error('没有运动验证结果');
  // The goal is endpoint settling, not high peak speed. Normalize time by
  // task speed; penalize speed peaks separately from position overshoot.
  return moves.reduce((s,m)=>s+m.tailMs/1000+.1*m.elapsedMs/1000+
    12*m.speedExcess+80*m.overshootPercent+100*m.finalErrorPercent,0)/moves.length;
}
export function qualifiedMotion(moves:MotionQuality[]) {
  return moves.length>0&&moves.every(m=>m.finalErrorPercent<=.05&&m.overshootPercent<=.05&&m.speedExcess<=.25);
}
