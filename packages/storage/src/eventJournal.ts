import {
  validateMarketEvent, validateDataQualityInterval,
  type DataQualityInterval, type MarketEvent,
} from "@workspace/core/events";
import {
  createMarketQualityState, ingestMarketEvent, ingestMbpBatch, markChannelCondition,
  type MarketQualityConfig, type MarketQualityState, type MarketResult, type QualityChannel,
} from "@workspace/core/quality-timeline";
import { canonical, checksum, EMPTY_HASH, insist, sqliteNs, type SqliteCatalog } from "./sqliteCatalog";
import { anchorFor, liveIndices, insertIndex, isV2, saveStorageState, storageState, verifyMetadata } from "./storageMigration";
import { SegmentReader } from "./segmentReader";

export type JournalInput =
  | { type: "EVENT"; event: MarketEvent }
  | { type: "BATCH"; events: readonly MarketEvent[] }
  | { type: "QUALITY_INTERVAL"; interval: DataQualityInterval; observedAtNs: string }
  | { type: "CONDITION"; channel: QualityChannel; atNs: string;
      status: "GAP" | "STALE" | "RESYNCING" | "CLOSED" | "OUTSIDE_DEPTH"; reason: string };
export interface ScopeDefinition { id: string; config: MarketQualityConfig; startNs: string }
export interface JournalRecord {
  position: string; scopeId: string; channel: QualityChannel;
  eventNs: string | null; receiveNs: string; input: JournalInput;
  applied: boolean; outcome: string; reason: string; previousHash: string; checksum: string;
}
interface RecordRow {
  position: bigint; scope_id: string; channel: QualityChannel;
  event_ns: bigint | null; receive_ns: bigint; payload: string; applied: bigint;
  outcome: string; reason: string; previous_hash: string; checksum: string;
}
export const eventsIn = (input: JournalInput): readonly MarketEvent[] =>
  input.type === "EVENT" ? [input.event] : input.type === "BATCH" ? input.events : [];

function onlyKeys(object: object, keys: readonly string[]): void {
  insist(Object.keys(object).every(k => keys.includes(k)), "UNEXPECTED_FIELD",
    "Only normalized event fields are accepted; credentials/arbitrary annotations are not storage inputs");
}
export function inputMetadata(input: JournalInput): {
  channel: QualityChannel; eventNs: string | null; receiveNs: string;
} {
  const events = eventsIn(input);
  if (input.type === "EVENT" || input.type === "BATCH") {
    insist(events.length > 0, "INVALID_BATCH", "Empty batch");
    for (const e of events) {
      validateMarketEvent(e); sqliteNs(e.header.receiveTimeNs);
      onlyKeys(e.header, ["schemaVersion", "environment", "source", "sourceId", "canonicalInstrumentId",
        "channel", "sessionId", "exchangeTimeNs", "receiveTimeNs", "sourceTimePrecision",
        "sequenceScope", "sequence", "eventId", "quality"]);
      const fields = e.kind === "L2_SNAPSHOT" ? ["bids", "asks", "depthScope", "snapshotCoversSequence", "impliedPolicy"] :
        e.kind === "L2_SET_LEVEL" || e.kind === "L2_DELETE_LEVEL" ? ["side", "priceTicks", "qty", "updateBatchId"] :
        e.kind === "L1_QUOTE" ? ["bestBidTick", "bestAskTick", "bidQty", "askQty"] :
          ["tradeId", "originalTradeId", "priceTicks", "qty", "aggressor", "classification"];
      onlyKeys(e, ["kind", "header", ...fields]);
      if (e.header.exchangeTimeNs !== null) sqliteNs(e.header.exchangeTimeNs);
      insist(e.header.channel !== "MBO", "UNSUPPORTED_CHANNEL", "R14 does not implement MBO");
    }
    if (input.type === "BATCH") {
      const first = events[0];
      insist(events.every(e => (e.kind === "L2_SET_LEVEL" || e.kind === "L2_DELETE_LEVEL") &&
        e.header.exchangeTimeNs === first.header.exchangeTimeNs &&
        e.header.receiveTimeNs === first.header.receiveTimeNs), "INVALID_BATCH",
      "Complete MBP batch must have one event/detection time");
    }
    const h = events[events.length - 1].header;
    return { channel: h.channel as QualityChannel, eventNs: h.exchangeTimeNs, receiveNs: h.receiveTimeNs };
  }
  if (input.type === "QUALITY_INTERVAL") {
    const q = validateDataQualityInterval(input.interval);
    sqliteNs(q.startNs); if (q.endNs !== null) sqliteNs(q.endNs); sqliteNs(input.observedAtNs);
    return { channel: q.channel, eventNs: q.startNs, receiveNs: input.observedAtNs };
  }
  insist(input.type === "CONDITION" && ["L1", "L2_MBP", "TRADES"].includes(input.channel) &&
    ["GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"].includes(input.status) &&
    typeof input.reason === "string" && input.reason.trim().length > 0,
  "INVALID_CONDITION", "Invalid local quality notification");
  sqliteNs(input.atNs);
  return { channel: input.channel, eventNs: input.atNs, receiveNs: input.atNs };
}

/** Reuse R02/R03; do not implement another MBP, sequence, or aggregation engine. */
export function applyJournalInput(state: MarketQualityState, input: JournalInput): MarketResult {
  inputMetadata(input);
  for (const event of eventsIn(input)) {
    insist(Object.entries(state.config.identity).every(([k, v]) =>
      event.header[k as keyof typeof event.header] === v), "SCOPE_MISMATCH", "Foreign source/contract/session");
  }
  if (input.type === "BATCH") return ingestMbpBatch(state, input.events);
  if (input.type === "EVENT") {
    const result = ingestMarketEvent(state, input.event);
    if (input.event.kind === "TRADE_CORRECTION" || input.event.kind === "TRADE_CANCEL") {
      return {
        state: markChannelCondition(result.state, "TRADES", "GAP", input.event.header.receiveTimeNs,
          "UNSUPPORTED_REVISION: application deferred until vendor specification is verified"),
        applied: false, outcome: "UNSUPPORTED_REVISION", reason: "Audit only; no correction/cancel application",
      };
    }
    return result;
  }
  if (input.type === "QUALITY_INTERVAL") {
    const q = input.interval;
    // An interval is preserved verbatim, but VALID metadata is not a resync snapshot.
    const invalid = ["GAP", "STALE", "CLOSED", "OUTSIDE_DEPTH"].includes(q.status);
    return {
      state: invalid ? markChannelCondition(state, q.channel,
        q.status as "GAP" | "STALE" | "CLOSED" | "OUTSIDE_DEPTH", input.observedAtNs, q.reason) : state,
      applied: false, outcome: "QUALITY_AUDIT", reason: "Original quality interval preserved; no automatic validity extension",
    };
  }
  return {
    state: markChannelCondition(state, input.channel, input.status, input.atNs, input.reason),
    applied: false, outcome: "CONDITION_RECORDED", reason: input.reason,
  };
}

function recordBody(record: JournalRecord): Omit<JournalRecord, "checksum"> {
  const { checksum: _unused, ...body } = record; return body;
}
function fromRow(row: RecordRow): JournalRecord {
  return {
    position: row.position.toString(), scopeId: row.scope_id, channel: row.channel,
    eventNs: row.event_ns?.toString() ?? null, receiveNs: row.receive_ns.toString(),
    input: JSON.parse(row.payload) as JournalInput, applied: row.applied === 1n,
    outcome: row.outcome, reason: row.reason, previousHash: row.previous_hash, checksum: row.checksum,
  };
}

export class EventJournal {
  constructor(readonly catalog: SqliteCatalog) { this.verify(); }

  register(config: MarketQualityConfig, startNs: string): ScopeDefinition {
    sqliteNs(startNs);
    const copy = JSON.parse(canonical(config)) as MarketQualityConfig;
    insist(copy.identity.environment === "MOCK" && copy.identity.source === "MOCK_DETERMINISTIC",
      "MOCK_ONLY", "R14 stores normalized deterministic MOCK only, not vendor RAW/live data");
    createMarketQualityState(copy, startNs);
    const id = checksum(copy.identity);
    const definition: ScopeDefinition = { id, config: copy, startNs };
    const previous = this.catalog.database.prepare("SELECT payload FROM scopes WHERE id=?").get(id) as
      { payload: string } | undefined;
    if (previous) {
      insist(previous.payload === canonical(definition), "SCOPE_CONFIG_CONFLICT",
        "Same identity cannot change depth, rules, or origin");
      return definition;
    }
    const i = copy.identity;
    insist(["MOCK", "LIVE", "REPLAY_FROM_SAVED_DATA"].includes(i.environment) &&
      ["MOCK_DETERMINISTIC", "VENDOR_UNVERIFIED", "VERIFIED_VENDOR"].includes(i.source) &&
      [i.sourceId, i.canonicalInstrumentId, i.sessionId].every(s => typeof s === "string" && s.trim()),
    "INVALID_SCOPE", "Explicit market identity required");
    this.catalog.transaction(() => this.catalog.database.prepare(
      "INSERT INTO scopes VALUES (?,?,?,?,?,?,?,?,?)").run(
      id, canonical(definition), checksum(definition), i.environment, i.source, i.sourceId,
      i.canonicalInstrumentId, i.sessionId, sqliteNs(startNs)));
    return definition;
  }
  scope(id: string): ScopeDefinition {
    const row = this.catalog.database.prepare("SELECT payload,checksum FROM scopes WHERE id=?").get(id) as
      { payload: string; checksum: string } | undefined;
    insist(row, "UNKNOWN_SCOPE", "Scope is not registered");
    const value = JSON.parse(row.payload) as ScopeDefinition;
    insist(checksum(value) === row.checksum && value.id === id && checksum(value.config.identity) === id,
      "SCOPE_CHECKSUM", "Scope definition is corrupt");
    insist(value.config.identity.environment === "MOCK" && value.config.identity.source === "MOCK_DETERMINISTIC",
      "MOCK_ONLY", "Unsupported non-MOCK persisted scope");
    return value;
  }
  /** Indexed audit search, not a replay/reordering instruction. Half-open UTC range. */
  search(scopeId: string, channel: QualityChannel, startNs: string, endNs: string): JournalRecord[] {
    this.scope(scopeId);
    const start = sqliteNs(startNs), end = sqliteNs(endNs);
    insist(end > start && ["L1", "L2_MBP", "TRADES"].includes(channel),
      "INVALID_QUERY", "Explicit channel and increasing UTC range required");
    if (isV2(this.catalog)) {
      verifyMetadata(this.catalog);
      const cutoff = storageState(this.catalog).cutoffNs;
      insist(cutoff === null || start >= BigInt(cutoff), "OUTSIDE_RETENTION", "Protected seed data is not display history");
      return new SegmentReader(this.catalog).records(liveIndices(this.catalog).filter(d =>
        d.scopeId === scopeId && d.channel === channel && d.eventNs !== null &&
        BigInt(d.eventNs) >= start && BigInt(d.eventNs) < end));
    }
    return this.catalog.database.prepare(
      "SELECT * FROM records WHERE scope_id=? AND channel=? AND event_ns>=? AND event_ns<? ORDER BY event_ns,position",
    ).safeIntegers().all(scopeId, channel, start, end).map(row => fromRow(row as RecordRow));
  }
  records(scopeId?: string): JournalRecord[] {
    if (isV2(this.catalog)) {
      verifyMetadata(this.catalog);
      return new SegmentReader(this.catalog).records(liveIndices(this.catalog).filter(d => !scopeId || d.scopeId === scopeId));
    }
    const stmt = this.catalog.database.prepare(`SELECT * FROM records${scopeId ? " WHERE scope_id=?" : ""} ORDER BY position`).safeIntegers();
    return (scopeId ? stmt.all(scopeId) : stmt.all()).map(r => fromRow(r as RecordRow));
  }
  replay(scopeId: string, records = this.records(scopeId), initial?: MarketQualityState): MarketQualityState {
    const scope = this.scope(scopeId);
    let state = initial ?? anchorFor(this.catalog, scopeId)?.state ?? createMarketQualityState(scope.config, scope.startNs);
    const cursor = initial ? 0n : BigInt(anchorFor(this.catalog, scopeId)?.auditPosition ?? "0");
    for (const r of records) {
      if (BigInt(r.position) <= cursor) continue; // protected pre-cutoff R04 inputs are not applied twice
      insist(r.scopeId === scopeId, "SCOPE_MISMATCH", "Mixed journal scopes");
      const result = applyJournalInput(state, r.input);
      insist(result.applied === r.applied && result.outcome === r.outcome && result.reason === r.reason,
        "APPLICATION_MISMATCH", "Stored application decision differs from R02/R03");
      state = result.state;
    }
    return state;
  }
  /** No file writes here. This is received/pending, explicitly NOT committed. */
  stage(scopeId: string, inputs: readonly JournalInput[]) {
    this.scope(scopeId);
    insist(inputs.length > 0, "EMPTY_TRANSACTION", "At least one input required");
    const pending = JSON.parse(canonical(inputs)) as JournalInput[];
    for (const input of pending) inputMetadata(input);
    if (isV2(this.catalog)) {
      const cutoff = storageState(this.catalog).cutoffNs;
      if (cutoff !== null) for (const input of pending) {
        const m = inputMetadata(input);
        insist(BigInt(m.eventNs ?? m.receiveNs) >= BigInt(cutoff), "EXPIRED_INPUT", "Do not resurrect expired history");
      }
    }
    let committed = false;
    return {
      receivedCount: pending.reduce((n, i) => n + eventsIn(i).length, 0),
      get committed() { return committed; },
      commit: (beforeCommit?: () => void) => {
        insist(!committed, "ALREADY_COMMITTED", "Pending transaction already committed");
        const result = this.commit(scopeId, pending, beforeCommit);
        committed = true;
        return result;
      },
    };
  }
  append(scopeId: string, events: readonly MarketEvent[]) {
    return this.stage(scopeId, events.map(event => ({ type: "EVENT", event }))).commit();
  }
  private commit(scopeId: string, inputs: readonly JournalInput[], beforeCommit?: () => void) {
    return this.catalog.transaction(() => {
      let state = this.replay(scopeId);
      const manifest = this.catalog.manifest();
      let position = BigInt(manifest.recordCount);
      let head = manifest.head;
      for (const input of inputs) {
        const metadata = inputMetadata(input);
        const result = applyJournalInput(state, input);
        const record: JournalRecord = {
          position: (++position).toString(), scopeId, ...metadata, input,
          applied: result.applied, outcome: result.outcome, reason: result.reason,
          previousHash: head, checksum: "",
        };
        record.checksum = checksum(recordBody(record)); head = record.checksum;
        this.catalog.database.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
          position, scopeId, record.channel,
          record.eventNs === null ? null : sqliteNs(record.eventNs), sqliteNs(record.receiveNs),
          canonical(input), record.applied ? 1 : 0, record.outcome, record.reason,
          record.previousHash, record.checksum);
        if (isV2(this.catalog)) insertIndex(this.catalog, record);
        state = result.state;
      }
      this.catalog.setManifest({ ...manifest, recordCount: position.toString(), head });
      if (isV2(this.catalog)) saveStorageState(this.catalog, storageState(this.catalog));
      beforeCommit?.(); // diagnostics fault injection; exceptions roll back everything
      return { committed: true as const, lastPosition: position.toString(), checksum: head };
    });
  }
  stats(scopeId?: string) {
    const records = this.records(scopeId);
    return {
      auditRecords: records.length,
      eventsReceived: records.reduce((n, r) => n + eventsIn(r.input).length, 0),
      eventsApplied: records.reduce((n, r) => n + (r.applied ? eventsIn(r.input).length : 0), 0),
      lastPosition: records.at(-1)?.position ?? "0",
      checksum: records.at(-1)?.checksum ?? EMPTY_HASH,
    };
  }
  verify(): void {
    const scopes = this.catalog.database.prepare("SELECT * FROM scopes").safeIntegers().all() as
      { id: string; environment: string; source: string; source_id: string; instrument: string;
        session: string; start_ns: bigint }[];
    for (const row of scopes) {
      const s = this.scope(row.id); const i = s.config.identity;
      insist(row.environment === i.environment && row.source === i.source && row.source_id === i.sourceId &&
        row.instrument === i.canonicalInstrumentId && row.session === i.sessionId &&
        row.start_ns === sqliteNs(s.startNs), "SCOPE_CHECKSUM", "Scope index differs from original definition");
    }
    const retained = isV2(this.catalog) ? storageState(this.catalog) : null;
    if (retained) verifyMetadata(this.catalog);
    let previous = retained?.floorHash ?? EMPTY_HASH; let position = BigInt(retained?.floorPosition ?? "0");
    for (const record of this.records()) {
      insist((retained || (record.position === (++position).toString() && record.previousHash === previous)) &&
        checksum(recordBody(record)) === record.checksum, "EVENT_CHECKSUM", "Journal chain/count/content corrupt");
      insist(canonical(inputMetadata(record.input)) === canonical({
        channel: record.channel, eventNs: record.eventNs, receiveNs: record.receiveNs,
      }), "EVENT_INDEX", "Event time/channel indexes do not match original input");
      previous = record.checksum;
    }
    const manifest = this.catalog.manifest();
    insist(retained || (position.toString() === manifest.recordCount && previous === manifest.head),
      "EVENT_MANIFEST", "Missing or uncommitted journal records");
    for (const row of scopes) this.replay(row.id);
    const snapshots = this.catalog.database.prepare("SELECT scope_id,at_ns,audit_position,payload,checksum FROM snapshots ORDER BY scope_id,at_ns")
      .safeIntegers().all() as { scope_id: string; at_ns: bigint; audit_position: bigint; payload: string; checksum: string }[];
    for (const row of snapshots) {
      const value = JSON.parse(row.payload) as { scopeId: string; checkpointNs: string; auditPosition: string };
      insist(checksum(value) === row.checksum && value.scopeId === row.scope_id &&
        sqliteNs(value.checkpointNs) === row.at_ns && BigInt(value.auditPosition) === row.audit_position,
      "SNAPSHOT_CHECKSUM", "Snapshot checksum/index corrupt");
    }
    insist(BigInt(snapshots.length).toString() === manifest.snapshotCount &&
      checksum(snapshots.map(r => [r.scope_id, r.at_ns.toString(), r.checksum])) === manifest.snapshotHead,
    "SNAPSHOT_MANIFEST", "Missing/corrupt checkpoint records");
  }
}
