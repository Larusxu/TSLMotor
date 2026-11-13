import {api} from "./api";
let sequence=0;
async function exchange(fc:number,address:number,count:number,values:number[]=[]){
 const id=sequence=sequence%65535+1;
 const data=[id>>>8,id&255,fc,address>>>8,address&255,count>>>8,count&255,...values.flatMap(v=>[v>>>8,v&255])];
 const r=await api.mainControl(0,35,data);
 if(r.length<4||r[0]!==id>>>8||r[1]!==(id&255)||r[2]!==fc)throw Error("运动寄存器响应不匹配");
 if(r[3])throw Error(`主控运动请求失败，结果码 ${r[3]}`);
 return r.slice(4);
}
export async function readMotionRegisters(address:number,count=1){const raw=await exchange(3,address,count);if(raw.length!==count*2)throw Error("运动寄存器长度错误");return Array.from({length:count},(_,i)=>raw[2*i]*256+raw[2*i+1]);}
export async function writeMotionRegisters(address:number,values:number[]){
 if(!values.length||values.length>60||values.some(v=>!Number.isInteger(v)||v<0||v>65535))throw Error("运动寄存器值无效");
 const r=await exchange(16,address,values.length,values);if(r.length)throw Error("运动寄存器写入响应错误");
}
export const startHandHome=()=>writeMotionRegisters(554,[1]);
export const stopHandHome=()=>writeMotionRegisters(554,[2]);
export const readHandHome=()=>readMotionRegisters(555,8);

export const stopHandDemo=()=>writeMotionRegisters(558,[1]);
