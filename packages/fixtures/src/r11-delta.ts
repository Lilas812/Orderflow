import type { Trade, EventHeader, DataQualityInterval } from "@workspace/core/events";
import type { DeltaAlignment } from "@workspace/core/delta-timeline";
import { F04_TRADES } from "./f04-trades";
import { F05_TRADES } from "./f05-trades";
import { F09_UNKNOWN_TRADES } from "./f09-unknown-trades";
import { R09_SCENARIOS } from "./r09-bubbles";
import { R10_SCENARIOS } from "./r10-density";

export interface DeltaDemoSource {
  readonly id: string; readonly label: string; readonly header: EventHeader;
  readonly events: readonly Trade[]; readonly quality: readonly DataQualityInterval[];
  readonly alignment: DeltaAlignment; readonly range: { readonly startNs: string; readonly endNs: string };
}
export interface DeltaDemoStep {
  readonly label: string; readonly counts: readonly number[];
  readonly progressNs?: readonly (string | null)[];
  readonly conditions?: readonly ("VALID" | "GAP" | "RESYNCING" | null)[];
}
export interface DeltaDemoCase {
  readonly id: string; readonly label: string; readonly sources: readonly DeltaDemoSource[];
  readonly steps: readonly DeltaDemoStep[]; readonly endNs: string; readonly spanNs: string;
  readonly priceMinTick: number; readonly priceMaxTick: number;
}
const T0 = BigInt(F04_TRADES.expected.startNs), S = 1_000_000_000n;
const at = (s: number) => (T0 + BigInt(s) * S).toString();
const observed = (start = 0, end = 10): readonly DataQualityInterval[] => [{
  channel: "TRADES", startNs: at(start), endNs: at(end), status: "VALID",
  reason: "R11 independent MOCK explicitly declares full exchange-time observation; never inferred from no Trades",
}];
function source(
  id: string, events: readonly Trade[], start: number, end: number,
  quality = observed(), header = events[0]?.header,
): DeltaDemoSource {
  if (!header) throw new TypeError("An explicit header is required for the empty MOCK");
  const { environment, source, sourceId, canonicalInstrumentId, sessionId } = header;
  return {
    id, label: `${id} / independent MOCK session ${sessionId}`, header, events, quality,
    range: { startNs: at(start), endNs: at(end) },
    alignment: { scope: { environment, source, sourceId, canonicalInstrumentId, sessionId },
      timeAxis: "EXCHANGE_TIME_NS", evidence: "R11 MOCK-only observation ledger is explicitly aligned to these unchanged exchangeTimeNs values" },
  };
}
function demo(id: string, label: string, sources: readonly DeltaDemoSource[], steps: readonly DeltaDemoStep[], density = false): DeltaDemoCase {
  return { id, label, sources, steps, endNs: at(density ? 30 : 10),
    spanNs: String((density ? 600n : 20n) * S),
    priceMinTick: density ? 79900 : 79980, priceMaxTick: density ? 80100 : 80020 };
}
const pair = [
  source("F04", F04_TRADES.events, 0, 2),
  source("F05", F05_TRADES.events, 2, 4),
];
const multi = F04_TRADES.events.map((t, i) => ({
  ...t, tradeId: `MOCK-R11-MULTI-T${i + 1}`, priceTicks: [80000, 80004, 80010][i],
  header: { ...t.header, sessionId: "MOCK-R11-MULTIPRICE", eventId: `MOCK-R11-MULTI-E${i + 1}` },
}));
const cases: DeltaDemoCase[] = [
  demo("PAIR", "F04 +19 / F05 -2 — independent Store/session comparison, NOT a continuous market session", pair, [
    { label: "PROVISIONAL / original events, no identity or timestamp changes", counts: [3, 2] },
    { label: "FINAL / two independent trusted MOCK progress points", counts: [3, 2], progressNs: [at(5), at(7)] },
  ]),
  demo("MULTIPRICE", "All prices +19; each source price bubble fails the default volume filter",
    [source("MULTIPRICE", multi, 0, 2)], [
      { label: "3 price bins / PROVISIONAL", counts: [3] },
      { label: "FINAL all-price Delta +19", counts: [3], progressNs: [at(5)] },
    ]),
  demo("UNKNOWN", "F09 UNKNOWN classification — INCOMPLETE, never assigned to BUY or SELL",
    [source("F09", F09_UNKNOWN_TRADES.events, 0, 2)], [{ label: "Observed B23 S4 U5; Delta withheld", counts: [4], progressNs: [at(5)] }]),
  demo("ZERO", "Guaranteed empty intervals vs GAP and unobserved time",
    [source("ZERO", [], 0, 10, [
      ...observed(0, 4),
      { channel: "TRADES", startNs: at(4), endNs: at(6), status: "GAP", reason: "Explicit MOCK Trade gap; not zero" },
      ...observed(8, 10),
    ], { ...F04_TRADES.events[0].header, sessionId: "MOCK-R11-ZERO", eventId: "MOCK-R11-ZERO-HEADER" })],
    [{ label: "No Trades, valid observation + trusted progress; no wallclock advancement", counts: [0], progressNs: [at(9)] }]),
];
for (const [id, oldId] of [["GAP", "GAP"], ["LATE", "LATE"], ["CORRECTION", "CORRECTION"], ["CANCEL", "CANCEL"]] as const) {
  const scn = R09_SCENARIOS.find(s => s.id === oldId)!;
  cases.push(demo(id, `R09 ${scn.label} / independent Delta calculation from raw Trade store`,
    [source(id, scn.events, 0, id === "GAP" ? 4 : 2, scn.quality)],
    scn.steps.map(s => ({ label: s.label, counts: [s.tradeCount], progressNs: [s.progressNs ?? null], conditions: [s.condition ?? null] }))));
}
const density = R10_SCENARIOS.find(s => s.id === "DENSITY")!;
cases.push(demo("DENSITY", "R10 raw Trades — Delta independent of ALL/STANDARD/HIGH and bubble visibility",
  [source("DENSITY", density.events, 0, 8, density.quality)],
  density.steps.map(s => ({ label: s.label, counts: [s.tradeCount], progressNs: [s.progressNs ?? null] })), true));
export const R11_DELTA_CASES: readonly DeltaDemoCase[] = cases;
export const R11_DELTA_EXPECTED = {
  environment: "MOCK", seed: 11, fixtureId: "R11-DELTA", expectedResultSchemaVersion: 1,
  pair: { scopes: 2, rawEvents: 5, deltaBySource: { F04: 19, F05: -2 }, neverCombineAcrossScopes: true },
  multiPrice: { prices: 3, B: 23, S: 4, V: 27, delta: 19 },
  unknown: { B: 23, S: 4, U: 5, V_raw: 32, V: null, delta: null },
  late: { B: 23, S: 64, V: 87, delta: -41, revision: 1 },
} as const;
