import { evaluateBubbleFilter, type BubbleFilters } from "@workspace/core/bubble-aggregate";
import { bubbleDiameter, DEFAULT_BUBBLE_SIZING, type BubbleSizing } from "@workspace/core/bubble-sizing";
import type { BubbleStatus } from "@workspace/core/bubble-finality";
import { validateDataQualityInterval, type DataQualityInterval } from "@workspace/core/events";
import { tradeScopeKey, type TradeScope } from "@workspace/core/trade-store";
import type { ProjectedBubble } from "./bubbleRenderer";

export type BubbleDensity = "ALL" | "STANDARD" | "HIGH_COMPRESSION";
/** Caller must establish both identity and the mapping onto exchange event time.
 * Timestamp resemblance or an absence of recorded trades is NOT evidence.
 */
export interface ClusteringContinuity {
  readonly scope: TradeScope;
  readonly timeAxis: "EXCHANGE_TIME_NS";
  readonly alignmentEvidence: string;
  readonly intervals: readonly DataQualityInterval[];
}
export interface ClusteringOptions {
  readonly mode: BubbleDensity;
  readonly continuity?: readonly ClusteringContinuity[];
}
export interface ClusterSpread {
  readonly minX: number; readonly maxX: number;
  readonly minY: number; readonly maxY: number;
  readonly width: number; readonly height: number;
  readonly maxCenterDistance: number;
  readonly footprintWidth: number; readonly footprintHeight: number;
}
export interface VisualBubbleCluster {
  readonly id: string;
  readonly childrenIds: readonly string[];
  readonly children: readonly ProjectedBubble[];
  readonly B: bigint; readonly S: bigint; readonly V: bigint; readonly delta: bigint;
  readonly imbalancePercent: number;
  readonly status: BubbleStatus;
  readonly revision: number;
  readonly x: number; readonly y: number; readonly diameter: number;
  readonly rgba: readonly [number, number, number, number];
  readonly startNs: string; readonly endNs: string;
  readonly minTick: number; readonly maxTick: number;
  readonly spread: ClusterSpread;
}
function validCoverage(entry: ClusteringContinuity): readonly DataQualityInterval[] | null {
  if (entry.timeAxis !== "EXCHANGE_TIME_NS" || !entry.alignmentEvidence?.trim()) return null;
  try {
    let end: bigint | null = -1n;
    for (const input of entry.intervals) {
      const q = validateDataQualityInterval(input);
      if (q.channel !== "TRADES" || end === null || BigInt(q.startNs) < end) return null;
      end = q.endNs === null ? null : BigInt(q.endNs);
    }
    return entry.intervals;
  } catch { return null; } // Unverified evidence cannot authorize a merge.
}
function covers(intervals: readonly DataQualityInterval[] | null, from: bigint, to: bigint): boolean {
  if (!intervals) return false;
  let cursor = from;
  for (const q of intervals) {
    const start = BigInt(q.startNs), end = q.endNs === null ? to : BigInt(q.endNs);
    // Even a zero-duration invalid marker inside the span forbids bridging it.
    if (q.status !== "VALID" && start < to && (end > from || (start === end && start >= from))) return false;
    if (end <= cursor || start >= to) continue;
    if (start > cursor || q.status !== "VALID") return false;
    if (end > cursor) cursor = end;
  }
  return cursor >= to;
}
const sign = (delta: bigint) => delta > 0n ? 1 : delta < 0n ? -1 : 0;
function eligible(p: ProjectedBubble, filters?: BubbleFilters): boolean {
  const b = p.source.bucket;
  return p.source.status !== "INCOMPLETE" && b.status === "COMPLETE" && b.quality.length === 0
    && b.U === 0n && b.V !== null && b.delta !== null && evaluateBubbleFilter(b, filters).pass;
}
function summarize(children: readonly ProjectedBubble[], sizing: BubbleSizing): VisualBubbleCluster {
  const first = children[0], ids = Object.freeze(children.map(p => p.source.id));
  let B = 0n, S = 0n, V = 0n, delta = 0n;
  let start = BigInt(first.source.bucket.startNs), end = BigInt(first.source.bucket.endNs);
  let minTick = first.source.bucket.minTick, maxTick = first.source.bucket.maxTick;
  for (const child of children) {
    const b = child.source.bucket;
    B += b.B; S += b.S; V += b.V!; delta += b.delta!;
    if (BigInt(b.startNs) < start) start = BigInt(b.startNs);
    if (BigInt(b.endNs) > end) end = BigInt(b.endNs);
    minTick = Math.min(minTick, b.minTick); maxTick = Math.max(maxTick, b.maxTick);
  }
  // Relative display weights only; the exact count totals above remain BigInt.
  const ratio = (n: bigint) => Number(n * 1_000_000_000_000_000_000n / V) / 1e18;
  let x = first.x, y = first.y, maxCenterDistance = 0;
  for (const c of children) {
    const w = ratio(c.source.bucket.V!);
    x += (c.x - first.x) * w; y += (c.y - first.y) * w;
    for (const d of children) maxCenterDistance = Math.max(maxCenterDistance, Math.hypot(c.x - d.x, c.y - d.y));
  }
  const minX = Math.min(...children.map(c => c.x)), maxX = Math.max(...children.map(c => c.x));
  const minY = Math.min(...children.map(c => c.y)), maxY = Math.max(...children.map(c => c.y));
  const footprintWidth = Math.max(...children.map(c => c.x + c.diameter / 2))
    - Math.min(...children.map(c => c.x - c.diameter / 2));
  const footprintHeight = Math.max(...children.map(c => c.y + c.diameter / 2))
    - Math.min(...children.map(c => c.y - c.diameter / 2));
  const absDelta = delta < 0n ? -delta : delta;
  return Object.freeze({
    id: ids.length === 1 ? ids[0] : JSON.stringify(["VISUAL_CLUSTER", ...ids]),
    childrenIds: ids, children: Object.freeze([...children]), B, S, V, delta,
    imbalancePercent: Number(absDelta * 100n) / Number(V),
    status: first.source.status, revision: first.source.revision, x, y,
    diameter: bubbleDiameter(V, sizing), rgba: first.rgba,
    startNs: start.toString(), endNs: end.toString(), minTick, maxTick,
    spread: Object.freeze({ minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY,
      maxCenterDistance, footprintWidth, footprintHeight }),
  });
}
/** Original-node graph + connected components. No greedy reassignment, no
 * second proximity pass using merged diameters, and deliberately no span cap.
 * Input must already be projected/cropped using R05 CSS coordinates.
 */
export function clusterBubbles(
  projected: readonly ProjectedBubble[],
  options: ClusteringOptions = { mode: "STANDARD" },
  sizing: BubbleSizing = DEFAULT_BUBBLE_SIZING,
  filters?: BubbleFilters,
): readonly VisualBubbleCluster[] {
  if (!["ALL", "STANDARD", "HIGH_COMPRESSION"].includes(options.mode)) throw new TypeError("Invalid bubble density");
  bubbleDiameter(0, sizing);
  const nodes = projected.filter(p => eligible(p, filters)).slice()
    .sort((a, b) => a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0);
  const keys = new Set<string>();
  for (const p of nodes) {
    if (keys.has(p.source.id)) throw new TypeError("Duplicate source bubble identity");
    if (p.cluster && p.cluster.childrenIds.length > 1) throw new TypeError("Clustering requires original bubbles, not prior clusters");
    if (![p.x, p.y, p.diameter].every(Number.isFinite) || p.diameter <= 0) throw new TypeError("Invalid CSS bubble geometry");
    keys.add(p.source.id);
  }
  const coverage = new Map<string, readonly DataQualityInterval[] | null>();
  for (const entry of options.continuity ?? []) {
    const key = tradeScopeKey(entry.scope);
    // Ambiguous/competing evidence for one scope cannot authorize continuity.
    coverage.set(key, coverage.has(key) ? null : validCoverage(entry));
  }
  const parents = nodes.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
    return i;
  };
  if (options.mode !== "ALL") {
    const factor = options.mode === "STANDARD" ? .75 : 1.5;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], A = a.source, B = b.source;
      const scope = tradeScopeKey(A.bucket.scope);
      if (scope !== tradeScopeKey(B.bucket.scope) || sign(A.bucket.delta!) !== sign(B.bucket.delta!)
        || A.status !== B.status || (A.status === "REVISED" && A.revision !== B.revision)) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) > factor * (a.diameter + b.diameter) / 2) continue;
      const startA = BigInt(A.bucket.startNs), startB = BigInt(B.bucket.startNs);
      const endA = BigInt(A.bucket.endNs), endB = BigInt(B.bucket.endNs);
      if (!covers(coverage.get(scope) ?? null, startA < startB ? startA : startB, endA > endB ? endA : endB)) continue;
      const ri = root(i), rj = root(j);
      if (ri !== rj) parents[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }
  const groups = new Map<number, ProjectedBubble[]>();
  nodes.forEach((p, i) => { const r = root(i), group = groups.get(r) ?? []; group.push(p); groups.set(r, group); });
  return Object.freeze([...groups.values()].map(group => summarize(group, sizing)));
}
