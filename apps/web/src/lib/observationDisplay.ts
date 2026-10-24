import { buildLadderView, type LadderView } from "@workspace/core/ladder-view";
import { restingQuantity } from "@workspace/core/events";
import type { Viewport } from "@workspace/core/viewport";
import type { LiveFrame } from "@workspace/core/analysis-hub";

export interface ObservationDisplay {
  readonly frame: LiveFrame | null;
  readonly reason: string;
}
/** Display adapter only: reuse the existing ladder geometry/density. Explicit
 * snapshot entries are observed quantities; omissions remain unknown, not zero.
 * No MarketIdentity, best guarantee, depth scope or VALID coverage is invented. */
export function observationLadder(frame: LiveFrame | null, vp: Viewport): LadderView {
  const base = buildLadderView(null, vp);
  const levels = frame?.book.status === "OBSERVED_SNAPSHOT" ? frame.book.levels : [];
  const bids = new Map(levels.filter(l => l.side === "BID").map(l => [l.priceTicks, l.qty]));
  const asks = new Map(levels.filter(l => l.side === "ASK").map(l => [l.priceTicks, l.qty]));
  const read = (map: Map<number, number>, price: number) => map.has(price)
    ? { status: "KNOWN" as const, qty: restingQuantity(map.get(price)!) }
    : { status: "UNKNOWN" as const, qty: null };
  return {
    ...base, asOfNs: frame?.book.asOfNs ?? null, asOfKind: "NONE",
    rows: base.rows.map(row => ({ ...row, bid: read(bids, row.priceTicks), ask: read(asks, row.priceTicks) })),
    warnings: ["OBSERVED SNAPSHOT ONLY — not current market quantities",
      "NQ root / contract UNKNOWN / exchange session UNKNOWN / coverage UNKNOWN / precision seconds",
      "Unlisted levels UNKNOWN; no TWA, finalized Bubble, Delta or market Best guarantee"],
  };
}
