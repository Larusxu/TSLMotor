/** Target editor only. No motor commands, stop commands or authorization. */
export class PercentJog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private direction = 0;
  private value = 0;
  private last = 0;
  constructor(private update: (percent: number) => void,
              private limit: (percent: number) => void,
              private clock: () => number = () => performance.now()) {}
  start(percent: number, direction: -1 | 1) {
    this.cancel();
    if(!Number.isFinite(percent))throw Error("行程百分比无效");
    this.value = Math.max(0, Math.min(100, percent));
    this.direction = direction; this.last = this.clock();
    if ((direction < 0 && this.value === 0) || (direction > 0 && this.value === 100)) {
      this.direction = 0; this.limit(this.value); return;
    }
    this.timer = setInterval(() => this.tick(), 40);
  }
  tick() {
    if (!this.direction) return;
    const now = this.clock();
    const next = Math.max(0, Math.min(100, this.value + this.direction * 15 * Math.max(0, now - this.last) / 1000));
    this.last = now;
    if (next !== this.value) { this.value = next; this.update(next); }
    if (next === 0 || next === 100) { this.cancel(); this.limit(next); }
  }
  release() { this.tick(); this.cancel(); }
  cancel() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null; this.direction = 0;
  }
}
