import { describe, expect, it } from "vitest";
import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import { makeWorkload, WORKLOAD_IDS } from "./finiteMockWorkload";
import { MetricBuffer, distribution, classifyInput } from "./metrics";
import { canonical, measureWorkload, validateWorkload } from "./runAnalysisBenchmark";

// Only small definitions (<=13 inputs) reach a hub here. No benchmark flag in normal tests.
describe("finite MOCK definitions", () => {
  it.each(WORKLOAD_IDS)("is deterministic, isolated and small for unit verification: %s", id => {
    const a = makeWorkload(id, 8), b = makeWorkload(id, 8);
    expect(a.inputs.length).toBeLessThanOrEqual(13);
    expect(canonical(a)).toBe(canonical(b));
    expect(validateWorkload(a).bytes).toBeLessThan(a.scope.budget.normalizedBytes);
    const channels = new Map<string, { seq: bigint; time: bigint }>();
    const identities = new Set<string>();
    for (const input of a.inputs) if (input.type === "EVENT") {
      const h = input.event.header, seq = BigInt(h.sequence!), time = BigInt(h.exchangeTimeNs!);
      expect(h.sessionId).toBe(a.scope.config.identity.sessionId);
      expect(h.sourceId).toBe(a.scope.config.identity.sourceId);
      const old = channels.get(h.channel);
      if (!identities.has(h.eventId)) {
        if (old) { expect(seq).toBe(old.seq + 1n); expect(time).toBeGreaterThanOrEqual(old.time); }
        channels.set(h.channel, { seq, time });
      }
      identities.add(h.eventId);
    }
  });
  it("independently defines the existing 13-input numerical contract without borrowing events", () => {
    const w = makeWorkload("baseline13"), e = UNIFIED_MOCK_STREAM.expected;
    expect([w.expected.B, w.expected.S, w.expected.U, w.expected.V]).toEqual([e.B, e.S, e.U, e.volume].map(String));
    expect(w.expected.twa).toEqual(e.bidTwa);
    expect(w.expected.coverage).toEqual(e.coverage);
    expect(w.expected.delta).toEqual(e.delta.map(d => d === null ? null : String(d)));
    expect([w.expected.poc, w.expected.val, w.expected.vah]).toEqual([e.pocTick, e.valTick, e.vahTick]);
    expect(w.scope.config.identity.sourceId).not.toBe(UNIFIED_MOCK_STREAM.scope.config.identity.sourceId);
  });
  it("rejects nonfinite small generators and foreign input", () => {
    expect(() => makeWorkload("mixed128", 100)).toThrow();
    const w = makeWorkload("mixed128", 8);
    const first = w.inputs[0];
    if (first.type !== "EVENT") throw Error("test fixture");
    const broken = { ...w, inputs: [{ ...first, event: { ...first.event,
      header: { ...first.event.header, sessionId: "FOREIGN" } } }] };
    expect(() => validateWorkload(broken)).toThrow("FOREIGN_SCOPE");
  });
});

describe("bounded measurement records", () => {
  it("never silently overwrites a full buffer and returns a defensive array", () => {
    const b = new MetricBuffer<number>(2); b.record(1); b.record(2);
    expect(() => b.record(3)).toThrow("METRIC_BUFFER_FULL");
    const copy = b.snapshot() as number[]; copy[0] = 99;
    expect(b.snapshot()).toEqual([1, 2]);
    expect(() => new MetricBuffer(4097)).toThrow();
  });
  it("uses nearest-rank quantiles, flags sparse p99 and does not sort the caller array", () => {
    const v = [5, 1, 4, 2, 3], s = distribution(v);
    expect(s).toEqual({ count: 5, mean: 3, p50: 3, p95: 5, p99: 5, maximum: 5, p99ReferenceOnly: true });
    expect(v).toEqual([5, 1, 4, 2, 3]);
    const large = distribution(Array.from({ length: 100 }, (_, i) => i + 1));
    expect([large.p50, large.p95, large.p99, large.p99ReferenceOnly]).toEqual([50, 95, 99, false]);
    expect(distribution([]).p99).toBeNull();
    expect(() => distribution([NaN])).toThrow();
  });
  it("preserves large bigint quantities and Map insertion order", () => {
    expect(canonical(900719925474099312345n)).toContain("900719925474099312345");
    expect(canonical(new Map([[2, "a"], [1, "b"]]))).not.toBe(canonical(new Map([[1, "b"], [2, "a"]])));
  });
});

function fakeClock() {
  let t = 0;
  return { clock: () => { t += .01; return t; }, sleep: async (ms: number) => { t += ms; } };
}
describe("small explicit hub measurement", () => {
  it("does not invent zero Delta or a POC when the minimum definition has no Trade", async () => {
    const r = await measureWorkload(makeWorkload("mixed128", 4), { notifications: false, ...fakeClock() });
    expect(r.pass).toBe(true);
    expect([r.summary.poc, r.summary.val, r.summary.vah]).toEqual([null, null, null]);
    expect(r.summary.delta).toEqual([null, null, null]);
  });
  it.each(["baseline13", "mixed128", "duplicate", "conflict", "unknown", "budget513", "cells128", "cells512"] as const)(
    "verifies quantities, disposition, hash and bounded stopping: %s", async id => {
      const w = makeWorkload(id, 8);
      const result = await measureWorkload(w, { notifications: true, ...fakeClock() });
      expect(result.checks).toEqual(expect.objectContaining({ referenceHash: true, noPartialPublish: true }));
      expect(result.pass).toBe(true);
      expect(result.summary.revision).toBe(w.inputs.length);
      expect(result.reads.at(-1)?.cache).toBe("HIT");
      if (id === "budget513") {
        expect(result.hubStop).toContain("inputs");
        expect(result.committedHash).toBe(result.beforeOverflowHash);
        expect(result.rejectedInputs).toBe(1);
      }
      if (id === "conflict") expect(result.byKind.TRADE_CONFLICTING_TRADE_ID.count).toBe(1);
      if (id === "duplicate") expect(result.byKind.TRADE_DUPLICATE.count).toBeGreaterThan(0);
    });
  it("ON and OFF preserve exactly the same final state; schedule and processing are separate", async () => {
    const w = makeWorkload("mixed128", 8);
    const on = await measureWorkload(w, { notifications: true, mode: "paced", ...fakeClock() });
    const off = await measureWorkload(w, { notifications: false, mode: "paced", ...fakeClock() });
    expect(on.meaningHash).toBe(off.meaningHash);
    expect(on.summary).toEqual(off.summary);
    expect(off.frames.noticeWaiting).toBeNull();
    expect(on.plannedInputsPerSecond).toBe(1000);
    expect(on.ingest.count).toBe(8);
    expect(on.frames.hit.count).toBeGreaterThan(0);
  });
  it("records a metric-cap stop before accepting an unrecordable input", async () => {
    const r = await measureWorkload(makeWorkload("mixed128", 8), {
      notifications: false, recordCapacity: 2, ...fakeClock(),
    });
    expect(r.benchmarkStop).toBe("METRIC_BUFFER_FULL");
    expect(r.count).toBe(2);
    expect(r.unattempted).toBe(6);
    expect(r.checks.referenceHash).toBe(true);
    expect(r.pass).toBe(false);
  });
  it("records cooperative wall stop and validates wall/rate limits", async () => {
    let t = 0;
    const r = await measureWorkload(makeWorkload("mixed128", 8), {
      notifications: false, maxWallMs: 1, clock: () => (t += .2),
    });
    expect(r.benchmarkStop).toBe("WALL_LIMIT");
    expect(r.pass).toBe(false);
    await expect(measureWorkload(makeWorkload("mixed128", 8), {
      notifications: false, maxWallMs: Infinity,
    })).rejects.toThrow("Finite wall/rate");
    expect(classifyInput(makeWorkload("mixed128", 8).inputs[0])).toBe("L2_SNAPSHOT");
  });
});
