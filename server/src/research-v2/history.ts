import { sessionStartSec } from "../vp/state.ts";
import { digest, type HistoryRow } from "./engine.ts";
export type SharedRow = Omit<HistoryRow, "carried" | "carried_close" | "carried_from_pre_window">;
export function sharedRow(h: HistoryRow): SharedRow {
  const { carried: _c, carried_close: _p, carried_from_pre_window: _w, ...base } = h; return base;
}
export function reconstructHistory(rows: SharedRow[], seed: { history_initial_price_used: number; history_initial_price_ticks: number | null }) {
  let carry = seed.history_initial_price_used ? seed.history_initial_price_ticks : null, active = !!seed.history_initial_price_used;
  return rows.map(r => {
    const good = !!(r.coverage_mask && r.contract_mask);
    if (!good) { carry = null; active = false; } else if (r.count) { carry = r.close; active = false; }
    return { ...r, carried_close: carry, carried: +(good && !r.count && carry !== null),
      carried_from_pre_window: +(good && !r.count && carry !== null && active) };
  });
}
export function seriesId(inputVersion: string, symbol: string, contract: string, at: number) {
  return digest([inputVersion, symbol, contract, sessionStartSec(at / 1e6) * 1e6]);
}
export function historyRanges(inputVersion: string, symbol: string, contract: string, from: number, to: number) {
  const out = [];
  while (from < to) {
    const session = sessionStartSec(from / 1e6), next = sessionStartSec(session + 27 * 3600) * 1e6, end = Math.min(next, to);
    out.push({ series_id: seriesId(inputVersion, symbol, contract, from), from_us: String(from), to_us: String(end) }); from = end;
  }
  return out;
}
