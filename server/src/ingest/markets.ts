import { marketSymbol } from "../../../lib/market/instruments.ts";
import type { Receiver } from "./receiver.ts";

/** Demultiplex before any book, sequence, rollback, aggregate or store mutation. */
export class MarketReceiver {
  readonly metrics: Receiver["metrics"];
  private receivers: Map<string, Receiver>;
  constructor(nq: Receiver, gc: Receiver) {
    this.receivers = new Map([["NQ", nq], ["GC", gc]]);
    this.metrics = nq.metrics;
  }
  receive(raw: unknown, recvUs: number, pong: () => void) {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(raw)); } catch { this.receivers.get("NQ")!.receive(raw, recvUs, pong); return; }
    const symbol = marketSymbol(message?.symbol);
    if (symbol) {
      this.receivers.get(symbol)!.receive(raw, recvUs, pong);
    } else if (message?.type === "book" || message?.type === "tick") {
      this.metrics.issue("invalidMessage", { reason: "unknown_symbol" }); return;
    } else {
      // Record warnings/feed/errors in each instrument's diagnostics, pong once.
      this.receivers.get("NQ")!.receive(raw, recvUs, pong);
      this.receivers.get("GC")!.receive(raw, recvUs, () => {});
    }
  }
}
