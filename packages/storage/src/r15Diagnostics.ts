import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { F03_GAP_TWA, F04_TRADES } from "@workspace/fixtures";
import { SqliteCatalog, checksum, insist } from "./sqliteCatalog";
import { EventJournal } from "./eventJournal";
import { SnapshotStore } from "./snapshotStore";
import { EIGHT_DAYS, DAY, at, day, F01_BOOK, mockConfig, mockEvidence } from "./r15Fixtures";
import { migrateToV2, segments, storageState } from "./storageMigration";
import { SegmentWriter } from "./segmentWriter";
import { RangeQuery } from "./rangeQuery";
import { Retention, resumeRetention } from "./retention";

const marker = "R15 dedicated MOCK diagnostic database";
export function diagnosticDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r15-diag-"));
  writeFileSync(join(dir, "owned.txt"), marker, { mode: 0o600 }); return dir;
}
function checkDirectory(dir: string): void {
  insist(basename(dir).startsWith("orderflow-r15-diag-") &&
    readFileSync(join(dir, "owned.txt"), "utf8") === marker, "DIAGNOSTIC_PATH", "Dedicated diagnostic directory required");
}
const bytes = (p: string): number => existsSync(p) ? statSync(p).size : 0;
function sizes(c: SqliteCatalog) {
  const chunks = segments(c).filter(s => s.finalizationStatus === "FINALIZED").reduce((n,s) => n+s.bytes, 0);
  return { db: bytes(c.filename), wal: bytes(`${c.filename}-wal`), chunks };
}
function open(dir: string, name: "numeric" | "retention") {
  checkDirectory(dir);
  const catalog = new SqliteCatalog(join(dir, `${name}.sqlite`));
  // Explicit intent recovery on the dedicated DB, not an automatic catalog side effect.
  if (catalog.database.pragma("user_version", { simple: true }) === 2 && storageState(catalog).pendingRetention) resumeRetention(catalog);
  return { catalog, journal: new EventJournal(catalog) };
}
function numericResults(journal: EventJournal) {
  const q = new RangeQuery(journal);
  const f01 = journal.scope(checksum(mockConfig(F01_BOOK.events[0]).identity));
  const f03 = journal.scope(checksum(mockConfig(F03_GAP_TWA.events[0]).identity));
  const t0 = performance.now();
  const depth = (start: number, end: number) => q.depth(f01.id, {
    side: "BID", priceTicks: 80000, width: 1, startNs: at(start), endNs: at(end),
  }, mockEvidence(f01, at(10)));
  const twa = depth(0,10).twa, bins = [0,2,4,6,8].map(t => depth(t,t+2).twa);
  const gap = q.depth(f03.id, { side: "BID", priceTicks: 80000, width: 1, startNs: at(8), endNs: at(12) },
    { ...mockEvidence(f03, at(12)), description: F03_GAP_TWA.timeAlignmentEvidence });
  const readMs = performance.now()-t0;
  insist(twa === 38 && JSON.stringify(bins) === "[60,40,30,60,0]" &&
    "coverageRatio" in gap && gap.coverageRatio === 0.5 && gap.partialTWA === 35 && gap.status === "NO DATA",
  "DIAGNOSTIC_NUMBERS", "Independent fixture oracle failed");
  return { twa, bins, gap: { status: gap.status, coverageRatio: gap.coverageRatio, partialTWA: gap.partialTWA }, readMs };
}
export function saveDiagnostic(dir: string) {
  const { catalog, journal } = open(dir, "numeric");
  const t0 = performance.now();
  const f01 = journal.register(mockConfig(F01_BOOK.events[0]), at(0));
  const f03 = journal.register(mockConfig(F03_GAP_TWA.events[0]), at(8));
  const f04 = journal.register({ ...mockConfig(F01_BOOK.events[0]), identity: {
    ...mockConfig(F01_BOOK.events[0]).identity, sessionId: F04_TRADES.events[0].header.sessionId,
  } }, F04_TRADES.expected.startNs);
  journal.append(f01.id, F01_BOOK.events);
  journal.append(f03.id, [F03_GAP_TWA.events[0]]);
  journal.stage(f03.id, [{ type: "CONDITION", channel: "L2_MBP", atNs: at(9), status: "GAP",
    reason: "F03 exact MOCK missing interval; receive/exchange clocks declared equal" }]).commit();
  journal.append(f03.id, [F03_GAP_TWA.events[1]]);
  journal.append(f04.id, F04_TRADES.events);
  const journalWriteMs = performance.now()-t0;
  const snapshots = new SnapshotStore(journal);
  snapshots.capture(f01.id, at(0)); snapshots.capture(f01.id, at(3)); snapshots.capture(f03.id, at(8));
  insist(!snapshots.capture(f03.id, at(10)).captured, "DIAGNOSTIC_GAP", "GAP must not become checkpoint");
  const inputHash = checksum(journal.records()), migrationStart = performance.now();
  migrateToV2(journal); const migrationMs = performance.now()-migrationStart;
  const sqlOnly = numericResults(journal), writer = new SegmentWriter(journal);
  const chunkStart = performance.now(), chunks = [
    writer.write(f01.id, "L2_MBP", ["1","2","3"]),
    writer.write(f01.id, "L2_MBP", ["4","5"]),
    writer.write(f03.id, "L2_MBP", ["6","7","8"]),
    writer.write(f04.id, "TRADES", ["9","10","11"]),
  ];
  const chunkWriteMs = performance.now()-chunkStart;
  const mirrored = numericResults(journal);
  for (const chunk of chunks) writer.releaseSqliteCopies(chunk);
  const chunkOnly = numericResults(journal), pipelineMs = performance.now()-t0;
  const hashStart = performance.now(), outputHash = checksum(journal.records()), hashMs = performance.now()-hashStart;
  insist(inputHash === outputHash, "DIAGNOSTIC_HASH", "Original content changed");
  const openSize = sizes(catalog), version = catalog.sqliteVersion; catalog.close();
  const numeric = { recordCount: 11, marketEvents: 10, localQualityNotifications: 1,
    journalWriteMs, chunkWriteMs, pipelineMs, migrationMs, hashMs,
    inputHash, outputHash, sqlOnly, mirrored, chunkOnly, sqlite: version, openSize,
    closedSize: { db: bytes(catalog.filename), wal: bytes(`${catalog.filename}-wal`), chunks: openSize.chunks },
    chunkBytesPerMarketEvent: openSize.chunks/10,
    chunks: chunks.map(s => ({ id: s.segmentId, recordCount: s.recordCount, bytes: s.bytes, checksum: s.checksum })) };
  const target = open(dir, "retention"), j = target.journal;
  const scope = j.register(mockConfig(EIGHT_DAYS.events[0]), at(0));
  for (const event of EIGHT_DAYS.events) {
    if (event.header.exchangeTimeNs === day(7)) j.stage(scope.id, [{
      type: "CONDITION", channel: "L2_MBP", status: "GAP",
      atNs: (BigInt(day(6))+DAY/2n).toString(), reason: "R15 declared MOCK gap [day6.5, day7)",
    }]).commit();
    j.append(scope.id, [event]);
  }
  const ss = new SnapshotStore(j);
  ss.capture(scope.id, at(0));
  ss.capture(scope.id, (BigInt(at(0))+3n*DAY/4n).toString(), mockEvidence(scope, day(8)));
  insist(!ss.capture(scope.id, (BigInt(day(6))+3n*DAY/4n).toString(), mockEvidence(scope, day(8))).captured,
    "DIAGNOSTIC_GAP", "8-day GAP cannot publish snapshot");
  migrateToV2(j);
  const w = new SegmentWriter(j);
  const retentionChunks = [
    w.write(scope.id, "L2_MBP", ["1"]), w.write(scope.id, "L2_MBP", ["2","3"]),
    w.write(scope.id, "L2_MBP", ["4","5","6","7","8","9","10","11"]),
  ];
  for (const s of retentionChunks) w.releaseSqliteCopies(s);
  const retentionSize = sizes(target.catalog); target.catalog.close();
  return { environment: "MOCK / SIMULATED", node: process.version, platform: `${process.platform}/${process.arch}`,
    format: "UTF-8 JSONL v1 uncompressed; schema v2; no vendor RAW data", numeric,
    retention: { records: 11, snapshots: 10, gapMarkers: 1, durationDays: 8, openSize: retentionSize } };
}
export function recoverDiagnostic(dir: string) {
  const start = performance.now(), { catalog, journal } = open(dir, "numeric");
  const restored = numericResults(journal), hash = checksum(journal.records());
  const q = new SnapshotStore(journal), f01 = journal.scope(checksum(mockConfig(F01_BOOK.events[0]).identity));
  const recoveryStart = performance.now();
  const book = q.recover(f01.id, at(10), mockEvidence(f01, at(10)));
  const boardRecoveryMs = performance.now()-recoveryStart, recordCount = journal.records().length;
  // Separate clock: original F01/F03 UTC instants are never shifted into the 8-day fixture.
  new Retention(journal, () => (BigInt(at(0))+7n*DAY).toString()).run();
  const afterRetention = numericResults(journal); catalog.close();
  const target = open(dir, "retention"), j = target.journal;
  const scope = j.scope(checksum(mockConfig(EIGHT_DAYS.events[0]).identity)), range = new RangeQuery(j);
  const visible = range.query(scope.id, "L2_MBP", day(1), day(8), mockEvidence(scope, day(8)));
  const gap = range.query(scope.id, "L2_MBP", (BigInt(day(6))+DAY/2n).toString(), day(7), mockEvidence(scope, day(8)));
  const finalSize = sizes(target.catalog), state = storageState(target.catalog);
  target.catalog.close();
  return { restored, afterRetention, hash, recordCount, status: book.status, boardRecoveryMs,
    totalRestartAndReadMs: performance.now()-start, retention: {
      visibleMarketEvents: visible.events.length, visibleHash: checksum(visible.events),
      gapStatus: gap.status, cutoffNs: state.cutoffNs, floorPosition: state.floorPosition,
      finalSize, closedSize: { db: bytes(target.catalog.filename), wal: bytes(`${target.catalog.filename}-wal`), chunks: finalSize.chunks },
    } };
}
export function expireDiagnostic(dir: string, killAt?: string) {
  const { catalog, journal } = open(dir, "retention");
  const start = performance.now(), scopeId = checksum(mockConfig(EIGHT_DAYS.events[0]).identity);
  const range = new RangeQuery(journal), before = range.query(scopeId, "L2_MBP", day(1), day(8), mockEvidence(journal.scope(scopeId),day(8)));
  const outcome = new Retention(journal, () => day(8)).run(phase => {
    if (phase === killAt) { writeSync(1, JSON.stringify({ killedAt: phase })+"\n"); process.kill(process.pid, "SIGKILL"); }
  });
  const after = new RangeQuery(journal).query(scopeId, "L2_MBP", day(1), day(8), mockEvidence(journal.scope(scopeId),day(8)));
  insist(checksum(before.events) === checksum(after.events), "DIAGNOSTIC_RANGE", "Retention lost in-window events");
  const result = { ...outcome, durationMs: performance.now()-start, visibleHash: checksum(after.events),
    visibleMarketEvents: after.events.length, sizes: sizes(catalog) };
  catalog.close(); return result;
}
export function diagnosticChild(mode: string, dir: string) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    fileURLToPath(import.meta.url), mode, dir], { encoding: "utf8", timeout: 30_000 });
}
export function runDiagnostics() {
  const dir = diagnosticDirectory();
  try {
    const result = (mode: string) => {
      const child = diagnosticChild(mode, dir);
      insist(child.status === 0, "DIAGNOSTIC_CHILD", child.stderr || String(child.signal));
      return JSON.parse(child.stdout);
    };
    const saved = result("save"), restartBeforeExpiry = result("recover"), expiry = result("expire"),
      restartAfterExpiry = result("recover");
    return { saved, restartBeforeExpiry, expiry, restartAfterExpiry,
      notes: ["Small fixed MOCK only; not a capacity forecast for NQ", "Temporary dedicated DBs removed after report",
        "F01/F03 use a separate fixture-aligned clock; no expired history displayed",
        "Logical expiry does not physically shrink SQLite allocation; no VACUUM introduced"] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, dir] = process.argv.slice(2);
  const result = !mode ? runDiagnostics() : mode === "save" ? saveDiagnostic(dir) :
    mode === "recover" ? recoverDiagnostic(dir) : mode === "expire" ? expireDiagnostic(dir) :
      mode.startsWith("kill-retention:") ? expireDiagnostic(dir, mode.split(":")[1]) : (() => {
        const { catalog, journal } = open(dir, "numeric");
        const scope = journal.scope(checksum(mockConfig(F01_BOOK.events[0]).identity));
        if (mode === "kill-write" || mode.startsWith("kill-segment:")) {
          const source = F01_BOOK.events.at(-1)!;
          const event = { ...source, header: { ...source.header, eventId: "MOCK-R15-FAULT-6", sequence: "6",
            exchangeTimeNs: at(9), receiveTimeNs: at(9) } };
          const kill = (phase: string) => {
            writeSync(1, JSON.stringify({ killedAt: phase, hash: checksum(journal.records()), records: journal.records().length })+"\n");
            process.kill(process.pid, "SIGKILL");
          };
          if (mode === "kill-write") journal.stage(scope.id, [{ type: "EVENT", event }]).commit(() => kill("uncommitted-sqlite"));
          else {
            journal.append(scope.id, [event]);
            new SegmentWriter(journal).write(scope.id, "L2_MBP", ["12"], phase => {
              if (phase === mode.split(":")[1]) kill(phase);
            });
          }
        }
        catalog.close(); throw new Error("Unknown diagnostic mode");
      })();
  console.log(JSON.stringify(result, null, 2));
}
