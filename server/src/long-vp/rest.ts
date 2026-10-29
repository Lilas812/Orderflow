import { setTimeout as delay } from "node:timers/promises";
import type { Trade } from "../types.ts";
import { normalizePrice } from "../ingest/normalize.ts";
import { validContract, UNKNOWN_CONTRACT, type MarketSymbol } from "../../../lib/market/instruments.ts";
export interface Roll { contract: string; sinceUs: number; }
export interface TickPage { trades: Trade[]; truncated: boolean; }
export interface LongSource {
  roll(signal: AbortSignal): Promise<Roll>;
  ticks(startUs: number, endUs: number, signal: AbortSignal): Promise<TickPage>;
}
export function rollSinceUs(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    throw Error("unverified_contract_since");
  const base = Date.parse(value.replace(/\.\d+/, ""));
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  const us = base * 1000 + Number(fraction.slice(0, 6).padEnd(6, "0"));
  if (!Number.isSafeInteger(us)) throw Error("unverified_contract_since");
  return us;
}
/** Independent REST client: no upstream socket, no changes to heatmap backfill behavior. */
export class LongRest implements LongSource {
  readonly symbol: MarketSymbol;
  currentContract: string | null = null;
  private onContract: (contract: string) => void;
  private key: string;
  private request: typeof fetch;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(key: string, request = fetch,
    wait = async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); },
    symbol: MarketSymbol = "NQ", onContract: (contract: string) => void = () => {}) {
    this.symbol = symbol; this.onContract = onContract;
    this.key = key; this.request = request; this.wait = wait;
  }
  private async json(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      signal.throwIfAborted();
      try {
        const r = await this.request("https://api.tick-stream.xyz/v1" + path, {
          headers: { Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
        if (!r.ok) {
          await r.body?.cancel();
          if (r.status === 401 || r.status === 403) throw Error("long_rest_auth_failed");
          if (r.status < 500 && r.status !== 429) throw Error("long_rest_request_rejected");
          throw Error("long_rest_temporarily_unavailable");
        }
        const d: unknown = await r.json();
        if (!d || typeof d !== "object" || Array.isArray(d)) throw Error("long_rest_invalid_payload");
        return d as Record<string, unknown>;
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof Error && ["long_rest_auth_failed", "long_rest_request_rejected",
          "long_rest_invalid_payload"].includes(e.message)) throw e;
        if (attempt === 3) throw Error("long_rest_exhausted");
        await this.wait(60000, signal);
      }
    }
    throw Error("long_rest_exhausted");
  }
  async roll(signal: AbortSignal) {
    const d = await this.json("/symbols", signal);
    const row = Array.isArray(d.futures) ? d.futures.find(r => r?.symbol === this.symbol) : undefined;
    if (!row || !validContract(row.contract, this.symbol))
      throw Error("unverified_contract");
    this.currentContract = row.contract; this.onContract(row.contract);
    // No observed-at boundary, no retroactive assignment to the current expiry.
    if (this.symbol === "GC" && row.contractSince == null) return { contract: UNKNOWN_CONTRACT, sinceUs: 0 };
    return { contract: row.contract, sinceUs: rollSinceUs(row.contractSince) };
  }
  async ticks(startUs: number, endUs: number, signal: AbortSignal): Promise<TickPage> {
    // The REST API takes seconds, rows contain microseconds. Filter to exact half-open bounds.
    const p = new URLSearchParams({ symbol: this.symbol, start: String(Math.floor(startUs / 1e6)),
      end: String(Math.ceil(endUs / 1e6)), limit: "100000", order: "asc" });
    const d = await this.json("/ticks?" + p, signal);
    if (!Array.isArray(d.ticks) || typeof d.truncated !== "boolean"
      || d.history_clamped === true || d.note != null || (d.start != null && Number(d.start) > Math.floor(startUs / 1e6)))
      throw Error("long_rest_clamped_or_invalid");
    const trades: Trade[] = [];
    for (const [seq, row] of d.ticks.entries()) {
      if (!row || typeof row !== "object" || !Number.isSafeInteger(row.ts)) throw Error("long_rest_invalid_tick");
      if (row.ts < startUs || row.ts >= endUs) continue;
      const price = normalizePrice(row.price, this.symbol);
      if (price === null || !Number.isSafeInteger(row.size) || row.size <= 0 || !["buy", "sell"].includes(row.side))
        throw Error("long_rest_invalid_tick");
      trades.push({ tsUs: row.ts, recvUs: row.ts, seq, price, size: row.size, side: row.side,
        ...(this.symbol === "GC" && validContract(row.contract, this.symbol) ? { contract: row.contract } : {}) });
    }
    return { trades, truncated: d.truncated };
  }
}
