import { validateMarketEvent, type Trade } from "./events";
import { tradeScopeKey, type TradeScope } from "./tradeStore";

export interface VolumeProfileOptions {
  /** Required finite cap; zero explicitly permits an empty profile only. */
  readonly maxPriceLevels: number;
}
export interface VolumeProfileTotals {
  readonly buyVolume: bigint;
  readonly sellVolume: bigint;
  readonly unknownVolume: bigint;
  readonly totalVolume: bigint;
  readonly tradeCount: number;
}
export interface VolumeProfileLevel extends VolumeProfileTotals {
  readonly priceTicks: number;
}
export interface VolumeProfileValueArea {
  readonly ratioNumerator: 7n;
  readonly ratioDenominator: 10n;
  readonly valTick: number | null;
  readonly vahTick: number | null;
  readonly includedVolume: bigint;
}
export interface VolumeProfileSnapshot {
  readonly scope: Readonly<TradeScope>;
  /** These are accepted, observed executions, not proof of complete market coverage. */
  readonly volumeBasis: "ACCEPTED_OBSERVED_TRADES";
  readonly marketCompleteness: "NOT_ASSERTED";
  readonly totals: VolumeProfileTotals;
  readonly levels: readonly VolumeProfileLevel[];
  readonly pocTick: number | null;
  readonly valueArea: VolumeProfileValueArea;
  readonly maxPriceLevels: number;
  readonly priceLevels: number;
  readonly unknownTimePrecision: boolean;
  readonly nonValidTradeQuality: boolean;
  readonly classificationComplete: boolean;
}

export class VolumeProfileCapacityError extends RangeError {
  constructor(readonly maximum: number, readonly attempted: number) {
    super("Finite MOCK budget exceeded: volumeProfilePriceLevels");
  }
}

const empty = (): VolumeProfileTotals => Object.freeze({
  buyVolume: 0n, sellVolume: 0n, unknownVolume: 0n, totalVolume: 0n, tradeCount: 0,
});
function add(previous: VolumeProfileTotals, trade: Trade): VolumeProfileTotals {
  if (!Number.isSafeInteger(previous.tradeCount + 1)) throw new RangeError("VP trade count exhausted");
  const qty = BigInt(trade.qty);
  return Object.freeze({
    buyVolume: previous.buyVolume + (trade.aggressor === "BUY" ? qty : 0n),
    sellVolume: previous.sellVolume + (trade.aggressor === "SELL" ? qty : 0n),
    unknownVolume: previous.unknownVolume + (trade.aggressor === "UNKNOWN" ? qty : 0n),
    totalVolume: previous.totalVolume + qty,
    tradeCount: previous.tradeCount + 1,
  });
}

/** Read-only O(P) exploration of sorted levels; absent ticks are observed-profile zeros,
 * not evidence of market completeness. No arrays/loops proportional to tick span.
 */
function valueArea(
  levels: readonly VolumeProfileLevel[], total: bigint, poc: number | null,
): VolumeProfileValueArea {
  const result = (low: bigint | null, high: bigint | null, volume: bigint): VolumeProfileValueArea =>
    Object.freeze({
      ratioNumerator: 7n, ratioDenominator: 10n,
      valTick: low === null ? null : Number(low),
      vahTick: high === null ? null : Number(high), includedVolume: volume,
    });
  if (total === 0n) return result(null, null, 0n);
  const positive = levels.filter(level => level.totalVolume > 0n);
  const center = positive.findIndex(level => level.priceTicks === poc);
  if (center < 0) throw new Error("VP Value Area: positive total requires an existing POC");
  const minimum = BigInt(levels[0].priceTicks), maximum = BigInt(levels[levels.length - 1].priceTicks);
  let low = BigInt(positive[center].priceTicks), high = low;
  let volume = positive[center].totalVolume, below = center - 1, above = center + 1;
  while (volume * 10n < total * 7n) {
    const hasBelow = low > minimum, hasAbove = high < maximum;
    if (!hasBelow && !hasAbove) throw new Error("VP Value Area: inconsistent total/levels");
    const lowerTick = below >= 0 ? BigInt(positive[below].priceTicks) : null;
    const upperTick = above < positive.length ? BigInt(positive[above].priceTicks) : null;
    const lowerVolume = lowerTick === low - 1n ? positive[below].totalVolume : 0n;
    const upperVolume = upperTick === high + 1n ? positive[above].totalVolume : 0n;
    if (lowerVolume === 0n && upperVolume === 0n) {
      // Skip only simultaneous zero/zero steps, or one-sided zeros at the domain edge.
      // Stop before the nearest positive neighbor (or at an edge), then compare again.
      const lowerZeros = lowerTick === null ? low - minimum : low - lowerTick - 1n;
      const upperZeros = upperTick === null ? maximum - high : upperTick - high - 1n;
      const steps = !hasBelow ? upperZeros : !hasAbove ? lowerZeros :
        lowerZeros < upperZeros ? lowerZeros : upperZeros;
      if (steps <= 0n) throw new Error("VP Value Area: zero expansion cannot make progress");
      if (hasBelow) low -= steps;
      if (hasAbove) high += steps;
    } else {
      // Decide both directions BEFORE changing volume; an equal pair is indivisible.
      const takeBelow = hasBelow && (!hasAbove || lowerVolume >= upperVolume);
      const takeAbove = hasAbove && (!hasBelow || upperVolume >= lowerVolume);
      if (takeBelow) { low--; volume += lowerVolume; if (lowerVolume > 0n) below--; }
      if (takeAbove) { high++; volume += upperVolume; if (upperVolume > 0n) above++; }
    }
  }
  return result(low, high, volume);
}

/**
 * Internal hub accumulator, NOT an independent Trade acceptance/dedup API.
 * The hub alone supplies final accepted Trades. No Trade IDs or history are retained.
 * Mutable state is private; candidate preparation touches one level, never copies the Map.
 */
export class VolumeProfileAccumulator {
  readonly #scope: Readonly<TradeScope>;
  readonly #key: string;
  readonly #maximum: number;
  readonly #levels = new Map<number, Readonly<VolumeProfileLevel>>();
  #totals = empty();
  #poc: number | null = null;
  #pocVolume = 0n;
  #generation = 0;
  #unknownTime = false;
  #nonValidQuality = false;
  #classificationComplete = true;

  constructor(scope: TradeScope, options: VolumeProfileOptions) {
    if (scope.environment !== "MOCK" || scope.source !== "MOCK_DETERMINISTIC") {
      throw new TypeError("VP only accepts the finite MOCK analysis scope");
    }
    if (!Number.isSafeInteger(options?.maxPriceLevels) || options.maxPriceLevels < 0) {
      throw new TypeError("VP requires a finite nonnegative maxPriceLevels");
    }
    this.#scope = Object.freeze({
      environment: scope.environment, source: scope.source, sourceId: scope.sourceId,
      canonicalInstrumentId: scope.canonicalInstrumentId, sessionId: scope.sessionId,
    });
    this.#key = tradeScopeKey(scope);
    this.#maximum = options.maxPriceLevels;
  }

  /** All validation/allocation happens before the hub publishes its candidates. */
  prepareAccepted(trade: Trade): () => void {
    validateMarketEvent(trade);
    if (trade.kind !== "TRADE" || trade.header.exchangeTimeNs === null ||
        tradeScopeKey(trade.header) !== this.#key) {
      throw new TypeError("VP requires an accepted normal Trade of the exact scope with event time");
    }
    const previous = this.#levels.get(trade.priceTicks);
    if (!previous && this.#levels.size >= this.#maximum) {
      throw new VolumeProfileCapacityError(this.#maximum, this.#levels.size + 1);
    }
    const level = Object.freeze({ ...add(previous ?? empty(), trade), priceTicks: trade.priceTicks });
    const totals = add(this.#totals, trade);
    const generation = this.#generation;
    const replacePoc = level.totalVolume > 0n &&
      (level.totalVolume > this.#pocVolume ||
       level.totalVolume === this.#pocVolume && (this.#poc === null || trade.priceTicks < this.#poc));
    const unknownTime = this.#unknownTime || trade.header.sourceTimePrecision === "unknown";
    const nonValidQuality = this.#nonValidQuality || trade.header.quality !== "VALID";
    const classificationComplete = this.#classificationComplete &&
      trade.aggressor !== "UNKNOWN" && trade.classification !== "UNKNOWN";
    return () => {
      if (this.#generation !== generation) throw new Error("Stale or already applied VP candidate");
      // The only potentially allocating write precedes non-throwing field publication.
      this.#levels.set(level.priceTicks, level);
      this.#totals = totals;
      if (replacePoc) { this.#poc = level.priceTicks; this.#pocVolume = level.totalVolume; }
      this.#unknownTime = unknownTime;
      this.#nonValidQuality = nonValidQuality;
      this.#classificationComplete = classificationComplete;
      this.#generation++;
    };
  }

  read(): VolumeProfileSnapshot {
    const levels = Object.freeze([...this.#levels.values()]
      .sort((a, b) => a.priceTicks - b.priceTicks).map(level => Object.freeze({ ...level })));
    return Object.freeze({
      scope: Object.freeze({ ...this.#scope }),
      volumeBasis: "ACCEPTED_OBSERVED_TRADES", marketCompleteness: "NOT_ASSERTED",
      totals: Object.freeze({ ...this.#totals }),
      levels,
      pocTick: this.#poc, maxPriceLevels: this.#maximum, priceLevels: this.#levels.size,
      valueArea: valueArea(levels, this.#totals.totalVolume, this.#poc),
      unknownTimePrecision: this.#unknownTime, nonValidTradeQuality: this.#nonValidQuality,
      classificationComplete: this.#classificationComplete,
    });
  }
}
