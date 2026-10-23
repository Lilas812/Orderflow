import { describe, it, expect } from "vitest";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { validateMarketEvent, type MarketEvent } from "@workspace/core/events";
import { ticksToPrice } from "@workspace/core";
import { calculateTimeWeightedDepth } from "@workspace/core/time-weighted-depth";
import { at, makeWorkload } from "../../bench/finiteMockWorkload";
import { defaults, definition, generate, sha256 } from "./generator";

const small = () => ({ ...defaults(1), maxEvents: 64, cells: 16 });
describe("load29 finite deterministic generator", () => {
  it("same seed/config/version yields byte-for-byte stable input and definition", () => {
    const a = generate(small()), b = generate(small());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputSha256).toBe(sha256(JSON.stringify(a.inputs)));
  });
  it("different seed changes serialized events", () => {
    expect(generate(small()).inputSha256).not.toBe(generate({ ...small(), seed: 30 }).inputSha256);
  });
  it("owns its frozen definition rather than caller config", () => {
    const c = small(), d = generate(c); c.baseTick++;
    expect(d.config!.baseTick).toBe(100000);
    expect(Object.isFrozen(d.inputs[0])).toBe(true);
  });
  it("keeps all existing resource caps unchanged", () => {
    expect(generate(small()).scope.budget).toEqual(makeWorkload("cells128").scope.budget);
    expect(generate(small()).scope.derivedViews).toEqual(makeWorkload("cells128").scope.derivedViews);
  });
  it("preserves the original 128-input control unchanged", () => {
    expect(definition(0).inputs).toEqual(makeWorkload("cells128").inputs);
    expect(definition(0).query).toEqual(makeWorkload("cells128").query);
  });
  it.each([8, 32])("creates asymmetric %i-level BID and ASK, no crossed book", n => {
    const d = generate({ ...small(), bidLevels: n, askLevels: n });
    const x = d.inputs[0];
    if (x.type !== "EVENT" || x.event.kind !== "L2_SNAPSHOT") throw Error("snapshot");
    expect(x.event.bids).toHaveLength(n); expect(x.event.asks).toHaveLength(n);
    expect(x.event.bids[0].qty).toBe(40); expect(x.event.asks[0].qty).toBe(20);
    expect(Math.max(...x.event.bids.map(l => l.priceTicks))).toBeLessThan(
      Math.min(...x.event.asks.map(l => l.priceTicks)));
  });
  it("all generated normalized events pass the real schema", () => {
    for (const stage of [1, 2] as const) for (const x of generate(defaults(stage)).inputs) {
      if (x.type === "EVENT") expect(validateMarketEvent(x.event)).toEqual(x.event);
    }
  });
  it("NQ ticks convert at the boundary without float accumulation", () => {
    expect([100000, 100001, 100002].map(ticksToPrice)).toEqual([25000, 25000.25, 25000.5]);
    const x = generate(small()).inputs.filter(x => x.type === "EVENT").map(x => x.event);
    expect(x.every(e => !("priceTicks" in e) || Number.isSafeInteger(e.priceTicks))).toBe(true);
  });
  it("orders equal timestamps stably and never reverses time", () => {
    const e = generate(small()).inputs.filter(x => x.type === "EVENT").map(x => x.event);
    const times = e.map(x => BigInt(x.header.receiveTimeNs));
    expect(times.every((t, i) => !i || t >= times[i - 1])).toBe(true);
    expect(times.some((t, i) => i > 0 && t === times[i - 1])).toBe(true);
    expect(new Set(e.map(x => x.header.eventId)).size).toBe(e.length);
  });
  it("SET-zero and DELETE-zero are distinct valid inputs", () => {
    const e = generate(small()).inputs.filter(x => x.type === "EVENT").map(x => x.event);
    expect(e.some(x => x.kind === "L2_SET_LEVEL" && x.qty === 0)).toBe(true);
    expect(e.some(x => x.kind === "L2_DELETE_LEVEL" && x.qty === 0)).toBe(true);
  });
  it("shifts the complete board by +3 then -2 ticks through snapshots", () => {
    const e = generate({ ...small(), maxEvents: 128 }).inputs.flatMap(x =>
      x.type === "EVENT" && x.event.kind === "L2_SNAPSHOT" ? [x.event] : []);
    expect(e.map(x => x.bids[0].priceTicks)).toEqual([99999, 100002, 100000]);
  });
  it("represents a burst as repeated timestamps, not lost inputs", () => {
    const d = generate({ ...small(), maxEvents: 128 });
    const e = d.inputs.slice(64, 80).filter(x => x.type === "EVENT").map(x => x.event.header.receiveTimeNs);
    expect(e).toHaveLength(16); expect(new Set(e).size).toBe(1);
  });
  it("has explicit channel-specific GAP/RESYNCING followed by Snapshot", () => {
    const d = generate({ ...defaults(2), maxEvents: 64, cells: 16 });
    expect(d.inputs[32]).toMatchObject({ type: "CONDITION", status: "GAP", channel: "L2_MBP" });
    expect(d.inputs[33]).toMatchObject({ type: "CONDITION", status: "RESYNCING" });
    expect(d.inputs[34]).toMatchObject({ type: "EVENT", event: { kind: "TRADE" } });
    expect(d.inputs[35]).toMatchObject({ type: "EVENT", event: { kind: "L2_SNAPSHOT" } });
  });
  it("hand-computable prefix: Trade B23/S4/V27, POC/VA=100001", () => {
    const d = generate(small()), hub = createAnalysisHub(d.scope, () => 0);
    for (const x of d.inputs.slice(0, 10)) expect(hub.ingest(x).disposition).toBe("ACCEPTED");
    const v = hub.readVolumeProfile()!;
    expect(v.totals).toMatchObject({ buyVolume: 23n, sellVolume: 4n, unknownVolume: 0n, totalVolume: 27n });
    expect(v.pocTick).toBe(100001);
    expect(v.valueArea).toMatchObject({ valTick: 100001, vahTick: 100001 });
  });
  it("hand-computable TWA: [40,80,0,60,0] at equal 20ms = 36, including known zero", () => {
    const d = generate(small()), hub = createAnalysisHub(d.scope, () => 0);
    d.inputs.slice(0, 10).forEach(x => hub.ingest(x));
    const history = hub.read().depthHistory!;
    const q = (a: number, b: number) => calculateTimeWeightedDepth(history, {
      side: "BID", priceTicks: 99999, width: 1, startNs: at(a), endNs: at(b),
    });
    expect(q(0, 100)).toMatchObject({ twa: 36, coverageRatio: 1, integralQuantityNs: "3600000000" });
    expect(q(40, 60)).toMatchObject({ twa: 0, status: "VALID", coverageRatio: 1 });
    expect(q(80, 100)).toMatchObject({ twa: 0, status: "VALID" });
    // The boundary update at t=20 belongs to the next half-open interval.
    expect(q(0, 20).twa).toBe(40); expect(q(20, 40).twa).toBe(80);
    const absent = calculateTimeWeightedDepth(history, { side: "BID", priceTicks: 99900,
      width: 1, startNs: at(40), endNs: at(60) });
    expect(absent.twa).toBeNull(); expect(absent.status).toBe("NO DATA");
  });
  it("Trade does not directly alter the book", () => {
    const d = generate(small()), h = createAnalysisHub(d.scope, () => 0);
    h.ingest(d.inputs[0]); h.ingest(d.inputs[1]); const b = h.read().book;
    h.ingest(d.inputs[2]); expect(h.read().book).toEqual(b);
  });
  it.each([
    { maxEvents: 513 }, { bidLevels: 33, askLevels: 32 }, { stepMs: 0 },
    { initialBidQty: -1 }, { seed: 1.5 }, { maxSyntheticMs: 1 },
    { cells: 513 }, { baseTick: Number.MAX_SAFE_INTEGER }, { gap: true, maxEvents: 16 },
  ])("rejects finite/price/time/schema budget violations %j", patch => {
    expect(() => generate({ ...small(), ...patch })).toThrow();
  });
});
