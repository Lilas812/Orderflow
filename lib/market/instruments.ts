/** Root symbols only. Prices and roll differences are integer instrument ticks. */
export const INSTRUMENTS = {
  NQ: { symbol: "NQ", tickSize: 0.25, ticksPerPoint: 4, decimals: 2, depth: 400, contract: /^NQ[HMUZ]\d{1,4}$/ },
  GC: { symbol: "GC", tickSize: 0.1, ticksPerPoint: 10, decimals: 1, depth: 400, contract: /^GC[FGHJKMNQUVXZ]\d{1,4}$/ },
} as const;
export type MarketSymbol = keyof typeof INSTRUMENTS;
export const UNKNOWN_CONTRACT = "UNKNOWN";
export function marketSymbol(value: unknown): MarketSymbol | null {
  return value === "NQ" || value === "GC" ? value : null;
}
export function validContract(value: unknown, symbol: MarketSymbol, unknown = false): value is string {
  return typeof value === "string" && ((unknown && symbol === "GC" && value === UNKNOWN_CONTRACT)
    || INSTRUMENTS[symbol].contract.test(value));
}
export function instrumentPrice(ticks: number, symbol: MarketSymbol): string {
  return (ticks / INSTRUMENTS[symbol].ticksPerPoint).toFixed(INSTRUMENTS[symbol].decimals);
}
