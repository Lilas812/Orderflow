import { executedVolume, restingQuantity, type EventHeader, type Trade, type L2Snapshot } from "@workspace/core/events";
import type { AnalysisInput, AnalysisRenderQuery, AnalysisScope } from "@workspace/core/analysis-hub";

/** Independent, finite artificial definitions. No market/fixture inputs are imported. */
export const WORKLOAD_IDS = [
  "baseline13", "mixed128", "mixed384", "near500", "l2-heavy", "trade-heavy",
  "duplicate", "conflict", "gap-recovery", "unknown", "budget513",
  "cells128", "cells512", "vp1", "vp64",
] as const;
export type WorkloadId = typeof WORKLOAD_IDS[number];
export interface Workload {
  id: WorkloadId;
  scope: AnalysisScope;
  inputs: readonly AnalysisInput[];
  query: AnalysisRenderQuery;
  expected: {
    acceptedTrades: number; duplicateTrades: number; conflictingTrades: number;
    rejectedInputs: number; acceptedMarkets: number; attemptedInputs: number;
    B: string; S: string; U: string; V: string;
    poc: number | null; val: number | null; vah: number | null;
    twa: readonly (number | null)[]; coverage: readonly number[];
    delta: readonly (string | null)[];
    stopLimit: string | null;
  };
}
const ORIGIN = 1767225600000000000n;
export const at = (milliseconds: number) => (ORIGIN + BigInt(milliseconds) * 1_000_000n).toString();
const alignment = "Artificial finite benchmark: exchange, receive and quality UTC axes aligned explicitly";

export function makeWorkload(id: WorkloadId, smallInputs?: number): Workload {
  if (!WORKLOAD_IDS.includes(id)) throw new TypeError("Unknown finite workload");
  if (smallInputs !== undefined && (!Number.isSafeInteger(smallInputs) || smallInputs < 4 || smallInputs > 16)) {
    throw new RangeError("Small unit workload must contain 4..16 inputs");
  }
  const identity = { environment: "MOCK", source: "MOCK_DETERMINISTIC",
    sourceId: `MOCK-BENCH-${id}`, canonicalInstrumentId: "CME:NQ:2026-03",
    sessionId: `MOCK-BENCH-${id}-SESSION` } as const;
  const depthScope = { type: "PRICE_RANGE", minTick: 80000,
    maxTick: id === "baseline13" || id === "gap-recovery" ? 80003 : 80065 } as const;
  const rule = { scope: "CHANNEL", continuity: { contiguous: true,
    evidence: "Artificial independent channel sequences increase by one; exact retransmits retain original headers" } } as const;
  const scope: AnalysisScope = {
    config: { identity, depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
      snapshotAlignmentEvidence: alignment },
    startNs: at(0), depthTimeAlignmentEvidence: alignment, tradeTimeAlignmentEvidence: alignment,
    budget: { inputs: id === "budget513" && smallInputs !== undefined ? smallInputs - 1 : 512,
      normalizedBytes: 1_048_576, trades: 256, rawDeliveries: 512,
      depthRecords: 512, depthEvents: 512, qualityNotifications: 128, qualityIntervals: 512,
      dedupEntries: 1024, bookLevels: 64 },
    volumeProfile: { maxPriceLevels: 64 },
    derivedViews: { maxHeatmapCells: 512, maxBubbles: 256, maxDeltaBins: 30 },
  };
  let l2 = 0, tr = 0;
  const header = (channel: "L2_MBP" | "TRADES", ms: number): EventHeader => {
    const seq = channel === "L2_MBP" ? ++l2 : ++tr;
    return { ...identity, schemaVersion: 1, channel, sequenceScope: "CHANNEL", sequence: String(seq),
      eventId: `${id}-${channel}-${seq}`, exchangeTimeNs: at(ms), receiveTimeNs: at(ms),
      sourceTimePrecision: "ns", quality: "VALID" };
  };
  const snapshot = (ms: number, qty: number): AnalysisInput => {
    const h = header("L2_MBP", ms);
    const event: L2Snapshot = { kind: "L2_SNAPSHOT", header: h, depthScope,
      snapshotCoversSequence: h.sequence!, impliedPolicy: "UNKNOWN",
      bids: [{ priceTicks: 80000, qty: restingQuantity(qty) }],
      asks: [{ priceTicks: depthScope.maxTick, qty: restingQuantity(20) }] };
    return { type: "EVENT", event };
  };
  const update = (ms: number, qty: number, price = 80064): AnalysisInput => ({
    type: "EVENT", event: { kind: qty === 0 ? "L2_DELETE_LEVEL" : "L2_SET_LEVEL",
      header: header("L2_MBP", ms), side: "BID", priceTicks: price, qty: restingQuantity(qty) },
  });
  const quality = (end: number): AnalysisInput => ({ type: "QUALITY_INTERVAL", observedAtNs: at(0),
    interval: { channel: "TRADES", startNs: at(0), endNs: at(end), status: "VALID",
      reason: "Explicit finite artificial coverage, not an inferred real-market guarantee" } });
  const trade = (ms: number, price: number, qty: number, aggressor: Trade["aggressor"]): AnalysisInput => {
    const h = header("TRADES", ms);
    return { type: "EVENT", event: { kind: "TRADE", header: h, tradeId: `${id}-trade-${tr}`,
      priceTicks: price, qty: executedVolume(qty), aggressor,
      classification: aggressor === "UNKNOWN" ? "UNKNOWN" : "VENUE" } };
  };
  const gap: AnalysisInput = { type: "CONDITION", channel: "L2_MBP", atNs: at(5000),
    status: "GAP", reason: "Artificial L2 interruption; only aligned Snapshot restores" };
  if (id === "baseline13" || id === "gap-recovery") {
    const inputs = [snapshot(0, 40), quality(14000), trade(1000, 80000, 12, "BUY"),
      update(2000, 80, 80000), trade(3000, 80001, 4, "SELL"), update(4000, 0, 80000),
      gap, trade(6000, 80000, 11, "BUY"), snapshot(7000, 60),
      trade(8000, 80002, 3, "UNKNOWN"), trade(10000, 80000, 7, "BUY"),
      trade(12000, 80001, 6, "SELL"), update(14000, 60, 80000)];
    return { id, scope, inputs, query: { startNs: at(0), endNs: at(14000),
      cells: Array.from({ length: 7 }, (_, i) => ({ side: "BID", priceTicks: 80000,
        width: 1, startNs: at(i * 2000), endNs: at((i + 1) * 2000) })) },
    expected: { acceptedTrades: 6, duplicateTrades: 0, conflictingTrades: 0,
      rejectedInputs: 0, acceptedMarkets: 11, attemptedInputs: 13,
      B: "30", S: "10", U: "3", V: "43", poc: 80000, val: 80000, vah: 80001,
      twa: [40, 80, null, null, 60, 60, 60], coverage: [1, 1, .5, .5, 1, 1, 1],
      delta: ["12", "-4", "0", "11", null, "7", "-6"], stopLimit: null } };
  }
  const n = smallInputs ?? (id === "near500" ? 500 : id === "budget513" ? 513
    : id === "vp1" || id === "vp64" ? 132
    : ["mixed384", "l2-heavy", "trade-heavy"].includes(id) ? 384 : 128);
  const lastAccepted = id === "budget513" ? n - 1 : n;
  const p = id === "vp1" ? 1 : ["vp64", "near500", "budget513"].includes(id) ? 64 : 8;
  const targetTrades = id === "l2-heavy" ? Math.min(16, n - 3)
    : id === "trade-heavy" || id === "near500" || id === "budget513" ? Math.min(250, n - 4)
    : Math.min(96, Math.floor((n - 3) / 2));
  const inputs: AnalysisInput[] = [snapshot(0, 40), quality(6000)];
  let acceptedTrades = 0, duplicates = 0, conflicts = 0, B = 0n, S = 0n, U = 0n;
  let firstTrade: Trade | null = null;
  const delta = [0n, 0n, 0n], incomplete = [false, false, false];
  for (let index = 2; index < n; index++) {
    // The terminal accepted marker bounds observation, so TWA does not extend into future time.
    const ms = index >= lastAccepted - 1 ? 6000 : Math.min(5900, index * 10);
    if (index >= lastAccepted || index === lastAccepted - 1) {
      inputs.push(update(ms, 60)); continue;
    }
    if (id === "duplicate" && firstTrade && index % (smallInputs ? 5 : 13) === 0) {
      inputs.push({ type: "EVENT", event: { ...firstTrade, header: { ...firstTrade.header } } });
      duplicates++; continue;
    }
    if (id === "conflict" && firstTrade && index === n - 2) {
      const h = header("TRADES", ms);
      inputs.push({ type: "EVENT", event: { ...firstTrade, header: h, qty: executedVolume(2) } });
      conflicts++; continue;
    }
    const makeTrade = acceptedTrades < targetTrades && (index % 2 === 0 ||
      targetTrades - acceptedTrades >= lastAccepted - index - 2);
    if (makeTrade) {
      const side = id === "unknown" && acceptedTrades % 5 === 0 ? "UNKNOWN"
        : acceptedTrades % 2 === 0 ? "BUY" : "SELL";
      const t = trade(ms, 80000 + acceptedTrades % p, 1, side);
      inputs.push(t); firstTrade ??= (t as { type: "EVENT"; event: Trade }).event;
      const bin = Math.floor(ms / 2000);
      if (side === "BUY") { B++; delta[bin]++; }
      else if (side === "SELL") { S++; delta[bin]--; }
      else { U++; incomplete[bin] = true; }
      acceptedTrades++;
    } else inputs.push(update(ms, index % 3 === 0 ? 0 : 40 + index % 40));
  }
  const levels = Math.min(p, acceptedTrades), q = Math.floor(acceptedTrades / p), remainder = acceptedTrades % p;
  const threshold = (BigInt(acceptedTrades) * 7n + 9n) / 10n;
  // Closed form for this fixture's cyclic unit-volume allocation, not a second VA engine.
  const highGroup = BigInt(remainder * (q + 1));
  const needed = acceptedTrades === 0 ? 0 : threshold <= highGroup
    ? Number((threshold + BigInt(q)) / BigInt(q + 1))
    : remainder + Number((threshold - highGroup + BigInt(q - 1)) / BigInt(q));
  const cells = id === "cells512" ? 512 : id === "cells128" ? 128 : 7;
  const query: AnalysisRenderQuery = { startNs: at(0), endNs: at(6000),
    cells: Array.from({ length: cells }, (_, i) => ({ side: "BID",
      // Snapshot's unlisted levels are UNKNOWN, not zero. Vary C with known
      // quantity at one price to keep the measured cell semantics comparable.
      priceTicks: 80000, width: 1,
      startNs: at(cells > 7 ? Math.floor(i * 6000 / cells) : i * 750),
      endNs: at(cells > 7 ? Math.floor((i + 1) * 6000 / cells) : (i + 1) * 750) })) };
  return { id, scope, inputs, query, expected: {
    acceptedTrades, duplicateTrades: duplicates, conflictingTrades: conflicts,
    rejectedInputs: conflicts + Number(id === "budget513"),
    acceptedMarkets: lastAccepted - 1 - duplicates - conflicts,
    attemptedInputs: n, B: String(B), S: String(S), U: String(U), V: String(B + S + U),
    poc: levels ? 80000 : null, val: levels ? 80000 : null, vah: levels ? 80000 + needed - 1 : null,
    twa: query.cells.map(c => c.priceTicks === 80000 ? 40 : 0),
    coverage: query.cells.map(() => 1),
    delta: delta.map((d, i) => conflicts || incomplete[i] || acceptedTrades === 0 ? null : String(d)),
    stopLimit: id === "budget513" ? "inputs" : null,
  } };
}
