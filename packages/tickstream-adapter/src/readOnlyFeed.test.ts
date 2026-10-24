import { describe, expect, it } from "vitest";
import { analysisAdmission, createReadOnlyFeed, DOCUMENTED_FEED, reviewReadOnlyConnection,
  subscriptionFrames, type AccessEvidence } from "./readOnlyFeed";
import type { WireContext } from "./readOnlyFeed";

const evidence: AccessEvidence = { account: "CONFIRMED", realtimeL2Plan: "CONFIRMED",
  privateApplicationUse: "CONFIRMED", secretPresent: true };
const book = { type: "book", symbol: "NQ", ts: 1767225600, imbalance: 0,
  bids: [[20000, 40], [19999.75, 5]], asks: [[20000.25, 60]] };
const tick = { type: "tick", symbol: "NQ", ts: 1767225600, price: 20000.25,
  size: 3, side: "buy", exch: "CME" };
const context = (channel: "ticks" | "book" = "ticks", connectionEpoch = 1): WireContext =>
  ({ channel, connectionEpoch, receivedAtUtcNs: "1767225600000000000", receivedAtMonotonicNs: "1" });
const make = (maxFrames = 20, maxBytes = 1024 * 1024) =>
  createReadOnlyFeed("SYNTHETIC_TEST", { maxFrames, maxBytes });
const receive = (f: ReturnType<typeof make>, value: unknown, c = context()) => f.observe(JSON.stringify(value), c);

describe("documented contract and Task31 connection policy", () => {
  it("refuses connection even with a key and confirmed entitlements: query credentials remain forbidden", () => {
    expect(reviewReadOnlyConnection(evidence)).toEqual({ status: "BLOCKED", canConnect: false,
      reasons: ["QUERY_AUTH_FORBIDDEN_BY_TASK31"], canPersistMarketData: false });
    expect(DOCUMENTED_FEED.authentication).toBe("QUERY_KEY_ONLY");
  });
  it.each(["account", "realtimeL2Plan", "privateApplicationUse"] as const)("does not infer missing %s", key => {
    expect(reviewReadOnlyConnection({ ...evidence, [key]: "UNKNOWN" }).reasons).toHaveLength(2);
  });
  it("does not require reading a credential value", () => {
    expect(reviewReadOnlyConnection({ ...evidence, secretPresent: false }).reasons).toContain("SECRET_MISSING");
  });
  it("rejects malformed evidence instead of treating it as authorized", () => {
    expect(() => reviewReadOnlyConnection({ ...evidence, account: "yes" } as any)).toThrow("INVALID_ACCESS");
  });
  it.each(["subscribe", "unsubscribe"] as const)("builds only documented NQ %s frames", op => {
    expect(subscriptionFrames(op)).toEqual(["ticks", "book"].map(channel => ({ op, channel, symbols: ["NQ"] })));
    expect(Object.isFrozen(subscriptionFrames(op)[0].symbols)).toBe(true);
  });
  it("does not invent incremental, depth, L3 or contract subscription fields", () => {
    expect(() => subscriptionFrames("incremental" as any)).toThrow();
    expect(DOCUMENTED_FEED).toMatchObject({ bookSemantics: "COALESCED_FULL_SNAPSHOT",
      providerSequence: null, providerTradeId: null, contractSelection: "AUTOMATIC_FRONT_MONTH" });
  });
});

describe("bounded observation ingress, not a connected or core-promoted market feed", () => {
  it("reuses NQ quarter-tick conversion and preserves seconds precision", () => {
    const r = receive(make(), tick);
    expect(r.status).toBe("OBSERVED");
    if (r.status !== "OBSERVED" || r.record.result.status !== "ACCEPTED_OBSERVATION") throw Error();
    expect(r.record.result.observation).toMatchObject({ priceTicks: 80001,
      timestampNs: "1767225600000000000", timestampPrecision: "s", contract: null });
    expect(r.record.provenance.environment).toBe("SIMULATED");
    expect(r.admission.analysisInput).toBeNull();
    expect(r.admission.reasons).toContain("EXACT_TRADE_ID_UNAVAILABLE");
  });
  it("replaces a whole book image instead of merging omitted prices as if it were incremental", () => {
    const f = make(); receive(f, book, context("book"));
    receive(f, { ...book, bids: [[20000, 80]] }, context("book"));
    const r = f.snapshot().latestBook!;
    if (r.result.status !== "ACCEPTED_OBSERVATION" || r.result.observation.kind !== "BOOK_OBSERVATION") throw Error();
    expect(r.result.observation.bids.map(l => l.size)).toEqual([80]);
    expect(r.result.observation.asks[0].size).toBe(60);
    expect(f.snapshot().continuity).toBe("UNVERIFIED");
    expect(analysisAdmission(r).reasons).toContain("COALESCED_BOOK_NO_CONTINUOUS_COVERAGE");
  });
  it.each(["unknown", "sell", "buy"])("preserves documented aggressor %s", side => {
    const r = receive(make(), { ...tick, side });
    if (r.status !== "OBSERVED" || r.record.result.status !== "ACCEPTED_OBSERVATION") throw Error();
    expect(r.record.result.observation).toMatchObject({ side: side.toUpperCase() });
  });
  it.each([
    { price: 20000.10 }, { size: -1 }, { size: 1.5 }, { ts: 1767225600000000 },
    { symbol: "MNQ" }, { side: "guessed" }, { sequence: 7 },
  ])("rejects unsupported/malformed Tick %j", patch => {
    const f = make();
    expect(receive(f, { ...tick, ...patch }).status).toBe("REJECTED");
    expect(f.snapshot().latestTrade).toBeNull();
  });
  it("does not interpret identical deliveries as exact provider duplicates", () => {
    const f = make(); receive(f, tick); receive(f, tick);
    expect(f.snapshot()).toMatchObject({ accepted: 2, exactDedup: "UNAVAILABLE", sequence: null });
  });
  it("rejects older source seconds but makes no ordering guarantee within one second", () => {
    const f = make(); receive(f, tick);
    expect(receive(f, { ...tick, ts: tick.ts - 1 })).toEqual({ status: "REJECTED", reason: "OUT_OF_ORDER_SOURCE_TIME" });
    expect(f.snapshot().accepted).toBe(1);
  });
  it("reconnect generation clears previous observations and rejects late old-generation input", () => {
    const f = make(); receive(f, tick); receive(f, book, context("book"));
    f.nextGeneration(2);
    expect(f.snapshot()).toMatchObject({ latestBook: null, latestTrade: null, quality: "UNKNOWN" });
    expect(receive(f, tick).status).toBe("REJECTED");
    expect(receive(f, tick, context("ticks", 2)).status).toBe("OBSERVED");
    expect(() => f.nextGeneration(2)).toThrow();
  });
  it("does not reset cumulative budgets on reconnect or silently evict accepted history", () => {
    const f = make(1); receive(f, tick); f.nextGeneration(2);
    expect(receive(f, tick, context("ticks", 2))).toMatchObject({ reason: "FINITE_FEED_BUDGET_EXCEEDED" });
    expect(f.snapshot().stopped).toBe("FINITE_FEED_BUDGET_EXCEEDED");
  });
  it("fails closed before accepting input beyond byte quota", () => {
    const f = make(2, 1);
    expect(receive(f, tick).status).toBe("REJECTED");
    expect(f.snapshot()).toMatchObject({ frames: 0, bytes: 0, latestTrade: null });
  });
  it("does not retain caller-owned mutable budget configuration", () => {
    const b = { maxFrames: 1, maxBytes: 1024 }; const f = createReadOnlyFeed("SYNTHETIC_TEST", b);
    b.maxFrames = 100; receive(f, tick); expect(receive(f, tick).status).toBe("REJECTED");
  });
  it("close releases the two retained observations and never falls back to MOCK-as-LIVE", () => {
    const f = make(); receive(f, tick); f.close(); f.close();
    expect(f.snapshot()).toMatchObject({ closed: true, latestBook: null, latestTrade: null });
    expect(receive(f, tick)).toEqual({ status: "REJECTED", reason: "CLOSED" });
  });
  it("read results cannot alter retained book/Trade state", () => {
    const f = make(); receive(f, tick);
    expect(() => { (f.snapshot().latestTrade!.provenance as any).individualContract = "NQZ6"; }).toThrow();
    expect(f.snapshot().latestTrade!.provenance.individualContract).toBeNull();
  });
  it("does not expose raw payload in a rejection", () => {
    const r = make().observe('{"ARTIFICIAL_PRIVATE_MARKER":1}', context());
    expect(JSON.stringify(r)).not.toContain("ARTIFICIAL_PRIVATE_MARKER");
  });
  it.each([0, -1, 1001, 0.5])("rejects an unsafe finite frame budget %s", maxFrames => {
    expect(() => make(maxFrames)).toThrow();
  });
  it("does not pass a forged structured observation into AnalysisHub", () => {
    expect(() => analysisAdmission({ schema: "INVENTED", event: tick })).toThrow("OBSERVATION_INVALID");
  });
  it("late-generation frames consume the finite ingress budget too", () => {
    const f = make(1);
    expect(receive(f, tick, context("ticks", 2))).toMatchObject({ reason: "FOREIGN_CONNECTION_GENERATION" });
    expect(receive(f, tick)).toMatchObject({ reason: "FINITE_FEED_BUDGET_EXCEEDED" });
    const counters = f.snapshot(); receive(f, tick);
    expect(f.snapshot()).toEqual(counters);
  });
  it("rejects a malformed caller context without exposing native exception text", () => {
    expect(make().observe(JSON.stringify(tick), null as any)).toEqual({ status: "REJECTED", reason: "INVALID_RECEIVE_CONTEXT" });
  });
  it("keeps known zero resting quantity different from unavailable continuity", () => {
    const f = make(), r = receive(f, { ...book, bids: [[20000, 0]] }, context("book"));
    if (r.status !== "OBSERVED" || r.record.result.status !== "ACCEPTED_OBSERVATION") throw Error();
    expect(r.record.result.observation).toMatchObject({ bids: [{ size: 0 }] });
    expect(f.snapshot().quality).toBe("UNKNOWN");
  });
  it.each([20000.25, 20000.5])("does not promote a locked/crossed image with bid %s", price => {
    const r = receive(make(), { ...book, bids: [[price, 40]] }, context("book"));
    if (r.status !== "OBSERVED") throw Error();
    expect(r.admission.reasons).toContain("LOCKED_OR_CROSSED_BOOK");
    expect(r.admission.analysisInput).toBeNull();
  });
  it("rejects undocumented incremental messages instead of guessing SET/DELETE semantics", () => {
    expect(receive(make(), { type: "book_delta", side: "bid", price: 20000, size: 10 }, context("book")).status).toBe("REJECTED");
  });
  it("rejects oversized frames before allocating a complete UTF-8 copy or parsing JSON", () => {
    const f = make(1);
    expect(f.observe("x".repeat(1024 * 1024 + 1), context())).toMatchObject({ reason: "FRAME_TOO_LARGE" });
    expect(f.snapshot()).toMatchObject({ frames: 1, bytes: 0, accepted: 0 });
    expect(receive(f, tick)).toMatchObject({ reason: "FINITE_FEED_BUDGET_EXCEEDED" });
  });
});
