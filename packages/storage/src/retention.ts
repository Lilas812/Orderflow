import { closeSync, existsSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import type { EventJournal } from "./eventJournal";
import { eventsIn } from "./eventJournal";
import { canonical, checksum, decode, insist, sqliteNs, type SqliteCatalog } from "./sqliteCatalog";
import {
  anchors, compactState, indices, liveIndices, putSegment, refreshSnapshotManifest, saveStorageState,
  segments, storageState, verifyMetadata, type RetentionAnchor,
} from "./storageMigration";
import { SegmentReader, segmentDirectory, segmentPath } from "./segmentReader";
import type { BookCheckpoint } from "./snapshotStore";

export const SEVEN_DAYS_NS = 7n * 24n * 60n * 60n * 1_000_000_000n;
export const retentionCutoff = (nowNs: string): string => (sqliteNs(nowNs) - SEVEN_DAYS_NS).toString();
export type RetentionPhase = "after-intent" | "after-unlink" | "before-final-commit";

/** Explicit recovery; does not run from catalog constructor or against guessed files. */
export function resumeRetention(c: SqliteCatalog, fault?: (phase: RetentionPhase) => void) {
  verifyMetadata(c, true);
  const state = storageState(c), plan = state.pendingRetention;
  if (!plan) { verifyMetadata(c); return { deleted: 0, floorPosition: state.floorPosition }; }
  const selected = segments(c).filter(s => plan.segmentIds.includes(s.segmentId));
  insist(selected.length === plan.segmentIds.length && selected.every(s => s.finalizationStatus === "DELETING"),
    "RETENTION_INTENT", "Deletion intent/catalog mismatch");
  for (const s of selected) {
    const path = segmentPath(c, s);
    if (existsSync(path)) {
      new SegmentReader(c).read({ ...s, finalizationStatus: "FINALIZED" });
      unlinkSync(path);
    }
    fault?.("after-unlink");
  }
  if (selected.length) {
    const fd = openSync(segmentDirectory(c), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  c.transaction(() => {
    for (const a of plan.anchors) c.database.prepare("INSERT OR REPLACE INTO r15_anchors VALUES (?,?,?)")
      .run(a.scopeId, canonical(a), checksum(a));
    for (const position of plan.purgedPositions) c.database.prepare("DELETE FROM records WHERE position=?").run(BigInt(position));
    c.database.prepare("DELETE FROM r15_records WHERE position<=?").run(BigInt(plan.floorPosition));
    c.database.exec("DELETE FROM snapshots");
    for (const s of plan.snapshots) c.database.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?)")
      .run(s.scopeId, BigInt(s.atNs), BigInt(s.auditPosition), s.payload, s.checksum);
    for (const s of selected) putSegment(c, { ...s, finalizationStatus: "DELETED" });
    refreshSnapshotManifest(c);
    const { pendingRetention: _finished, ...rest } = state;
    saveStorageState(c, { ...rest, floorPosition: plan.floorPosition, floorHash: plan.floorHash,
      cutoffNs: plan.cutoffNs, retiredPositions: plan.retiredPositions });
    fault?.("before-final-commit");
  });
  verifyMetadata(c);
  return { deleted: selected.length, floorPosition: plan.floorPosition };
}
export class Retention {
  constructor(readonly journal: EventJournal, readonly clock: () => string) {}
  run(fault?: (phase: RetentionPhase) => void) {
    const c = this.journal.catalog;
    if (storageState(c).pendingRetention) return resumeRetention(c, fault);
    this.journal.verify();
    const cutoffNs = retentionCutoff(this.clock()), cutoff = BigInt(cutoffNs);
    const state = storageState(c);
    insist(state.cutoffNs === null || cutoff >= BigInt(state.cutoffNs), "CLOCK_BACKWARDS", "Retention clock cannot move backwards");
    const index = liveIndices(c), all = this.journal.records(), segs = segments(c);
    // Validate every finalized file before planning any deletion, including SQL+file mirrors.
    for (const s of segs.filter(s => s.finalizationStatus === "FINALIZED")) new SegmentReader(c).read(s);
    const activeScopes = new Set(index.filter(r => BigInt(r.eventNs ?? r.receiveNs) >= cutoff).map(r => r.scopeId));
    const protectedSources = new Map([...activeScopes].flatMap(scope => {
      const source = index.filter(r => r.scopeId === scope && r.channel === "L2_MBP" &&
        r.isSnapshot && r.eventNs !== null && BigInt(r.eventNs) <= cutoff).at(-1);
      return source ? [[scope, BigInt(source.position)] as const] : [];
    }));
    const oldPrefixes = new Map<string, typeof all>();
    for (const scopeId of new Set(all.map(r => r.scopeId))) {
      const group = all.filter(r => r.scopeId === scopeId);
      const firstFuture = group.findIndex(r => BigInt(r.eventNs ?? r.receiveNs) >= cutoff || BigInt(r.receiveNs) >= cutoff);
      oldPrefixes.set(scopeId, firstFuture < 0 ? group : group.slice(0, firstFuture));
    }
    const oldPositions = new Set([...oldPrefixes.values()].flat().map(r => r.position));
    const eligible = segs.filter(s => s.finalizationStatus === "FINALIZED" && BigInt(s.endNs) <= cutoff &&
      s.positions.every(p => {
        const d = index.find(r => r.position === p);
        const source = d ? protectedSources.get(d.scopeId) : undefined;
        return d && oldPositions.has(p) && !(source !== undefined && d.channel === "L2_MBP" && BigInt(p) >= source) &&
          BigInt(d.receiveNs) < cutoff && (!d.isQuality ||
          (d.qualityEndNs !== null && BigInt(d.qualityEndNs) <= cutoff));
      }));
    const purgedPositions = eligible.flatMap(s => s.positions);
    const covered = new Set([...(state.retiredPositions ?? []), ...purgedPositions]);
    let floor = BigInt(state.floorPosition);
    for (const d of indices(c)) {
      if (!covered.has(d.position)) break;
      floor = BigInt(d.position);
    }
    const selected = eligible;
    const removed = new Set(purgedPositions);
    const remaining = all.filter(r => !removed.has(r.position));
    const keep = new Set(remaining.flatMap(r => eventsIn(r.input)).map(canonical));
    const previousAnchors = anchors(c);
    const scopes = c.database.prepare("SELECT id FROM scopes ORDER BY id").all() as { id: string }[];
    const newAnchors: RetentionAnchor[] = [];
    const checkpoints = c.database.prepare("SELECT payload FROM snapshots ORDER BY scope_id,at_ns").all() as { payload: string }[];
    const parsed = checkpoints.map(r => decode<BookCheckpoint>(r.payload));
    for (const { id } of scopes) {
      const prefix = oldPrefixes.get(id) ?? [];
      const old = previousAnchors.find(a => a.scopeId === id);
      if (!prefix.length && !old) continue;
      const restored = this.journal.replay(id, prefix);
      const nearest = parsed.filter(s => s.scopeId === id && BigInt(s.checkpointNs) < cutoff).at(-1);
      newAnchors.push({
        schemaVersion: 2, kind: "RETENTION_STATE_NOT_EXCHANGE_SNAPSHOT", scopeId: id,
        auditPosition: BigInt(prefix.at(-1)?.position ?? "0") > BigInt(old?.auditPosition ?? "0") ?
          prefix.at(-1)!.position : old!.auditPosition,
        lastAppliedPosition: [...prefix.filter(r => r.channel === "L2_MBP" && r.applied).map(r => r.position),
          ...(old?.lastAppliedPosition ? [old.lastAppliedPosition] : [])]
          .sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1) ?? null,
        clockAligned: (old?.clockAligned ?? true) && prefix.filter(r => r.channel === "L2_MBP")
          .every(r => r.eventNs !== null && r.eventNs === r.receiveNs),
        state: compactState(restored, cutoffNs, keep),
        precedingCheckpoint: nearest ? { checkpointNs: nearest.checkpointNs, state: compactState(nearest.state, cutoffNs, keep) } :
          old?.precedingCheckpoint ?? null,
      });
    }
    // Keep at most one pre-cutoff normal checkpoint per scope, plus retained ones.
    const preserved = parsed.filter(p => BigInt(p.auditPosition) >
      BigInt(newAnchors.find(a => a.scopeId === p.scopeId)?.auditPosition ?? "0") &&
      (BigInt(p.checkpointNs) >= cutoff || p === parsed.filter(s => s.scopeId === p.scopeId && BigInt(s.checkpointNs) < cutoff).at(-1)))
      .map(p => {
        const value: BookCheckpoint = { ...p, schemaVersion: 2, state: compactState(p.state, cutoffNs, keep) };
        return { scopeId: p.scopeId, atNs: p.checkpointNs, auditPosition: p.auditPosition,
          payload: canonical(value), checksum: checksum(value) };
      });
    const floorHash = indices(c).find(r => BigInt(r.position) === floor)?.checksum ?? state.floorHash;
    const plan = { floorPosition: floor.toString(), floorHash, cutoffNs,
      purgedPositions, retiredPositions: [...covered].filter(p => BigInt(p) > floor),
      segmentIds: selected.map(s => s.segmentId), anchors: newAnchors, snapshots: preserved };
    c.transaction(() => {
      for (const s of selected) putSegment(c, { ...s, finalizationStatus: "DELETING" });
      saveStorageState(c, { ...state, pendingRetention: plan });
    });
    fault?.("after-intent");
    return resumeRetention(c, fault);
  }
}
