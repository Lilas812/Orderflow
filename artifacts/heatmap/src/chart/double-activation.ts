interface Tap { x: number; y: number; at: number; }

export class DoubleTap {
  private starts = new Map<number, Tap>();
  private previous: Tap | null = null;
  down(id: number, x: number, y: number, at: number): void {
    this.starts.set(id, { x, y, at });
    if (this.starts.size > 1) { this.starts.clear(); this.previous = null; }
  }
  move(id: number, x: number, y: number): void {
    const start = this.starts.get(id);
    if (start && Math.hypot(x - start.x, y - start.y) > 8) {
      this.starts.delete(id); this.previous = null;
    }
  }
  up(id: number, x: number, y: number, at: number, cancelled = false): boolean {
    this.move(id, x, y);
    const start = this.starts.get(id);
    this.starts.delete(id);
    if (cancelled || !start || at - start.at >= 320) { this.previous = null; return false; }
    if (this.previous && at - this.previous.at < 320
      && Math.hypot(x - this.previous.x, y - this.previous.y) < 26) {
      this.previous = null; return true;
    }
    this.previous = { x, y, at };
    return false;
  }
  clear(): void { this.starts.clear(); this.previous = null; }
}

/** Pointer-based touch support, with no native dblclick double-firing after a tap. */
export function bindDoubleActivation(element: HTMLElement, activate: () => void): () => void {
  const taps = new DoubleTap();
  const active = new Set<number>();
  let lastTouch = -Infinity;
  element.addEventListener("dblclick", event => {
    event.preventDefault();
    if (performance.now() - lastTouch > 700) activate();
  });
  element.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;
    active.add(event.pointerId);
    if (active.size > 1) { taps.clear(); return; }
    taps.down(event.pointerId, event.clientX, event.clientY, performance.now());
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") taps.move(event.pointerId, event.clientX, event.clientY);
  });
  const up = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    lastTouch = performance.now();
    active.delete(event.pointerId);
    if (taps.up(event.pointerId, event.clientX, event.clientY, lastTouch, event.type === "pointercancel")) activate();
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", up);
  return () => {
    taps.clear();
    for (const id of active) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    active.clear();
  };
}
