import type { FootprintBar } from "./model.ts";

export interface PriceRow { price: number; buy: number; sell: number; undirected: number; }
export interface GroupedRows { rows: PriceRow[]; poc: number; }

/** Display-only. No input mutation, no side inference, no merging between contracts/bars. */
export function groupPriceRows(bar: FootprintBar, ticks: number): GroupedRows {
  const rows: PriceRow[] = [];
  let poc = 0, max = -1;
  for (let i = 0; i < bar.prices.length; i++) {
    const price = Math.floor(bar.prices[i]! / ticks) * ticks;
    let r = rows.at(-1);
    if (!r || r.price !== price) { r = { price, buy: 0, sell: 0, undirected: 0 }; rows.push(r); }
    r.buy += bar.buy[i]!; r.sell += bar.sell[i]!; r.undirected += bar.undirected?.[i] ?? 0;
  }
  for (const r of rows) {
    const total = r.buy + r.sell + r.undirected;
    if (total >= max) { poc = r.price; max = total; }
  }
  return { rows, poc };
}
