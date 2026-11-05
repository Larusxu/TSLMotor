/** One logical owner for TMC RTMI configuration. Host keepalive and STOP stay live. */
export class AcquisitionLane {
  private reserved=false;
  private preparations=new Set<()=>Promise<void>>();
  busy(){return this.reserved;}
  beforeCapture(stop:()=>Promise<void>){this.preparations.add(stop);return ()=>{this.preparations.delete(stop);};}
  async enter(){
    if(this.reserved)throw Error('辨识采集正在使用RTMI；请等待完成或点击停止');
    this.reserved=true;
    try{for(const stop of this.preparations)await stop();}
    catch(e){this.reserved=false;throw e;}
    let released=false;
    return ()=>{if(!released){released=true;this.reserved=false;}};
  }
}
export const acquisitionLane=new AcquisitionLane();
