import {api} from "./api";

let serial=Date.now()%65535;
const u16=(v:number)=>[v>>>8,v&255];
export function registerWords(text:string,count:number):number[]{
 const parts=text.trim().split(/[\s,，]+/);
 if(parts.length!==count)throw Error(`请输入 ${count} 个 16 位整数，空格分隔；支持 0x 十六进制`);
 return parts.map(p=>{if(!/^(?:\d+|0x[\da-f]+)$/i.test(p))throw Error("请输入十进制或 0x 十六进制整数");const v=Number(p);if(v<0||v>65535)throw Error("寄存器字范围为 0–65535");return v;});
}
export function splitRegister32(v:number):number[]{
 if(!Number.isInteger(v)||v<0||v>0xffffffff)throw Error("请输入 0–4294967295 的整数");
 return [v>>>16,v&65535];
}
export async function controllerRegisters(address:number,count:number,values?:number[]):Promise<number[]>{
 if(!Number.isInteger(address)||address<528||address+count>1312||!Number.isInteger(count)||count<1||count>60)throw Error("主控运动寄存器范围或长度无效");
 if(values&&(values.length!==count||values.some(v=>!Number.isInteger(v)||v<0||v>65535)))throw Error("寄存器数据必须为完整 16 位字组");
 const id=serial=serial%65535+1,fc=values?16:3;
 const q=[...u16(id),fc,...u16(address),...u16(count),...(values?.flatMap(u16)??[])];
 const p=await api.mainControl(0,35,q);
 if(p.length<4||p[0]*256+p[1]!==id||p[2]!==fc)throw Error("主控寄存器响应不匹配");
 if(p[3])throw Error(`主控寄存器 ${address} 拒绝${values?"写入":"读取"}，结果码 ${p[3]}${p[3]===1?"（当前有任务占用，请稍后读取状态）":""}`);
 if(p.length!==(values?4:4+2*count))throw Error("主控寄存器响应长度不完整");
 return Array.from({length:values?0:count},(_,i)=>p[4+i*2]*256+p[5+i*2]);
}

export type ControlRegister={address:number;name:string;count:number;unit?:string;format?:"u32"|"words";description:string;command?:boolean};
export function motorControlRegisters(m:number):ControlRegister[]{
 const i=m-1;
 return [
  {address:576+i,name:`M${m} 位置目标`,count:1,unit:"0.01%",description:"写入即提交绝对位置目标，0–10000 对应已找零安全行程"},
  {address:640+2*i,name:`M${m} 转速限制`,count:2,format:"u32",unit:"rpm",description:"32 位整数，高字在前；复用任务转速配置"},
  {address:672+2*i,name:`M${m} 电流限制`,count:2,format:"u32",unit:"mA",description:"32 位整数，高字在前；临时运行配置，不保存档案"},
  {address:704+4*i,name:`M${m} 模式 / 加速 / 减速`,count:3,format:"words",description:"整组：位置模式 0直通/1插补、加速ms、减速ms"},
  {address:1184+8*i,name:`M${m} 往复工况`,count:6,format:"words",description:"写入即运行：A、B（0.01%）、到位间隔ms高/低字、次数高/低字"},
 ];
}
export const commonControlRegisters:ControlRegister[]=[
 {address:592,name:"电机供电位图",count:1,description:"bit0–15 对应 M1–M16；1开启输入供电，0关闭"},
 {address:593,name:"电机驱动使能位图",count:1,description:"bit0–15 对应 M1–M16；写入目标使能状态"},
 {address:594,name:"停止并禁能",count:1,command:true,description:"写1的位执行停止并禁能；bit0=M1，不自动重复"},
 {address:595,name:"清除故障",count:1,command:true,description:"写1的位清除对应接口故障；bit0=M1"},
];
export function cylinderControlRegisters(ch:number):ControlRegister[]{
 const b=1024+32*(ch-1);
 return [
  {address:b,name:`C${ch} 行程目标`,count:1,unit:"0.01%",description:"写入0–10000为行程百分比；该地址读取值为原协议目标步数"},
  {address:b+11,name:`C${ch} 运动授权`,count:1,description:"0关闭，1开启"},
  {address:b+12,name:`C${ch} 停止`,count:1,command:true,description:"写入触发停止，不重放"},
  {address:b+13,name:`C${ch} 到初始位`,count:1,command:true,description:"写入触发移动至已保存初始位置"},
  {address:b+14,name:`C${ch} 清除故障`,count:1,command:true,description:"写入触发清除电缸故障"},
 ];
}
