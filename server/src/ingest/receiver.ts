import { BookState } from "../book/state.ts";
import { RecentTrades } from "../trades/recent.ts";
import { Metrics } from "./metrics.ts";
import type { BookSnapshot, Trade } from "../types.ts";
import type { Log } from "../logger.ts";
import { normalizeBook, normalizePrice, normalizeTime, normalizeTradeSide } from "./normalize.ts";
import { validContract, type MarketSymbol } from "../../../lib/market/instruments.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Receiver {
  readonly book = new BookState();
  readonly trades = new RecentTrades();
  readonly metrics: Metrics;
  private log: Log;
  private seq = 0;
  readonly symbol: MarketSymbol;
  currentContract: string | null = null;
  private lastTs: Partial<Record<"tick" | "book", number>> = {};
  private observers: { book?: (book: BookSnapshot) => void; trade?: (trade: Trade) => void };

  constructor(log: Log, observers: { book?: (book: BookSnapshot) => void; trade?: (trade: Trade) => void } = {},
    symbol: MarketSymbol = "NQ") {
    this.symbol = symbol;
    this.log = log;
    this.metrics = new Metrics(log);
    this.observers = observers;
  }

  nextSequence() { return ++this.seq; }

  /** Sole boundary for external seconds -> microseconds. No unit guessing. */
  private time(ts: unknown): number | null {
    return normalizeTime(ts, "live");
  }

  /** Sole boundary for external price -> integer NQ ticks. No rounding. */
  private price(price: unknown): number | null {
    return normalizePrice(price, this.symbol);
  }

  private rollback(type: "tick" | "book", tsUs: number): boolean {
    const previous = this.lastTs[type];
    if (previous !== undefined && tsUs < previous) {
      this.metrics.issue(type === "book" ? "bookTimestampRollback" : "tradeTimestampRollback", { type, tsUs, previous });
      return type === "book";
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
    const side = normalizeTradeSide(message.side);
    let invalid = false;
    if (price === null) {
      this.metrics.issue("offTick", { type: "tick", price: message.price, recvUs });
      invalid = true;
    }
    if (tsUs === null || message.symbol !== this.symbol
      || typeof message.size !== "number" || !Number.isFinite(message.size) || message.size <= 0
      || side === null) {
      this.metrics.issue("invalidMessage", { type: "tick", reason: "invalid_fields", recvUs });
      invalid = true;
    }
    if (tsUs !== null) this.rollback("tick", tsUs);
    if (invalid) { this.metrics.count("rejectedTrade"); return; }
    const trade: Trade = {
      tsUs: tsUs!, recvUs, seq: this.nextSequence(), price: price!,
      size: message.size as number, side: side!,
    };
    if (this.symbol === "GC") {
      const contract = validContract(message.contract, "GC") ? message.contract : this.currentContract;
      if (contract) trade.contract = contract;
    }
    this.lastTs.tick = trade.tsUs;
    this.trades.push(trade);
    this.metrics.count("acceptedTrade");
    this.observers.trade?.(trade);
  }

  private snapshot(message: Record<string, unknown>, recvUs: number) {
    const book = normalizeBook(message, recvUs, "live", this.metrics, (tsUs) => this.rollback("book", tsUs), this.symbol);
    if (!book) return;
    this.lastTs.book = book.tsUs;
    this.book.replace(book);
    this.metrics.count("acceptedBook");
    this.observers.book?.(book);
  }
}
