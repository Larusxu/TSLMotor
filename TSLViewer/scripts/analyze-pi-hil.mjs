import fs from 'node:fs';
// Analyze recorded real transport evidence; never opens serial or moves a motor.
for(const path of process.argv.slice(2)){
 const records=JSON.parse(fs.readFileSync(path,'utf8'));let segment=null,last=null;const moves=[];
 for(const x of records){
  const r=x.response;
  if(r?.motor)last=r;
  if(x.bench_start)segment={rpm:x.rpm,percent:x.percent,mode:x.mode,started:last?.timestamp_ms,fromRaw:Number(last?.motor?.position),fromLogical:Number(last?.motor?.logical_position),samples:[],currents:[],positions:[]};
  if(x.bench_accepted&&segment)segment.started=x.timestamp_ms;
  if(segment&&r?.rtmi){const bytes=Uint8Array.from(r.rtmi),b=new DataView(bytes.buffer);
   for(let i=20;i+9<=bytes.length;i+=9){const ch=bytes[i+4],v=b.getInt32(i+5,true);if(b.getUint32(i,true)<segment.started)continue;
    if(ch===0)segment.samples.push(v/305.4198966044444);
    if(ch===1)segment.currents.push((v>>16)*.20131);
    if(ch===2)segment.positions.push({at:b.getUint32(i,true),value:v});
   }
  }
  if(x.bench_done&&segment){const m=last.motor,span=Number(m.logical_span),target=span*x.percent/100;
   const distance=Math.abs(target-segment.fromLogical),tail=segment.positions.find(p=>Math.abs(p.value-segment.fromRaw)>=distance*.9);
   const rawTarget=Number(m.positive_contact)+target*(Number(m.negative_contact)-Number(m.positive_contact))/span;
   const direction=Math.sign(rawTarget-segment.fromRaw);
   moves.push({rpm:x.rpm,percent:x.percent,mode:segment.mode,peakRpm:Math.max(0,...segment.samples.map(Math.abs)),
    peakIqMa:Math.max(0,...segment.currents.map(Math.abs)),velocitySamples:segment.samples.length,
    samplesAt95Percent:segment.samples.filter(v=>Math.abs(v)>=.95*x.rpm).length,elapsedMs:last.timestamp_ms-segment.started,
    finalErrorCounts:Math.abs(Number(m.logical_position)-target),errorPercent:100*Math.abs(Number(m.logical_position)-target)/span,
    sampledPositionOvershootPercent:100*Math.max(0,...segment.positions.map(p=>(p.value-rawTarget)*direction))/span,
    last10PercentAndDwellMs:tail?last.timestamp_ms-tail.at:null,fault:m.fault,arrivalPhase:m.arrival_phase});segment=null;
  }
 }
 console.log(JSON.stringify({path,moves,final:last?.motor,piReadbacks:records.filter(v=>v.live_pi_rtmi).map(v=>v.live_pi_rtmi)},null,2));
}
