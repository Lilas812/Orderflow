import { BookState } from "../book/state.ts";
import { RecentTrades } from "../trades/recent.ts";
import { Metrics } from "./metrics.ts";
import type { BookLevel, BookSnapshot, Trade } from "../types.ts";
import type { Log } from "../logger.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Receiver {
  readonly book = new BookState();
  readonly trades = new RecentTrades();
  readonly metrics: Metrics;
  private log: Log;
  private seq = 0;
  private lastTs: Partial<Record<"tick" | "book", number>> = {};

  constructor(log: Log) {
    this.log = log;
    this.metrics = new Metrics(log);
  }

  /** Sole boundary for external seconds -> microseconds. No unit guessing. */
  private time(ts: unknown): number | null {
    if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0) return null;
    const tsUs = ts * 1_000_000;
    return Number.isSafeInteger(tsUs) ? tsUs : null;
  }

  /** Sole boundary for external price -> integer NQ ticks. No rounding. */
  private price(price: unknown): number | null {
    if (typeof price !== "number" || !Number.isFinite(price)) return null;
    const ticks = price / 0.25;
    return Number.isSafeInteger(ticks) ? ticks : null;
  }

  private rollback(type: "tick" | "book", tsUs: number): boolean {
    const previous = this.lastTs[type];
    if (previous !== undefined && tsUs < previous) {
      this.metrics.issue("timestampRollback", { type, tsUs, previous });
      return true;
    }
    return false;
  }

  receive(raw: unknown, recvUs: number, pong: () => void) {
    let message: unknown;
    if (typeof raw !== "string") {
      this.metrics.issue("invalidMessage", { reason: "non_text_frame", recvUs });
      return;
    }
    try { message = JSON.parse(raw); }
    catch {
      this.metrics.issue("invalidJson", { recvUs });
      return;
    }
    if (!record(message) || typeof message.type !== "string") {
      this.metrics.issue("invalidMessage", { reason: "missing_type", recvUs });
      return;
    }
    // Do not retain arbitrary strings as counter keys: unbounded and potentially secret.
    const known = ["welcome", "tick", "book", "ping", "pong", "warning", "feed", "error"];
    const type = known.includes(message.type) ? message.type : "unknown";
    this.metrics.type(type);
    switch (type) {
      case "ping": pong(); return;
      case "welcome": this.log("upstream_welcome"); return;
      case "pong": return;
      case "warning":
      case "feed":
      case "error": {
        this.metrics.count(type);
        const diagnostic = { type, recvUs, message };
        this.log("upstream_notice", diagnostic);
        if (this.metrics.examples[type]?.length !== 5) {
          (this.metrics.examples[type] ??= []).push(diagnostic);
        }
        if (message.code === "ticks_lagged" || message.warning === "ticks_lagged"
          || message.reason === "ticks_lagged" || message.message === "ticks_lagged") {
          this.metrics.count("ticksLagged");
          // Keep the documented source fields without guessing their units.
          // In absence of source bounds, record the observed receive-time gap.
          const gap = {
            observedAtUs: recvUs,
            previousTradeUs: this.lastTs.tick ?? null,
            sourceBounds: {
              start: message.start ?? null, end: message.end ?? null,
              from: message.from ?? null, to: message.to ?? null,
            },
            sourceBoundsUnit: "unknown",
          };
          if (this.metrics.lagIntervals.length < 5) this.metrics.lagIntervals.push(gap);
          this.log("ticks_lagged_interval", gap);
        }
        return;
      }
      case "tick": this.trade(message, recvUs); return;
      case "book": this.snapshot(message, recvUs); return;
      default: this.metrics.issue("unknownType", { recvUs }); return;
    }
  }

  private trade(message: Record<string, unknown>, recvUs: number) {
    const tsUs = this.time(message.ts);
    const price = this.price(message.price);
    let invalid = false;
    if (price === null) {
      this.metrics.issue("offTick", { type: "tick", price: message.price, recvUs });
      invalid = true;
    }
    if (tsUs === null || message.symbol !== "NQ"
      || typeof message.size !== "number" || !Number.isFinite(message.size) || message.size <= 0
      || (message.side !== "buy" && message.side !== "sell")) {
      this.metrics.issue("invalidMessage", { type: "tick", reason: "invalid_fields", recvUs });
      invalid = true;
    }
    if (tsUs !== null && this.rollback("tick", tsUs)) invalid = true;
    if (invalid) { this.metrics.count("rejectedTrade"); return; }
    const trade: Trade = {
      tsUs: tsUs!, recvUs, seq: ++this.seq, price: price!,
      size: message.size as number, side: message.side as Trade["side"],
    };
    this.lastTs.tick = trade.tsUs;
    this.trades.push(trade);
    this.metrics.count("acceptedTrade");
  }

  private snapshot(message: Record<string, unknown>, recvUs: number) {
    const tsUs = this.time(message.ts);
    let invalid = false;
    if (tsUs === null || message.symbol !== "NQ") {
      this.metrics.issue("invalidMessage", { type: "book", reason: "invalid_fields", recvUs });
      invalid = true;
    }
    const side = (raw: unknown, name: "bids" | "asks"): BookLevel[] => {
      if (!Array.isArray(raw)) {
        this.metrics.issue("invalidMessage", { type: "book", side: name, recvUs });
        invalid = true;
        return [];
      }
      const levels: BookLevel[] = [];
      const seen = new Set<number>();
      for (const row of raw) {
        if (!Array.isArray(row) || row.length !== 2
          || typeof row[1] !== "number" || !Number.isFinite(row[1])) {
          this.metrics.issue("invalidMessage", { type: "book", side: name, reason: "invalid_level", recvUs });
          invalid = true;
          continue;
        }
        // Even excluded levels may not hide an off-tick input price (SPEC 6).
        const price = this.price(row[0]);
        if (price === null) {
          this.metrics.issue("offTick", { type: "book", side: name, price: row[0], recvUs });
          invalid = true;
        }
        if (row[1] <= 0) {
          this.metrics.issue("nonPositiveBookLevels", { side: name, price: row[0], size: row[1], recvUs });
          continue;
        }
        if (price === null) continue;
        if (seen.has(price)) {
          this.metrics.issue("duplicatePrice", { side: name, price, recvUs });
          invalid = true;
        }
        const previous = levels.at(-1)?.price;
        if (previous !== undefined && (name === "bids" ? price > previous : price < previous)) {
          this.metrics.issue("bookOrder", { side: name, previous, price, recvUs });
          invalid = true;
        }
        seen.add(price);
        levels.push({ price, size: row[1] });
      }
      return levels;
    };
    const bids = side(message.bids, "bids");
    const asks = side(message.asks, "asks");
    if (bids.length && asks.length && bids[0].price >= asks[0].price) {
      this.metrics.issue("crossedBook", { bestBid: bids[0].price, bestAsk: asks[0].price, recvUs });
      invalid = true;
    }
    if (tsUs !== null && this.rollback("book", tsUs)) invalid = true;
    if (invalid) { this.metrics.count("rejectedBook"); return; }
    const book: BookSnapshot = { tsUs: tsUs!, recvUs, source: "live", bids, asks };
    this.lastTs.book = book.tsUs;
    this.book.replace(book);
    this.metrics.count("acceptedBook");
  }
}
