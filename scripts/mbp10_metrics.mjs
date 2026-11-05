import { Distribution, bbo, counter, count, rates } from "./gc_board_metrics.mjs";
const UNDEFINED_PRICE = 9223372036854775807n;
export function decodeMbp10(record) {
  if (record.length !== 368 || record[1] !== 10) throw Error("not_dbn_mbp10_368");
  const sides = { bids: [], asks: [] };
  for (let level = 0; level < 10; level++) {
    const offset = 48 + level * 32;
    for (const [side, priceOffset, sizeOffset] of [["bids", 0, 16], ["asks", 8, 20]]) {
      const px = record.readBigInt64LE(offset + priceOffset), size = record.readUInt32LE(offset + sizeOffset);
      if (px === UNDEFINED_PRICE || !size) continue;
      if (px <= 0n || px % 100000000n) throw Error("gc_mbp10_off_tick");
      const ticks = Number(px / 100000000n);
      if (!Number.isSafeInteger(ticks)) throw Error("unsafe_gc_price");
      sides[side].push(ticks, size);
    }
  }
  return { ...sides, instrumentId: record.readUInt32LE(4), tsEvent: record.readBigUInt64LE(8),
    tsRecv: record.readBigUInt64LE(32), flags: record[30], sequence: record.readUInt32LE(44) };
}

/** Each MBP row already contains full top10. Ties use stable file order, no float timestamps. */
export class SecondSampler {
  frames = new Map(); bad = new Set(); records = 0; withLastFlag = 0; emptyOrCrossedRows = 0;
  constructor(start, end) { this.start = start; this.end = end; }
  accept(row) {
    this.records++; if (row.flags & 128) this.withLastFlag++;
    const ns = row.flags & 32 ? row.tsRecv : row.tsEvent;
    const second = Number(ns / 1000000000n);
    if (second < this.start || second >= this.end) return;
    if (row.flags & 4) {
      this.bad.add(second); return;
    }
    const valid = !!(row.bids.length && row.asks.length && row.bids[0] < row.asks[0]);
    if (!valid) this.emptyOrCrossedRows++;
    for (const side of ["bids", "asks"])
      for (let i = 2; i < row[side].length; i += 2)
        if (side === "bids" ? row[side][i] >= row[side][i - 2] : row[side][i] <= row[side][i - 2])
          throw Error("unsorted_mbp10_prices");
    const previous = this.frames.get(second);
    if (!previous || ns >= previous.ns) this.frames.set(second, { ns, row, valid });
  }
  finish() {
    const rows = new Map();
    let state = null, carriedSeconds = 0, finalRowsWithoutLastFlag = 0;
    for (let second = this.start; second < this.end; second++) {
      const frame = this.frames.get(second);
      if (this.bad.has(second)) { state = null; continue; }
      if (frame) {
        state = frame.valid ? frame.row : null;
        if (state && !(state.flags & 128)) finalRowsWithoutLastFlag++;
      } else if (state) carriedSeconds++;
      if (state) rows.set(second, state);
    }
    return { rows, records: this.records, withLastFlag: this.withLastFlag,
      observedSeconds: this.frames.size, carriedSeconds, badSeconds: this.bad.size,
      emptyOrCrossedRows: this.emptyOrCrossedRows, finalRowsWithoutLastFlag };
  }
}

class Quantity {
  n = 0; equal = 0; abs = 0; signed = 0; reference = 0;
  errors = new Distribution(); ratios = new Distribution();
  add(value, reference) {
    const difference = value - reference;
    this.n++; this.equal += Number(difference === 0); this.abs += Math.abs(difference);
    this.signed += difference; this.reference += reference; this.errors.add(difference);
    if (reference > 0) this.ratios.add(value / reference);
  }
  result() {
    return { n: this.n, equal: this.equal, exactRate: this.n ? this.equal / this.n : null,
      meanAbsoluteError: this.n ? this.abs / this.n : null, meanSignedError: this.n ? this.signed / this.n : null,
      meanReference: this.n ? this.reference / this.n : null,
      meanComparison: this.n ? (this.reference + this.signed) / this.n : null,
      relativeL1: this.reference ? this.abs / this.reference : null,
      signedError: this.errors.result(), comparisonDivReference: this.ratios.result() };
  }
}
export class BookMetrics {
  quote = counter(); referenceLevels = 0; comparisonLevels = 0; commonLevels = 0; rankEqual = 0;
  priceExactSeconds = 0; fullExactSeconds = 0;
  atReference = new Quantity(); commonPrice = new Quantity(); union = new Quantity(); total = new Quantity();
  add(comparison, reference) {
    const match = bbo(comparison, reference);
    if (!match) return;
    count(this.quote, match);
    let priceExact = true, fullExact = true, totalA = 0, totalB = 0;
    for (const side of ["bids", "asks"]) {
      const aa = comparison[side].slice(0, 20), bb = reference[side].slice(0, 20);
      const a = new Map(), b = new Map();
      for (let i = 0; i < aa.length; i += 2) { a.set(aa[i], aa[i+1]); totalA += aa[i+1]; }
      for (let i = 0; i < bb.length; i += 2) { b.set(bb[i], bb[i+1]); totalB += bb[i+1]; }
      this.comparisonLevels += a.size; this.referenceLevels += b.size;
      if (aa.length !== bb.length) priceExact = fullExact = false;
      for (let i = 0; i < bb.length; i += 2) {
        const p = bb[i], q = bb[i+1], value = a.get(p) ?? 0;
        this.atReference.add(value, q);
        if (a.has(p)) { this.commonLevels++; this.commonPrice.add(value, q); }
        if (aa[i] === p) this.rankEqual++; else priceExact = fullExact = false;
        if (aa[i+1] !== q) fullExact = false;
      }
      for (const p of new Set([...a.keys(), ...b.keys()])) this.union.add(a.get(p) ?? 0, b.get(p) ?? 0);
    }
    this.priceExactSeconds += Number(priceExact); this.fullExactSeconds += Number(fullExact);
    this.total.add(totalA, totalB);
  }
  result() {
    const n = this.quote.seconds;
    return { bbo: rates(this.quote), prices: { referenceLevels: this.referenceLevels,
      comparisonLevels: this.comparisonLevels, commonLevels: this.commonLevels,
      overlapDivReference: this.referenceLevels ? this.commonLevels / this.referenceLevels : null,
      rankMatchRate: this.referenceLevels ? this.rankEqual / this.referenceLevels : null,
      jaccard: this.commonLevels / (this.referenceLevels + this.comparisonLevels - this.commonLevels),
      allPricesExactRate: n ? this.priceExactSeconds / n : null },
      allPricesAndSizesExactRate: n ? this.fullExactSeconds / n : null,
      sizeAtReferencePriceMissingAsZero: this.atReference.result(), sizeAtCommonTop10Prices: this.commonPrice.result(),
      sizeAtUnionTop10PricesMissingAsZero: this.union.result(), top10BothSidesTotal: this.total.result() };
  }
}
