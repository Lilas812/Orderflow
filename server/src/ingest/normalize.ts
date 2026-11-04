import type { BookLevel, BookSnapshot } from "../types.ts";
import type { Metrics } from "./metrics.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../../lib/market/instruments.ts";

/** External units are explicit, never inferred from digit count. */
export function normalizeTime(ts: unknown, source: "live" | "history"): number | null {
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0) return null;
  const us = source === "live" ? ts * 1_000_000 : ts;
  return Number.isSafeInteger(us) ? us : null;
}

export function normalizePrice(price: unknown, symbol: MarketSymbol = "NQ"): number | null {
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  const ticks = price * INSTRUMENTS[symbol].ticksPerPoint;
  if (symbol === "GC") {
    const integer = Math.round(ticks);
    if (Number.isSafeInteger(integer) && Math.abs(ticks - integer) <= Number.EPSILON * Math.max(1, Math.abs(ticks)) * 2)
      return integer;
  }
  return Number.isSafeInteger(ticks) ? ticks : null;
}

/** Shared Phase 1 rules; excluded nonpositive levels still undergo price validation. */
export function normalizeBook(
  message: Record<string, unknown>, recvUs: number, source: "live" | "history",
  metrics: Metrics, rollback: (tsUs: number) => boolean,
  symbol: MarketSymbol = "NQ",
): BookSnapshot | null {
  const tsUs = normalizeTime(message.ts, source);
  let invalid = false;
  let rejectedReason: string | null = null;
  if (tsUs === null || message.symbol !== symbol) {
    metrics.issue("invalidMessage", { type: "book", reason: "invalid_fields", recvUs });
    invalid = true;
    rejectedReason ??= "invalid_fields";
  }
  const side = (raw: unknown, name: "bids" | "asks"): BookLevel[] => {
    if (!Array.isArray(raw)) {
      metrics.issue("invalidMessage", { type: "book", side: name, recvUs });
      invalid = true;
      rejectedReason ??= "invalid_side";
      return [];
    }
    const levels: BookLevel[] = [];
    const seen = new Set<number>();
    for (const row of raw) {
      if (!Array.isArray(row) || row.length !== 2
        || typeof row[1] !== "number" || !Number.isFinite(row[1])) {
        metrics.issue("invalidMessage", { type: "book", side: name, reason: "invalid_level", recvUs });
        invalid = true;
        rejectedReason ??= "invalid_level";
        continue;
      }
      const price = normalizePrice(row[0], symbol);
      if (price === null) {
        metrics.issue("offTick", { type: "book", side: name, price: row[0], recvUs });
        invalid = true;
        rejectedReason ??= "off_tick";
      }
      if (row[1] <= 0) {
        metrics.issue("nonPositiveBookLevels", { side: name, price: row[0], size: row[1], recvUs });
        continue;
      }
      if (price === null) continue;
      if (seen.has(price)) {
        metrics.issue("duplicatePrice", { side: name, price, recvUs });
        invalid = true;
        rejectedReason ??= "duplicate_price";
      }
      const previous = levels.at(-1)?.price;
      if (previous !== undefined && (name === "bids" ? price > previous : price < previous)) {
        metrics.issue("bookOrder", { side: name, previous, price, recvUs });
        invalid = true;
        rejectedReason ??= "book_order";
      }
      seen.add(price);
      levels.push({ price, size: row[1] });
    }
    return levels;
  };
  const bids = side(message.bids, "bids");
  const asks = side(message.asks, "asks");
  if (bids.length && asks.length && bids[0].price >= asks[0].price) {
    metrics.issue("crossedBook", { bestBid: bids[0].price, bestAsk: asks[0].price, recvUs });
    invalid = true;
    rejectedReason ??= "crossed_book";
  }
  if (tsUs !== null && rollback(tsUs)) { invalid = true; rejectedReason ??= "timestamp_rollback"; }
  if (invalid) {
    metrics.count("rejectedBook");
    const reason = rejectedReason ?? "invalid_fields";
    metrics.bookRejections[reason] = (metrics.bookRejections[reason] ?? 0) + 1;
    return null;
  }
  return { tsUs: tsUs!, recvUs, source, bids, asks };
}
