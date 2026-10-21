import {
  restingQuantity, validateMarketEvent,
  type BookSide, type DepthScope, type EventHeader,
  type L2PriceUpdate, type L2Snapshot, type RestingQuantity,
} from "./events";
import { ticksToPrice } from "./instrument";

export type LevelObservation =
  | { readonly status: "KNOWN"; readonly qty: RestingQuantity }
  | { readonly status: "NOT_INITIALIZED" | "UNKNOWN" | "OUTSIDE_DEPTH"; readonly qty: null };

/**
 * Omission semantics are external evidence, not implied by FULL/PRICE_RANGE.
 * ZERO must be explicitly attested by the caller; R02 tests use MOCK evidence only.
 */
export type SnapshotSemantics =
  | { readonly unlistedLevels: "UNKNOWN" }
  | { readonly unlistedLevels: "ZERO"; readonly evidence: string };

type Identity = Pick<EventHeader,
  "canonicalInstrumentId" | "environment" | "source" | "sourceId" | "sessionId">;
type Bounds = { readonly minTick: number; readonly maxTick: number } | null;

export interface MbpBook {
  readonly status: "NOT_INITIALIZED" | "READY";
  readonly identity: Identity | null;
  readonly bids: ReadonlyMap<number, RestingQuantity>;
  readonly asks: ReadonlyMap<number, RestingQuantity>;
  readonly depthScope: DepthScope | null;
  readonly semantics: SnapshotSemantics;
  /** TOP_N: conservative side-specific envelopes established by this snapshot. */
  readonly bidBounds: Bounds;
  readonly askBounds: Bounds;
  readonly lastHeader: EventHeader | null;
  readonly snapshotCoversSequence: string | null;
  readonly impliedPolicy: L2Snapshot["impliedPolicy"] | null;
}

const identityFields = [
  "canonicalInstrumentId", "environment", "source", "sourceId", "sessionId",
] as const;

function requireBook(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

export function createMbpBook(): MbpBook {
  return {
    status: "NOT_INITIALIZED", identity: null,
    bids: new Map(), asks: new Map(), depthScope: null,
    semantics: { unlistedLevels: "UNKNOWN" }, bidBounds: null, askBounds: null,
    lastHeader: null, snapshotCoversSequence: null, impliedPolicy: null,
  };
}

function identity(header: EventHeader): Identity {
  return {
    canonicalInstrumentId: header.canonicalInstrumentId, environment: header.environment,
    source: header.source, sourceId: header.sourceId, sessionId: header.sessionId,
  };
}

function checkIdentity(book: MbpBook, header: EventHeader): void {
  requireBook(header.quality === "VALID", "Only explicitly VALID L2 events may alter the book");
  if (book.identity) {
    for (const key of identityFields) {
      requireBook(book.identity[key] === header[key], `Book identity mismatch: ${key}`);
    }
  }
}

function bounds(levels: readonly { readonly priceTicks: number }[]): Bounds {
  if (levels.length === 0) return null;
  let minTick = levels[0].priceTicks;
  let maxTick = minTick;
  for (const level of levels) {
    minTick = Math.min(minTick, level.priceTicks);
    maxTick = Math.max(maxTick, level.priceTicks);
  }
  return { minTick, maxTick };
}

function covered(book: MbpBook, side: BookSide, priceTicks: number): boolean {
  const scope = book.depthScope;
  if (!scope) return false;
  if (scope.type === "FULL") return true;
  if (scope.type === "PRICE_RANGE") {
    return priceTicks >= scope.minTick && priceTicks <= scope.maxTick;
  }
  const limit = side === "BID" ? book.bidBounds : book.askBounds;
  return limit !== null && priceTicks >= limit.minTick && priceTicks <= limit.maxTick;
}

function checkSide(side: BookSide): void {
  requireBook(side === "BID" || side === "ASK", "Side must be BID or ASK");
}

export function readMbpLevel(book: MbpBook, side: BookSide, priceTicks: number): LevelObservation {
  checkSide(side);
  ticksToPrice(priceTicks);
  if (book.status === "NOT_INITIALIZED") return { status: "NOT_INITIALIZED", qty: null };
  if (!covered(book, side, priceTicks)) return { status: "OUTSIDE_DEPTH", qty: null };
  const qty = (side === "BID" ? book.bids : book.asks).get(priceTicks);
  if (qty !== undefined) return { status: "KNOWN", qty };
  return book.semantics.unlistedLevels === "ZERO"
    ? { status: "KNOWN", qty: restingQuantity(0) }
    : { status: "UNKNOWN", qty: null };
}

function fromSnapshot(book: MbpBook, event: L2Snapshot, semantics: SnapshotSemantics): MbpBook {
  checkIdentity(book, event.header);
  requireBook(semantics.unlistedLevels === "ZERO" || semantics.unlistedLevels === "UNKNOWN",
    "Snapshot omission semantics must be explicit");
  if (semantics.unlistedLevels === "ZERO") {
    requireBook(typeof semantics.evidence === "string" && semantics.evidence.trim().length > 0,
      "ZERO omission semantics require evidence");
  }
  const next: MbpBook = {
    status: "READY", identity: identity(event.header),
    bids: new Map(), asks: new Map(), depthScope: { ...event.depthScope },
    semantics: { ...semantics }, bidBounds: bounds(event.bids), askBounds: bounds(event.asks),
    lastHeader: { ...event.header }, snapshotCoversSequence: event.snapshotCoversSequence,
    impliedPolicy: event.impliedPolicy,
  };
  const bids = new Map<number, RestingQuantity>();
  const asks = new Map<number, RestingQuantity>();
  for (const [side, levels, target] of [
    ["BID", event.bids, bids], ["ASK", event.asks, asks],
  ] as const) {
    if (event.depthScope.type === "TOP_N") {
      requireBook(levels.length <= event.depthScope.n, "Snapshot exceeds TOP_N per-side limit");
    }
    for (const level of levels) {
      requireBook(covered(next, side, level.priceTicks), "Snapshot level outside declared scope");
      requireBook(!target.has(level.priceTicks), "Duplicate snapshot price on the same side");
      target.set(level.priceTicks, level.qty);
    }
  }
  return { ...next, bids, asks };
}

/**
 * A single, unbatched event. Returns a fresh state; never mutates prior state/raw.
 * A new snapshot replaces both sides, never merges stale levels into the new book.
 */
export function applyMbpEvent(
  book: MbpBook,
  input: unknown,
  semantics: SnapshotSemantics = { unlistedLevels: "UNKNOWN" },
): MbpBook {
  const event = validateMarketEvent(input);
  if (event.kind === "L2_SNAPSHOT") return fromSnapshot(book, event, semantics);
  requireBook(event.kind === "L2_SET_LEVEL" || event.kind === "L2_DELETE_LEVEL",
    "MBP accepts only L2 snapshot/SET/DELETE, not trades or L1");
  requireBook(event.updateBatchId === undefined, "Tagged updates require a complete applyMbpBatch call");
  return applyMbpBatch(book, [event]);
}

/**
 * Caller supplies ONE complete batch in source order (transport completion is
 * vendor-specific and is not inferred here). Untagged ordered transactions are
 * also allowed. No partial state escapes if any event is invalid.
 */
export function applyMbpBatch(book: MbpBook, inputs: readonly unknown[]): MbpBook {
  requireBook(Array.isArray(inputs) && inputs.length > 0, "Batch must be a nonempty array");
  requireBook(book.status === "READY", "A valid snapshot is required before updates");
  const updates: L2PriceUpdate[] = inputs.map((input) => {
    const event = validateMarketEvent(input);
    requireBook(event.kind === "L2_SET_LEVEL" || event.kind === "L2_DELETE_LEVEL",
      "An MBP update batch may contain only SET/DELETE");
    checkIdentity(book, event.header);
    requireBook(covered(book, event.side, event.priceTicks),
      "Update outside snapshot scope requires a new snapshot");
    return event;
  });
  const batchId = updates[0].updateBatchId;
  for (const event of updates) {
    requireBook(event.updateBatchId === batchId, "Mixed or partially tagged logical batches");
    if (batchId !== undefined) {
      requireBook(event.header.exchangeTimeNs === updates[0].header.exchangeTimeNs,
        "One logical batch must have one exchange event time");
    }
  }
  const bids = new Map(book.bids);
  const asks = new Map(book.asks);
  for (const event of updates) {
    const target = event.side === "BID" ? bids : asks;
    // SET is absolute replacement; DELETE retains an explicit, known zero.
    target.set(event.priceTicks, event.qty);
  }
  return { ...book, bids, asks, lastHeader: { ...updates[updates.length - 1].header } };
}
