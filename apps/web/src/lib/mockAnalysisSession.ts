import {
  createAnalysisHub, analysisInputBytes, type AnalysisInput, type AnalysisScope, type AnalysisRenderQuery,
  type AnalysisRenderFrame, type AnalysisDecision,
} from "@workspace/core/analysis-hub";
import type { Recorder } from "../diagnostics/mockDiagnostics";

export interface MockSessionOptions {
  readonly scope: AnalysisScope;
  readonly inputs: readonly AnalysisInput[];
  readonly query: AnalysisRenderQuery;
  readonly inputEveryMs?: number;
  readonly maxSubscribers?: number;
  readonly diagnostics?: Recorder;
}
export type MockSessionState = "IDLE" | "RUNNING" | "DRAINING" | "STOPPED" | "COMPLETED" | "DISPOSED";

/** Library only: importing/creating a session never starts timers or data input.
 * Each explicit start owns one finite source, one hub and at most two timers.
 */
export function createMockAnalysisSession(options: MockSessionOptions) {
  const interval = options.inputEveryMs ?? 50, maxSubscribers = options.maxSubscribers ?? 16;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647 ||
      !Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1) {
    throw new TypeError("Finite positive input interval/subscriber cap required");
  }
  if (!options.scope.derivedViews || !Array.isArray(options.inputs) ||
      options.inputs.length > options.scope.budget.inputs) {
    throw new TypeError("Finite source must fit the opted-in hub input budget");
  }
  let bytes = 0, sourceEvents = 0;
  for (const input of options.inputs) {
    sourceEvents += input.type === "EVENT" ? 1 : input.type === "BATCH" ? input.events.length : 0;
    if (sourceEvents > options.scope.budget.inputs) throw new RangeError("Finite market-event budget exceeded");
    bytes += analysisInputBytes(input);
    if (bytes > options.scope.budget.normalizedBytes) throw new RangeError("Finite source byte budget exceeded");
  }
  if (!Array.isArray(options.query.cells) || options.query.cells.length > options.scope.derivedViews.maxHeatmapCells) {
    throw new RangeError("Finite render-cell budget exceeded");
  }
  // Own the small bounded definition/source. Never hold a caller's mutable input array.
  const definition = JSON.parse(JSON.stringify({
    scope: options.scope, inputs: options.inputs, query: options.query,
  })) as MockSessionOptions;
  const listeners = new Set<(frame: AnalysisRenderFrame) => void>();
  let hub: ReturnType<typeof createAnalysisHub> | null = null;
  let inputTimer: ReturnType<typeof setInterval> | null = null;
  let noticeTimer: ReturnType<typeof setInterval> | null = null;
  let state: MockSessionState = "IDLE", reason = "NOT_STARTED", processed = 0;
  let decision: AnalysisDecision | null = null;
  let marketEvents = 0, acceptedMarketEvents = 0;
  let notificationsEnabled = true;
  let delivering = false;
  let startedAt = 0;
  let lastRead: AnalysisRenderFrame | null = null;
  const now = () => performance.now();
  function clearTimers() {
    if (inputTimer !== null) clearInterval(inputTimer);
    if (noticeTimer !== null) clearInterval(noticeTimer);
    inputTimer = noticeTimer = null;
  }
  function finish(next: MockSessionState, why: string) {
    clearTimers(); state = next; reason = why;
  }
  function pump() {
    if (!hub || delivering || (state !== "RUNNING" && state !== "DRAINING")) return;
    try {
      const notice = hub.pollNotice();
      if (notice) {
        const frame = hub.readRenderFrame(definition.query);
        if (frame.revision !== notice.revision) throw new Error("Mixed analysis revision");
        delivering = true;
        try {
          for (const listener of [...listeners]) {
            listener(frame);
            if (state !== "RUNNING" && state !== "DRAINING") break;
          }
        } finally { delivering = false; }
      }
      if (state === "DRAINING") finish("COMPLETED", "INPUT_EXHAUSTED");
    } catch {
      finish("STOPPED", "NOTIFICATION_OR_PROJECTION_FAILED");
    }
  }
  function nextInput() {
    if (!hub || state !== "RUNNING") return;
    try {
      const d = options.diagnostics;
      const entered = d ? performance.now() : 0;
      decision = hub.ingest(definition.inputs[processed]);
      d?.add("ingest", decision.revision, processed + 1, "session", performance.now() - entered,
        startedAt + (processed + 1) * interval, entered, decision.disposition === "ACCEPTED" ? 1 : 0);
      processed++;
      marketEvents += decision.eventCount;
      if (decision.disposition === "ACCEPTED") acceptedMarketEvents += decision.eventCount;
      if (decision.stop) { finish("STOPPED", decision.outcome); return; }
      if (decision.disposition === "REJECTED") { finish("STOPPED", decision.outcome); return; }
      if (processed === definition.inputs.length) {
        if (inputTimer !== null) clearInterval(inputTimer);
        inputTimer = null;
        if (notificationsEnabled) state = "DRAINING";
        else finish("COMPLETED", "INPUT_EXHAUSTED");
      }
    } catch {
      finish("STOPPED", "INPUT_FAILED");
    }
  }
  return Object.freeze({
    start() {
      if (delivering || state === "DISPOSED" || state === "RUNNING" || state === "DRAINING") {
        throw new Error("Session cannot be started in its current state");
      }
      clearTimers();
      hub = createAnalysisHub(definition.scope, now);
      processed = 0; marketEvents = 0; acceptedMarketEvents = 0;
      decision = null; state = "RUNNING"; reason = "STARTED";
      lastRead = null;
      if (options.diagnostics) startedAt = performance.now();
      if (definition.inputs.length === 0) { finish("COMPLETED", "INPUT_EXHAUSTED"); return; }
      inputTimer = setInterval(nextInput, interval);
      if (notificationsEnabled) noticeTimer = setInterval(pump, 250);
    },
    stop() {
      if (state !== "DISPOSED") finish("STOPPED", "MANUAL_STOP");
      options.diagnostics?.dispose();
    },
    dispose() {
      finish("DISPOSED", "DISPOSED");
      listeners.clear(); hub = null; decision = null;
      lastRead = null;
      options.diagnostics?.dispose();
    },
    subscribe(listener: (frame: AnalysisRenderFrame) => void) {
      if (state === "DISPOSED" || typeof listener !== "function") throw new Error("Invalid subscription");
      if (!listeners.has(listener) && listeners.size >= maxSubscribers) throw new RangeError("Subscriber budget exceeded");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setNotificationsEnabled(enabled: boolean) {
      notificationsEnabled = enabled;
      if (noticeTimer !== null) clearInterval(noticeTimer);
      noticeTimer = null;
      if (enabled && (state === "RUNNING" || state === "DRAINING")) noticeTimer = setInterval(pump, 250);
      if (!enabled && state === "DRAINING") finish("COMPLETED", "INPUT_EXHAUSTED");
    },
    readFrame(query: AnalysisRenderQuery = definition.query) {
      if (!hub) throw new Error("No active analysis hub");
      const d = options.diagnostics, started = d ? performance.now() : 0;
      const frame = hub.readRenderFrame(query);
      d?.add("frame", frame.revision, processed, "session", performance.now() - started, Number(frame === lastRead));
      if (d) lastRead = frame;
      return frame;
    },
    getStatus() {
      return Object.freeze({
        state, reason, processedInputs: processed, sourceInputs: definition.inputs.length,
        processedMarketEvents: marketEvents, acceptedMarketEvents,
        revision: decision?.revision ?? 0, counts: decision ? { ...decision.counts } : null,
        timers: Number(inputTimer !== null) + Number(noticeTimer !== null), subscribers: listeners.size,
        stop: decision?.stop ?? null,
      });
    },
  });
}
