import type { AnalysisRenderFrame } from "./analysisHub";

/** Provider observations are NOT MarketEvents: no invented expiry, session,
 * sequence, Trade ID, subsecond precision, or completeness certificate. */
export interface LiveObservation {
  readonly origin: "SYNTHETIC_TEST" | "ACTUAL_PROVIDER_RESPONSE";
  readonly generation: number;
  readonly ordinal: number;
  readonly channel: "book" | "ticks";
  readonly timestampNs: string;
  readonly receivedNs: string;
  readonly symbol: "NQ";
  readonly precision: "s";
  readonly contract: null;
  readonly session: null;
  readonly sequence: null;
  readonly tradeId: null;
  readonly levels: readonly { readonly side: "BID" | "ASK"; readonly priceTicks: number; readonly qty: number }[];
  readonly trade: { readonly priceTicks: number; readonly volume: number;
    readonly side: "BUY" | "SELL" | "UNKNOWN" } | null;
}
export interface LiveFrame {
  readonly kind: "LIVE_OBSERVATION_FRAME";
  readonly label: "LIVE HOLD / NOT CONNECTED" | "LIVE / UNVERIFIED" | "SIMULATED / LIVE PIPELINE";
  readonly generation: number;
  readonly revision: number;
  readonly state: "RUNNING" | "HOLD" | "STOPPED";
  readonly reason: string;
  readonly identity: { readonly root: "NQ"; readonly contract: null; readonly session: null };
  readonly quality: {
    readonly revision: number;
    readonly coverage: "UNKNOWN";
    readonly sequence: "UNAVAILABLE";
    readonly exactDedup: "UNAVAILABLE";
    readonly precision: "s";
    readonly snapshotCadence: "APPROX_7HZ_NOT_A_GUARANTEE";
  };
  readonly book: {
    readonly revision: number;
    readonly asOfNs: string | null;
    readonly receivedNs: string | null;
    readonly status: "OBSERVED_SNAPSHOT" | "NO_DATA";
    readonly levels: LiveObservation["levels"];
  };
  /** Last received Trade observation, NOT a total or an exactly deduplicated Trade. */
  readonly lastTrade: (NonNullable<LiveObservation["trade"]> & { readonly timestampNs: string }) | null;
  readonly heatmap: { readonly revision: number; readonly cells: AnalysisRenderFrame["heatmap"]["cells"]; readonly status: "NO_DATA" };
  readonly bubbles: { readonly revision: number; readonly items: AnalysisRenderFrame["bubbles"]["items"]; readonly status: "NO_DATA" };
  readonly delta: { readonly revision: number; readonly items: AnalysisRenderFrame["delta"]["items"]; readonly status: "NO_DATA" };
  readonly accepted: number;
}
export const LIVE_LIMITS = Object.freeze({ inputs: 20_000, bytes: 16 * 1024 * 1024, levels: 800,
  frameBytes: 256 * 1024, staleMs: 2000 });
const REASON = "CONTRACT_SESSION_UNRESOLVED; COVERAGE_UNKNOWN; NO_EXACT_TRADE_DEDUP";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** RAM only, one bounded observation scope per generation. No normalized MOCK
 * adapter and no parallel calculation engine. Existing analytics require a
 * resolved identity + quality evidence; none is manufactured here. */
export function createLiveAnalysisHub(generation: number,
  origin: LiveObservation["origin"], now: () => number) {
  if (!Number.isSafeInteger(generation) || generation < 1 ||
    !["SYNTHETIC_TEST", "ACTUAL_PROVIDER_RESPONSE"].includes(origin)) throw Error("LIVE_SCOPE");
  let revision = 0, accepted = 0, bytes = 0, lastOrdinal = 0, lastClock = -Infinity;
  let state: LiveFrame["state"] = "HOLD", reason = "NOT_CONNECTED; " + REASON;
  let book: LiveObservation | null = null, trade: LiveFrame["lastTrade"] = null;
  let bookAt = -Infinity, lastPoll = -Infinity, published = -1, disposed = false;
  function clock() {
    const t = now();
    if (!Number.isFinite(t) || t < lastClock) throw Error("LIVE_CLOCK");
    lastClock = t; return t;
  }
  function stop(why: string) {
    if (disposed) return;
    if (state !== "STOPPED") { revision++; state = "STOPPED"; reason = why; }
    book = null; trade = null;
  }
  function ingest(input: LiveObservation) {
    if (disposed || state === "STOPPED") return false;
    if (input.generation !== generation) return false; // late old-generation delivery
    const validNs = (s: string) => typeof s === "string" && /^(0|[1-9]\d{0,29})$/.test(s);
    if (input.origin !== origin || input.symbol !== "NQ" || input.precision !== "s" ||
      input.contract !== null || input.session !== null || input.sequence !== null || input.tradeId !== null ||
      !Number.isSafeInteger(input.ordinal) || input.ordinal <= lastOrdinal ||
      !["book", "ticks"].includes(input.channel) || !validNs(input.timestampNs) || !validNs(input.receivedNs) ||
      BigInt(input.timestampNs) % 1_000_000_000n !== 0n || !Array.isArray(input.levels) ||
      input.levels.length > LIVE_LIMITS.levels) { stop("INVALID_OBSERVATION"); return false; }
    if (input.channel === "book" ? input.trade !== null : input.levels.length !== 0 || !input.trade) {
      stop("INVALID_OBSERVATION"); return false;
    }
    const quantity = (n: number) => Number.isSafeInteger(n) && n >= 0;
    const ticks = (n: number) => Number.isSafeInteger(n);
    const seen = new Set<string>();
    for (const level of input.levels) {
      const key = `${level.side}:${level.priceTicks}`;
      if (!["BID", "ASK"].includes(level.side) || !ticks(level.priceTicks) || !quantity(level.qty) ||
        seen.has(key)) { stop("INVALID_OBSERVATION"); return false; }
      seen.add(key);
    }
    if (input.trade && (!ticks(input.trade.priceTicks) || !quantity(input.trade.volume) ||
      !["BUY", "SELL", "UNKNOWN"].includes(input.trade.side))) { stop("INVALID_OBSERVATION"); return false; }
    // Input counts/bytes are finite safety budgets, NOT retention/market-capacity claims.
    const size = JSON.stringify(input).length; // normalized input contains ASCII-only fields
    if (accepted + 1 > LIVE_LIMITS.inputs || bytes + size > LIVE_LIMITS.bytes) {
      stop("LIVE_CAPACITY_EXCEEDED"); return false;
    }
    const t = clock();
    const value = freeze(JSON.parse(JSON.stringify(input)) as LiveObservation);
    if (value.channel === "book") { book = value; bookAt = t; }
    else trade = freeze({ ...value.trade!, timestampNs: value.timestampNs });
    accepted++; bytes += size; lastOrdinal = value.ordinal; revision++;
    state = "RUNNING"; reason = REASON;
    return true;
  }
  function read(): LiveFrame {
    const t = clock();
    if (book && t - bookAt >= LIVE_LIMITS.staleMs) {
      book = null; revision++; reason = "BOOK_STALE; " + REASON;
    }
    return freeze({
      kind: "LIVE_OBSERVATION_FRAME", label: origin === "SYNTHETIC_TEST"
        ? "SIMULATED / LIVE PIPELINE" : accepted === 0 ? "LIVE HOLD / NOT CONNECTED" : "LIVE / UNVERIFIED",
      generation, revision, state, reason, identity: { root: "NQ", contract: null, session: null },
      quality: { revision, coverage: "UNKNOWN", sequence: "UNAVAILABLE", exactDedup: "UNAVAILABLE",
        precision: "s", snapshotCadence: "APPROX_7HZ_NOT_A_GUARANTEE" },
      book: { revision, status: book ? "OBSERVED_SNAPSHOT" : "NO_DATA",
        asOfNs: book?.timestampNs ?? null, receivedNs: book?.receivedNs ?? null, levels: book?.levels ?? [] },
      lastTrade: trade, heatmap: { revision, cells: [], status: "NO_DATA" },
      bubbles: { revision, items: [], status: "NO_DATA" }, delta: { revision, items: [], status: "NO_DATA" }, accepted,
    });
  }
  return Object.freeze({
    ingest, read, stop,
    pollNotice(): LiveFrame | null {
      if (disposed) return null;
      const frame = read(), t = clock();
      if (frame.revision === published || t - lastPoll < 250) return null;
      published = frame.revision; lastPoll = t; return frame;
    },
    dispose() { stop("DISPOSED"); disposed = true; },
  });
}
