import {
  validateMarketEvent, type BookSide, type L2PriceUpdate, type L2Snapshot,
} from "./events";
import {
  applyMbpBatch, applyMbpEvent, createMbpBook, type SnapshotSemantics,
} from "./mbpBook";
import { currentQuality, type MarketQualityState, type QualityInterval } from "./qualityTimeline";
import { priceBinId, priceBinTicks, readPriceBin, type PriceBinWidth } from "./priceBins";

/** A batch envelope is an analysis input, NOT a new normalized market event. */
export type DepthRecord = L2Snapshot | L2PriceUpdate | { readonly batch: readonly L2PriceUpdate[] };
export interface DepthHistory {
  readonly events: readonly DepthRecord[];
  /** Completed R03 timeline and its bound market identity, not inferred from quantity. */
  readonly qualityState: MarketQualityState;
  /** Evidence that these quality boundaries are aligned to the event-time axis. No implicit clock mapping. */
  readonly qualityTimeAlignmentEvidence: string;
  readonly snapshotSemantics?: SnapshotSemantics;
}
export interface DepthQuery {
  readonly side: BookSide;
  /** Any representative Tick in the requested floor-aligned price bucket. */
  readonly priceTicks: number;
  readonly width: PriceBinWidth;
  readonly startNs: string;
  readonly endNs: string;
}
interface Metrics {
  readonly side: BookSide;
  readonly binId: number;
  readonly width: PriceBinWidth;
  readonly startNs: string;
  readonly endNs: string;
  /** Exact decimal nanoseconds, JSON-safe. */
  readonly coveredDuration: string;
  readonly coverageRatio: number;
  readonly partialTWA: number | null;
  /** Exact integral of quantity * nanoseconds, before any floating-point division. */
  readonly integralQuantityNs: string;
}
export type TimeWeightedDepth = Metrics & (
  | { readonly status: "VALID"; readonly twa: number }
  | { readonly status: "NO DATA"; readonly twa: null }
);

function ensure(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new TypeError(reason);
}
function ns(value: string): bigint {
  ensure(typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value), "Invalid UTC nanosecond string");
  return BigInt(value);
}

function validateQuality(history: DepthHistory): readonly QualityInterval[] {
  ensure(typeof history.qualityTimeAlignmentEvidence === "string" &&
    history.qualityTimeAlignmentEvidence.trim().length > 0, "Event/quality time alignment evidence is required");
  const intervals = history.qualityState.timeline.L2_MBP;
  ensure(intervals.length > 0, "R03 L2 quality timeline is required");
  ensure(currentQuality(history.qualityState.timeline, "L2_MBP").endNs === null,
    "R03 timeline must have an open final interval");
  for (let index = 0; index < intervals.length; index++) {
    const interval = intervals[index];
    ensure(interval.channel === "L2_MBP", "Quality channel mismatch");
    ensure(["NOT_INITIALIZED", "VALID", "GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"]
      .includes(interval.status), "Invalid quality status");
    ensure(["NOT_CHECKED", "CONTIGUOUS", "ORDER_ONLY", "UNVERIFIABLE"]
      .includes(interval.sequenceVerification), "Invalid sequence verification");
    ensure(interval.reason.trim().length > 0, "Quality reason is required");
    if (interval.endNs !== null) ensure(ns(interval.endNs) >= ns(interval.startNs), "Backwards quality interval");
    else ensure(index === intervals.length - 1, "Only the last quality interval may be open");
    ns(interval.startNs);
    if (index > 0) ensure(intervals[index - 1].endNs !== null &&
      ns(intervals[index - 1].endNs!) === ns(interval.startNs), "Quality intervals must remain in R03 order");
  }
  return intervals;
}

function prepare(history: DepthHistory) {
  const identity = history.qualityState.config.identity;
  let previous: bigint | null = null;
  return history.events.map((record) => {
    const isBatch = "batch" in record;
    const raw: readonly unknown[] = isBatch ? record.batch : [record];
    ensure(Array.isArray(raw) && raw.length > 0, "A complete nonempty batch is required");
    const events = raw.map((input) => {
      const event = validateMarketEvent(input);
      ensure(event.kind === "L2_SNAPSHOT" || event.kind === "L2_SET_LEVEL" || event.kind === "L2_DELETE_LEVEL",
        "Only L2 depth records are accepted");
      ensure((["environment", "source", "sourceId", "canonicalInstrumentId", "sessionId"] as const)
        .every((field) => event.header[field] === identity[field]), "Mixed market identity in depth history");
      ensure(event.header.exchangeTimeNs !== null && event.header.sourceTimePrecision !== "unknown",
        "An explicit exchange event time and precision are required");
      ensure(event.header.quality === "VALID", "Non-VALID raw events cannot establish depth");
      if (isBatch) ensure(event.kind !== "L2_SNAPSHOT", "An update batch may not contain snapshots");
      else if (event.kind !== "L2_SNAPSHOT") {
        ensure(event.updateBatchId === undefined, "Tagged updates require an explicit complete batch envelope");
      }
      return event;
    });
    const at = ns(events[0].header.exchangeTimeNs!);
    ensure(events.every((event) => ns(event.header.exchangeTimeNs!) === at), "Batch event times must match");
    ensure(previous === null || at >= previous, "Depth events are out of order; sorting is not authorized");
    previous = at;
    return { at, events, isBatch };
  });
}

/** Convert only a dimensionless rational after exact BigInt arithmetic; never convert an epoch ns. */
function ratio(numerator: bigint, denominator: bigint): number {
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER) * denominator) {
    throw new RangeError("Derived quantity exceeds safe Number output");
  }
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  const scale = 1_000_000_000_000_000_000n;
  return Number(whole) + Number((remainder * scale) / denominator) / Number(scale);
}

/**
 * Integrate event-time step states, intersected with R03 VALID/CONTIGUOUS intervals.
 * A gap invalidates carried depth; only a new valid snapshot can re-establish it.
 * No UI sampling, filters, aggregation of trades, or persistent history store.
 */
export function calculateTimeWeightedDepth(history: DepthHistory, query: DepthQuery): TimeWeightedDepth {
  const checked = validateQuery(query);
  return integrate(history, query, checked, prepareHistory(history));
}

/** Only the first bucket shares a bounded, call-local replay. Failures retain caller order. */
export function calculateTimeWeightedDepthCells(
  history: DepthHistory, queries: readonly DepthQuery[],
): readonly TimeWeightedDepth[] {
  let prepared: ReturnType<typeof prepareHistory> | undefined;
  let key: { side: BookSide; width: PriceBinWidth; binId: number } | undefined;
  let prefix: ReturnType<typeof createBucketPrefix> | undefined;
  let disabled = false;
  return queries.map(query => {
    // Do not inspect history for [] or prepare it before the first query is valid.
    const checked = validateQuery(query);
    prepared ??= prepareHistory(history);
    key ??= { side: query.side, width: query.width, binId: checked.binId };
    if (disabled || key.side !== query.side || key.width !== query.width || key.binId !== checked.binId) {
      return integrate(history, query, checked, prepared);
    }
    const count = boundaryIndex(prepared.times, checked.end);
    // Reaching the ceiling disables reuse for the rest of this call. No partial
    // prefix is combined with a scalar result, and no apply error is caught.
    if (count >= 4096) {
      prefix = undefined;
      disabled = true;
      return integrate(history, query, checked, prepared);
    }
    prefix ??= createBucketPrefix(history, query, prepared);
    return prefix.read(query, checked, count);
  });
}

/** First boundary >= end: a right-endpoint event must not be applied. */
function boundaryIndex(times: readonly bigint[], end: bigint): number {
  let low = 0, high = times.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (times[mid] < end) low = mid + 1;
    else high = mid;
  }
  return low;
}

interface PrefixNode {
  readonly at: bigint;
  /** null is UNKNOWN, never a synthetic zero. */
  readonly qty: bigint | null;
  readonly covered: bigint;
  readonly integral: bigint;
}

function createBucketPrefix(
  history: DepthHistory, bucket: DepthQuery,
  { quality, qualityStarts, records, times }: ReturnType<typeof prepareHistory>,
) {
  const side = bucket.side, priceTicks = bucket.priceTicks, width = bucket.width;
  const nodes: PrefixNode[] = [];
  let book = createMbpBook();
  let fresh = false;
  let eventIndex = 0;
  let qualityIndex = -1;

  function valueAt(at: bigint) {
    let low = 0, high = nodes.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (nodes[mid].at <= at) low = mid + 1;
      else high = mid;
    }
    const node = nodes[low - 1];
    if (!node) return { covered: 0n, integral: 0n };
    const duration = node.qty === null ? 0n : at - node.at;
    return { covered: node.covered + duration,
      integral: node.integral + (node.qty ?? 0n) * duration };
  }

  return {
    read(query: DepthQuery, { start, end, binId }: ReturnType<typeof validateQuery>, count: number): TimeWeightedDepth {
      // Only canonical boundaries strictly before THIS end are visited. A
      // decreasing/overlapping query reads retained scalar prefixes, not books.
      while (nodes.length < count) {
        const at = times[nodes.length];
        const previous = nodes[nodes.length - 1];
        const elapsed = previous && previous.qty !== null ? at - previous.at : 0n;
        const cumulative = {
          covered: (previous?.covered ?? 0n) + elapsed,
          integral: (previous?.integral ?? 0n) + (previous?.qty ?? 0n) * elapsed,
        };
        while (qualityIndex + 1 < quality.length && qualityStarts[qualityIndex + 1] <= at) {
          const interval = quality[++qualityIndex];
          if (interval.status !== "VALID" || interval.sequenceVerification !== "CONTIGUOUS") fresh = false;
        }
        const valid = qualityIndex >= 0 && quality[qualityIndex].status === "VALID" &&
          quality[qualityIndex].sequenceVerification === "CONTIGUOUS";
        while (eventIndex < records.length && records[eventIndex].at <= at) {
          const record = records[eventIndex++];
          if (!valid) continue;
          if (record.isBatch) {
            if (fresh) book = applyMbpBatch(book, record.events);
          } else {
            const event = record.events[0];
            if (event.kind === "L2_SNAPSHOT") {
              book = applyMbpEvent(book, event, history.snapshotSemantics);
              fresh = true;
            } else if (fresh) book = applyMbpEvent(book, event);
          }
        }
        const observed = valid && fresh ? readPriceBin(book, side, priceTicks, width) : null;
        nodes.push({ at, ...cumulative, qty: observed?.status === "KNOWN" ? observed.qty : null });
      }
      const left = valueAt(start), right = valueAt(end);
      const covered = right.covered - left.covered;
      const integral = right.integral - left.integral;
      const duration = end - start;
      const full = covered === duration;
      const partialTWA = covered === 0n ? null : ratio(integral, covered);
      const rawCoverage = ratio(covered, duration);
      const coverageRatio = !full && rawCoverage >= 1 ? 1 - Number.EPSILON : rawCoverage;
      const metrics: Metrics = {
        side: query.side, binId, width: query.width, startNs: query.startNs, endNs: query.endNs,
        coveredDuration: covered.toString(), coverageRatio, partialTWA,
        integralQuantityNs: integral.toString(),
      };
      return full
        ? { ...metrics, status: "VALID", twa: partialTWA! }
        : { ...metrics, status: "NO DATA", twa: null };
    },
  };
}

function validateQuery(query: DepthQuery) {
  ensure(query.side === "BID" || query.side === "ASK", "Side must be BID or ASK");
  const start = ns(query.startNs);
  const end = ns(query.endNs);
  ensure(end > start, "TWA interval must have positive duration");
  const binId = priceBinId(query.priceTicks, query.width);
  priceBinTicks(query.priceTicks, query.width);
  return { start, end, binId };
}

function prepareHistory(history: DepthHistory) {
  const quality = validateQuality(history);
  const records = prepare(history);
  const qualityStarts = quality.map(interval => ns(interval.startNs));
  // Validate ALL records, including future ones, before sharing sorted time keys.
  // The records and zero-length quality transitions themselves remain in source order.
  const boundaries = new Set<bigint>(qualityStarts);
  for (const record of records) boundaries.add(record.at);
  const times = [...boundaries].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return { quality, qualityStarts, records, times };
}

function integrate(
  history: DepthHistory, query: DepthQuery, { start, end, binId }: ReturnType<typeof validateQuery>,
  { quality, qualityStarts, records, times: sharedTimes }: ReturnType<typeof prepareHistory>,
): TimeWeightedDepth {
  // Merge [start,end) into the common sorted prefix; retain earlier keys for replay.
  const times: bigint[] = [];
  let insertedStart = false;
  for (const at of sharedTimes) {
    if (at >= end) break;
    if (!insertedStart && start < at) { times.push(start); insertedStart = true; }
    if (at === start) insertedStart = true;
    times.push(at);
  }
  if (!insertedStart) times.push(start);
  times.push(end);
  let book = createMbpBook();
  let fresh = false;
  let eventIndex = 0;
  let qualityIndex = -1;
  let covered = 0n;
  let integral = 0n;
  for (let index = 0; index < times.length - 1; index++) {
    const at = times[index];
    while (qualityIndex + 1 < quality.length && qualityStarts[qualityIndex + 1] <= at) {
      const interval = quality[++qualityIndex];
      if (interval.status !== "VALID" || interval.sequenceVerification !== "CONTIGUOUS") fresh = false;
    }
    const valid = qualityIndex >= 0 && quality[qualityIndex].status === "VALID" &&
      quality[qualityIndex].sequenceVerification === "CONTIGUOUS";
    while (eventIndex < records.length && records[eventIndex].at <= at) {
      const record = records[eventIndex++];
      if (!valid) continue;
      if (record.isBatch) {
        if (fresh) book = applyMbpBatch(book, record.events);
      } else {
        const event = record.events[0];
        if (event.kind === "L2_SNAPSHOT") {
          book = applyMbpEvent(book, event, history.snapshotSemantics);
          fresh = true;
        } else if (fresh) book = applyMbpEvent(book, event);
      }
    }
    if (at < start || !valid || !fresh) continue;
    const observed = readPriceBin(book, query.side, query.priceTicks, query.width);
    if (observed.status !== "KNOWN") continue;
    const duration = times[index + 1] - at;
    covered += duration;
    integral += observed.qty * duration;
  }
  const duration = end - start;
  const full = covered === duration;
  const partialTWA = covered === 0n ? null : ratio(integral, covered);
  const rawCoverage = ratio(covered, duration);
  // A rounded floating ratio must never falsely advertise exact full coverage.
  const coverageRatio = !full && rawCoverage >= 1 ? 1 - Number.EPSILON : rawCoverage;
  const metrics: Metrics = {
    side: query.side, binId, width: query.width, startNs: query.startNs, endNs: query.endNs,
    coveredDuration: covered.toString(), coverageRatio, partialTWA,
    integralQuantityNs: integral.toString(),
  };
  return full
    ? { ...metrics, status: "VALID", twa: partialTWA! }
    : { ...metrics, status: "NO DATA", twa: null };
}
