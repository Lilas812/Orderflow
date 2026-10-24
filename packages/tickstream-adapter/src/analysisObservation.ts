import type { LiveObservation } from "@workspace/core/analysis-hub";
import { parseObservation, type ReceiveContext } from "./liveObservation";

/** Caller-owned receive context, never wire-controlled origin/generation/ordinal.
 * Do not promote parser acceptance into normalized exchange event acceptance. */
export function parseAnalysisObservation(raw: string, context: ReceiveContext): LiveObservation | null {
  const record = parseObservation(raw, context);
  if (record.result.status !== "ACCEPTED_OBSERVATION") return null;
  const o = record.result.observation;
  if (o.timestampPrecision !== "s") return null;
  return {
    origin: context.origin, generation: context.connectionEpoch, ordinal: context.receiveOrdinal,
    channel: context.channel, timestampNs: o.timestampNs, receivedNs: context.receivedAtUtcNs,
    symbol: "NQ", precision: "s", contract: null, session: null, sequence: null, tradeId: null,
    levels: o.kind === "BOOK_OBSERVATION" ? [
      ...o.bids.map(l => ({ side: "BID" as const, priceTicks: l.priceTicks, qty: l.size })),
      ...o.asks.map(l => ({ side: "ASK" as const, priceTicks: l.priceTicks, qty: l.size })),
    ] : [],
    trade: o.kind === "TRADE_OBSERVATION"
      ? { priceTicks: o.priceTicks, volume: o.size, side: o.side } : null,
  };
}
