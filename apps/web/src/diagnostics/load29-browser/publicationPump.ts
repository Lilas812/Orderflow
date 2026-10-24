/** Diagnostic-only publication lifecycle. Input completion is not UI completion. */
export function createPublicationPump(options: {
  period: number; wallMs: number;
  status(): { state: string; revision: number };
  publish(at: number, due: number): number;
  observe(): Record<"react" | "heatmap" | "bubble" | "delta" | "volumeProfile", number>;
  complete(): void; failure(error: unknown): void;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  const began = now(), rows: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let published = 0, lastAt = -Infinity, ticks = 0, done = false, ended = false;
  let inputComplete = false, hub = 0, reflected = options.observe();
  const record = (kind: string, at: number) => {
    if (rows.length >= 8192) throw Error("PUMP_RECORD_CAP");
    rows.push({ kind, at, inputComplete, hub, published, reflected: { ...reflected } });
  };
  function dispose() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (!ended) { ended = true; record("disposed", now()); }
  }
  function tick() {
    const at = now(), due = began + (++ticks) * options.period;
    try {
      if (done || ended) throw Error("PUMP_AFTER_STOP");
      if (at - began >= options.wallMs) throw Error("FINAL_PUBLICATION_TIMEOUT");
      const status = options.status();
      if (status.state === "STOPPED" || status.state === "DISPOSED") throw Error("INPUT_STOPPED");
      if (status.revision < hub) throw Error("HUB_REVISION_REVERSED");
      hub = status.revision;
      if (status.state === "COMPLETED" && !inputComplete) {
        inputComplete = true; record("input-complete", at);
      }
      if (hub !== published && at - lastAt >= options.period) {
        const revision = options.publish(at, due);
        if (revision !== hub || revision <= published) throw Error("PUBLICATION_REVISION");
        published = revision; lastAt = at; record("published", at);
      }
      reflected = options.observe();
      if (inputComplete && hub === published && Object.values(reflected).every(r => r === hub)) {
        done = true; record("ui-complete", at);
        if (timer !== null) clearInterval(timer);
        timer = null; options.complete();
      }
    } catch (error) { dispose(); options.failure(error); }
  }
  return {
    start() {
      if (timer !== null || ended || done) throw Error("PUMP_START_ONCE");
      timer = setInterval(tick, options.period);
    },
    /** Normal stop may never conceal an unpublished/unreflected revision. */
    stop() {
      if (!done) throw Error("PUMP_UNDELIVERED");
      dispose();
    },
    dispose,
    snapshot: () => ({ inputComplete, hub, published, reflected: { ...reflected },
      done, ended, timers: Number(timer !== null), rows: rows.map(r => ({ ...r })) }),
  };
}

export function publicationCleanupGate(state: { timers: number; subscribers: number; pending: number }) {
  if (state.timers !== 0 || state.subscribers !== 0 || state.pending !== 0)
    throw Error("PUBLICATION_RESOURCE_REMAINDER");
  return true;
}
