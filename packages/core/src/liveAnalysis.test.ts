import { expect, it } from "vitest";
import { createLiveAnalysisHub, LIVE_LIMITS, type LiveObservation } from "./analysisHub";

const observation = (ordinal = 1): LiveObservation => ({
  origin: "SYNTHETIC_TEST", generation: 1, ordinal, channel: "book",
  timestampNs: "1767225600000000000", receivedNs: "1767225600123000000",
  symbol: "NQ", precision: "s", contract: null, session: null, sequence: null, tradeId: null,
  levels: [{ side: "BID", priceTicks: 80000, qty: 17 }, { side: "ASK", priceTicks: 80001, qty: 0 }],
  trade: null,
});
it("accepts bounded observations without pretending to be normalized MOCK or calculating unknown history", () => {
  let now = 0;
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => now);
  expect(hub.read()).toMatchObject({ state: "HOLD", book: { status: "NO_DATA" } });
  expect(hub.ingest(observation())).toBe(true);
  const first = hub.pollNotice()!;
  expect(first).toMatchObject({ label: "SIMULATED / LIVE PIPELINE", revision: 1,
    identity: { root: "NQ", contract: null, session: null },
    quality: { precision: "s", coverage: "UNKNOWN", exactDedup: "UNAVAILABLE" } });
  expect(first.book.levels.map(l => l.qty)).toEqual([17, 0]);
  expect(first.heatmap.cells).toEqual([]);
  expect(first.bubbles.items).toEqual([]);
  expect(first.delta.items).toEqual([]);
  expect(Object.isFrozen(first.book.levels)).toBe(true);
  expect([first.book, first.heatmap, first.bubbles, first.delta, first.quality]
    .every(s => s.revision === first.revision)).toBe(true);
  expect(hub.ingest({ ...observation(2), levels: [{ side: "BID", priceTicks: 79999, qty: 2 }] })).toBe(true);
  now = 249; expect(hub.pollNotice()).toBeNull();
  now = 250;
  const next = hub.pollNotice()!;
  expect(next.revision).toBe(2);
  expect(next.book.levels).toHaveLength(1); // full snapshot replacement, not a delta
  now = 2000;
  expect(hub.pollNotice()).toMatchObject({ book: { status: "NO_DATA", levels: [] }, revision: 3 });
});
it("does not collapse identical Trade observations into an invented exact duplicate", () => {
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => 0);
  const trade: LiveObservation = { ...observation(), channel: "ticks", levels: [],
    trade: { priceTicks: 80000, volume: 10, side: "UNKNOWN" } };
  expect(hub.ingest(trade)).toBe(true);
  expect(hub.ingest({ ...trade, ordinal: 2 })).toBe(true);
  expect(hub.read()).toMatchObject({ accepted: 2, lastTrade: { volume: 10, side: "UNKNOWN" }, delta: { items: [] } });
});
it("ignores an old generation and rejects reuse of a local ordinal without calling it a provider sequence", () => {
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => 0);
  expect(hub.ingest({ ...observation(), generation: 2 })).toBe(false);
  expect(hub.read().revision).toBe(0);
  hub.ingest(observation());
  expect(hub.ingest(observation())).toBe(false);
  expect(hub.read()).toMatchObject({ state: "STOPPED", book: { levels: [] }, lastTrade: null });
});
it.each([
  { precision: "ns" }, { contract: "2026-12" }, { session: "CME-SESSION" }, { sequence: "1" },
  { tradeId: "provider" }, { origin: "ACTUAL_PROVIDER_RESPONSE" }, { timestampNs: "1767225600000000001" },
  { levels: Array.from({ length: LIVE_LIMITS.levels + 1 }, () => ({ side: "BID", priceTicks: 1, qty: 1 })) },
  { levels: [{ side: "BID", priceTicks: 1.5, qty: 1 }] },
  { levels: [{ side: "BID", priceTicks: 1, qty: -1 }] },
])("fails closed on unsupported or dishonest metadata %j", change => {
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => 0);
  expect(hub.ingest({ ...observation(), ...change } as LiveObservation)).toBe(false);
  expect(hub.read().state).toBe("STOPPED");
});
it("stops explicitly at its finite input budget, clears quantities, and releases on dispose", () => {
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => 0);
  for (let n = 1; n <= LIVE_LIMITS.inputs; n++) expect(hub.ingest(observation(n))).toBe(true);
  expect(hub.ingest(observation(LIVE_LIMITS.inputs + 1))).toBe(false);
  expect(hub.read()).toMatchObject({ reason: "LIVE_CAPACITY_EXCEEDED", book: { levels: [] } });
  hub.dispose(); expect(hub.pollNotice()).toBeNull(); expect(hub.ingest(observation())).toBe(false);
});
it("refuses the whole input at the byte budget without silently truncating a snapshot", () => {
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => 0);
  const levels = Array.from({ length: LIVE_LIMITS.levels }, (_, i) =>
    ({ side: "BID" as const, priceTicks: i, qty: Number.MAX_SAFE_INTEGER }));
  let n = 1;
  while (n < LIVE_LIMITS.inputs && hub.ingest({ ...observation(n), levels })) n++;
  expect(n).toBeLessThan(LIVE_LIMITS.inputs);
  expect(hub.read()).toMatchObject({ state: "STOPPED", reason: "LIVE_CAPACITY_EXCEEDED",
    accepted: n - 1, book: { levels: [] } });
});
