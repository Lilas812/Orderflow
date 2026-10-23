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
export interface VolumeProfileSnapshot {
  readonly scope: Readonly<TradeScope>;
  /** These are accepted, observed executions, not proof of complete market coverage. */
  readonly volumeBasis: "ACCEPTED_OBSERVED_TRADES";
  readonly marketCompleteness: "NOT_ASSERTED";
  readonly totals: VolumeProfileTotals;
  readonly levels: readonly VolumeProfileLevel[];
  readonly pocTick: number | null;
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
    return Object.freeze({
      scope: Object.freeze({ ...this.#scope }),
      volumeBasis: "ACCEPTED_OBSERVED_TRADES", marketCompleteness: "NOT_ASSERTED",
      totals: Object.freeze({ ...this.#totals }),
      levels: Object.freeze([...this.#levels.values()]
        .sort((a, b) => a.priceTicks - b.priceTicks).map(level => Object.freeze({ ...level }))),
      pocTick: this.#poc, maxPriceLevels: this.#maximum, priceLevels: this.#levels.size,
      unknownTimePrecision: this.#unknownTime, nonValidTradeQuality: this.#nonValidQuality,
      classificationComplete: this.#classificationComplete,
    });
  }
}
