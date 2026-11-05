import { semanticMotion } from "./semantic-motion";
import type { RtmiBatch } from "./types";
import { acquisitionLane } from './pi-auto/acquisition';

export function decodeRtmi(data:number[]) {
  if(data.length<20)throw Error("RTMI 响应过短");
  const b=new DataView(Uint8Array.from(data).buffer), count=data[19];
  if(count>8||data.length!==20+9*count||data[16]>1||data[18]>127)throw Error("RTMI 响应格式错误");
  const samples=Array.from({length:count},(_,i)=>{
    const at=20+i*9,ch=data[at+4];if(ch>6)throw Error("RTMI 通道错误");
    return {at:b.getUint32(at,true),ch,raw:b.getInt32(at+5,true)};
  });
  return {cursor:b.getUint32(0,true),lost:b.getUint32(4,true),errors:b.getUint32(8,true),
    generation:b.getUint32(12,true),enabled:!!data[16],sampling:data[17],mask:data[18],samples};
}

/** Native UART RTMI frames only. MCU timestamp is preserved; never synthesizes
 * samples from the semantic feedback cache. One request in flight, bounded FIFO. */
export class NativeRtmi {
  private motor=0; private epoch=0; private running=false;
  private cursor=0; private generation=0; private boot="";
  private offset:number|null=null; private lastTime=0; private wrap=0;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private inFlight:Promise<void>|null=null;
  async start(motor:number,channels:[number,number][],sampling:number,decimation:number,
      batch:(b:RtmiBatch)=>void,status:(s:{sampling:number;lost:number;errors:number})=>void,
      fail:(e:unknown)=>void) {
    if(acquisitionLane.busy())throw Error('正在辨识采集，普通遥测在整定结束后可重新开始');
    await this.stop();
    if(acquisitionLane.busy())throw Error('正在辨识采集，普通遥测暂不改变RTMI配置');
    const addresses=Array(7).fill(65535);
    for(const [ch,addr] of channels){if(ch<0||ch>6)throw Error("RTMI 通道超出范围");addresses[ch]=addr;}
    await semanticMotion.configureRtmi(motor,{kind:"rtmi_config",enabled:true,sampling,addresses,decimation});
    this.motor=motor;
    const ready=await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
    this.boot=ready.boot_id;this.cursor=this.generation=0;this.offset=null;this.wrap=this.lastTime=0;
    const epoch=++this.epoch;this.running=true;let lastSample=Date.now(),lost=0;
    const poll=async()=>{
      try {
        const reply=await semanticMotion.command(motor,{kind:"rtmi_state",cursor:this.cursor});
        if(epoch!==this.epoch)return;
        if(reply.boot_id!==this.boot||!reply.rtmi)throw Error("RTMI 来源或启动身份已改变");
        const s=decodeRtmi(reply.rtmi);
        if(!s.enabled)throw Error("芯片 RTMI 已停止");
        if(this.generation&&s.generation!==this.generation)throw Error("RTMI 配置已改变，请重新采集");
        this.generation=s.generation;this.cursor=s.cursor;lost+=s.lost;status({...s,lost});
        if(s.samples.length)lastSample=Date.now();
        else if(Date.now()-lastSample>3000)throw Error("RTMI 连续 3 秒没有有效数据帧");
        if(this.offset===null&&s.samples.length)this.offset=Date.now()-s.samples[s.samples.length-1].at;
        for(const v of s.samples){
          if(v.at<this.lastTime&&this.lastTime-v.at>0x80000000)this.wrap+=0x100000000;
          this.lastTime=v.at;batch({t:(this.offset??0)+this.wrap+v.at,pts:[[v.ch,v.raw]]});
        }
      }catch(e){if(epoch===this.epoch){this.running=false;fail(e);}}
      finally{if(epoch===this.epoch&&this.running)this.timer=setTimeout(tick,15);}
    };
    const tick=()=>{this.inFlight=poll();};tick();
  }
  async stop() {
    ++this.epoch;this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=null;
    await this.inFlight;this.inFlight=null;
    if(!this.motor)return;
    const motor=this.motor;
    await semanticMotion.configureRtmi(motor,{kind:"rtmi_config",enabled:false,sampling:255,addresses:Array(7).fill(65535)});
    await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
    this.motor=0;
  }
}
