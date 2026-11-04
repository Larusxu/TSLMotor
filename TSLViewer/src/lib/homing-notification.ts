import type { SemanticReply } from "./semantic-state";

/** Observe an actual home task, not a valid bit inherited on connection. */
export class HomingNotification {
  private active = new Map<number, string>();
  observe(motor: number, r: SemanticReply): { tone: "ok" | "error"; text: string } | null {
    const s=r.motor;if(!motor||!s)return null;
    if(this.active.has(motor)&&this.active.get(motor)!==r.boot_id)this.active.delete(motor);
    if(s.motion_owner===2&&s.motion_active){this.active.set(motor,r.boot_id);return null;}
    if(!this.active.has(motor)||s.motion_active||s.drive===1||r.pending||s.pending_action)return null;
    this.active.delete(motor);
    const ok=!s.fault&&!s.last_error&&s.config_verified&&s.limits_valid&&(s.home_neg_valid||s.home_pos_valid);
    return ok?{tone:"ok",text:`M${motor} 找零完成，电机已停止，逻辑供电保持`}
      :{tone:"error",text:`M${motor} 找零失败或已取消，电机已停止（fault=${s.fault}, error=${s.last_error}）`};
  }
}
