import {motionScore,qualifiedMotion,type MotionQuality} from './motion-quality';
export interface EndpointTrial {coefficients:number[];moves:MotionQuality[];score:number}
export interface EndpointPort {
  apply(words:number[]):Promise<void>;measure():Promise<MotionQuality[]>;
  cancelled():boolean;notice(text:string):void;
}
export interface EndpointResult {improved:boolean;baseline:EndpointTrial;best:EndpointTrial;trials:EndpointTrial[]}
export class EndpointMotionRejected extends Error {}
/** Real task comparison, separate from small-signal PRBS loop fitting. */
export async function optimizeEndpoint(original:number[],port:EndpointPort):Promise<EndpointResult>{
  const trials:EndpointTrial[]=[],seen=new Set<string>();
  const run=async(words:number[])=>{
    if(port.cancelled())throw Error('末段优化已取消');
    await port.apply(words);const moves=await port.measure();
    const trial={coefficients:[...words],moves,score:motionScore(moves)};
    trials.push(trial);seen.add(words.join(','));
    port.notice(`末段对照 ${trials.length}：速度P/I=${words[2]>>>16}/${words[2]&65535}，位置P/I=${words[3]>>>16}/${words[3]&65535}，评分 ${trial.score.toFixed(3)}`);
    return trial;
  };
  try{
    const baseline=await run(original);let best=baseline;
    const pair=(p:number,i:number)=>(Math.max(1,Math.min(32767,Math.round(p)))*65536+Math.max(0,Math.min(32767,Math.round(i))))>>>0;
    const variants=(original:number[])=>[
      [...original.slice(0,2),pair((original[2]>>>16)*1.5,original[2]&65535),original[3]],
      [...original.slice(0,2),pair((original[2]>>>16)*.7,original[2]&65535),original[3]],
      [...original.slice(0,2),pair(original[2]>>>16,(original[2]&65535)*.5),original[3]],
      [...original.slice(0,2),pair(original[2]>>>16,0),original[3]],
      [...original.slice(0,3),pair((original[3]>>>16)*.5,original[3]&65535)],
      [...original.slice(0,3),pair(original[3]>>>16,(original[3]&65535)*.5)],
      [...original.slice(0,3),pair(original[3]>>>16,0)],
    ];
    // Continue around this batch's best result; no separate repeat-and-rollback gate.
    for(let pass=0;pass<2;pass++){
    for(const words of variants(best.coefficients)){
      if(seen.has(words.join(',')))continue;
      try {
        const trial=await run(words);
        if((qualifiedMotion(trial.moves)&&!qualifiedMotion(best.moves))||
          (qualifiedMotion(trial.moves)===qualifiedMotion(best.moves)&&trial.score<best.score))best=trial;
      } catch(error) {
        if(!(error instanceof EndpointMotionRejected)||port.cancelled())throw error;
        port.notice(String(error)+"；本组合不入选，恢复已验证组合继续比较");
        await port.apply(best.coefficients);
      }
    }
    }
    await port.apply(best.coefficients);
    const improved=best!==baseline;
    return {improved,baseline,best,trials};
  }catch(e){try{await port.apply(original);}catch(restore){throw Error(`${String(e)}；恢复本轮PI失败：${String(restore)}`);}throw e;}
}
