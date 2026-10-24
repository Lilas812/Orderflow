import type { LiveFrame } from "@workspace/core/analysis-hub";
import type { ObservationDisplay } from "../../web/src/lib/observationDisplay";

export interface ObservationReply { generation: number; frame: LiveFrame | null }
export interface ObservationTransport {
  select(): Promise<ObservationReply>;
  read(generation: number): Promise<ObservationReply>;
  stop(generation: number): Promise<ObservationReply>;
  release(generation: number): Promise<ObservationReply>;
}
/** Exactly one in-flight request; no delivery queue, automatic reconnect, or
 * source input in the renderer. Disposed selections release even if they finish late. */
export function createObservationSession(transport: ObservationTransport,
  publish: (value: ObservationDisplay) => void) {
  let disposed = false, busy = false, generation = 0, revision = -1;
  let timer: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  function clear() {
    if (timer !== null) clearInterval(timer);
    if (deadline !== null) clearTimeout(deadline);
    timer = null; deadline = null;
  }
  function bounded<T>(request: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      deadline = setTimeout(() => { deadline = null; reject(Error("IPC_TIMEOUT")); }, 2000);
      request.then(resolve, reject).finally(() => {
        if (deadline !== null) clearTimeout(deadline);
        deadline = null;
      });
    });
  }
  function release(g: number) { void transport.release(g).catch(() => {}); }
  function accept(reply: ObservationReply) {
    if (reply.generation !== generation) throw Error("RESPONSE_GENERATION");
    const f = reply.frame;
    if (!f) return;
    if (f.kind !== "LIVE_OBSERVATION_FRAME" || f.generation !== generation ||
      !Number.isSafeInteger(f.revision) || f.revision <= revision ||
      [f.book, f.heatmap, f.bubbles, f.delta, f.quality].some(s => s.revision !== f.revision))
      throw Error("RESPONSE_REVISION");
    revision = f.revision;
    publish({ frame: f, reason: f.reason });
    if (f.state === "STOPPED") clear();
  }
  function failed() {
    clear();
    if (!disposed) publish({ frame: null, reason: "IPC_FAILED; NO DATA" });
    if (generation) release(generation);
    disposed = true;
  }
  async function read() {
    if (disposed || busy) return;
    busy = true;
    try {
      const reply = await bounded(transport.read(generation));
      if (!disposed) accept(reply);
    } catch { if (!disposed) failed(); }
    finally { busy = false; }
  }
  return Object.freeze({
    async start() {
      if (disposed || busy || timer !== null || generation) return;
      busy = true;
      publish({ frame: null, reason: "LIVE HOLD / NOT CONNECTED" });
      try {
        const selected = transport.select();
        // A timeout/disposal cannot cancel Electron invoke. Release a scope
        // that arrives late without publishing it or starting another request.
        void selected.then(reply => { if (disposed) release(reply.generation); }, () => {});
        const reply = await bounded(selected);
        if (disposed) return;
        if (!Number.isSafeInteger(reply.generation) || reply.generation < 1) throw Error("RESPONSE_GENERATION");
        generation = reply.generation; accept(reply);
        timer = setInterval(() => { void read(); }, 250);
      } catch { if (!disposed) failed(); }
      finally { busy = false; }
    },
    stop() {
      // Clear on the client immediately; late reads cannot restore the old frame.
      if (disposed) return;
      disposed = true; clear();
      publish({ frame: null, reason: "USER_STOPPED; NO DATA" });
      if (generation) {
        void transport.stop(generation).catch(() => {}).finally(() => release(generation));
      }
    },
    dispose() { if (disposed) return; disposed = true; clear(); if (generation) release(generation); },
  });
}
