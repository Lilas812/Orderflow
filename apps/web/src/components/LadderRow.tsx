import type { LadderQuantity, LadderRowView } from "@workspace/core/ladder-view";

const qtyText = (q: LadderQuantity) => (q.status === "KNOWN" && q.qty !== null ? String(q.qty) : "");

function Cell({ q, side }: { q: LadderQuantity; side: "bid" | "ask" }) {
  const t = qtyText(q);
  return (
    <span className={`lad-q lad-${side}`} data-status={q.status} title={t ? `${side.toUpperCase()} ${t}` : `${side.toUpperCase()} ${q.status}`}>
      {t || (q.status === "OUTSIDE_DEPTH" ? "\u2014 OUT" : "\u2014")}
    </span>
  );
}

/** One price row. Center is positioned at row.y (CSS px from plot top) via translateY(-50%); height is row.rowHeight. */
export function LadderRow({ row }: { row: LadderRowView }) {
  const h = Math.max(1, row.rowHeight);
  return (
    <div
      className="lad-row"
      data-testid={`ladder-row-${row.priceTicks}`}
      data-tick={row.priceTicks}
      data-y={row.y}
      data-status-bid={row.bid.status}
      data-status-ask={row.ask.status}
      data-qty-bid={qtyText(row.bid)}
      data-qty-ask={qtyText(row.ask)}
      data-is-best-bid={String(row.isBestBid)}
      data-is-best-ask={String(row.isBestAsk)}
      data-is-observed-bid={String(row.isObservedBid)}
      data-is-observed-ask={String(row.isObservedAsk)}
      style={{ top: row.y, height: h, lineHeight: `${h}px`, fontSize: Math.max(6, Math.min(11, h - 1)) }}
    >
      <Cell q={row.ask} side="ask" />
      <span className="lad-price" data-hidden={!row.labelVisible}>
        {row.labelVisible ? row.priceLabel : ""}
        {row.isBestAsk && <i className="lad-tag lad-tag-ask">A</i>}
        {row.isBestBid && <i className="lad-tag lad-tag-bid">B</i>}
        {!row.isBestAsk && row.isObservedAsk && <i className="lad-tag lad-tag-ask">a?</i>}
        {!row.isBestBid && row.isObservedBid && <i className="lad-tag lad-tag-bid">b?</i>}
      </span>
      <Cell q={row.bid} side="bid" />
    </div>
  );
}
