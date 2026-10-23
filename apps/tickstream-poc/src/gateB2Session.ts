import { assertLiveAuthorization, AUTHORIZED_LIVE_MODE, type LiveAuthorization } from "@workspace/tickstream-storage/live-authorization";
import { LiveAppendStore, type LiveAppendOptions } from "@workspace/tickstream-storage/live-append";
import { LiveStorageQueue, type LiveQueueOptions } from "@workspace/tickstream-storage/live-queue";
import { GateBTicks, type BTicksSocket, type BEvent } from "./gateBTransport";
import { GateBWireSocket, type BTarget } from "./gateBSession";
import { LIMITS, type BReason } from "./gateBConfig";
import type { Clock } from "./transport";
import { B2_ENDPOINT, assertB2ConnectionPolicy, bindLiveStoragePort, readB2Capture, type B2CaptureReport } from "./gateB2Config";

export interface B2ManagedSocket extends BTicksSocket { closed: Promise<void>; forcedCleanup: boolean }
export async function runGateB2Session(target: BTarget, authorization: LiveAuthorization, options: {
  clock?: Clock;
  finishAfter?: number;
  onStopReady?: (stop: (reason: BReason) => void) => void;
  onActive?: (atNs: string) => void;
  /** Artificial tests only; never changes production socket or budgets. */
  artificial?: { socketFactory?: () => B2ManagedSocket; store?: Pick<LiveAppendOptions, "quotaBytes" | "fault">; queue?: LiveQueueOptions };
} = {}): Promise<B2CaptureReport> {
  const connectionPolicy = assertB2ConnectionPolicy(); // before store creation or socket construction
  assertLiveAuthorization(authorization);
  const production = authorization.captureMode === "PRODUCTION";
  if (production !== (target.kind === "PRODUCTION") ||
    production && (target.kind !== "PRODUCTION" || target.review.endpoint !== B2_ENDPOINT ||
      options.artificial || options.finishAfter !== undefined || options.clock)) throw Error("LIVE_AUTH_SCOPE");
  const clock: Clock = options.clock ?? {
    monoNs: () => process.hrtime.bigint(), utcMs: () => Date.now(),
    schedule: (ms, callback) => { const id = setTimeout(callback, ms); return () => clearTimeout(id); },
  };
  const store = new LiveAppendStore(authorization.directory, { testMode: AUTHORIZED_LIVE_MODE, authorization, ...options.artificial?.store });
  const queue = new LiveStorageQueue(store, options.artificial?.queue);
  const port = bindLiveStoragePort(queue, authorization), sockets: B2ManagedSocket[] = [];
  let pipeline: GateBTicks, activeSent = false, peak = 0, memoryFailed = false;
  const factory = () => {
    const socket = options.artificial?.socketFactory?.() ?? new GateBWireSocket(target, clock, () => pipeline.capacity);
    sockets.push(socket);
    return {
      listen: (callback: (event: BEvent) => void) => socket.listen(event => {
        if (event.type === "open" && !activeSent) { activeSent = true; options.onActive?.(clock.monoNs().toString()); }
        callback(event);
      }),
      connect: () => socket.connect(), subscribe: () => socket.subscribe(), jsonPong: () => socket.jsonPong(),
      close: () => socket.close(), terminate: () => socket.terminate(),
    };
  };
  pipeline = new GateBTicks(clock, factory, production ? "PRODUCTION" : "LOOPBACK_TEST",
    { liveStorage: port, finishAfter: options.finishAfter });
  const stopped = new Promise<void>(resolve => pipeline.onTerminal(resolve));
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (!Number.isSafeInteger(rss) || rss < 0) { memoryFailed = true; pipeline.stop("MEMORY_NOT_MEASURED"); }
    else { peak = Math.max(peak, rss); if (rss > LIMITS.sessionRss) pipeline.stop("MEMORY_THRESHOLD"); }
  };
  const monitor = setInterval(sample, 50);
  try {
    options.onStopReady?.(reason => pipeline.stop(reason, reason !== "ACTIVE_TIME_LIMIT"));
    if (!pipeline.terminal) pipeline.start(); // a supervisor STOP received before START must never dial
    sample(); await stopped;
    await Promise.all(sockets.map(socket => socket.closed)); sample();
    const transport = pipeline.liveReport().transport;
    transport.endpointBasis = production ? "USER_SELECTED_OFFICIAL_STREAMING" : "LOOPBACK_TEST";
    // A session can sample itself, NOT its supervisor. Only the independent
    // process supervisor can label combined RSS as MEASURED.
    transport.memory = { measurement: "NOT_MEASURED", childRssPeak: peak || null, totalRssPeak: null };
    if (sockets.some(s => s.forcedCleanup)) { transport.phase = "FAILED"; transport.stopReason = "FORCED_TERMINATION"; }
    const storage = queue.report();
    const result = readB2Capture({ schema: "TICKSTREAM_GATE_B2B_CAPTURE_V1", connectionPolicy, captureMode: authorization.captureMode,
      phase: transport.phase, reason: storage.phase === "FAILED" ? storage.reason : transport.stopReason,
      transport, storage, commit: store.commitState });
    if (!result) throw Error("B2_IPC_INVALID");
    return result;
  } finally {
    clearInterval(monitor); sockets.forEach(s => s.terminate()); queue.abort();
  }
}
