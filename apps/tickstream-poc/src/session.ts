import { FakeClock, FakeSocket, LIMITS, Transport, SYNTHETIC_UTC_MS } from "./transport";
import { Diagnostics, type Report, type StopReason } from "./diagnostics";

/** Fixed, explicitly synthetic input. Never emit the payload in diagnostics. */
export function syntheticTick(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    type: "tick", symbol: "NQ", price: 20000.25, size: 1,
    side: "buy", exch: "CME", ts: SYNTHETIC_UTC_MS / 1000 - 15 * 60,
  }));
}
export function syntheticSession(): Report {
  const clock = new FakeClock();
  const socket = new FakeSocket();
  const transport = new Transport(clock, () => socket);
  transport.start(); socket.emit({ type: "open" }); socket.emit({ type: "subscribed" });
  // The same economic content is intentionally delivered twice; no false dedup.
  socket.emit({ type: "text", bytes: syntheticTick() });
  socket.emit({ type: "text", bytes: new TextEncoder().encode('{"type":"ping"}') });
  socket.emit({ type: "wsPing" });
  socket.emit({ type: "text", bytes: syntheticTick() });
  clock.advance(0); transport.stop(); clock.advance(LIMITS.cleanupMs);
  return transport.report();
}

export type WatchdogAction =
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "REQUEST_STOP"; readonly reason: StopReason }
  | { readonly kind: "FORCE_TERMINATE"; readonly reason: StopReason };
/** Parent-side policy is independently testable with fake time, no sleep/process needed. */
export function watchdog(input: {
  elapsedMs: number; stopElapsedMs: number | null;
  sessionRss: number | null; totalRss: number | null;
}): WatchdogAction {
  if (input.elapsedMs >= LIMITS.wallMs) return { kind: "FORCE_TERMINATE", reason: "FORCED_TERMINATION" };
  if (input.stopElapsedMs !== null) return input.stopElapsedMs >= LIMITS.cleanupMs ?
    { kind: "FORCE_TERMINATE", reason: "FORCED_TERMINATION" } : { kind: "CONTINUE" };
  if (input.sessionRss === null || input.totalRss === null ||
    !Number.isSafeInteger(input.sessionRss) || !Number.isSafeInteger(input.totalRss) ||
    input.sessionRss < 0 || input.totalRss < input.sessionRss) {
    return { kind: "REQUEST_STOP", reason: "MEMORY_NOT_MEASURED" };
  }
  if (input.sessionRss > LIMITS.sessionRss || input.totalRss > LIMITS.totalRss) {
    return { kind: "REQUEST_STOP", reason: "MEMORY_THRESHOLD" };
  }
  if (input.elapsedMs >= LIMITS.wallMs - LIMITS.cleanupMs) return { kind: "REQUEST_STOP", reason: "WALL_TIME_LIMIT" };
  return { kind: "CONTINUE" };
}
export function unavailableReport(reason: StopReason): Report {
  const diagnostics = new Diagnostics();
  diagnostics.reason(reason);
  return diagnostics.report("FAILED", reason, 0, false);
}
