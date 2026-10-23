import { createHash } from "node:crypto";
import {
  executedVolume, restingQuantity, validateMarketEvent,
  type Aggressor, type BookSide, type EventHeader, type L2Snapshot,
} from "@workspace/core/events";
import type { AnalysisInput, AnalysisRenderQuery, AnalysisScope } from "@workspace/core/analysis-hub";
import { at, makeWorkload } from "../../bench/finiteMockWorkload";

export const VERSION = "load29-v1";
export interface Scenario {
  seed: number;
  baseTick: number;
  bidLevels: number;
  askLevels: number;
  initialBidQty: number;
  initialAskQty: number;
  addQty: number;
  cancelQty: number;
  tradeQty: number;
  sides: readonly Aggressor[];
  stepMs: number;
  burstStart: number;
  burstLength: number;
  gap: boolean;
  maxEvents: number;
  maxSyntheticMs: number;
  cells: number;
}
export interface Definition {
  version: string;
  label: "MOCK / SIMULATED";
  config: Scenario | null;
  scope: AnalysisScope;
  inputs: readonly AnalysisInput[];
  query: AnalysisRenderQuery;
  inputSha256: string;
}
export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const defaults = (stage: 1 | 2): Scenario => ({
  seed: 29, baseTick: 100000, bidLevels: stage === 1 ? 8 : 32,
  askLevels: stage === 1 ? 8 : 32, initialBidQty: 40, initialAskQty: 20,
  addQty: 17, cancelQty: 13, tradeQty: 3, sides: ["BUY", "SELL", "UNKNOWN"],
  stepMs: 10, burstStart: 64, burstLength: 16, gap: stage === 2,
  maxEvents: stage === 1 ? 256 : 500, maxSyntheticMs: 6000, cells: 128,
});
function freeze<T>(x: T): T {
  if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}
export function generate(input: Scenario): Definition {
  const c: Scenario = JSON.parse(JSON.stringify(input));
  for (const value of Object.values(c).filter(v => typeof v === "number")) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("INTEGER_CONFIG");
  }
  if (c.seed > 0xffffffff || c.maxEvents < 16 || c.maxEvents > 512 ||
      c.bidLevels < 2 || c.askLevels < 2 || c.bidLevels + c.askLevels > 64 ||
      c.stepMs < 1 || c.maxSyntheticMs < 1 || c.maxSyntheticMs > 6000 ||
      c.cells < 1 || c.cells > 512 || c.baseTick < 128 ||
      c.baseTick > Number.MAX_SAFE_INTEGER - 128 ||
      !c.sides.length || c.sides.some(s => !["BUY", "SELL", "UNKNOWN"].includes(s)) ||
      typeof c.gap !== "boolean" || (c.gap && c.maxEvents < 32) ||
      Math.max(c.initialBidQty, c.initialAskQty, c.addQty, c.cancelQty, c.tradeQty) > 10000) {
    throw new RangeError("FINITE_CONFIG");
  }
  let random = c.seed;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const unit = (i: number) => i < 10 ? [0, 0, 1, 2, 3, 4, 6, 8, 9, 10][i]
    : 10 + Math.floor((i - 9) / 2);
  const when = (i: number) => {
    const index = i >= c.burstStart && i < c.burstStart + c.burstLength
      ? c.burstStart : i;
    return (i === c.maxEvents - 1 ? unit(i - 1) + 1 : unit(index)) * c.stepMs;
  };
  // The final observation marker is strictly after every Trade timestamp.
  const end = when(c.maxEvents - 1);
  if (end > c.maxSyntheticMs) throw new RangeError("SYNTHETIC_TIME_LIMIT");
  const scope: AnalysisScope = JSON.parse(JSON.stringify(makeWorkload("cells128").scope));
  const identity = { ...scope.config.identity, sourceId: `MOCK-${VERSION}-${c.seed}`,
    sessionId: `MOCK-${VERSION}-${c.seed}-SESSION` };
  const depthScope = { type: "PRICE_RANGE", minTick: c.baseTick - 64,
    maxTick: c.baseTick + 64 } as const;
  const configuredScope: AnalysisScope = { ...scope, config: {
    ...scope.config, identity, depthScope,
  } };
  const sequences = { L2_MBP: 0, TRADES: 0 };
  const header = (channel: "L2_MBP" | "TRADES", ms: number): EventHeader => ({
    ...identity, schemaVersion: 1, channel, sequenceScope: "CHANNEL",
    sequence: String(++sequences[channel]), eventId: `${VERSION}-${channel}-${sequences[channel]}`,
    exchangeTimeNs: at(ms), receiveTimeNs: at(ms), sourceTimePrecision: "ns", quality: "VALID",
  });
  let shift = 0;
  const book = { BID: new Map<number, number>(), ASK: new Map<number, number>() };
  const price = (side: BookSide, level: number) =>
    c.baseTick + shift + (side === "BID" ? -1 - level : 1 + level);
  const snapshot = (ms: number): AnalysisInput => {
    for (const s of ["BID", "ASK"] as const) {
      book[s].clear();
      const count = s === "BID" ? c.bidLevels : c.askLevels;
      for (let j = 0; j < count; j++) book[s].set(price(s, j),
        j === 0 ? (s === "BID" ? c.initialBidQty : c.initialAskQty)
          : j % 5 === 0 ? 1 + next() % 3
            : (s === "BID" ? c.initialBidQty : c.initialAskQty) + next() % 80);
    }
    const h = header("L2_MBP", ms);
    const event: L2Snapshot = { kind: "L2_SNAPSHOT", header: h,
      depthScope, snapshotCoversSequence: h.sequence, impliedPolicy: "UNKNOWN",
      bids: [...book.BID].map(([priceTicks, qty]) => ({ priceTicks, qty: restingQuantity(qty) })),
      asks: [...book.ASK].map(([priceTicks, qty]) => ({ priceTicks, qty: restingQuantity(qty) })) };
    return { type: "EVENT", event };
  };
  const update = (ms: number, side: BookSide, level: number, qty: number, del = false): AnalysisInput => {
    const p = price(side, level);
    if (del) book[side].delete(p); else book[side].set(p, qty);
    return { type: "EVENT", event: {
      kind: del ? "L2_DELETE_LEVEL" : "L2_SET_LEVEL", header: header("L2_MBP", ms),
      side, priceTicks: p, qty: restingQuantity(del ? 0 : qty),
    } };
  };
  const trade = (ms: number, aggressor: Aggressor, qty: number): AnalysisInput => {
    const h = header("TRADES", ms);
    return { type: "EVENT", event: { kind: "TRADE", header: h,
      tradeId: `${VERSION}-TRADE-${sequences.TRADES}`,
      priceTicks: c.baseTick + shift + (aggressor === "BUY" ? 1 : aggressor === "SELL" ? -1 : 0),
      qty: executedVolume(qty), aggressor,
      classification: aggressor === "UNKNOWN" ? "UNKNOWN" : "VENUE" } };
  };
  const inputs: AnalysisInput[] = [];
  const gapIndex = Math.floor(c.maxEvents / 2);
  for (let i = 0; i < c.maxEvents; i++) {
    const ms = when(i);
    let x: AnalysisInput;
    if (i === 0) x = snapshot(ms);
    else if (i === 1) x = { type: "QUALITY_INTERVAL", observedAtNs: at(0),
      interval: { channel: "TRADES", startNs: at(0), endNs: at(end), status: "VALID",
        reason: "Explicit artificial aligned Trade coverage, not vendor evidence" } };
    else if (i === 2) x = trade(ms, "BUY", 12);
    else if (i === 3) x = update(ms, "BID", 0, 80);
    else if (i === 4) x = trade(ms, "SELL", 4);
    else if (i === 5) x = update(ms, "BID", 0, 0);
    else if (i === 6) x = update(ms, "BID", 0, 60);
    else if (i === 7) x = update(ms, "BID", 0, 0, true);
    else if (i === 8) x = trade(ms, "BUY", 11);
    else if (i === 9 || i === c.maxEvents - 1) x = update(ms, "BID", 1, 21);
    else if (c.gap && (i === gapIndex || i === gapIndex + 1)) x = {
      type: "CONDITION", channel: "L2_MBP", atNs: at(ms),
      status: i === gapIndex ? "GAP" : "RESYNCING",
      reason: "Artificial explicit condition, NOT a measured transport sequence loss",
    };
    else if (c.gap && i === gapIndex + 2) x = trade(ms, "BUY", c.tradeQty);
    else if (c.gap && i === gapIndex + 3) x = snapshot(ms);
    else if (i === 32 || i === 96) { shift += i === 32 ? 3 : -2; x = snapshot(ms); }
    else if (i % 4 === 0) x = trade(ms, c.sides[Math.floor(i / 4) % c.sides.length], c.tradeQty);
    else {
      const side = i % 2 ? "BID" : "ASK", level = next() % (side === "BID" ? c.bidLevels : c.askLevels);
      const old = book[side].get(price(side, level)) ?? 0;
      const qty = i % 7 === 0 ? 0 : i % 3 === 0 ? Math.max(0, old - c.cancelQty) : old + c.addQty;
      x = update(ms, side, level, qty, i % 11 === 0);
    }
    if (x.type === "EVENT") validateMarketEvent(x.event);
    inputs.push(x);
  }
  const levels = [...Array(c.bidLevels)].map((_, i) => ({ side: "BID" as const, priceTicks: c.baseTick - 1 - i }));
  const prices: { side: BookSide; priceTicks: number }[] = [...levels,
    ...Array.from({ length: c.askLevels }, (_, i) => ({ side: "ASK" as const, priceTicks: c.baseTick + 1 + i }))];
  const bins = Math.ceil(c.cells / prices.length), duration = BigInt(end) * 1_000_000n;
  const origin = BigInt(at(0));
  const query: AnalysisRenderQuery = { startNs: at(0), endNs: at(end),
    cells: Array.from({ length: c.cells }, (_, i) => {
      const bin = Math.floor(i / prices.length);
      return { ...prices[i % prices.length], width: 1,
        startNs: (origin + duration * BigInt(bin) / BigInt(bins)).toString(),
        endNs: (origin + duration * BigInt(bin + 1) / BigInt(bins)).toString() };
    }) };
  return freeze({ version: VERSION, label: "MOCK / SIMULATED", config: c,
    scope: configuredScope, inputs, query, inputSha256: sha256(JSON.stringify(inputs)) });
}
export function definition(stage: 0 | 1 | 2): Definition {
  if (stage !== 0) return generate(defaults(stage));
  const w = makeWorkload("cells128");
  return freeze({ version: VERSION, label: "MOCK / SIMULATED", config: null,
    scope: w.scope, inputs: w.inputs, query: w.query,
    inputSha256: sha256(JSON.stringify(w.inputs)) });
}
