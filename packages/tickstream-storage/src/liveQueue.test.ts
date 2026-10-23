import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalObservation, parseObservation } from "@workspace/tickstream-adapter/live-observation";
import { LiveAppendStore } from "./liveAppendStore";
import { OFFLINE_LIVE_MODE, offlineLiveRecord } from "./liveRecord";
import { recoverLive } from "./liveRecovery";
import { LiveStorageQueue, type LiveQueueOptions } from "./liveStorageQueue";
import { authorizeLiveStorage, AUTHORIZED_LIVE_MODE } from "./liveAuthorization";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function observation(n = 1, origin: "SYNTHETIC_TEST" | "ACTUAL_PROVIDER_RESPONSE" = "SYNTHETIC_TEST") {
  return parseObservation(JSON.stringify({ type: "tick", symbol: "NQ", ts: 1700000000,
    price: 20000.25, size: 12, side: "buy", exch: "CME" }), { origin, channel: "ticks", timestampUnit: "s",
    receivedAtUtcNs: "1700000000000000000", receivedAtMonotonicNs: "0", connectionEpoch: 1, receiveOrdinal: n });
}
const record = (n = 1) => offlineLiveRecord(observation(n));
function harness(options: LiveQueueOptions = {}, fault?: (phase: string) => void) {
  const d = mkdtempSync(join(tmpdir(), "tickstream-b2a-queue-")); chmodSync(d, 0o700); dirs.push(d);
  const store = new LiveAppendStore(d, { testMode: OFFLINE_LIVE_MODE, fault });
  const queue = new LiveStorageQueue(store, { manualDrain: true, ...options });
  return { d, store, queue };
}

describe("B-2A bounded durable queue and truthful accounting", () => {
  it("uses the same bounded commit protocol for explicitly authorized artificial V2 records", () => {
    // Use a new owned directory; never reuse or resume a prior store.
    const d = mkdtempSync(join(tmpdir(), "b2b-queue-v2-")); chmodSync(d, 0o700); dirs.push(d);
    const now = Date.now(), a = authorizeLiveStorage({ explicitMode: "GATE_B2B", dataPermission: true,
      replitStoragePermission: true, manualCleanupConfirmed: true, captureMode: "ARTIFICIAL_PROTOCOL_TEST",
      trialId: "bfb331cf-087e-41f6-9227-21488394112f", directory: d, issuedAtMs: now, deleteByMs: now + 60000 });
    const store = new LiveAppendStore(d, { testMode: AUTHORIZED_LIVE_MODE, authorization: a }),
      queue = new LiveStorageQueue(store, { manualDrain: true });
    queue.accept(observation()); queue.accept(observation(2)); queue.finish();
    expect(queue.report()).toMatchObject({ mode: AUTHORIZED_LIVE_MODE, persisted: 2, pending: 0, accountingMatches: true });
    expect(recoverLive(d, undefined, a).persistedCount).toBe(2);
  });
  it("separates input, enqueued and acknowledged counts", () => {
    const h = harness(); h.queue.accept(observation()); h.queue.accept(observation(2));
    expect(h.queue.report()).toMatchObject({ offered: 2, enqueued: 2, persisted: 0, pending: 2,
      unpersisted: 2, unknown: 0, accountingMatches: true });
    h.queue.finish();
    expect(h.queue.report()).toMatchObject({ phase: "STOPPED", reason: "LIVE_FINISHED", offered: 2,
      persisted: 2, pending: 0, pendingBytes: 0, unpersisted: 0, accountingMatches: true });
    expect(recoverLive(h.d).persistedCount).toBe(2);
    h.queue.finish(); expect(() => h.queue.enqueue(record(3))).toThrow("LIVE_QUEUE_CLOSED");
  });
  it("accepts exactly 128 pending records and refuses 129 without erasing ownership", () => {
    const h = harness(); let calls = 0; h.queue.onFailure(() => calls++);
    for (let n = 1; n <= 128; n++) h.queue.enqueue(record(n));
    expect(() => h.queue.enqueue(record(129))).toThrow("LIVE_QUEUE_COUNT_LIMIT");
    expect(h.queue.report()).toMatchObject({ phase: "FAILED", reason: "LIVE_QUEUE_COUNT_LIMIT",
      offered: 129, enqueued: 128, pending: 128, refused: 1, persisted: 0,
      unpersisted: 129, peakCount: 128, accountingMatches: true });
    h.queue.drain(); expect(h.store.persisted).toBe(0); expect(calls).toBe(1); h.queue.abort();
  });
  it("enforces byte cap independently, including the exact boundary", () => {
    const bytes = Buffer.byteLength(canonicalObservation(record())), h = harness({ maxBytes: bytes });
    h.queue.enqueue(record()); expect(h.queue.report().pendingBytes).toBe(bytes);
    expect(() => h.queue.enqueue(record(2))).toThrow("LIVE_QUEUE_BYTE_LIMIT");
    expect(h.queue.report()).toMatchObject({ pending: 1, refused: 1, peakBytes: bytes, accountingMatches: true });
    h.queue.abort();
  });
  it.each([{ maxCount: 129 }, { maxCount: 0 }, { maxBytes: 8 * 1024 * 1024 + 1 }, { maxBytes: 0 }])(
    "cannot enlarge or disable safety limits %j", options => {
      const h = harness();
      expect(() => new LiveStorageQueue(h.store, options)).toThrow(/LIVE_QUEUE_(COUNT|BYTE)_LIMIT/); h.queue.abort();
    });
  it.each(["BEFORE_LOG_FSYNC", "AFTER_MANIFEST"])("retains unknown head after %s; never retries or increments persisted", phase => {
    let armed = false;
    const h = harness({}, p => { if (armed && p === phase) throw Error("SECRET_SENTINEL"); });
    h.queue.enqueue(record()); h.queue.drain(); armed = true;
    h.queue.enqueue(record(2)); h.queue.enqueue(record(3)); h.queue.drain();
    expect(h.queue.report()).toMatchObject({ phase: "FAILED", reason: "LIVE_STORE_UNKNOWN",
      persisted: 1, pending: 2, unknown: 1, unpersisted: 2, accountingMatches: true });
    expect(() => h.queue.enqueue(record(4))).toThrow("LIVE_QUEUE_FAILED");
    h.queue.drain(); h.queue.abort();
    expect(recoverLive(h.d).persistedCount).toBe(phase === "AFTER_MANIFEST" ? 2 : 1);
    expect(h.queue.report().persisted).toBe(1); expect(JSON.stringify(h.queue.report())).not.toContain("SENTINEL");
  });
  it("aborts without flushing remaining events or hiding them in reports", () => {
    const h = harness(); h.queue.enqueue(record()); h.queue.abort(); h.queue.abort();
    expect(h.queue.report()).toMatchObject({ phase: "ABORTED", reason: "LIVE_QUEUE_ABORTED",
      pending: 1, unpersisted: 1, persisted: 0, accountingMatches: true });
    expect(() => h.queue.finish()).toThrow("LIVE_QUEUE_CLOSED");
    expect(recoverLive(h.d).persistedCount).toBe(0);
  });
  it("stops on invalid record without scheduling/writing it", () => {
    const h = harness();
    expect(() => h.queue.enqueue({ ...record(), raw: "SECRET_SENTINEL" } as any)).toThrow("LIVE_RECORD_INVALID");
    expect(h.queue.report()).toMatchObject({ refused: 1, enqueued: 0, offered: 1, persisted: 0, accountingMatches: true });
    h.queue.abort();
  });
  it("does not rebrand real-provider observations as synthetic test input", () => {
    const h = harness();
    expect(() => h.queue.accept(observation(1, "ACTUAL_PROVIDER_RESPONSE"))).toThrow("LIVE_PRODUCTION_DISABLED");
    expect(h.queue.report()).toMatchObject({ refused: 1, persisted: 0, accountingMatches: true }); h.queue.abort();
  });
  it("does not content-dedup or reorder queued identical Trades", () => {
    const h = harness(); for (let n = 1; n <= 20; n++) h.queue.enqueue(record(n));
    h.queue.finish(); const ordinals: number[] = []; recoverLive(h.d, r => ordinals.push(r.receiveOrdinal));
    expect(ordinals).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  it("automatically drains on a bounded scheduled turn and cancels on finish", () => {
    let callback: (() => void) | undefined, scheduled = 0, cancelled = 0;
    const h = harness({ manualDrain: false, schedule: cb => { callback = cb; scheduled++; return () => { cancelled++; }; } });
    h.queue.enqueue(record()); h.queue.enqueue(record(2)); expect(scheduled).toBe(1);
    callback!(); expect(h.queue.report().persisted).toBe(2);
    h.queue.enqueue(record(3)); h.queue.finish(); expect(cancelled).toBe(1);
    expect(h.queue.report()).toMatchObject({ persisted: 3, pending: 0 });
  });
  it("contains scheduler exceptions and keeps ownership", () => {
    const h = harness({ manualDrain: false, schedule: () => { throw Error("KEY_URL_SENTINEL"); } });
    expect(() => h.queue.enqueue(record())).toThrow(/^LIVE_STORE_IO$/);
    expect(h.queue.report()).toMatchObject({ pending: 1, persisted: 0, accountingMatches: true }); h.queue.abort();
  });
  it("refuses the 1001st offer even after previous records drained (isolated queue boundary)", () => {
    // Queue-only limit test: real durability is exercised separately. Do not
    // make this counter boundary depend on 1000 physical fsync latencies.
    let count = 0;
    const writer = { get persisted() { return count; }, append: () => { count++; }, close: () => {} };
    const queue = new LiveStorageQueue(writer as unknown as LiveAppendStore, { manualDrain: true });
    for (let n = 1; n <= 1000; n++) { queue.enqueue(record(n)); queue.drain(); }
    expect(() => queue.enqueue(record(1001))).toThrow("LIVE_STORE_QUOTA");
    expect(queue.report()).toMatchObject({ persisted: 1000, refused: 1, offered: 1001, accountingMatches: true });
    queue.abort();
  });
});
