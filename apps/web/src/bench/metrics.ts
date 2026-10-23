export type InputMetric = {
  scheduled: number; start: number; end: number; kind: string;
  disposition: import("@workspace/core/analysis-hub").AnalysisDecision["disposition"];
  tradeDisposition: import("@workspace/core/analysis-hub").AnalysisDecision["tradeDisposition"];
  revision: number; eventCount: number; stopReason: string | null;
};
export type FrameMetric = {
  notifyStart: number | null; start: number; end: number; revision: number;
  cache: "HIT" | "MISS"; reason: "NOTICE" | "FINAL" | "CACHE_PROBE";
};
/** A record cap, NOT an assertion about JavaScript heap/RSS. Never evicts silently. */
export class MetricBuffer<T> {
  private readonly records: (T | undefined)[];
  private used = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new RangeError("Metric capacity 1..4096");
    this.records = new Array<T | undefined>(capacity);
  }
  get count() { return this.used; }
  record(value: T): void {
    if (this.used === this.capacity) throw new RangeError("METRIC_BUFFER_FULL");
    this.records[this.used++] = value;
  }
  snapshot(): readonly T[] { return this.records.slice(0, this.used) as T[]; }
}
export interface Distribution {
  count: number; mean: number | null; p50: number | null; p95: number | null;
  p99: number | null; maximum: number | null; p99ReferenceOnly: boolean;
}
/** Nearest rank: sorted[ceil(p*N)-1]. Aggregation only, never called from ingest recording. */
export function distribution(values: readonly number[]): Distribution {
  if (values.some(n => !Number.isFinite(n) || n < 0)) throw new TypeError("Nonnegative finite durations required");
  const a = [...values].sort((x, y) => x - y), n = a.length;
  const percentile = (p: number) => n ? a[Math.ceil(p * n) - 1] : null;
  return { count: n, mean: n ? a.reduce((s, v) => s + v, 0) / n : null,
    p50: percentile(.50), p95: percentile(.95), p99: percentile(.99),
    maximum: n ? a[n - 1] : null, p99ReferenceOnly: n < 100 };
}
export function classifyInput(input: import("@workspace/core/analysis-hub").AnalysisInput): string {
  return input.type === "EVENT" ? input.event.kind : input.type;
}
export function summarizeInputs(records: readonly InputMetric[]) {
  const result: Record<string, Distribution> = {};
  const names = new Set(records.map(r => r.kind));
  for (const name of names) result[name] = distribution(records.filter(r => r.kind === name).map(r => r.end - r.start));
  for (const disposition of ["ACCEPTED", "DUPLICATE", "CONFLICTING_TRADE_ID"]) {
    result[`TRADE_${disposition}`] = distribution(records.filter(r => r.tradeDisposition === disposition).map(r => r.end - r.start));
  }
  return result;
}
