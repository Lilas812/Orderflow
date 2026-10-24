import { expect, it } from "vitest";
import { parseAnalysisObservation } from "./analysisObservation";
import type { ReceiveContext } from "./liveObservation";
const context: ReceiveContext = {
  origin: "SYNTHETIC_TEST", channel: "book", timestampUnit: "s",
  receivedAtUtcNs: "1767225600123000000", receivedAtMonotonicNs: "123000000",
  connectionEpoch: 7, receiveOrdinal: 1,
};
it("preserves root, unresolved expiry/session, second precision and snapshot quantities", () => {
  const result = parseAnalysisObservation(JSON.stringify({ type: "book", symbol: "NQ",
    ts: 1767225600, bids: [[20000, 17]], asks: [[20000.25, 0]], imbalance: 0 }), context);
  expect(result).toMatchObject({ generation: 7, precision: "s", contract: null, session: null,
    sequence: null, tradeId: null, timestampNs: "1767225600000000000",
    levels: [{ side: "BID", priceTicks: 80000, qty: 17 }, { side: "ASK", priceTicks: 80001, qty: 0 }] });
});
it("does not reinterpret a provider side as certified aggressor or create a Trade ID", () => {
  const result = parseAnalysisObservation(JSON.stringify({ type: "tick", symbol: "NQ",
    ts: 1767225600, price: 20000, size: 5, side: "buy", exch: "CME" }), { ...context, channel: "ticks" });
  expect(result).toMatchObject({ tradeId: null, trade: { volume: 5, side: "BUY" }, levels: [] });
});
it.each([
  { type: "book", symbol: "NQZ6", ts: 1767225600, bids: [], asks: [], imbalance: 0 },
  { type: "book", symbol: "NQ", ts: 1767225600000, bids: [], asks: [], imbalance: 0, contract: "NQZ6" },
  { type: "warning", code: "ticks_lagged" },
])("refuses unsupported frame instead of preserving a supposedly healthy book", frame => {
  expect(parseAnalysisObservation(JSON.stringify(frame), context)).toBeNull();
});
