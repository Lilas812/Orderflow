import WebSocket from "ws";
import { createReadOnlyFeed, reviewReadOnlyConnection, subscriptionFrames,
  type AccessEvidence, type ObservationBudget } from "@workspace/tickstream-adapter/read-only-feed";
import { loopbackUrl, WS_OPTIONS } from "./wsClient";

export type ReadOnlyTarget =
  | { readonly kind: "LOOPBACK_TEST"; readonly endpoint: string }
  | { readonly kind: "LIVE"; readonly evidence: AccessEvidence };

/**
 * Finite Node-side connection contract. LIVE always stops at the current public
 * auth-policy gate, before dial/credential access. Artificial loopback exercises
 * the actual socket, subscription, parser, unsubscribe and close path.
 * No automatic reconnect, environment read, persistence, IPC or logging.
 */
export async function runReadOnlyFeedSession(target: ReadOnlyTarget, options: {
  readonly budget: ObservationBudget;
  readonly maxDurationMs: number;
  readonly finishAfter: number;
  readonly onObservation?: (snapshot: ReturnType<ReturnType<typeof createReadOnlyFeed>["snapshot"]>) => void;
}, dial: (url: string, options: typeof WS_OPTIONS) => WebSocket =
  (url, config) => new WebSocket(url, config)) {
  if (target.kind === "LIVE") return Object.freeze({ status: "BLOCKED" as const,
    reason: reviewReadOnlyConnection(target.evidence).reasons[0], attempts: 0, reconnects: 0 });
  if (target.kind !== "LOOPBACK_TEST") throw new Error("INVALID_FEED_TARGET");
  const endpoint = loopbackUrl(target.endpoint);
  if (!Number.isInteger(options.maxDurationMs) || options.maxDurationMs < 1 ||
    options.maxDurationMs > 60_000 || !Number.isInteger(options.finishAfter) ||
    options.finishAfter < 1 || options.finishAfter > options.budget.maxFrames)
    throw new Error("INVALID_SESSION_LIMIT");
  const feed = createReadOnlyFeed("SYNTHETIC_TEST", options.budget);
  return new Promise<Readonly<{
    status: "FINISHED" | "FAILED"; reason: string; attempts: number; reconnects: number;
    accepted: number; rejected: number; subscriptionFrames: number; unsubscribeFrames: number;
    forcedSocketCleanup: boolean; closed: boolean;
  }>>(resolve => {
    let socket: WebSocket | undefined, finished = false, stopping = false;
    let reason = "OBSERVATION_LIMIT", failed = false, forced = false, subscribed = 0, unsubscribed = 0;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let wireFrames = 0, wireBytes = 0;
    const finish = () => {
      if (finished) return; finished = true;
      clearTimeout(deadline); if (cleanupTimer) clearTimeout(cleanupTimer);
      const state = feed.snapshot(); feed.close();
      socket?.removeAllListeners();
      resolve(Object.freeze({ status: failed ? "FAILED" : "FINISHED", reason, attempts: 1,
        reconnects: 0, accepted: state.accepted, rejected: state.rejected,
        subscriptionFrames: subscribed, unsubscribeFrames: unsubscribed,
        forcedSocketCleanup: forced, closed: !socket || socket.readyState === WebSocket.CLOSED }));
    };
    const stop = (code: string, failure = false) => {
      if (stopping || finished) return;
      stopping = true; reason = code; failed = failure;
      cleanupTimer = setTimeout(() => {
        forced = true; failed = true; reason = "OWNED_SOCKET_CLEANUP_TIMEOUT";
        socket?.terminate();
        cleanupTimer = setTimeout(finish, 500);
      }, 500);
      if (socket?.readyState === WebSocket.OPEN) {
        for (const frame of subscriptionFrames("unsubscribe")) {
          socket.send(JSON.stringify(frame)); unsubscribed++;
        }
        socket.close(1000);
      } else if (socket?.readyState === WebSocket.CONNECTING) socket.close();
      else if (!socket || socket.readyState === WebSocket.CLOSED) finish();
    };
    const deadline = setTimeout(() => stop("FINITE_OBSERVATION_END"), options.maxDurationMs);
    try {
      socket = dial(endpoint, WS_OPTIONS);
      socket.on("open", () => {
        if (stopping) return;
        for (const frame of subscriptionFrames("subscribe")) {
          socket!.send(JSON.stringify(frame)); subscribed++;
        }
      });
      socket.on("message", (data, binary) => {
        if (stopping || finished) return;
        if (binary) { stop("BINARY_FRAME_REJECTED", true); return; }
        const bytes = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
        wireFrames++; wireBytes += bytes.byteLength;
        if (wireFrames > options.budget.maxFrames || wireBytes > options.budget.maxBytes) {
          stop("WIRE_BUDGET_EXCEEDED", true); return;
        }
        // WS_OPTIONS already limits frame bytes, validates UTF-8 and fragments.
        let message: unknown;
        try { message = JSON.parse(bytes.toString("utf8")); }
        catch { stop("MALFORMED_PROVIDER_FRAME", true); return; }
        const type = (message as { type?: unknown } | null)?.type;
        if (type === "ping") { socket!.send('{"op":"pong"}'); return; }
        if (type === "welcome" || type === "pong") return;
        if (type === "error" || type === "warning" || type === "feed") {
          // No free-form payload/error forwarding, no invented continuity recovery.
          stop("PROVIDER_CONTROL_REQUIRES_REVIEW", true); return;
        }
        if (type !== "tick" && type !== "book") { stop("UNDOCUMENTED_MESSAGE", true); return; }
        const result = feed.observe(bytes, { channel: type === "tick" ? "ticks" : "book",
          connectionEpoch: 1, receivedAtUtcNs: (BigInt(Date.now()) * 1_000_000n).toString(),
          receivedAtMonotonicNs: process.hrtime.bigint().toString() });
        if (result.status !== "OBSERVED") { stop(result.reason, true); return; }
        try { options.onObservation?.(feed.snapshot()); }
        catch { stop("OBSERVATION_CONSUMER_FAILED", true); return; }
        if (feed.snapshot().accepted >= options.finishAfter) stop("OBSERVATION_LIMIT");
      });
      socket.on("error", () => { if (!stopping) stop("SOCKET_FAILURE", true); });
      socket.on("close", () => {
        if (!stopping) { reason = "REMOTE_DISCONNECT"; failed = true; }
        finish();
      });
    } catch { failed = true; reason = "SOCKET_CONSTRUCTION_FAILED"; finish(); }
  });
}
