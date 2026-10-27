export interface FrameTiming {
  at: number;
  totalMs: number;
  heatmapMs: number;
  tradesMs: number;
  bookMs: number;
  bigMs: number;
  priceAxisMs: number;
  timeAxisMs: number;
  otherMs: number;
  depth: boolean;
  aggregationMs: number;
  scaleMs: number;
  rasterMs: number;
  colorMs: number;
  uploadMs: number;
  tileSyncMs: number;
}

/** Bounded diagnostic history; timers with containment are not added twice. */
export class FrameProfile {
  private frames: FrameTiming[] = [];
  record(frame: Omit<FrameTiming, "otherMs">): void {
    const exclusive = frame.heatmapMs + frame.tradesMs + frame.bookMs + frame.bigMs
      + frame.priceAxisMs + frame.timeAxisMs;
    this.frames.push({ ...frame, otherMs: Math.max(0, frame.totalMs - exclusive) });
    if (this.frames.length > 2400) this.frames.splice(0, this.frames.length - 2400);
  }
  snapshot(): FrameTiming[] { return this.frames.map(frame => ({ ...frame })); }
}
