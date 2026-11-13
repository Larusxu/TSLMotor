import { semanticMotion } from "../semantic-motion";
import { readMotorProfile, pidFromProfile, tuneMotorPi, applyMotorPi, COUNTS_PER_RPM, word } from "../motor-profile-ui";
import { decodeCapture, decodeCapturePage, decodeCaptureDiagnostic, trialCoefficients, type Capture, type Loop, type Candidate } from "./model";
import type { PidCfgPayload } from "../types";
import { parsePidConfig } from '../units';
import { decodeRtmi } from '../native-rtmi';
import { amplitudeText, captureFailure, permittedAmplitude, validatePositionExcitation, resolveCaptureTravel, percentCaptureTravel, diagnosticText } from './capture-policy';
import { automaticTune, type AutoResult, type Trial } from './automatic';
import type {CaptureProgress} from './presentation';
import {reproductionOptions} from './presets';
import { acquisitionLane } from './acquisition';
import { optimizeEndpoint,type EndpointResult } from './endpoint';
import { measureEndpoint } from './motion-trial';
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export interface IdentificationOptions { loop:Loop; amplitude:number; durationMs:number; travelCounts:number; sampling?:number; excitationSampling?:number; useHomedTravel?:boolean; travelPercentRange?:readonly number[] }
/** Shared singleton prevents page switches from leaving an unowned excitation. */
export class PiAutoService {
  private activeMotor=0;
  private cancelled=false;
  private before:PidCfgPayload|null=null;
  private trial:PidCfgPayload|null=null;
  private trialMotor=0;
  private trialBoot="";
  private active=false;
  private verified=false;
  private automaticRunning=false;
  private automaticCancelled=false;
  private sequenceRunning=false;
  private sequenceCancelled=false;
  hasTrial(motor:number){return this.trialMotor===motor&&this.trial!==null;}
  trialValues(motor:number){return this.hasTrial(motor)?{...this.trial!}:null;}
  async capture(motor:number,o:IdentificationOptions,progress:(s:CaptureProgress)=>void,notice:(message:string)=>void=()=>{},automatic=false):Promise<Capture> {
    if(this.automaticRunning&&!automatic)throw Error('自动整定正在执行');
    if(automatic&&this.automaticCancelled)throw Error('自动整定已取消');
    if(this.active)throw Error("已有辨识任务");
    this.active=true;this.activeMotor=motor;this.cancelled=false;
    let started=false,release:(()=>void)|undefined;
    try {
      if(!automatic)release=await acquisitionLane.enter();
      if(!Number.isInteger(o.amplitude)||o.amplitude<1||o.amplitude>0x7fffffff||!Number.isInteger(o.travelCounts)||o.travelCounts<1||o.travelCounts>0x7fffffff||!Number.isInteger(o.durationMs)||o.durationMs<1000||o.durationMs>7000)throw Error('幅值、时长或位移范围无效');
      const state=await semanticMotion.command(motor,{kind:"position_state"});
      if(!state.motor)throw Error("未读取到电机状态");
      if(state.motor.motion_active)throw Error("请先停止当前任务");
      if(state.motor.drive!==0){await semanticMotion.command(motor,{kind:"stop",after:2});await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);}
      const prior=decodeCapture((await semanticMotion.command(motor,{kind:"ident_state",cursor:0})).identification??[]);
      const limits=await this.liveRegisters(motor,[0x14a,0x14b]);
      const actualAmplitude=permittedAmplitude(o.loop,o.amplitude,limits[0],limits[1]);
      const travel=o.travelPercentRange?percentCaptureTravel(o.travelPercentRange,state.motor):resolveCaptureTravel(o.travelCounts,o.useHomedTravel??true,state.motor),attempt=1;
      if(o.loop===3)validatePositionExcitation(actualAmplitude,travel);
      if(this.cancelled)throw Error("辨识已取消");
      const currentLimit=o.loop===0?limits[0]&32767:limits[0]>>>16&32767;
      const setup=`实际激励${amplitudeText(o.loop,actualAmplitude)}；TMC ${o.loop===0?'Id':'Iq'}上限${amplitudeText(1,currentLimit)}；${o.useHomedTravel!==false&&state.motor.coordinate_valid?'按已找零可用行程':'自定义'}边界±${(travel*360/65536).toFixed(2)}°；本次不改限幅、不降低激励`;
      notice(setup);semanticMotion.report('info',`M${motor} 辨识配置：${setup}`);
      await semanticMotion.command(motor,{kind:"ident_start",loop_id:o.loop,amplitude:actualAmplitude,duration_ms:o.durationMs,travel_counts:travel,sampling:o.sampling,excitation_sampling:o.excitationSampling});started=true;
      const end=Date.now()+o.durationMs+20000;let final:Capture;
      for(;;){
        await delay(150);
        const r=await semanticMotion.command(motor,{kind:"ident_state",cursor:0});
        if(r.boot_id!==state.boot_id)throw Error("主控已重启，辨识失效");
        const s=decodeCapture(r.identification??[]);
        if(s.generation!==prior.generation){
          if(s.motor!==motor)throw Error('辨识记录电机已改变');
          progress({phase:s.state===2||s.state===3?'downloading':'capturing',capture:{...s,samples:[],appliedAmplitude:actualAmplitude,attempts:attempt},received:0});
          if(s.state===2||s.state===3){final=s;break;}
        }
        if(Date.now()>end)throw Error("辨识执行超时");
      }
      const samples:Capture["samples"]=[];let cursor=0,lastProgress=0,dense=true;
      while(cursor<final.count){
        if(this.cancelled)throw Error('辨识下载已取消');
        const r=await semanticMotion.command(motor,{kind:"ident_state",cursor:dense?0x80000000+cursor:cursor});
        if(r.boot_id!==state.boot_id)throw Error("下载期间主控重启");
        if(dense&&r.identification?.[0]===1){dense=false;continue;} // old firmware compatibility
        const b=decodeCapturePage(r.identification??[],final);
        if(b.generation!==final.generation||b.state!==final.state||b.motor!==motor||b.cursor!==cursor+b.samples.length||b.cursor<=cursor)throw Error("辨识记录已改变或下载停滞");
        samples.push(...b.samples);cursor=b.cursor;
        if(Date.now()-lastProgress>=100){
          progress({phase:'downloading',capture:{...final,samples:[],appliedAmplitude:actualAmplitude,attempts:attempt},received:samples.length});
          lastProgress=Date.now();
        }
      }
      if(samples.length!==final.count)throw Error('辨识样本数量不一致');
      started=false; // The terminal record already stopped/restored excitation.
      let diagnostic:Capture['diagnostic'];
      let diagnosticBoot=state.boot_id;
      try{
        const reply=await semanticMotion.command(motor,{kind:'ident_state',cursor:0xfffffffe});
        diagnosticBoot=reply.boot_id;diagnostic=decodeCaptureDiagnostic(reply.identification??[]);
      }catch(e){semanticMotion.report('warn',`M${motor} 触发现场读取失败，保留完整采集记录：${String(e)}`);}
      if(diagnosticBoot!==state.boot_id)throw Error('读取辨识现场期间主控重启');
      const result:Capture={...final,cursor,samples,appliedAmplitude:actualAmplitude,attempts:attempt,diagnostic};
      progress({phase:'complete',capture:result,received:samples.length});
      semanticMotion.report(final.state===3?'error':'info',`M${motor} 辨识结果 loop=${final.loop} generation=${final.generation} state=${final.state} ident_error=${final.error} samples=${final.count} UART_EVENTS=0x${final.events.toString(16)}`);
      if(final.state===3){
        const reason=captureFailure(result,actualAmplitude,travel);
        semanticMotion.report('warn',`M${motor} 辨识中止：${reason}`);
        throw Error(`辨识停止：${reason}。本次采集不修改PI，已保留${samples.length}组现场数据；未自动重试。`);
      }
      semanticMotion.report("ok",`M${motor} PRBS辨识完成 ${result.count}组 / ${result.sampleHz.toFixed(2)}Hz；PI未改变`);
      if(result.diagnostic)semanticMotion.report('info',`M${motor} 辨识现场：${diagnosticText(result)}`);
      return result;
    } catch(e){if(started)try{await this.cancel();}catch{/* bounded MCU deadline remains active */}throw e;}
    finally{this.active=false;this.activeMotor=0;release?.();}
  }
  async cancel(){this.sequenceCancelled=true;this.automaticCancelled=true;this.cancelled=true;if(this.activeMotor)await semanticMotion.command(this.activeMotor,{kind:"ident_abort"});}
  async automatic(motor:number,o:IdentificationOptions,bandwidthHz:number,shared:boolean,progress:(s:CaptureProgress)=>void,notice:(text:string)=>void,trial?:(result:Trial,round:number)=>void,sequenceStep=false):Promise<AutoResult>{
    if(this.active||this.automaticRunning||(this.sequenceRunning&&!sequenceStep))throw Error('已有辨识或整定任务');
    // Tune outer loops on top of unsaved inner-loop trials. Keep the original
    // whole-set backup; a failed round restores only its own starting set.
    if(this.trial)await this.refreshTrial(motor);
    const checkpoint=this.trial?{values:{...this.trial},verified:this.verified}:null;
    this.automaticRunning=true;this.automaticCancelled=false;
    let release:(()=>void)|undefined;
    try {
      release=await acquisitionLane.enter();
      return await automaticTune({
        capture:(validation=false)=>this.capture(motor,validation&&o.loop>=2?{...o,excitationSampling:Math.min(255,((o.excitationSampling??7)+1)*4-1)}:o,progress,notice,true),
        apply:async(c,p,i)=>{await this.apply(motor,c,{p,i,kp:0,kiPerSecond:0,bandwidthHz,model:{a:0,b:0,fit:0,validationFit:0,tauSeconds:null,dcGain:null},warnings:[]},shared);},
        restore:async()=>{
          if(checkpoint){await this.restoreValues(motor,checkpoint.values);this.trial=checkpoint.values;this.verified=checkpoint.verified;}
          else if(this.hasTrial(motor))await this.restore(motor);
        },
        cancelled:()=>this.automaticCancelled,
        trial,
        notice:text=>{notice(text);semanticMotion.report('info',`M${motor} 自动整定：${text}`);},
      },bandwidthHz);
    } finally {this.automaticRunning=false;release?.();}
  }
  /** Same public service called by the page and real hardware reproduction. */
  async sequence(motor:number,shared:boolean,progress:(s:CaptureProgress)=>void,notice:(text:string)=>void,
      step:(loop:Loop)=>void,trial?:(result:Trial,round:number)=>void,range?:readonly number[],settings?:Partial<Record<Loop,{options:IdentificationOptions;bandwidthHz:number}>>,completed?:(result:AutoResult,loop:Loop)=>void):Promise<AutoResult[]>{
    if(this.active||this.automaticRunning||this.sequenceRunning)throw Error('已有辨识或整定任务');
    if(this.trial)await this.refreshTrial(motor);
    this.sequenceRunning=true;this.sequenceCancelled=false;
    const results:AutoResult[]=[];
    try{
      for(const loop of [1,2,3] as const){
        if(this.sequenceCancelled)throw Error('三环自动整定已取消');
        const chosen=settings?.[loop];
        step(loop);const p={...(chosen?.options??reproductionOptions(loop)),travelPercentRange:range};
        notice(`三环流程 ${loop}/3：${['','Iq电流环','速度环','位置环'][loop]}，每环包含多轮候选和重复对照；不是失败重试`);
        const result=await this.automatic(motor,p,chosen?.bandwidthHz??reproductionOptions(loop).bandwidthHz,shared,progress,notice,trial,true);
        results.push(result);completed?.(result,loop);
      }
      return results;
    }catch(e){
      notice('三环流程已停止；已完成内环的结果保留在 TMC，W25 未保存');
      throw e;
    }finally{this.sequenceRunning=false;}
  }
  private patch(p:PidCfgPayload,loop:Loop,c:Candidate,shared:boolean):PidCfgPayload {
    const words=trialCoefficients([p.flux_p*65536+p.flux_i,p.torque_p*65536+p.torque_i,p.vel_p*65536+p.vel_i,p.pos_p*65536+p.pos_i],loop,c.p,c.i,shared);
    return {...p,flux_p:words[0]>>>16,flux_i:words[0]&65535,torque_p:words[1]>>>16,torque_i:words[1]&65535,
      vel_p:words[2]>>>16,vel_i:words[2]&65535,pos_p:words[3]>>>16,pos_i:words[3]&65535};
  }
  private livePi(motor:number){return this.liveRegisters(motor,[0x140,0x142,0x143,0x145,0x146]);}
  private async liveRegisters(motor:number,addresses:number[]){
    await semanticMotion.configureRtmi(motor,{kind:'rtmi_config',enabled:true,sampling:255,addresses:[...addresses,...Array(7-addresses.length).fill(65535)],decimation:4});
    try{
      const ready=await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
      const boundary=decodeRtmi((await semanticMotion.command(motor,{kind:'rtmi_state',cursor:0xffffffff})).rtmi??[]);
      const values:(number|undefined)[]=Array(addresses.length).fill(undefined),seen=Array(addresses.length).fill(0);let cursor=boundary.cursor,generation=boundary.generation,errors=boundary.errors;
      const end=Date.now()+3000;
      while(seen.some(n=>n<2)){
        const reply=await semanticMotion.command(motor,{kind:'rtmi_state',cursor});
        if(reply.boot_id!==ready.boot_id)throw Error('读取PI期间主控重启');
        const b=decodeRtmi(reply.rtmi??[]);cursor=b.cursor;
        if(!b.enabled||(generation&&generation!==b.generation))throw Error('PI快照RTMI会话改变');
        // A register snapshot needs two matching CRC-valid observations, not
        // a continuous time series. Discard partial observations after loss;
        // never loosen the continuity checks on actual PRBS captures.
        if(b.lost||b.errors!==errors){
          semanticMotion.report('warn',`M${motor} PI快照接收中断 lost=${b.lost} errors=${errors}→${b.errors}；丢弃局部快照，重新核对两份一致读数`);
          errors=b.errors;values.fill(undefined);seen.fill(0);
          if(Date.now()>end)throw Error('PI快照持续中断，尚未确认寄存器值');
          continue;
        }
        generation=b.generation;for(const v of b.samples)if(v.ch<values.length){const raw=v.raw>>>0;if(seen[v.ch]&&values[v.ch]!==raw)throw Error('PI快照期间寄存器发生变化');values[v.ch]=raw;seen[v.ch]++;}
        if(Date.now()>end)throw Error('PI快照超时');await delay(10);
      }
      return values as number[];
    }finally{
      await semanticMotion.command(motor,{kind:'rtmi_config',enabled:false,sampling:255,addresses:Array(7).fill(65535),decimation:1});
      await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
    }
  }
  async apply(motor:number,capture:Capture,candidate:Candidate,shared:boolean){
    const release=this.automaticRunning?undefined:await acquisitionLane.enter();
    try{return await this.applyCandidate(motor,capture,candidate,shared);}
    finally{release?.();}
  }
  /** Same volatile group write as the PID page: no mode/target/integrator or W25 writes. */
  async tryResult(motor:number,loop:Loop,p:number,i:number,shared:boolean,editor?:PidCfgPayload){
    if(this.active||this.automaticRunning||this.sequenceRunning)throw Error('请等待当前整定完成后试用');
    const state=await semanticMotion.command(motor,{kind:'get_state'});
    if(this.trial&&this.trialBoot!==state.boot_id)this.discardTrial();
    const base=editor??this.trialValues(motor)??pidFromProfile((await readMotorProfile(motor)).data);
    const next=this.patch(base,loop,{p,i} as Candidate,shared);
    await tuneMotorPi(motor,loop<2?0:loop===2?1:2,next);
    if(this.hasTrial(motor)){this.trial=next;this.verified=true;}
    semanticMotion.report('ok',`M${motor} ${loop<2&&shared?'Id/Iq':'本环'} P=${p} I=${i} 临时写入并回读；积分器保持，W25未写入`);
    return next;
  }
  private async applyCandidate(motor:number,capture:Capture,candidate:Candidate,shared:boolean){
    const state=await semanticMotion.command(motor,{kind:"get_state"});
    if(state.motor?.motion_active)throw Error("请先停止运动后试用候选PI");
    if(state.motor?.drive!==0){await semanticMotion.command(motor,{kind:'stop',after:2});await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);}
    const stored=pidFromProfile((await readMotorProfile(motor)).data);
    // W25 is a saved preset, not the configuration used by this acquisition.
    // Volatile PID edits and native mode switches may legitimately differ.
    // Validate against the live snapshot below, never against the archive.
    if(capture.motor!==motor)throw Error("辨识记录属于另一电机，请选择对应电机或重新辨识");
    if(this.trial&&this.trialMotor!==motor)throw Error("请先保存或恢复上一电机的试用参数");
    if(this.trial&&this.trialBoot!==state.boot_id)this.discardTrial();
    const registers=await this.livePi(motor);
    const config=registers[0];
    if(((config^capture.pidConfig)&0x7ffffc)!==0)throw Error('TMC归一化、速度右移或位置采样已改变，请重新辨识');
    const live={...stored,...parsePidConfig(config)};
    const keys=[["flux_p","flux_i"],["torque_p","torque_i"],["vel_p","vel_i"],["pos_p","pos_i"]] as const;
    registers.slice(1).forEach((v,i)=>{live[keys[i][0]]=v>>>16;live[keys[i][1]]=v&65535;});
    if(registers.slice(1).some((v,i)=>v!==capture.coefficients[i]))throw Error('PI已在采集后改变，请重新辨识；不会使用历史快照覆盖当前PI');
    this.before=this.before??live;this.trial=this.patch(live,capture.loop,candidate,shared);this.trialMotor=motor;this.trialBoot=state.boot_id;this.verified=false;
    await semanticMotion.wait(motor,3000,r=>r.motor?.feedback_fresh===true&&!r.pending);
    await tuneMotorPi(motor,capture.loop<2?0:capture.loop===2?1:2,this.trial);
    const back=await this.livePi(motor);
    const expected=trialCoefficients(registers.slice(1),capture.loop,candidate.p,candidate.i,shared);
    if(back[0]!==config||back.slice(1).some((v,i)=>v!==expected[i]))throw Error('候选PI独立回读不一致，保留原PI备份以便恢复');
    this.verified=true;
    semanticMotion.report("ok",`M${motor} ${capture.loop<2&&shared?`Id/Iq共用 P=${candidate.p} I=${candidate.i}，两组均已写入并回读`:'候选PI已写TMC并回读'}；未保存W25，积分器未清零`);
    return this.trial;
  }
  async endpoint(motor:number,speeds:number[],notice:(text:string)=>void):Promise<EndpointResult>{
    if(this.active||this.automaticRunning)throw Error('已有辨识或整定任务');
    if(speeds.length!==2||speeds.some(v=>!Number.isFinite(v)||v<=0)||speeds[0]>=speeds[1])throw Error('请填写大于0且低速小于高速的两档转速');
    if(this.trial)await this.refreshTrial(motor);
    this.automaticRunning=true;this.automaticCancelled=false;this.activeMotor=motor;
    let release:(()=>void)|undefined,savedMode:number|undefined,savedSpeed=0;
    try{
      release=await acquisitionLane.enter();
      const state=await semanticMotion.command(motor,{kind:'position_state'});
      if(!state.motor)throw Error("未读取到电机状态");
      if(!state.motor.coordinate_valid)throw Error('请先完成双端找零；末段优化会在40%～60%行程运行');
      if(state.motor.motion_active)throw Error('请先停止当前运动');
      const profile=(await readMotorProfile(motor)).data,stored=pidFromProfile(profile);
      const ceilingRaw=word(profile,60);
      if(!ceilingRaw)throw Error('当前电机档案缺少长期转速上限，请先应用长期约束配置');
      const ceiling=ceilingRaw/COUNTS_PER_RPM;
      if(speeds.some(rpm=>Math.floor(rpm*COUNTS_PER_RPM)>ceilingRaw))
        throw Error(`末段优化转速 ${Math.max(...speeds)} rpm 超过当前电机长期转速上限 ${ceiling.toFixed(2)} rpm；请降低高速工况，或在长期约束中修改并应用转速上限`);
      savedMode=state.motor.mode;
      savedSpeed=new DataView(Uint8Array.from(profile).buffer).getUint32(112,true);
      const trialSpeeds=[speeds[0],Math.round((speeds[0]+speeds[1])/2),speeds[1]];

      const words=await this.livePi(motor),config=words[0];
      const initial={...stored,...parsePidConfig(config)};
      const keys=[['flux_p','flux_i'],['torque_p','torque_i'],['vel_p','vel_i'],['pos_p','pos_i']] as const;
      words.slice(1).forEach((v,i)=>{initial[keys[i][0]]=v>>>16;initial[keys[i][1]]=v&65535;});
      const write=async(coefficients:number[])=>{
        await semanticMotion.stop(motor,true);await semanticMotion.wait(motor,15000,r=>r.motor?.drive===0,[8]);
        const p={...initial};coefficients.forEach((v,i)=>{p[keys[i][0]]=v>>>16;p[keys[i][1]]=v&65535;});
        this.before=this.before??initial;this.trial=p;this.trialMotor=motor;this.trialBoot=state.boot_id;this.verified=false;
        // Only outer-loop coefficients change during endpoint comparison.
        for(const group of [1,2] as const)await tuneMotorPi(motor,group,p);
        const back=await this.livePi(motor);
        if(back[0]!==config||back.slice(1).some((v,i)=>v!==coefficients[i]))throw Error('末段候选PI回读不一致');
        this.verified=true;
      };
      const log=(text:string)=>{notice(text);semanticMotion.report('info',`M${motor} 位置直通末段优化：${text}`);};
      return await optimizeEndpoint(words.slice(1),{apply:write,measure:()=>measureEndpoint(motor,[...new Set(trialSpeeds)],()=>this.automaticCancelled,log),cancelled:()=>this.automaticCancelled,notice:log});
    }finally{
      try{
        if(savedMode!==undefined&&savedSpeed>0){
          await semanticMotion.stop(motor,true);await semanticMotion.wait(motor,15000,r=>r.motor?.drive===0,[8]);
          await semanticMotion.wait(motor,10000,r=>!!r.motor?.feedback_fresh&&!r.pending);
          await semanticMotion.command(motor,{kind:'task_speed',mode:savedMode,velocity_raw:savedSpeed});
          await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);
        }
      }finally{release?.();this.activeMotor=0;this.automaticRunning=false;}
    }
  }
  private config(p:PidCfgPayload){return ((p.pos_sampling<<16)|(p.vel_shift<<12)|(p.pos_norm_i<<10)|(p.pos_norm_p<<8)|(p.vel_norm_i<<6)|(p.vel_norm_p<<4)|(p.cur_norm_i<<3)|(p.cur_norm_p<<2)|(p.overwrite_target?2:0)|(p.keep_pos_target?1:0))>>>0;}
  async save(motor:number){
    const release=await acquisitionLane.enter();
    try {
    await this.checkTrial(motor);
    if(!this.verified)throw Error("候选参数尚未通过TMC回读");
    const r=await applyMotorPi(motor,this.trial!);this.before=this.trial=null;this.trialMotor=0;return r;
    }finally{release();}
  }
  async restore(motor:number){
    const release=this.automaticRunning?undefined:await acquisitionLane.enter();
    try {
    await this.checkTrial(motor);
    await this.restoreValues(motor,this.before!);
    this.before=this.trial=null;this.trialMotor=0;
    }finally{release?.();}
  }
  private async restoreValues(motor:number,p:PidCfgPayload){
    // Restoring coefficients does not require a new standstill/noise verdict.
    // First finish any stop; keep the backup on any genuine transport failure.
    const state=await semanticMotion.command(motor,{kind:'get_state'});
    if(state.motor?.motion_active||state.motor?.drive!==0||state.pending||state.motor.pending_action){
      await semanticMotion.stop(motor,true);
      await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0&&!r.motor.motion_active);
    }
    // Restore only coefficients, all three groups, using existing verified path.
    for(const group of [0,1,2] as const)await tuneMotorPi(motor,group,p);
    const current=await semanticMotion.command(motor,{kind:'get_state'});
    if(current.motor?.drive!==0){await semanticMotion.command(motor,{kind:'stop',after:2});await semanticMotion.wait(motor,10000,r=>r.motor?.drive===0);}
    const back=await this.livePi(motor);
    const expected=[this.config(p),p.flux_p*65536+p.flux_i,p.torque_p*65536+p.torque_i,p.vel_p*65536+p.vel_i,p.pos_p*65536+p.pos_i];
    if(back.some((v,i)=>v!==expected[i]))throw Error('原PI独立读回不一致，保留恢复备份');
  }
  private discardTrial(){this.before=this.trial=null;this.trialMotor=0;this.trialBoot="";this.verified=false;}
  private async refreshTrial(motor:number){
    if(this.trialMotor!==motor)throw Error('请先保存或恢复上一电机的试用参数');
    const r=await semanticMotion.command(motor,{kind:"get_state"});
    if(this.trialBoot!==r.boot_id){this.discardTrial();semanticMotion.report('info','主控重启，已自动清理上一轮试用缓存；可重新整定');return;}
    await this.checkTrial(motor);
  }
  private async checkTrial(motor:number){
    if(!this.trial||!this.before||this.trialMotor!==motor)throw Error("该电机没有待保存的试用参数");
    const r=await semanticMotion.command(motor,{kind:"get_state"});
    if(r.boot_id!==this.trialBoot){this.discardTrial();throw Error("上一轮试用记录已自动清理，请重新整定后保存");}
    if(r.motor?.motion_active)throw Error("请先停止当前任务");
  }
}
export const piAuto=new PiAutoService();
