import type { Trade } from "../types.ts";
import type { Column } from "../aggregate/columns.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";

export type Mode = "event_time_research" | "arrival_verified";
export type Span = [number, number];
/** Research evidence, not fields inferred from legacy recvUs or Column.tsSec. */
export interface Availability {
  basis: "local_arrival_and_finalization";
  localArrivalUs: number;
  finalizedUs: number;
}
export interface Tick extends Trade { availability?: Availability; }
export interface Board { column: Column; contract: string | null; availability?: Availability; }
export interface Coverage { fromUs: number; toUs: number; availability?: Availability; }
export interface Calculation {
  mode: Mode;
  lookbackSeconds: number;
  horizonsSeconds: number[];
  maxDivergenceEvents: number;
}
export interface Anchor { symbol: MarketSymbol; contract: string; asOfUs: number; }
export interface MarketInput {
  ticks: Coverage[];
  books: Coverage[];
  /** Immutable event-time batch index; never used to invent arrival evidence. */
  index?: { ticks: (a: number, b: number) => boolean; books: (a: number, b: number) => boolean };
}
export interface Source {
  symbol: MarketSymbol;
  contract: string;
  root: string;
  sourceKind: string;
  asOfUs: string[];
  annotationFile?: string;
  annotationIds?: string[];
  grid?: { fromUs: string; toUs: string; stepUs: string };
  grids?: { fromUs: string; toUs: string; stepUs: string }[];
}
export interface Config {
  schema: "orderflow.research.v2.1" | "orderflow.research.v2.2";
  calculation: Calculation;
  sources: Source[];
  splits: null | { fold: "train" | "validation" | "test"; fromUs: string; toUs: string }[];
}
export function coverageIndex(rows: Coverage[]) {
  const merged: Span[] = [];
  for (const r of [...rows].sort((a, b) => a.fromUs - b.fromUs)) {
    const last = merged.at(-1);
    if (last && r.fromUs <= last[1]) last[1] = Math.max(last[1], r.toUs);
    else merged.push([r.fromUs, r.toUs]);
  }
  return (a: number, b: number) => {
    if (a >= b) return true;
    let lo = 0, hi = merged.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (merged[m]![0] <= a) lo = m + 1; else hi = m; }
    return lo > 0 && merged[lo - 1]![1] >= b;
  };
}
export function integerUs(v: string | number) {
  if (typeof v === "string" && !/^\d+$/.test(v)) throw Error("invalid_integer_microseconds");
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw Error("invalid_integer_microseconds");
  return n;
}
export function knownContract(v: string) { return !!v && !["UNKNOWN", "MIXED"].includes(v); }
export function hasAvailabilityEvidence(a: Availability | undefined): a is Availability {
  return !!a && a.basis === "local_arrival_and_finalization"
    && Number.isSafeInteger(a.localArrivalUs) && Number.isSafeInteger(a.finalizedUs)
    && a.localArrivalUs >= 0 && a.finalizedUs >= a.localArrivalUs;
}
export function eligible(a: Availability | undefined, asOfUs: number, mode: Mode) {
  return mode === "event_time_research" || hasAvailabilityEvidence(a)
    && a.localArrivalUs <= asOfUs && a.finalizedUs <= asOfUs;
}
/** Union coverage, with a deadline only for strict X/history. A missing body has no ranges. */
export function covered(rows: Coverage[], a: number, b: number, mode: Mode, deadline: number) {
  if (a >= b) return true;
  let end = a;
  for (const r of [...rows].filter(r => eligible(r.availability, deadline, mode)).sort((x, y) => x.fromUs - y.fromUs)) {
    if (r.toUs <= end) continue;
    if (r.fromUs > end) return false;
    end = r.toUs; if (end >= b) return true;
  }
  return false;
}
