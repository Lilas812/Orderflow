import { priceBinId, type PriceBinWidth } from "./priceBins";
import { calculateTimeWeightedDepth, type DepthHistory, type TimeWeightedDepth } from "./timeWeightedDepth";
import type { BookSide } from "./events";

export const RELATIVE_WINDOW_NS = 300_000_000_000n;
export interface ScaleSettings {
  readonly minimumVolume: number;
  readonly width: PriceBinWidth;
  readonly mode: "ABSOLUTE" | "RELATIVE";
  readonly absoluteMaxQty: number;
  readonly minIntensity: number;
  readonly maxIntensity: number;
  readonly liquidityContrast: number;
  readonly topContrast: number;
  readonly fixedBaseline: boolean;
}
export const DEFAULT_SCALE: ScaleSettings = Object.freeze({
  minimumVolume: 50, width: 1, mode: "ABSOLUTE", absoluteMaxQty: 200,
  minIntensity: 0, maxIntensity: 1, liquidityContrast: 1, topContrast: 1, fixedBaseline: false,
});
function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new TypeError(message);
}
function ns(value: string): bigint {
  ensure(typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value), "Invalid UTC ns");
  return BigInt(value);
}
export function validateScale(s: ScaleSettings): void {
  ensure(Number.isSafeInteger(s.minimumVolume) && s.minimumVolume >= 0, "Minimum volume must be a nonnegative safe integer");
  ensure(Number.isSafeInteger(s.absoluteMaxQty) && s.absoluteMaxQty > 0, "Absolute maximum must be a positive safe integer");
  ensure([1, 2, 4, 8].includes(s.width), "Price width must be 1/2/4/8");
  ensure(s.mode === "ABSOLUTE" || s.mode === "RELATIVE", "Invalid scale mode");
  ensure(typeof s.fixedBaseline === "boolean", "Invalid fixed baseline flag");
  ensure(Number.isFinite(s.minIntensity) && Number.isFinite(s.maxIntensity) &&
    s.minIntensity >= 0 && s.maxIntensity <= 1 && s.minIntensity < s.maxIntensity, "Intensity requires 0 <= min < max <= 1");
  for (const v of [s.liquidityContrast, s.topContrast]) {
    ensure(Number.isFinite(v) && v >= 0.25 && v <= 4, "Contrast must be 0.25..4");
  }
}
export interface IntensityResult {
  readonly visible: boolean;
  readonly normalized: number | null;
  readonly brightness: number | null;
  readonly reason: "VISIBLE" | "NO DATA" | "MINIMUM_VOLUME" | "MINIMUM_INTENSITY" | "NO_BASELINE";
}
/** Display-only; never rounds a TWA or changes coverage. No color information enters core. */
export function scaleQuantity(
  cell: Pick<TimeWeightedDepth, "status" | "twa" | "coverageRatio">,
  settings: ScaleSettings, referenceQty: number | null,
): IntensityResult {
  validateScale(settings);
  ensure(Number.isFinite(cell.coverageRatio) && cell.coverageRatio >= 0 && cell.coverageRatio <= 1, "Invalid coverage");
  if (cell.status === "NO DATA") {
    ensure(cell.twa === null, "NO DATA has no confirmed quantity");
    return { visible: true, normalized: null, brightness: null, reason: "NO DATA" };
  }
  ensure(cell.status === "VALID" && cell.coverageRatio === 1 &&
    typeof cell.twa === "number" && Number.isFinite(cell.twa) && cell.twa >= 0, "A confirmed TWA is required");
  if (referenceQty !== null) ensure(Number.isFinite(referenceQty) && referenceQty > 0, "Reference quantity must be positive");
  if (settings.minimumVolume > 0 && cell.twa < settings.minimumVolume) {
    return { visible: false, normalized: null, brightness: null, reason: "MINIMUM_VOLUME" };
  }
  // Known zero remains VALID/background, even when no positive relative sample exists.
  const r = cell.twa === 0 ? 0 : referenceQty === null ? null : Math.min(1, cell.twa / referenceQty);
  if (r === null) return { visible: false, normalized: null, brightness: null, reason: "NO_BASELINE" };
  if (r < settings.minIntensity) return { visible: false, normalized: r, brightness: null, reason: "MINIMUM_INTENSITY" };
  const u = Math.max(0, Math.min(1, (r - settings.minIntensity) / (settings.maxIntensity - settings.minIntensity)));
  const c = Math.pow(u, 1 / settings.liquidityContrast);
  // Preserve the exact identity mapping at exponent1 instead of subtractive cancellation.
  const brightness = settings.topContrast === 1 ? c : 1 - Math.pow(1 - c, settings.topContrast);
  return { visible: true, normalized: r, brightness, reason: "VISIBLE" };
}

export interface QuantityStage {
  readonly side: BookSide;
  readonly width: PriceBinWidth;
  readonly binId: number;
  readonly startNs: string;
  readonly endNs: string;
  readonly quantity: number | null;
  readonly status: "VALID" | "NO DATA";
}
export interface ReferenceQuery {
  readonly side: BookSide;
  readonly width: PriceBinWidth;
  /** Explicit stable observed universe, NOT the visible viewport or only nonzero levels. */
  readonly priceTicks: readonly number[];
  readonly asOfNs: string;
}
export interface RelativeReference {
  readonly side: BookSide;
  readonly width: PriceBinWidth;
  readonly refQty: number | null;
  readonly asOfNs: string;
  readonly window: { readonly startNs: string; readonly endNs: string };
  readonly status: "READY" | "WARMING UP";
  readonly reason: string;
  /** Worst bin coverage; simultaneous levels never masquerade as elapsed observation time. */
  readonly coveredDurationNs: string;
  readonly coverageRatio: number;
  readonly positiveWeightNs: string;
}
function bins(query: ReferenceQuery): readonly number[] {
  ensure(query.side === "BID" || query.side === "ASK", "Invalid side");
  return [...new Set(query.priceTicks.map(p => priceBinId(p, query.width)))];
}
/** Weighted inverse empirical CDF, with exact BigInt duration and an exact 95/100 comparison. */
export function relativeP95(stages: readonly QuantityStage[], query: ReferenceQuery): RelativeReference {
  const ids = bins(query), wanted = new Set(ids);
  const end = ns(query.asOfNs), start = end - RELATIVE_WINDOW_NS;
  const samples: { quantity: number; duration: bigint }[] = [];
  const coverage = new Map(ids.map(id => [id, 0n]));
  const previousEnd = new Map<number, bigint>();
  for (const row of stages) {
    if (row.side !== query.side || row.width !== query.width || !wanted.has(row.binId)) continue;
    const a = ns(row.startNs), b = ns(row.endNs);
    ensure(b > a, "Stage duration must be positive");
    ensure(!previousEnd.has(row.binId) || a >= previousEnd.get(row.binId)!, "Overlapping/out-of-order stages duplicate weight");
    previousEnd.set(row.binId, b);
    ensure(row.status === "VALID" || row.status === "NO DATA", "Invalid stage status");
    if (row.status === "NO DATA") { ensure(row.quantity === null, "Missing stage is not zero"); continue; }
    ensure(Number.isSafeInteger(row.quantity) && row.quantity! >= 0, "P95 requires integer state quantities, not averaged cells");
    const left = a > start ? a : start, right = b < end ? b : end;
    if (right <= left) continue;
    const duration = right - left;
    coverage.set(row.binId, coverage.get(row.binId)! + duration);
    if (row.quantity! > 0) samples.push({ quantity: row.quantity!, duration });
  }
  const covered = ids.length ? ids.reduce((v, id) => coverage.get(id)! < v ? coverage.get(id)! : v, RELATIVE_WINDOW_NS) : 0n;
  const weight = samples.reduce((sum, row) => sum + row.duration, 0n);
  samples.sort((a, b) => a.quantity - b.quantity); // Derived distribution only; source ordering is unchanged.
  let accumulated = 0n, p95: number | null = null;
  for (const row of samples) {
    accumulated += row.duration;
    if (accumulated * 100n >= weight * 95n) { p95 = row.quantity; break; }
  }
  const ready = covered === RELATIVE_WINDOW_NS && p95 !== null;
  return {
    side: query.side, width: query.width, refQty: p95, asOfNs: query.asOfNs,
    window: { startNs: start.toString(), endNs: end.toString() },
    status: ready ? "READY" : "WARMING UP",
    reason: ready ? "300s fully observed; duration-weighted positive state distribution"
      : p95 === null ? "No positive reference samples; no zero substitution"
      : "Less than 300s fully observed or missing bucket coverage; provisional only",
    coveredDurationNs: covered.toString(), coverageRatio: Number(covered) / Number(RELATIVE_WINDOW_NS),
    positiveWeightNs: weight.toString(),
  };
}

/**
 * Partition only at raw-event/R03-quality boundaries, then reuse the unchanged R04 engine.
 * Results within each partition are constant aggregated states, NOT display-bin TWA samples.
 * Deliberately simple fixture-scale adapter; no 250ms sampling or new MBP reconstruction.
 */
export function collectQuantityStages(history: DepthHistory, query: ReferenceQuery): readonly QuantityStage[] {
  const end = ns(query.asOfNs), start = end - RELATIVE_WINDOW_NS;
  const times = new Set<bigint>([start, end]);
  for (const record of history.events) {
    const event = "batch" in record ? record.batch[0] : record;
    ensure(event?.header.exchangeTimeNs !== null && event?.header.exchangeTimeNs !== undefined, "Exchange time required");
    const at = ns(event.header.exchangeTimeNs);
    if (at > start && at < end) times.add(at);
  }
  for (const interval of history.qualityState.timeline.L2_MBP) {
    const at = ns(interval.startNs);
    if (at > start && at < end) times.add(at);
  }
  const sorted = [...times].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return bins(query).flatMap(binId => sorted.slice(0, -1).map((left, i) => {
    const startNs = left.toString(), endNs = sorted[i + 1].toString();
    const result = calculateTimeWeightedDepth(history, { side: query.side, width: query.width,
      priceTicks: binId * query.width, startNs, endNs });
    return { side: query.side, width: query.width, binId, startNs, endNs,
      quantity: result.twa, status: result.status };
  }));
}
export interface ScaleBaseline {
  readonly mode: ScaleSettings["mode"];
  readonly side: BookSide;
  readonly width: PriceBinWidth;
  readonly refQty: number;
  readonly asOfNs: string;
  readonly window: RelativeReference["window"];
  readonly status: "READY" | "WARMING UP";
}
/** Explicit capture/recalibration, including clearly labelled provisional fixed records. */
export function captureBaseline(settings: ScaleSettings, candidate: RelativeReference): ScaleBaseline | null {
  validateScale(settings);
  ensure(settings.width === candidate.width, "Baseline width mismatch");
  const refQty = settings.mode === "ABSOLUTE" ? settings.absoluteMaxQty : candidate.refQty;
  if (refQty === null) return null;
  ensure(Number.isFinite(refQty) && refQty > 0, "Invalid reference");
  return Object.freeze({ mode: settings.mode, side: candidate.side, width: candidate.width, refQty,
    asOfNs: candidate.asOfNs, window: Object.freeze({ ...candidate.window }),
    status: settings.mode === "ABSOLUTE" ? "READY" : candidate.status });
}
/** No viewport argument: HISTORY movement cannot influence a captured reference. */
export function resolveReference(settings: ScaleSettings, candidate: RelativeReference, fixed: ScaleBaseline | null): number | null {
  validateScale(settings);
  ensure(settings.width === candidate.width, "Reference width mismatch");
  if (!settings.fixedBaseline) return settings.mode === "ABSOLUTE" ? settings.absoluteMaxQty : candidate.refQty;
  if (fixed === null) return null; // A different side/width/mode must be explicitly calibrated.
  ensure(fixed.side === candidate.side && fixed.width === settings.width && fixed.mode === settings.mode, "Fixed baseline key mismatch");
  return fixed.refQty;
}
