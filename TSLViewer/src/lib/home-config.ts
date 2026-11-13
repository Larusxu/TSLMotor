export const HOME_CONFIG_FIELDS = [
  {index:0,name:"判定系数 ×1000",unit:"",description:"接触电流阈值 = 判定系数 × 额定电流 / 1000",min:100,max:2000},
  {index:1,name:"额定电流",unit:"mA",description:"找零接触判据的电流参考",min:100,max:3000},
  {index:2,name:"连续确认",unit:"ms",description:"持续触限的确认时间",min:10,max:1000},
  {index:3,name:"找零电流上限",unit:"mA",description:"找零期间的临时电流上限",min:100,max:2000},
  {index:4,name:"推进速度上限",unit:"rpm",description:"找零阶段的推进速度上限",min:100,max:28730},
  {index:7,name:"每端超时",unit:"s",description:"每一端寻找限位的最长时间",min:5,max:300},
  {index:5,name:"触限回退",unit:"圈",description:"确认端点后反向退开，以退开后的实际位置记录零点",min:0,max:10000,scale:100},
] satisfies {index:number;name:string;unit:string;description:string;min:number;max:number;scale?:number}[];

export function validateHomeConfig(values:number[]) {
  for(const {index,name,unit,min,max,scale=1} of HOME_CONFIG_FIELDS) {
    const value=values[index];
    if(!Number.isInteger(value)||value<min||value>max)
      throw Error(`${name}范围 ${min/scale}～${max/scale}${unit ? ` ${unit}` : ""}，步长 ${1/scale}（当前 ${value/scale}）`);
  }
  if(values[3]*1000<=values[0]*values[1])
    throw Error(`找零电流上限须大于接触阈值 ${values[0]*values[1]/1000} mA`);
}
