import {
  constants, copyFileSync, existsSync, mkdtempSync, statSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMbpLevel } from "@workspace/core/mbp-book";
import { calculateTimeWeightedDepth, type DepthRecord } from "@workspace/core/time-weighted-depth";
import { EventJournal, eventsIn } from "./eventJournal";
import { SnapshotStore } from "./snapshotStore";
import { canonical, checksum, insist, SqliteCatalog } from "./sqliteCatalog";
import {
  F01_BOOK, F07_SEQUENCE_GAP, STORAGE_60S, STORAGE_GAP_60S, at, mockConfig, mockEvidence,
} from "./storageFixtures";

export function databaseSizes(filename: string) {
  return Object.fromEntries(["", "-wal", "-shm"].map(suffix => [
    suffix || "database", existsSync(filename + suffix) ? statSync(filename + suffix).size : 0,
  ]));
}
function scopes(journal: EventJournal) {
  return {
    f01: journal.register(mockConfig(F01_BOOK.events[0]), at(0)),
    sixty: journal.register(mockConfig(STORAGE_60S.events[0]), at(0)),
    gap: journal.register(mockConfig(STORAGE_GAP_60S.events[0]), at(0)),
    f07: journal.register(mockConfig(F07_SEQUENCE_GAP.events[0]), at(0)),
  };
}
function save(dir: string, crash: boolean) {
  const filename = join(dir, "events.sqlite");
  insist(!existsSync(filename), "DIAGNOSTIC_EXISTS", "Save diagnostic requires a new dedicated directory");
  const catalog = new SqliteCatalog(filename);
  const journal = new EventJournal(catalog);
  const s = scopes(journal);
  const snapshots = new SnapshotStore(journal);
  journal.append(s.f01.id, F01_BOOK.events);
  snapshots.capture(s.f01.id, at(0));
  journal.append(s.sixty.id, STORAGE_60S.events.slice(0, 2));
  const capture = snapshots.captureEvery60Seconds(s.sixty.id, at(0), at(60), mockEvidence(s.sixty, at(75)))[0];
  journal.append(s.sixty.id, [STORAGE_60S.events[2]]);
  journal.append(s.gap.id, STORAGE_GAP_60S.events);
  const invalid = snapshots.captureEvery60Seconds(s.gap.id, at(0), at(60), mockEvidence(s.gap, at(60)))[0];
  journal.append(s.f07.id, F07_SEQUENCE_GAP.events);
  const pending = journal.stage(s.sixty.id, [{ type: "EVENT", event: {
    ...STORAGE_60S.events[2], header: {
      ...STORAGE_60S.events[2].header, eventId: "MOCK-R14-UNCOMMITTED", sequence: "4",
      exchangeTimeNs: at(80), receiveTimeNs: at(80),
    },
  } }]);
  const result = {
    mode: crash ? "crash-save" : "save", dataKind: "NORMALIZED_MOCK_NOT_VENDOR_RAW",
    filename, sqliteVersion: catalog.sqliteVersion,
    stats: journal.stats(), manifest: catalog.manifest(),
    checkpointQty: readMbpLevel(capture.checkpoint!.state.lastGoodBook, "BID", 80000).qty,
    gapCheckpoint: invalid.captured,
    pendingReceived: pending.receivedCount, pendingCommitted: pending.committed,
    sizesBeforeClose: databaseSizes(filename),
    fixtureHash: checksum([F01_BOOK, STORAGE_60S, STORAGE_GAP_60S, F07_SEQUENCE_GAP]),
  };
  if (crash) {
    // Owned diagnostic DB only. Exercise rollback of an actual uncommitted SQL write.
    catalog.database.exec("BEGIN IMMEDIATE");
    catalog.database.exec("UPDATE records SET payload='UNCOMMITTED' WHERE position=1");
    writeSync(1, JSON.stringify(result) + "\n");
    process.kill(process.pid, "SIGKILL");
    return;
  }
  catalog.close();
  writeSync(1, JSON.stringify({ ...result, sizesAfterClose: databaseSizes(filename) }) + "\n");
}
function recover(dir: string) {
  const catalog = new SqliteCatalog(join(dir, "events.sqlite"));
  try {
    const journal = new EventJournal(catalog);
    const snapshots = new SnapshotStore(journal);
    const s = scopes(journal);
    const f01 = snapshots.recover(s.f01.id, at(10), mockEvidence(s.f01, at(10)));
    const events = journal.records(s.f01.id).flatMap(r => eventsIn(r.input)) as DepthRecord[];
    const history = { events, qualityState: f01.state,
      qualityTimeAlignmentEvidence: "F01 fixed MOCK explicitly has identical event/quality UTC axes" };
    const twa = (a: number, b: number) => calculateTimeWeightedDepth(history, {
      side: "BID", priceTicks: 80000, width: 1, startNs: at(a), endNs: at(b),
    }).twa;
    const sixty = snapshots.recover(s.sixty.id, at(60));
    const seventyFive = snapshots.recover(s.sixty.id, at(75));
    insist(sixty.book && seventyFive.book, "DIAGNOSTIC_RECOVERY", "Expected valid recovered MOCK boards");
    const result = {
      mode: "recover", sqliteVersion: catalog.sqliteVersion, stats: journal.stats(),
      manifest: catalog.manifest(), f01Twa: twa(0, 10),
      twoSecondTwa: [0, 2, 4, 6, 8].map(a => twa(a, a + 2)),
      checkpointQty: readMbpLevel(sixty.book, "BID", 80000).qty,
      recoveredQty: readMbpLevel(seventyFive.book, "BID", 80000).qty,
      replayedAfterCheckpoint: seventyFive.replayedPositions,
      gapStatus: snapshots.recover(s.gap.id, at(60)).status,
      f07Status: snapshots.recover(s.f07.id, at(4)).status,
      sizes: databaseSizes(catalog.filename),
      f01Unchanged: canonical(events) === canonical(F01_BOOK.events),
      fixtureHash: checksum([F01_BOOK, STORAGE_60S, STORAGE_GAP_60S, F07_SEQUENCE_GAP]),
    };
    writeSync(1, JSON.stringify(result) + "\n");
  } finally { catalog.close(); }
}
function corruptCopy(dir: string) {
  const healthy = join(dir, "events.sqlite");
  const broken = join(dir, "corrupted-copy.sqlite");
  copyFileSync(healthy, broken, constants.COPYFILE_EXCL);
  const c = new SqliteCatalog(broken);
  c.database.exec("UPDATE records SET payload=replace(payload,'\"qty\":40','\"qty\":41') WHERE position=1");
  c.close();
  const reopened = new SqliteCatalog(broken);
  let detected = "";
  try { new EventJournal(reopened); }
  catch (e) { detected = e instanceof Error ? e.message : String(e); }
  finally { reopened.close(); }
  insist(detected.includes("EVENT_CHECKSUM"), "DIAGNOSTIC_CORRUPTION", "Corrupted copy was not rejected");
  writeSync(1, JSON.stringify({ mode: "corrupt-copy", detected, healthyUnmodified: true }) + "\n");
}
export function diagnosticChild(mode: string, dir: string) {
  return spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), mode, dir,
  ], { encoding: "utf8", timeout: 30_000 });
}
function main() {
  const mode = process.argv[2] ?? "all";
  const dir = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), "orderflow-r14-diagnostics-"));
  if (mode === "save" || mode === "crash-save") return save(dir, mode === "crash-save");
  if (mode === "recover") return recover(dir);
  if (mode === "corrupt-copy") return corruptCopy(dir);
  insist(mode === "all", "DIAGNOSTIC_MODE", "Use all, save, crash-save, recover or corrupt-copy");
  const results: Record<string, unknown>[] = [];
  for (const step of ["save", "recover", "corrupt-copy", "recover"]) {
    const child = diagnosticChild(step, dir);
    insist(child.status === 0 && !child.error, "DIAGNOSTIC_PROCESS", `${step}: ${child.stderr || child.error}`);
    results.push(JSON.parse(child.stdout) as Record<string, unknown>);
  }
  writeSync(1, JSON.stringify({ directory: dir, results }, null, 2) + "\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
}
