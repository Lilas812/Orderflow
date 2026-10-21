import { createMarketQualityState, currentMbpBook, currentQuality, type MarketQualityState, type QualityChannel } from "@workspace/core/quality-timeline";
import { calculateTimeWeightedDepth, type DepthRecord, type DepthQuery } from "@workspace/core/time-weighted-depth";
import type { L2Snapshot, L2PriceUpdate } from "@workspace/core/events";
import { applyJournalInput, eventsIn, type EventJournal } from "./eventJournal";
import { SnapshotStore, type ContinuityEvidence } from "./snapshotStore";
import { anchorFor, liveIndices, storageState, verifyMetadata } from "./storageMigration";
import { insist, sqliteNs, StorageError } from "./sqliteCatalog";
import { SegmentReader } from "./segmentReader";

export class RangeQuery {
  constructor(readonly journal: EventJournal, readonly snapshots = new SnapshotStore(journal)) {}
  query(scopeId: string, channel: QualityChannel, startNs: string, endNs: string, proof?: ContinuityEvidence) {
    const start = sqliteNs(startNs), end = sqliteNs(endNs);
    insist(start < end && ["L1", "L2_MBP", "TRADES"].includes(channel), "INVALID_RANGE", "Half-open increasing UTC range required");
    const c = this.journal.catalog; verifyMetadata(c);
    const cutoff = storageState(c).cutoffNs;
    insist(cutoff === null || start >= BigInt(cutoff), "OUTSIDE_RETENTION", "Exception seeds cannot be displayed as expired history");
    const scope = this.journal.scope(scopeId), anchor = anchorFor(c, scopeId);
    const checkpoint = channel === "L2_MBP" ? this.snapshots.selectForRange(scopeId, startNs) : null;
    let state: MarketQualityState = checkpoint?.state ?? anchor?.state ??
      createMarketQualityState(scope.config, scope.startNs);
    const cursor = BigInt(checkpoint?.auditPosition ?? anchor?.auditPosition ?? "0");
    const selected = liveIndices(c).filter(r => r.scopeId === scopeId && r.channel === channel &&
      BigInt(r.position) > cursor && BigInt(r.eventNs ?? r.receiveNs) < end);
    const reader = new SegmentReader(c);
    try {
      const records = reader.records(selected);
      const audit = liveIndices(c).filter(r => r.scopeId === scopeId && r.channel === channel && BigInt(r.position) > cursor);
      let beyond = false;
      for (const r of audit) {
        if (BigInt(r.eventNs ?? r.receiveNs) >= end) beyond = true;
        else insist(!beyond, "NON_PREFIX_TIME_QUERY", "Cannot invent a replay order for late event timestamps");
      }
      let initialState = state;
      for (const r of records) {
        const result = applyJournalInput(state, r.input);
        insist(result.applied === r.applied && result.outcome === r.outcome, "RANGE_ORDER", "Replay order/application differs");
        state = result.state;
        if (BigInt(r.eventNs ?? r.receiveNs) <= start) initialState = state;
      }
      // Display events also include events covered by a checkpoint exactly at start.
      const visibleIndex = liveIndices(c).filter(r => r.scopeId === scopeId && r.channel === channel &&
        r.eventNs !== null && BigInt(r.eventNs) >= start && BigInt(r.eventNs) < end);
      const visible = reader.records(visibleIndex);
      const lastTime = initialState.lastGoodBook.lastHeader?.exchangeTimeNs;
      const continuity = proof ?? checkpoint?.continuityEvidence;
      const axes = (anchor?.clockAligned ?? true) && records.every(r => r.eventNs === r.receiveNs);
      const atStartValid = currentMbpBook(initialState) && axes && lastTime !== null && lastTime !== undefined &&
        (lastTime === startNs || (continuity?.schemaVersion === 1 && continuity.channel === "L2_MBP" && continuity.scopeId === scopeId &&
          continuity.clockMapping === "IDENTICAL_MOCK_EXCHANGE_RECEIVE_UTC" && continuity.description.trim() &&
          BigInt(continuity.startNs) <= BigInt(lastTime) && BigInt(continuity.endNs) >= start));
      const invalidRange = state.timeline[channel].some(q => q.status !== "VALID" &&
        BigInt(q.startNs) < end && (q.endNs === null || BigInt(q.endNs) > start));
      return {
        status: channel !== "L2_MBP" ? visible.length ? currentQuality(state.timeline, channel).status : "NO DATA" :
          invalidRange ? "NO DATA" :
          atStartValid ? "VALID" : currentQuality(initialState.timeline, channel).status === "VALID" ? "UNOBSERVED" :
            currentQuality(initialState.timeline, channel).status,
        events: visible.flatMap(r => eventsIn(r.input)), records: visible,
        initialState, state, initialBook: atStartValid ? currentMbpBook(initialState) : null,
        checkpointNs: checkpoint?.checkpointNs ?? anchor?.precedingCheckpoint?.checkpointNs ?? null,
        filesRead: [...reader.filesRead], faults: [] as string[],
      };
    } catch (e) {
      if (!(e instanceof StorageError) && !(e instanceof SyntaxError)) throw e;
      return { status: "NO DATA", events: [], records: [], initialState: state, state, initialBook: null,
        checkpointNs: checkpoint?.checkpointNs ?? null, filesRead: [...reader.filesRead],
        faults: [e instanceof Error ? e.message : String(e)] };
    }
  }
  /** Feed unchanged R04 with the actual source snapshot, never a fabricated exchange event. */
  depth(scopeId: string, query: DepthQuery, proof: ContinuityEvidence) {
    const result = this.query(scopeId, "L2_MBP", query.startNs, query.endNs, proof);
    if (proof.schemaVersion !== 1 || proof.scopeId !== scopeId || proof.channel !== "L2_MBP" ||
      proof.clockMapping !== "IDENTICAL_MOCK_EXCHANGE_RECEIVE_UTC" || !proof.description.trim() ||
      sqliteNs(proof.startNs) > sqliteNs(query.startNs) || sqliteNs(proof.endNs) < sqliteNs(query.endNs))
      return { status: "NO DATA" as const, twa: null, reason: "Unverified event/quality time alignment" };
    const c = this.journal.catalog;
    const index = liveIndices(c).filter(d => d.scopeId === scopeId && d.channel === "L2_MBP");
    const source = index.filter(d => d.isSnapshot && d.eventNs !== null && BigInt(d.eventNs) <= BigInt(query.startNs)).at(-1);
    if (result.faults.length || !source) return { status: "NO DATA" as const, twa: null, reason: "Verified source snapshot unavailable" };
    const records = new SegmentReader(c).records(index.filter(d => BigInt(d.position) >= BigInt(source.position) &&
      BigInt(d.eventNs ?? d.receiveNs) < BigInt(query.endNs)));
    if (records.some(r => r.eventNs === null || r.eventNs !== r.receiveNs))
      return { status: "NO DATA" as const, twa: null, reason: "MOCK exchange/receive axes do not match" };
    const events: DepthRecord[] = records.flatMap<DepthRecord>(r => r.input.type === "BATCH" ?
      [{ batch: r.input.events }] as DepthRecord[] : eventsIn(r.input).filter((e): e is L2Snapshot | L2PriceUpdate =>
        e.kind === "L2_SNAPSHOT" || e.kind === "L2_SET_LEVEL" || e.kind === "L2_DELETE_LEVEL"));
    return calculateTimeWeightedDepth({
      events,
      qualityState: result.state, qualityTimeAlignmentEvidence: proof.description,
    }, query);
  }
}
