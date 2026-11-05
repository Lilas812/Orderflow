/** Pure offline statistics. Prices are integer ticks; quantity ratios are dimensionless. */
export class Distribution {
  counts = new Map();
  n = 0;
  add(value) {
    if (!Number.isFinite(value)) throw Error("nonfinite_statistic");
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1); this.n++;
  }
  result() {
    if (!this.n) return { n: 0, quantiles: null };
    const rows = [...this.counts].sort(([a], [b]) => a - b);
    const quantiles = {};
    for (const p of [0, .01, .05, .25, .5, .75, .95, .99, 1]) {
      const target = Math.max(1, Math.ceil(p * this.n)); let seen = 0;
      for (const [v, count] of rows) if ((seen += count) >= target) { quantiles[p] = v; break; }
    }
    return { n: this.n, quantiles };
  }
}

export function bbo(a, b) {
  if (!a?.bids.length || !a?.asks.length || !b?.bids.length || !b?.asks.length) return null;
  const bid = a.bids[0] === b.bids[0], ask = a.asks[0] === b.asks[0];
  return { bid, ask, both: bid && ask };
}
export function packed(column) {
  return { tsSec: column.tsSec, source: column.source,
    bids: Float64Array.from(column.bids.flatMap(x => [x.price, x.size])),
    asks: Float64Array.from(column.asks.flatMap(x => [x.price, x.size])) };
}
export function overlap(a, b, n) {
  const ap = new Set(), bp = new Set(), other = new Map();
  for (let i = 0; i < Math.min(a.length, n * 2); i += 2) ap.add(a[i]);
  for (let i = 0; i < Math.min(b.length, n * 2); i += 2) bp.add(b[i]);
  for (let i = 0; i < b.length; i += 2) other.set(b[i], b[i + 1]);
  const shared = [...ap].filter(p => bp.has(p)).length;
  const ratios = [];
  for (let i = 0; i < Math.min(a.length, n * 2); i += 2)
    ratios.push({ value: (other.get(a[i]) ?? 0) / a[i + 1], sharedPrice: other.has(a[i]) });
  return { a: ap.size, b: bp.size, shared, union: ap.size + bp.size - shared, ratios };
}
export function counter() { return { seconds: 0, bid: 0, ask: 0, both: 0 }; }
export function count(row, match) {
  if (!match) return;
  row.seconds++; row.bid += Number(match.bid); row.ask += Number(match.ask); row.both += Number(match.both);
}
export function rates(row) {
  return { ...row, bidRate: row.seconds ? row.bid / row.seconds : null,
    askRate: row.seconds ? row.ask / row.seconds : null, bothRate: row.seconds ? row.both / row.seconds : null };
}
