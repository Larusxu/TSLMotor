/** Display names belong to physical interfaces, independent of device IDs. */
export const MOTOR_JOINT_NAMES: Readonly<Record<number, string>> = {
  1: "拇指微屈", 2: "中指半屈", 3: "食指半屈", 4: "拇指半屈",
  5: "食指全屈", 6: "拇指全屈", 9: "小拇指内收", 10: "中指全屈",
  11: "无名指全屈", 12: "小拇指半屈", 13: "无名指半屈", 14: "小拇指全屈",
};
export const motorJointName = (id: number) => MOTOR_JOINT_NAMES[id] ?? "";
export const motorDisplayName = (id: number) =>
  `M${String(id).padStart(2, "0")}${motorJointName(id) ? `-${motorJointName(id)}` : ""}`;
