/** No socket, service or background timer. The caller supplies a deterministic clock. */
export class ReconnectController {
  status: "CONNECTED" | "RECONNECTING" | "RESYNCING" = "CONNECTED";
  reconnectCount = 0;
  private retry=0;
  nextAttemptMs: number | null = null;
  constructor(readonly now: () => number, readonly invalidate: () => void, readonly attempt: () => void) {}
  disconnect(): void {
    if (this.status === "RECONNECTING") return;
    this.invalidate(); this.status="RECONNECTING"; this.retry=0; this.nextAttemptMs=this.now()+1000;
  }
  tick(): boolean {
    if (this.status!=="RECONNECTING" || this.nextAttemptMs===null || this.now()<this.nextAttemptMs) return false;
    this.reconnectCount++; this.retry++;
    this.nextAttemptMs=this.now()+Math.min(30,2**Math.min(this.retry,5))*1000;
    this.attempt(); return true;
  }
  connected(): void { this.status="RESYNCING"; this.nextAttemptMs=null; }
  synchronized(isSnapshotAndSequenceVerified: boolean): boolean {
    if (this.status!=="RESYNCING" || !isSnapshotAndSequenceVerified) return false;
    this.status="CONNECTED"; return true;
  }
}
