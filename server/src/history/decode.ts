import { ColumnAggregator } from "../aggregate/columns.ts";
import { normalizeBook, normalizePrice, normalizeTime } from "../ingest/normalize.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Trade } from "../types.ts";
import type { Column } from "../aggregate/columns.ts";

export type HistoryRow = Record<string, unknown>;
export const inWindow = (row: HistoryRow, start: number, end: number) =>
  typeof row.ts === "number" && row.ts >= start * 1_000_000 && row.ts < end * 1_000_000;

export function historyColumns(rows: HistoryRow[], start: number, end: number, metrics: Metrics): Column[] {
  const result: Column[] = [];
  const aggregate = new ColumnAggregator(c => result.push(c));
  let previous: number | undefined;
  let group: HistoryRow[] = [];
  const finish = () => {
    if (!group.length) return;
    const ts = group[0].ts;
    let selected = group;
    if (group.length === 1600) {
      const first = group.slice(0, 800), second = group.slice(800);
      const fields = ["ts", "side", "level", "price", "size", "flag"];
      const same = first.every((a, i) => fields.every(k => a[k] === second[i][k]));
      metrics.issue(same ? "historyDoubledSame" : "historyDoubledDifferent",
        { tsUs: ts, first: first[0], second: second[0] });
      selected = second;
    } else if (group.length !== 800) {
      metrics.issue("invalidMessage", { type: "history_book", reason: "snapshot_row_count", rows: group.length, ts });
      metrics.count("rejectedBook"); return;
    }
    const sides = (side: string) => selected.filter(r => r.side === side).sort((a, b) => Number(a.level) - Number(b.level));
    const bids = sides("bid"), asks = sides("ask");
    if (bids.length !== 400 || asks.length !== 400
      || [...bids, ...asks].some((r, i) => r.level !== i % 400 + 1 || r.flag !== 0)) {
      metrics.issue("invalidMessage", { type: "history_book", reason: "snapshot_structure", ts });
      metrics.count("rejectedBook"); return;
    }
    const book = normalizeBook({
      symbol: "NQ", ts, bids: bids.map(r => [r.price, r.size]), asks: asks.map(r => [r.price, r.size]),
    }, Number(ts), "history", metrics, (tsUs) => {
      if (previous !== undefined && tsUs < previous) {
        metrics.issue("timestampRollback", { type: "history_book", tsUs, previous }); return true;
      }
      return false;
    });
    if (book) { previous = book.tsUs; metrics.count("acceptedBook"); aggregate.accept(book); }
  };
  for (const row of rows) {
    if (!inWindow(row, start, end)) continue;
    if (group.length && row.ts !== group[0].ts) { finish(); group = []; }
    group.push(row);
  }
  finish(); aggregate.finish();
  return result;
}

export function historyTrades(
  rows: HistoryRow[], start: number, end: number, metrics: Metrics, nextSequence: () => number,
): Trade[] {
  const trades: Trade[] = [];
  let previous: number | undefined;
  for (const row of rows) {
    if (!inWindow(row, start, end)) continue;
    const tsUs = normalizeTime(row.ts, "history");
    const price = normalizePrice(row.price);
    let invalid = false;
    if (price === null) { metrics.issue("offTick", { type: "history_tick", price: row.price }); invalid = true; }
    if (tsUs === null || typeof row.size !== "number" || !Number.isFinite(row.size) || row.size <= 0
      || (row.side !== "buy" && row.side !== "sell")) {
      metrics.issue("invalidMessage", { type: "history_tick", reason: "invalid_fields" }); invalid = true;
    }
    if (tsUs !== null && previous !== undefined && tsUs < previous) {
      metrics.issue("timestampRollback", { type: "history_tick", tsUs, previous }); invalid = true;
    }
    if (invalid) { metrics.count("rejectedTrade"); continue; }
    previous = tsUs!;
    trades.push({ tsUs: tsUs!, recvUs: tsUs!, seq: nextSequence(), price: price!,
      size: row.size as number, side: row.side as Trade["side"] });
    metrics.count("acceptedTrade");
  }
  return trades;
}
