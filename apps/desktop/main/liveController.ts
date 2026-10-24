import { createLiveAnalysisHub, LIVE_LIMITS, type LiveObservation } from "@workspace/core/analysis-hub";
import { parseAnalysisObservation } from "@workspace/tickstream-adapter/analysis-observation";

export const LIVE_CHANNEL = "orderflow:observations:v1";
export type LiveCommand = "select" | "read" | "stop" | "release";
export interface SenderEvidence {
  readonly owned: boolean;
  readonly mainFrame: boolean;
  readonly url: string;
}
/** No credential reads, connector, storage, socket or timers. Production remains
 * HOLD until a separately authorized Node feed supplies receive() calls. */
export function createDesktopLiveController(documentUrl: string, now: () => number) {
  let generation = 0, ordinal = 0, disposed = false;
  let hub: ReturnType<typeof createLiveAnalysisHub> | null = null;
  let origin: LiveObservation["origin"] = "ACTUAL_PROVIDER_RESPONSE";
  function release() { hub?.dispose(); hub = null; ordinal = 0; }
  function command(sender: SenderEvidence, request: unknown) {
    if (disposed || !sender.owned || !sender.mainFrame || sender.url !== documentUrl) throw Error("IPC_SENDER");
    if (!request || typeof request !== "object" || Array.isArray(request)) throw Error("IPC_REQUEST");
    const r = request as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "generation,op" || typeof r.op !== "string" ||
      !["select", "read", "stop", "release"].includes(String(r.op)) ||
      !Number.isSafeInteger(r.generation) || (r.generation as number) < 0) throw Error("IPC_REQUEST");
    if (r.op === "select") {
      if (r.generation !== 0) throw Error("IPC_GENERATION");
      release();
      if (!Number.isSafeInteger(generation + 1)) throw Error("IPC_GENERATION");
      generation++; hub = createLiveAnalysisHub(generation, origin, now);
      return { generation, frame: hub.pollNotice() };
    }
    if (!hub || r.generation !== generation) throw Error("IPC_GENERATION");
    if (r.op === "release") { release(); return { generation, frame: null }; }
    if (r.op === "stop") hub.stop("USER_STOPPED");
    const frame = hub.pollNotice();
    const response = { generation, frame };
    if (JSON.stringify(response).length > LIVE_LIMITS.frameBytes) {
      hub.stop("IPC_CAPACITY"); throw Error("IPC_CAPACITY");
    }
    return response;
  }
  return Object.freeze({
    command,
    invalidate() { release(); },
    /** Node-internal injection seam. Not exposed in preload/renderer/CLI.
     * The caller must opt into synthetic provenance before selecting a scope. */
    syntheticTestOnly() {
      if (hub || generation || disposed) throw Error("TEST_SCOPE_ALREADY_STARTED");
      origin = "SYNTHETIC_TEST";
    },
    receive(raw: string, channel: "book" | "ticks", epoch: number, utcNs: string, monotonicNs: string) {
      if (!hub || disposed || epoch !== generation) return false;
      // Actual feed is intentionally not wired until authentication/entitlement approval.
      if (origin !== "SYNTHETIC_TEST") { hub.stop("LIVE_AUTHORIZATION_HOLD"); return false; }
      if (typeof raw !== "string" || raw.length > 1024 * 1024) { hub.stop("WIRE_CAPACITY"); return false; }
      try {
        const observation = parseAnalysisObservation(raw, {
          origin, channel, timestampUnit: "s", receivedAtUtcNs: utcNs, receivedAtMonotonicNs: monotonicNs,
          connectionEpoch: generation, receiveOrdinal: ++ordinal,
        });
        if (!observation) { hub.stop("WIRE_REJECTED"); return false; }
        return hub.ingest(observation);
      } catch { hub.stop("WIRE_REJECTED"); return false; }
    },
    dispose() { release(); disposed = true; },
  });
}
