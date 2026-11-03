import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { HistoryResponse } from "./client.ts";
import { historyColumns, historyTrades, inWindow } from "./decode.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";

export interface PreparedHistory {
  columns: Column[];
  trades: Trade[];
  inputRows: number;
  counts: Record<string, number>;
  examples: Record<string, unknown[]>;
}
export function inputRows(response: HistoryResponse, start: number, end: number) {
  return response.prepared?.inputRows ?? response.rows.filter(r => inWindow(r, start, end)).length;
}
function applyMetrics(prepared: PreparedHistory, metrics: Metrics) {
  for (const [name, count] of Object.entries(prepared.counts)) metrics.count(name, count);
  for (const [name, examples] of Object.entries(prepared.examples))
    for (const example of examples) if ((metrics.examples[name]?.length ?? 0) < 5) metrics.issue(name, example, 0);
}
export function decodedColumns(response: HistoryResponse, start: number, end: number, metrics: Metrics, symbol?: MarketSymbol) {
  if (!response.prepared) return historyColumns(response.rows, start, end, metrics, symbol);
  applyMetrics(response.prepared, metrics);
  return response.prepared.columns;
}
export function decodedTrades(response: HistoryResponse, start: number, end: number, metrics: Metrics,
  nextSeq: () => number, symbol?: MarketSymbol) {
  if (!response.prepared) return historyTrades(response.rows, start, end, metrics, nextSeq, symbol);
  applyMetrics(response.prepared, metrics);
  // Only the parent owns the receiver sequence. Never use a child's sequence
  // alongside live records, and never deduplicate equal trades.
  for (const trade of response.prepared.trades) trade.seq = nextSeq();
  return response.prepared.trades;
}
