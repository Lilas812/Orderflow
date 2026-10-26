import { setTimeout as delay } from "node:timers/promises";
import type { Kind } from "../store/local.ts";
import type { HistoryRow } from "./decode.ts";
import type { Log } from "../logger.ts";

export interface HistoryResponse { rows: HistoryRow[]; truncated: boolean; }
export interface HistorySource { get(kind: Kind, start: number, end: number, signal: AbortSignal): Promise<HistoryResponse>; }
export interface HistoryNetworkStats {
  requests: number; fetchedBookRows: number; fetchedTradeRows: number;
  errors: number; waits: number; waitUntilUs: number | null; lastError: string | null;
}
export class HistoryClient implements HistorySource {
  readonly stats: HistoryNetworkStats = {
    requests: 0, fetchedBookRows: 0, fetchedTradeRows: 0, errors: 0, waits: 0, waitUntilUs: null, lastError: null,
  };
  private apiKey: string;
  private log: Log;
  private request: typeof fetch;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(apiKey: string, log: Log, request: typeof fetch = fetch,
    wait = async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); }) {
    this.apiKey = apiKey; this.log = log; this.request = request; this.wait = wait;
  }
  private async pause(ms: number, signal: AbortSignal) {
    this.stats.waits++; this.stats.waitUntilUs = (Date.now() + ms) * 1000;
    this.log("history_wait", { ms, reason: this.stats.lastError });
    try { await this.wait(ms, signal); } finally { this.stats.waitUntilUs = null; }
  }
  async get(kind: Kind, start: number, end: number, signal: AbortSignal): Promise<HistoryResponse> {
    const url = new URL(`https://api.tick-stream.xyz/v1/history/${kind === "book" ? "book" : "ticks"}`);
    for (const [k, v] of Object.entries({ symbol: "NQ", start, end, limit: 500000 })) url.searchParams.set(k, String(v));
    while (true) {
      signal.throwIfAborted();
      let response: Response;
      this.stats.requests++;
      try {
        response = await this.request(url, { headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      } catch {
        signal.throwIfAborted();
        this.stats.errors++; this.stats.lastError = "network_or_timeout";
        this.log("history_request_failed", { kind, start, end, reason: this.stats.lastError });
        await this.pause(60000, signal); continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        this.stats.errors++; this.stats.lastError = `http_${response.status}`;
        this.log("history_request_failed", { kind, start, end, reason: this.stats.lastError });
        if (response.status === 429 || response.status >= 500) {
          const retry = response.headers.get("retry-after");
          const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000
            : retry !== null ? Date.parse(retry) - Date.now() : NaN;
          await this.pause(Number.isFinite(seconds) ? Math.max(0, seconds) : 60000, signal);
          continue;
        }
        throw Error(this.stats.lastError);
      }
      let payload: Record<string, unknown>;
      try { payload = await response.json() as Record<string, unknown>; }
      catch { this.stats.errors++; this.stats.lastError = "invalid_history_json"; throw Error(this.stats.lastError); }
      const rows = payload[kind === "book" ? "book" : "ticks"];
      if (!Array.isArray(rows) || typeof payload.truncated !== "boolean"
        || rows.some(r => !r || typeof r !== "object" || Array.isArray(r))
        || payload.history_clamped === true) {
        this.stats.errors++; this.stats.lastError = "invalid_or_clamped_history";
        throw Error(this.stats.lastError);
      }
      this.stats[kind === "book" ? "fetchedBookRows" : "fetchedTradeRows"] += rows.length;
      return { rows: rows as HistoryRow[], truncated: payload.truncated };
    }
  }
}
