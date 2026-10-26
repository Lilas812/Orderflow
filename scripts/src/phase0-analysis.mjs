// Phase 0 diagnostics only. No inferred timestamp conversion or deduplication.
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const quantile = (q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return { count: sorted.length, min: sorted[0], max: sorted.at(-1),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
}

export function histogram(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function perSecondStats(buckets, count, observedUs) {
  const seconds = Math.max(1, Math.ceil(observedUs / 1_000_000));
  const values = Array.from({ length: seconds }, (_, i) => buckets.get(i) ?? 0);
  return { ...distribution(values), histogram: histogram(values),
    averagePerActualSecond: observedUs > 0 ? count * 1_000_000 / observedUs : null,
    note: "Buckets are open-relative seconds, include zeros; final bucket may be partial." };
}

export function timestampCandidates(ts, recvUs) {
  const numeric = Number(ts);
  if (!Number.isFinite(numeric)) return null;
  return { digits: String(ts).replace(/[-.]/g, "").length,
    seconds: recvUs - numeric * 1_000_000,
    milliseconds: recvUs - numeric * 1_000,
    microseconds: recvUs - numeric,
    nanoseconds: recvUs - numeric / 1_000 };
}

export function inspectBook(book) {
  const counts = {};
  const examples = {};
  const add = (kind, value) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    (examples[kind] ??= []).length < 3 && examples[kind].push(value);
  };
  const sums = {};
  for (const side of ["bids", "asks"]) {
    const levels = book[side];
    if (!Array.isArray(levels)) { add("missingSide", { side }); continue; }
    if (!levels.length) add("emptySide", { side });
    const seen = new Set();
    let previous;
    let sum = 0;
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      if (!Array.isArray(level) || level.length < 2 ||
          !Number.isFinite(level[0]) || !Number.isFinite(level[1])) {
        add("malformedLevel", { side, index: i }); continue;
      }
      const [price, size] = level;
      const ticks = price * 4;
      if (!Number.isSafeInteger(ticks)) add("offTick", { side, index: i, price });
      if (size === 0) add("zeroSize", { side, index: i, price });
      if (size < 0) add("negativeSize", { side, index: i, price, size });
      if (seen.has(ticks)) add("duplicatePrice", { side, index: i, price });
      if (previous !== undefined &&
          (side === "bids" ? ticks > previous : ticks < previous))
        add("wrongOrder", { side, index: i, price, previousTicks: previous });
      // Gaps are observations, not proof of missing data: empty prices can be legitimate.
      if (previous !== undefined && Math.abs(ticks - previous) > 1)
        add("priceGap", { side, index: i, price, previousTicks: previous,
          ticksApart: Math.abs(ticks - previous) });
      previous = ticks;
      seen.add(ticks);
      sum += size;
    }
    sums[side] = sum;
  }
  const bid = book.bids?.[0]?.[0];
  const ask = book.asks?.[0]?.[0];
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid * 4 >= ask * 4)
    add("lockedOrCrossed", { bid, ask });
  const total = sums.bids + sums.asks;
  const bestBidSize = book.bids?.[0]?.[1];
  const bestAskSize = book.asks?.[0]?.[1];
  const bestTotal = bestBidSize + bestAskSize;
  const candidates = {
    bestSignedRatio: bestTotal > 0 ? (bestBidSize - bestAskSize) / bestTotal : null,
    signedRatio: total > 0 ? (sums.bids - sums.asks) / total : null,
    bidFraction: total > 0 ? sums.bids / total : null,
    bidAskRatio: sums.asks > 0 ? sums.bids / sums.asks : null,
  };
  return { counts, examples, sums, imbalance: book.imbalance, candidates };
}

export function halfOpen(rows, start, end) {
  return rows.filter((row) => row.ts >= start * 1_000_000 && row.ts < end * 1_000_000);
}

export function splitWindow(start, end) {
  if (end - start <= 1) throw new Error("Truncated one-second window cannot be subdivided safely.");
  const middle = start + Math.floor((end - start) / 2);
  return [[start, middle], [middle, end]];
}

const rowKey = (row) => JSON.stringify([
  row.ts, row.side, row.level, row.price, row.size, row.flag,
]);

function multiset(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function compareOccurrences(left, right) {
  const a = multiset(left);
  const b = multiset(right);
  let leftOnly = 0;
  let rightOnly = 0;
  for (const [key, count] of a) leftOnly += Math.max(0, count - (b.get(key) ?? 0));
  for (const [key, count] of b) rightOnly += Math.max(0, count - (a.get(key) ?? 0));
  return { leftRows: left.length, rightRows: right.length, leftOnly, rightOnly,
    equalWithMultiplicity: leftOnly === 0 && rightOnly === 0 };
}

function complete800(rows) {
  const identities = new Set(rows.map((r) => `${r.side}:${r.level}`));
  return rows.length === 800 && identities.size === 800 &&
    ["bid", "ask"].every((side) =>
      Array.from({ length: 400 }, (_, i) => identities.has(`${side}:${i + 1}`)).every(Boolean));
}

export function analyzeHistory(rows) {
  const groups = new Map();
  let outOfOrder = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i && row.ts < rows[i - 1].ts) outOfOrder++;
    if (!groups.has(row.ts)) groups.set(row.ts, []);
    groups.get(row.ts).push(row);
  }
  const doubles = [];
  for (const [ts, group] of groups) {
    if (group.length !== 1600) continue;
    const first = group.slice(0, 800);
    const second = group.slice(800);
    const comparison = compareOccurrences(first, second);
    doubles.push({ ts, firstComplete800: complete800(first), secondComplete800: complete800(second),
      ...comparison, sameOrderedRows: first.every((r, i) => rowKey(r) === rowKey(second[i])),
      firstFlags: histogram(first.map((r) => r.flag)), secondFlags: histogram(second.map((r) => r.flag)),
      firstOrder: first.slice(0, 2), secondOrder: second.slice(0, 2),
      differingExample: first.find((r, i) => rowKey(r) !== rowKey(second[i])) ?? null,
      newer: "Unknown: response order and flag alone do not prove exchange chronology." });
  }
  const timestamps = [...groups.keys()].sort((a, b) => a - b);
  const gaps = timestamps.slice(1).map((ts, i) => ts - timestamps[i]);
  return { rows: rows.length, groups: groups.size, firstTs: timestamps[0] ?? null,
    lastTs: timestamps.at(-1) ?? null, outOfOrder,
    rowsPerTimestamp: histogram([...groups.values()].map((g) => g.length)),
    interTimestampGapUs: distribution(gaps), doubles,
    offTick: rows.filter((r) => !Number.isSafeInteger(r.price * 4)).length,
    zeroSize: rows.filter((r) => r.size === 0).length };
}
