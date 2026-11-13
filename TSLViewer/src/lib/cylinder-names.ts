const joints = ["大拇指侧摆", "食指侧摆", "中指侧摆", "无名指侧摆", "小拇指侧摆"];
export function cylinderDisplayName(channel:number) {
  const joint=joints[channel-1];
  return joint?`C${channel}-${joint}`:`C${channel}`;
}
