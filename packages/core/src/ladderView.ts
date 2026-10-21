import type { DepthScope } from "./events";
import { ticksToPrice } from "./instrument";
import {
  currentMbpBook, currentQuality, readCurrentMbpLevel,
  type MarketIdentity, type MarketQualityState, type QualityStatus,
} from "./qualityTimeline";
import type { LevelObservation } from "./mbpBook";
import { tickToY, type Viewport } from "./viewport";

export type LadderQuantity = LevelObservation | {
  readonly status: Exclude<QualityStatus, "VALID">; readonly qty: null;
};
export interface LadderTopEvidence {
  readonly identity: MarketIdentity;
  readonly snapshotCoversSequence: string;
  /** Explicit source guarantee, never inferred from FULL/TOP_N/PRICE_RANGE. */
  readonly guarantee: "LISTED_LEVELS_INCLUDE_MARKET_BEST";
  readonly evidence: string;
}
export interface LadderRowView {
  readonly priceTicks: number; readonly priceLabel: string;
  readonly y: number; readonly rowHeight: number; readonly labelVisible: boolean;
  readonly bid: LadderQuantity; readonly ask: LadderQuantity;
  readonly isBestBid: boolean; readonly isBestAsk: boolean;
  readonly isObservedBid: boolean; readonly isObservedAsk: boolean;
}
export interface LadderView {
  readonly rows: readonly LadderRowView[]; readonly quality: QualityStatus;
  readonly asOfNs: string | null; readonly asOfKind: "EXCHANGE_TIME_NS" | "RECEIVE_TIME_NS" | "NONE";
  readonly identity: MarketIdentity | null; readonly depthScope: DepthScope | null;
  readonly bestBidTick: number | null; readonly bestAskTick: number | null;
  readonly observedBidTick: number | null; readonly observedAskTick: number | null;
  readonly topOfBookGuaranteed: boolean; readonly crossed: boolean; readonly locked: boolean;
  readonly densityStep: number; readonly warnings: readonly string[];
}
function same(a: MarketIdentity, b: MarketIdentity): boolean {
  return (["environment", "source", "sourceId", "canonicalInstrumentId", "sessionId"] as const)
    .every(k => a[k] === b[k]);
}
/** Read-only publication adapter. R02/R03 remain the sole board/quality engines. */
export function buildLadderView(
  state: MarketQualityState | null, vp: Viewport, evidence?: LadderTopEvidence,
): LadderView {
  const book = state ? currentMbpBook(state) : null;
  const last = state?.lastGoodBook.lastHeader ?? null;
  const reported = state ? currentQuality(state.timeline, "L2_MBP").status : "NOT_INITIALIZED";
  const quality = reported === "VALID" && !book ? "RESYNCING" : reported;
  if (book?.identity && state && !same(book.identity, state.config.identity)) {
    throw new TypeError("Ladder book identity differs from quality scope");
  }
  let observedBidTick: number | null = null, observedAskTick: number | null = null;
  if (book) {
    for (const [tick, qty] of book.bids) {
      if (qty > 0 && (observedBidTick === null || tick > observedBidTick)) observedBidTick = tick;
    }
    for (const [tick, qty] of book.asks) {
      if (qty > 0 && (observedAskTick === null || tick < observedAskTick)) observedAskTick = tick;
    }
  }
  const evidenceMatches = !!(book?.identity && evidence
    && evidence.guarantee === "LISTED_LEVELS_INCLUDE_MARKET_BEST"
    && evidence.evidence.trim() && same(book.identity, evidence.identity)
    && evidence.snapshotCoversSequence === book.snapshotCoversSequence);
  // UNKNOWN omissions can conceal a better price after a best level is deleted.
  // For finite scopes require explicit knowledge of every potential better level.
  // FULL + UNKNOWN is never promoted to global Best by the depth tag alone.
  const clearBetter = (side: "BID" | "ASK", candidate: number | null): boolean => {
    if (!book || candidate === null) return false;
    if (book.semantics.unlistedLevels === "ZERO") return true;
    if (book.depthScope?.type !== "PRICE_RANGE") return false;
    const boundary = side === "BID" ? book.depthScope.maxTick : book.depthScope.minTick;
    const distance = side === "BID" ? BigInt(boundary) - BigInt(candidate) : BigInt(candidate) - BigInt(boundary);
    // Do not scan a potentially unbounded depth range. Completeness can only
    // hold if at least that many explicit known levels exist in the map.
    const levels = side === "BID" ? book.bids : book.asks;
    if (distance > BigInt(levels.size)) return false;
    const direction = side === "BID" ? 1n : -1n;
    for (let t = BigInt(candidate) + direction; side === "BID" ? t <= BigInt(boundary) : t >= BigInt(boundary); t += direction) {
      const qty = levels.get(Number(t));
      if (qty === undefined || qty !== 0) return false;
    }
    return true;
  };
  const bidGuaranteed = evidenceMatches && clearBetter("BID", observedBidTick);
  const askGuaranteed = evidenceMatches && clearBetter("ASK", observedAskTick);
  const bestBidTick = bidGuaranteed ? observedBidTick : null, bestAskTick = askGuaranteed ? observedAskTick : null;
  const topOfBookGuaranteed = bidGuaranteed && askGuaranteed;
  const crossed = observedBidTick !== null && observedAskTick !== null && observedBidTick > observedAskTick;
  const locked = observedBidTick !== null && observedAskTick !== null && observedBidTick === observedAskTick;
  const warnings: string[] = [];
  if (quality !== "VALID") warnings.push(`${quality}: no current L2 quantities; a valid covering snapshot is required`);
  if (quality === "STALE") warnings.push("最終観測値・現在値ではない。旧数量も表示しない");
  if (book && !topOfBookGuaranteed) warnings.push("範囲内候補のみ：市場全体のBest未保証");
  if (crossed) warnings.push("CROSSED BOOK: observed Bid exceeds Ask; no correction applied");
  if (locked) warnings.push("LOCKED BOOK: observed Bid equals Ask; both sides retained");
  const rows: LadderRowView[] = [];
  let densityStep = 1;
  if (vp.price && vp.bounds.height > 0) {
    const lo = BigInt(vp.price.minTick), hi = BigInt(vp.price.maxTick), span = hi - lo;
    if (span <= 0n || span > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Invalid ladder price viewport");
    const slots = BigInt(Math.max(1, Math.floor(vp.bounds.height / 14)));
    const step = (span + slots - 1n) / slots;
    densityStep = Number(step);
    let top = hi / step * step;
    if (top > hi) top -= step; // BigInt division truncates toward zero for negative prices.
    const selected = new Set<number>();
    for (let tick = top; tick >= lo; tick -= step) selected.add(Number(tick));
    // Important levels retain their exact centers even when their labels are
    // suppressed by density; never move quantities to a neighboring Tick.
    for (const tick of [observedBidTick, observedAskTick]) if (tick !== null && tick >= vp.price.minTick && tick <= vp.price.maxTick) selected.add(tick);
    const rowHeight = Math.min(18, (tickToY(vp, vp.price.minTick)! - tickToY(vp, vp.price.maxTick)!) / Number(span) * densityStep);
    for (const priceTicks of [...selected].sort((a, b) => b - a)) {
      const read = (side: "BID" | "ASK"): LadderQuantity => state
        ? readCurrentMbpLevel(state, side, priceTicks) : { status: "NOT_INITIALIZED", qty: null };
      rows.push(Object.freeze({
        priceTicks, priceLabel: ticksToPrice(priceTicks).toFixed(2), y: tickToY(vp, priceTicks)!,
        rowHeight, labelVisible: BigInt(priceTicks) % step === 0n,
        bid: Object.freeze(read("BID")), ask: Object.freeze(read("ASK")),
        isBestBid: priceTicks === bestBidTick, isBestAsk: priceTicks === bestAskTick,
        isObservedBid: priceTicks === observedBidTick, isObservedAsk: priceTicks === observedAskTick,
      }));
    }
    if (densityStep > 1) warnings.push(`表示密度 ${densityStep} Tick：行の価格座標と元数量は不変`);
  }
  return Object.freeze({
    rows: Object.freeze(rows), quality, asOfNs: last?.exchangeTimeNs ?? last?.receiveTimeNs ?? null,
    asOfKind: last ? last.exchangeTimeNs !== null ? "EXCHANGE_TIME_NS" : "RECEIVE_TIME_NS" : "NONE",
    identity: state?.config.identity ?? null, depthScope: state?.lastGoodBook.depthScope ?? null,
    bestBidTick, bestAskTick, observedBidTick, observedAskTick, topOfBookGuaranteed,
    crossed, locked, densityStep, warnings: Object.freeze(warnings),
  });
}
