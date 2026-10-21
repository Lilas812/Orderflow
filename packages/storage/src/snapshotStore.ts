import { currentMbpBook, currentQuality, type MarketQualityState } from "@workspace/core/quality-timeline";
import type { MbpBook } from "@workspace/core/mbp-book";
import { createMarketQualityState } from "@workspace/core/quality-timeline";
import { EventJournal, eventsIn, type JournalRecord } from "./eventJournal";
import { canonical, checksum, decode, insist, sqliteNs } from "./sqliteCatalog";
import { anchorFor, compactState, isV2, storageState, verifyMetadata } from "./storageMigration";

export interface ContinuityEvidence {
  schemaVersion: 1;
  scopeId: string;
  channel: "L2_MBP";
  startNs: string;
  endNs: string;
  clockMapping: "IDENTICAL_MOCK_EXCHANGE_RECEIVE_UTC";
  description: string;
}
export interface BookCheckpoint {
  schemaVersion: 1 | 2;
  kind: "LOCAL_MBP_CHECKPOINT_NOT_EXCHANGE_SNAPSHOT";
  scopeId: string;
  channel: "L2_MBP";
  checkpointNs: string;
  lastMarketEventNs: string;
  auditPosition: string;
  lastAppliedPosition: string;
  lastAppliedEventId: string;
  lastAppliedSequence: string | null;
  state: MarketQualityState;
  continuityEvidence: ContinuityEvidence | null;
}
export interface RecoveredBook {
  state: MarketQualityState;
  book: MbpBook | null;
  status: string;
  atNs: string;
  auditPosition: string;
  checkpointNs: string | null;
  replayedPositions: readonly string[];
}
function isL2(record: JournalRecord): boolean { return record.channel === "L2_MBP"; }

export class SnapshotStore {
  constructor(readonly journal: EventJournal) { this.verify(); }

  private prefix(scopeId: string, atNs: string): JournalRecord[] {
    const at = sqliteNs(atNs);
    const records = this.journal.records(scopeId).filter(r =>
      BigInt(r.position) > BigInt(anchorFor(this.journal.catalog, scopeId)?.auditPosition ?? "0"));
    const firstFuture = records.findIndex(r => BigInt(r.eventNs ?? r.receiveNs) > at);
    if (firstFuture < 0) return records;
    insist(!records.slice(firstFuture + 1).some(r => BigInt(r.eventNs ?? r.receiveNs) <= at),
      "NON_PREFIX_TIME_QUERY", "Event-time query would reorder received audit history; no invented replay order");
    return records.slice(0, firstFuture);
  }
  private evidenceValid(scopeId: string, fromNs: string, atNs: string, proof?: ContinuityEvidence | null): boolean {
    if (!proof) return false;
    const scope = this.journal.scope(scopeId);
    return proof.schemaVersion === 1 && proof.scopeId === scopeId && proof.channel === "L2_MBP" &&
      scope.config.identity.environment === "MOCK" &&
      proof.clockMapping === "IDENTICAL_MOCK_EXCHANGE_RECEIVE_UTC" &&
      typeof proof.description === "string" && proof.description.trim().length > 0 &&
      sqliteNs(proof.startNs) <= sqliteNs(fromNs) && sqliteNs(proof.endNs) >= sqliteNs(atNs) &&
      sqliteNs(proof.startNs) <= sqliteNs(proof.endNs);
  }
  private publishable(
    scopeId: string, state: MarketQualityState, records: readonly JournalRecord[],
    atNs: string, proof?: ContinuityEvidence | null,
  ): { book: MbpBook | null; status: string } {
    const book = currentMbpBook(state);
    if (!book) return { book: null, status: currentQuality(state.timeline, "L2_MBP").status };
    const last = book.lastHeader?.exchangeTimeNs;
    // R03 detection time is not silently interpreted as event time.
    const identicalAxes = (anchorFor(this.journal.catalog, scopeId)?.clockAligned ?? true) &&
      records.filter(isL2).every(r => r.eventNs !== null && r.eventNs === r.receiveNs);
    if (last === null || last === undefined || !identicalAxes) return { book: null, status: "UNVERIFIED_TIME_ALIGNMENT" };
    if (BigInt(last) > sqliteNs(atNs)) return { book: null, status: "FUTURE_STATE" };
    if (last !== atNs && !this.evidenceValid(scopeId, last, atNs, proof)) {
      return { book: null, status: "UNOBSERVED" };
    }
    return { book, status: "VALID" };
  }
  private readCheckpoint(scopeId: string, atNs: string): BookCheckpoint | null {
    const row = this.journal.catalog.database.prepare(
      "SELECT payload,checksum FROM snapshots WHERE scope_id=? AND at_ns<=? ORDER BY at_ns DESC LIMIT 1",
    ).get(scopeId, sqliteNs(atNs)) as { payload: string; checksum: string } | undefined;
    if (!row) return null;
    const checkpoint = decode<BookCheckpoint>(row.payload);
    if (BigInt(checkpoint.auditPosition) < BigInt(anchorFor(this.journal.catalog, scopeId)?.auditPosition ?? "0")) return null;
    insist(checksum(checkpoint) === row.checksum, "SNAPSHOT_CHECKSUM", "Checkpoint checksum invalid");
    this.validateCheckpoint(checkpoint, scopeId);
    return checkpoint;
  }
  private validateCheckpoint(c: BookCheckpoint, scopeId: string): void {
    insist((c.schemaVersion === 1 || (c.schemaVersion === 2 && isV2(this.journal.catalog))) && c.kind === "LOCAL_MBP_CHECKPOINT_NOT_EXCHANGE_SNAPSHOT" &&
      c.scopeId === scopeId && c.channel === "L2_MBP", "SNAPSHOT_SCHEMA", "Unknown or mismatched checkpoint");
    const scope = this.journal.scope(scopeId);
    insist(canonical(c.state.config) === canonical(scope.config), "SNAPSHOT_SCOPE", "Checkpoint contract/depth/config differs");
    const seed = anchorFor(this.journal.catalog, scopeId);
    const covered = this.journal.records(scopeId).filter(r => BigInt(r.position) <= BigInt(c.auditPosition) &&
      BigInt(r.position) > BigInt(seed?.auditPosition ?? "0"));
    insist((covered.at(-1)?.position ?? seed?.auditPosition ?? "0") === c.auditPosition &&
      covered.every(r => BigInt(r.eventNs ?? r.receiveNs) <= sqliteNs(c.checkpointNs)),
    "SNAPSHOT_CURSOR", "Audit cursor differs from covered input prefix");
    const lastApplied = covered.filter(r => r.applied && isL2(r)).at(-1);
    insist((lastApplied?.position ?? seed?.lastAppliedPosition) === c.lastAppliedPosition, "SNAPSHOT_CURSOR", "Missing applied L2 cursor");
    const header = lastApplied ? eventsIn(lastApplied.input).at(-1)?.header : seed?.state.lastGoodBook.lastHeader;
    insist(header && header.eventId === c.lastAppliedEventId &&
      header.sequence === c.lastAppliedSequence &&
      header.exchangeTimeNs === c.lastMarketEventNs, "SNAPSHOT_CURSOR", "Applied event identity/sequence/time differs");
    // Independent verification replay, never applied ON TOP OF the checkpoint.
    const verified = this.journal.replay(scopeId, covered);
    const cutoff = isV2(this.journal.catalog) ? storageState(this.journal.catalog).cutoffNs : null;
    insist(canonical(cutoff === null ? verified : compactState(verified, cutoff)) === canonical(c.state),
      "SNAPSHOT_STATE", "Saved MBP/guard/quality differs from verified input prefix");
    const p = this.publishable(scopeId, c.state, covered, c.checkpointNs, c.continuityEvidence);
    insist(p.book && p.status === "VALID", "INVALID_SNAPSHOT", "Checkpoint is GAP/RESYNCING/unobserved, not a valid board");
  }
  recover(scopeId: string, atNs: string, proof?: ContinuityEvidence): RecoveredBook {
    this.journal.verify();
    const scope = this.journal.scope(scopeId);
    const cutoff = isV2(this.journal.catalog) ? storageState(this.journal.catalog).cutoffNs : null;
    insist(cutoff === null || sqliteNs(atNs) >= BigInt(cutoff), "OUTSIDE_RETENTION", "No display of expired seed history");
    const prefix = this.prefix(scopeId, atNs);
    const checkpoint = this.readCheckpoint(scopeId, atNs);
    const cursor = BigInt(checkpoint?.auditPosition ?? "0");
    const suffix = prefix.filter(r => BigInt(r.position) > cursor);
    const state = this.journal.replay(scopeId, suffix, checkpoint?.state ??
      anchorFor(this.journal.catalog, scopeId)?.state ?? createMarketQualityState(scope.config, scope.startNs));
    const effectiveProof = proof ?? checkpoint?.continuityEvidence;
    const p = this.publishable(scopeId, state, prefix, atNs, effectiveProof);
    return {
      ...p, state, atNs, auditPosition: prefix.at(-1)?.position ?? anchorFor(this.journal.catalog, scopeId)?.auditPosition ?? "0",
      checkpointNs: checkpoint?.checkpointNs ?? null,
      replayedPositions: suffix.map(r => r.position),
    };
  }
  /** Certified at creation/migration; bounded reads do not replay unrelated chunks. */
  selectForRange(scopeId: string, atNs: string): BookCheckpoint | null {
    insist(isV2(this.journal.catalog), "MIGRATION_REQUIRED", "Range reads require v2");
    verifyMetadata(this.journal.catalog);
    const rows = this.journal.catalog.database.prepare("SELECT scope_id,at_ns,checksum FROM snapshots ORDER BY scope_id,at_ns")
      .safeIntegers().all() as { scope_id: string; at_ns: bigint; checksum: string }[];
    const manifest = this.journal.catalog.manifest();
    insist(rows.length.toString() === manifest.snapshotCount &&
      checksum(rows.map(r => [r.scope_id, r.at_ns.toString(), r.checksum])) === manifest.snapshotHead,
    "SNAPSHOT_MANIFEST", "Range checkpoint index changed");
    const row = this.journal.catalog.database.prepare(
      "SELECT payload,checksum FROM snapshots WHERE scope_id=? AND at_ns<=? ORDER BY at_ns DESC LIMIT 1",
    ).get(scopeId, sqliteNs(atNs)) as { payload: string; checksum: string } | undefined;
    if (!row) return null;
    const c = decode<BookCheckpoint>(row.payload);
    if (BigInt(c.auditPosition) < BigInt(anchorFor(this.journal.catalog, scopeId)?.auditPosition ?? "0")) return null;
    insist(checksum(c) === row.checksum && c.scopeId === scopeId &&
      canonical(c.state.config) === canonical(this.journal.scope(scopeId).config) &&
      (c.schemaVersion === 1 || c.schemaVersion === 2), "SNAPSHOT_CHECKSUM", "Invalid range checkpoint");
    return c;
  }
  capture(scopeId: string, checkpointNs: string, proof?: ContinuityEvidence) {
    const recovered = this.recover(scopeId, checkpointNs, proof);
    if (!recovered.book) return { captured: false as const, status: recovered.status, checkpoint: null };
    const prefix = this.prefix(scopeId, checkpointNs);
    const lastApplied = prefix.filter(r => r.applied && isL2(r)).at(-1);
    const header = recovered.book.lastHeader;
    const lastPosition = lastApplied?.position ?? anchorFor(this.journal.catalog, scopeId)?.lastAppliedPosition;
    insist(lastPosition && header?.exchangeTimeNs !== null && header !== null,
      "SNAPSHOT_CURSOR", "No applied L2 event");
    const checkpoint: BookCheckpoint = {
      schemaVersion: isV2(this.journal.catalog) ? 2 : 1, kind: "LOCAL_MBP_CHECKPOINT_NOT_EXCHANGE_SNAPSHOT",
      scopeId, channel: "L2_MBP", checkpointNs,
      lastMarketEventNs: header.exchangeTimeNs,
      auditPosition: recovered.auditPosition, lastAppliedPosition: lastPosition,
      lastAppliedEventId: header.eventId, lastAppliedSequence: header.sequence,
      state: isV2(this.journal.catalog) && storageState(this.journal.catalog).cutoffNs !== null ?
        compactState(recovered.state, storageState(this.journal.catalog).cutoffNs!) : recovered.state,
      continuityEvidence: proof ?? null,
    };
    this.validateCheckpoint(checkpoint, scopeId);
    this.journal.catalog.transaction(() => {
      const db = this.journal.catalog.database;
      const existing = db.prepare("SELECT payload FROM snapshots WHERE scope_id=? AND at_ns=?")
        .get(scopeId, sqliteNs(checkpointNs)) as { payload: string } | undefined;
      if (existing) {
        insist(existing.payload === canonical(checkpoint), "SNAPSHOT_CONFLICT", "Checkpoint already exists with different contents");
        return;
      }
      db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?)").run(
        scopeId, sqliteNs(checkpointNs), BigInt(checkpoint.auditPosition), canonical(checkpoint), checksum(checkpoint));
      const rows = db.prepare("SELECT scope_id,at_ns,checksum FROM snapshots ORDER BY scope_id,at_ns").safeIntegers()
        .all() as { scope_id: string; at_ns: bigint; checksum: string }[];
      const manifest = this.journal.catalog.manifest();
      this.journal.catalog.setManifest({
        ...manifest, snapshotCount: rows.length.toString(),
        snapshotHead: checksum(rows.map(r => [r.scope_id, r.at_ns.toString(), r.checksum])),
      });
    });
    return { captured: true as const, status: "VALID", checkpoint };
  }
  /** Caller supplies a fixed UTC origin; no wall-clock timer or service is created. */
  captureEvery60Seconds(scopeId: string, originNs: string, throughNs: string, proof?: ContinuityEvidence) {
    const through = sqliteNs(throughNs);
    const results: ReturnType<SnapshotStore["capture"]>[] = [];
    for (let t = sqliteNs(originNs) + 60_000_000_000n; t <= through; t += 60_000_000_000n) {
      results.push(this.capture(scopeId, t.toString(), proof));
    }
    return results;
  }
  verify(): void {
    this.journal.verify();
    const rows = this.journal.catalog.database.prepare("SELECT payload FROM snapshots").all() as { payload: string }[];
    for (const row of rows) {
      const c = decode<BookCheckpoint>(row.payload);
      this.validateCheckpoint(c, c.scopeId);
    }
  }
}
