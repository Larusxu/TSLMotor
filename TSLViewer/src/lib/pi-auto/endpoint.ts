import {motionScore,qualifiedMotion,type MotionQuality} from './motion-quality';
export interface EndpointTrial {coefficients:number[];moves:MotionQuality[];score:number}
export interface EndpointPort {
  apply(words:number[]):Promise<void>;measure():Promise<MotionQuality[]>;
  cancelled():boolean;notice(text:string):void;
}
export interface EndpointResult {improved:boolean;baseline:EndpointTrial;best:EndpointTrial;trials:EndpointTrial[]}
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
    const variants=[
      [...original.slice(0,2),pair((original[2]>>>16)*1.5,original[2]&65535),original[3]],
      [...original.slice(0,2),pair((original[2]>>>16)*.7,original[2]&65535),original[3]],
      [...original.slice(0,2),pair(original[2]>>>16,(original[2]&65535)*.5),original[3]],
      [...original.slice(0,2),pair(original[2]>>>16,0),original[3]],
      [...original.slice(0,3),pair((original[3]>>>16)*.5,original[3]&65535)],
    ];
    for(const words of variants){
      if(seen.has(words.join(',')))continue;
      const trial=await run(words);
      if(qualifiedMotion(trial.moves)&&trial.score<best.score)best=trial;
    }
    // Recheck selected task response; never save a single fortunate result.
    const repeated=await run(best.coefficients);
    const improved=best!==baseline&&qualifiedMotion(repeated.moves)&&
      (best.score+repeated.score)/2<baseline.score*.98;
    if(!improved){await port.apply(original);best=baseline;}
    else best=repeated;
    return {improved,baseline,best,trials};
  }catch(e){try{await port.apply(original);}catch(restore){throw Error(`${String(e)}；恢复本轮PI失败：${String(restore)}`);}throw e;}
}
