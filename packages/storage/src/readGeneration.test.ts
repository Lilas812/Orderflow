import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { F03_GAP_TWA, F04_TRADES } from "@workspace/fixtures";
import { withStore, F01_BOOK, EIGHT_DAYS, at, day, mockConfig, mockEvidence } from "./r15Fixtures";
import { canonical, checksum, SqliteCatalog } from "./sqliteCatalog";
import { EventJournal, type JournalRecord } from "./eventJournal";
import { indices, insertIndex, migrateToV2, readCommitOriginals, saveStorageState,
  selectCommitReadForDiagnostics, storageState, verifyMetadata } from "./storageMigration";
import { SegmentReader, segmentPath } from "./segmentReader";
import { SegmentWriter } from "./segmentWriter";
import { Retention, resumeRetention } from "./retention";
import { RangeQuery } from "./rangeQuery";

type Store = Parameters<Parameters<typeof withStore>[0]>[0];
function v2(s: Store) {
  s.journal.append(s.scope.id, [F01_BOOK.events[0]]); migrateToV2(s.journal);
  selectCommitReadForDiagnostics(s.catalog, "reuse");
}
const originalRead = (s: Store) => readCommitOriginals(s.catalog, s.scope.id, ds => new SegmentReader(s.catalog).records(ds));
const roots = (s: Store) => ({ manifest: s.catalog.manifest(), meta: storageState(s.catalog),
  records: s.journal.records(), state: canonical(s.journal.replay(s.scope.id)) });

it("C-1 and old public replay agree after every duplicate/CONFLICT/multi-scope/channel commit", () => {
  const run = (mode: "reuse" | "reference") => withStore(s => {
    v2(s);
    const restore = selectCommitReadForDiagnostics(s.catalog, mode);
    try {
      const other = s.journal.register({ ...s.scope.config, identity: { ...s.scope.config.identity, sessionId: "C1-OTHER" } }, at(0));
      s.journal.append(other.id, [{ ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, sessionId: "C1-OTHER" } }]);
      const trade = F04_TRADES.events[0];
      const trades = s.journal.register(mockConfig({ ...F01_BOOK.events[0], header: {
        ...F01_BOOK.events[0].header, ...trade.header, channel: "L2_MBP" } }), at(0));
      s.journal.append(trades.id, F04_TRADES.events);
      for (const e of F01_BOOK.events.slice(1)) {
        s.journal.append(s.scope.id, [e]);
        expect(canonical(s.journal.replay(s.scope.id))).toBe(canonical(new EventJournal(s.catalog).replay(s.scope.id)));
      }
      const last = F01_BOOK.events.at(-1)!;
      s.journal.append(s.scope.id, [last, { ...last, header: { ...last.header, receiveTimeNs: at(20) } }]);
      expect(s.journal.records(s.scope.id).slice(-2).map(r => r.outcome)).toEqual(["DUPLICATE", "CONFLICT"]);
      s.journal.verify();
      return { ...roots(s), other: canonical(s.journal.replay(other.id)), trades: canonical(s.journal.replay(trades.id)) };
    } finally { restore(); }
  });
  expect(run("reuse")).toEqual(run("reference"));
});

it("GAP and RESYNCING survive until an aligned Snapshot, with independent public replay", () => withStore(s => {
  v2(s);
  for (const status of ["GAP", "RESYNCING"] as const) {
    s.journal.stage(s.scope.id, [{ type: "CONDITION", channel: "L2_MBP", atNs: at(1), status, reason: "C1 MOCK fault" }]).commit();
    expect(s.journal.replay(s.scope.id).timeline.L2_MBP.at(-1)!.status).toBe(status);
  }
  const snapshot = F01_BOOK.events[0];
  s.journal.append(s.scope.id, [{ ...snapshot, header: { ...snapshot.header, eventId: "C1-RESYNC",
    sequence: "99", exchangeTimeNs: at(2), receiveTimeNs: at(2) }, snapshotCoversSequence: "99" }]);
  expect(s.journal.replay(s.scope.id).timeline.L2_MBP.at(-1)!.status).toBe("VALID");
  s.journal.verify();
}));

it.each(["dml", "rolled-back dml", "ddl", "prepared ddl and reset cookie", "version restore"] as const)(
  "rejects metadata generation change: %s", kind => withStore(s => {
    v2(s);
    const db = s.catalog.database, before = roots(s), schema = db.pragma("schema_version", { simple: true });
    const create = db.prepare("CREATE TABLE c1_probe(n)"), drop = db.prepare("DROP TABLE IF EXISTS c1_probe");
    const restore = selectCommitReadForDiagnostics(s.catalog, "reuse", undefined, phase => {
      if (phase !== "verified") return;
      if (kind === "dml") db.prepare("UPDATE scopes SET payload=payload").run();
      if (kind === "rolled-back dml") db.exec("SAVEPOINT probe; UPDATE scopes SET payload=payload; ROLLBACK TO probe; RELEASE probe");
      if (kind === "ddl") db.exec("CREATE TABLE c1_probe(n)");
      if (kind === "prepared ddl and reset cookie") { create.run(); drop.run(); db.pragma(`schema_version=${schema}`); }
      if (kind === "version restore") { db.pragma("user_version=1"); db.pragma("user_version=2"); }
    });
    try { expect(() => s.journal.append(s.scope.id, [F01_BOOK.events[1]])).toThrow("READ_GENERATION"); }
    finally { restore(); }
    expect(roots(s)).toEqual(before);
  }));

it("rejects another connection without leaking a view or changing either catalog", () => withStore(s => withStore(other => {
  v2(s); v2(other);
  const db = s.catalog.database, restore = selectCommitReadForDiagnostics(s.catalog, "reuse", undefined, () => {
    Reflect.set(s.catalog, "database", other.catalog.database);
  });
  try { expect(() => s.journal.append(s.scope.id, [F01_BOOK.events[1]])).toThrow("READ_CONNECTION"); }
  finally { Reflect.set(s.catalog, "database", db); restore(); }
  s.journal.append(s.scope.id, [F01_BOOK.events[1]]);
  expect(s.catalog.manifest().recordCount).toBe("2"); expect(other.catalog.manifest().recordCount).toBe("1");
})));

it("rejects a new native transaction even with the same connection, versions and total_changes", () => withStore(s => {
  v2(s);
  // Captured native exec intentionally bypasses mutation instrumentation to test the identity sentinel itself.
  const exec = s.catalog.database.exec.bind(s.catalog.database);
  const restore = selectCommitReadForDiagnostics(s.catalog, "reuse", undefined, phase => {
    if (phase === "verified") exec("COMMIT; BEGIN IMMEDIATE");
  });
  try { expect(() => s.journal.append(s.scope.id, [F01_BOOK.events[1]])).toThrow("READ_TRANSACTION"); }
  finally { restore(); }
  expect(s.catalog.manifest().recordCount).toBe("1");
  s.journal.append(s.scope.id, [F01_BOOK.events[1]]);
}));

it("rejects simultaneous/reentrant views and out-of-transaction tokens", () => withStore(s => {
  v2(s); expect(() => originalRead(s)).toThrow("READ_TRANSACTION");
  const restore = selectCommitReadForDiagnostics(s.catalog, "reuse", undefined, () => originalRead(s));
  try { expect(() => s.catalog.transaction(() => originalRead(s))).toThrow("READ_TRANSACTION"); }
  finally { restore(); }
  expect(s.catalog.transaction(() => originalRead(s))).toHaveLength(1);
}));

it("rejects async readers and checks generation after reading original bytes", () => withStore(s => {
  v2(s);
  expect(() => s.catalog.transaction(() => readCommitOriginals(s.catalog, s.scope.id,
    () => Promise.resolve([]) as unknown as JournalRecord[]))).toThrow("READ_ASYNC");
  const restore = selectCommitReadForDiagnostics(s.catalog, "reuse", undefined, phase => {
    if (phase === "originals-read") s.catalog.database.prepare("UPDATE r15_meta SET payload=payload").run();
  });
  try { expect(() => s.catalog.transaction(() => originalRead(s))).toThrow("READ_GENERATION"); }
  finally { restore(); }
}));

it("disposes view before INSERT and keeps failed stage ownership for an ordered retry", () => withStore(s => {
  v2(s);
  const before = roots(s), staged = s.journal.stage(s.scope.id, F01_BOOK.events.slice(1).map(event => ({ type: "EVENT", event })));
  expect(() => staged.commit(() => { throw Error("C1 write failure"); })).toThrow("C1 write failure");
  expect(staged.committed).toBe(false); expect(roots(s)).toEqual(before);
  staged.commit(); expect(staged.committed).toBe(true);
  expect(s.journal.records().map(r => r.input)).toEqual(F01_BOOK.events.map(event => ({ type: "EVENT", event })));
  s.journal.verify();
}));

it.each(["raw", "chunk"] as const)("never treats metadata certification as %s certification", kind => withStore(s => {
  s.journal.append(s.scope.id, F01_BOOK.events); migrateToV2(s.journal);
  selectCommitReadForDiagnostics(s.catalog, "reuse");
  if (kind === "raw") s.catalog.database.prepare("UPDATE records SET payload='{}' WHERE position=1").run();
  else {
    const seg = new SegmentWriter(s.journal).write(s.scope.id, "L2_MBP", s.journal.records().map(r => r.position));
    writeFileSync(segmentPath(s.catalog, seg), readFileSync(segmentPath(s.catalog, seg), "utf8").replace('"qty":40', '"qty":41'));
  }
  expect(() => s.journal.append(s.scope.id, [F01_BOOK.events[0]])).toThrow(/CHECKSUM/);
}));

it("C-1-written F-01/F-03 preserve TWA38, bins, 50% coverage and NO DATA after independent replay",()=>withStore(s=>{
  migrateToV2(s.journal);selectCommitReadForDiagnostics(s.catalog,"reuse");
  s.journal.append(s.scope.id,F01_BOOK.events);
  const f=F03_GAP_TWA,gap=s.journal.register(mockConfig(f.events[0]),f.expected.startNs);
  s.journal.append(gap.id,[f.events[0]]);
  s.journal.stage(gap.id,[{type:"QUALITY_INTERVAL",observedAtNs:f.gap.startNs,interval:{
    channel:"L2_MBP",
    startNs:f.gap.startNs,endNs:f.gap.endNs,status:"GAP",reason:"C1 fixed MOCK gap",
  }}]).commit();
  s.journal.append(gap.id,[f.events[1]]);
  const query=new RangeQuery(new EventJournal(s.catalog)),proof=mockEvidence(s.scope,at(10));
  const depth=(a:number,b:number)=>query.depth(s.scope.id,{
    side:"BID",priceTicks:80000,width:1,startNs:at(a),endNs:at(b),
  },proof);
  expect(depth(0,10).twa).toBe(38);
  expect([0,2,4,6,8].map(t=>depth(t,t+2).twa)).toEqual([60,40,30,60,0]);
  expect(query.depth(gap.id,{side:"BID",priceTicks:80000,width:1,
    startNs:f.expected.startNs,endNs:f.expected.endNs},mockEvidence(gap,f.expected.endNs)))
    .toMatchObject({status:"NO DATA",coverageRatio:0.5,twa:null});
}));

it.each(["after-intent", "after-unlink", "before-final-commit"] as const)("retention resumes at %s, then C-1 agrees with public replay", phase => withStore(s => {
  const scope = s.journal.register(mockConfig(EIGHT_DAYS.events[0]), day(0));
  s.journal.append(scope.id, EIGHT_DAYS.events); migrateToV2(s.journal);
  new SegmentWriter(s.journal).write(scope.id, "L2_MBP", ["1"]);
  expect(() => new Retention(s.journal, () => day(8)).run(p => { if (p === phase) throw Error("C1 interrupt"); })).toThrow("C1 interrupt");
  expect(resumeRetention(s.catalog).deleted).toBe(1);
  expect(resumeRetention(s.catalog).deleted).toBe(0);
  selectCommitReadForDiagnostics(s.catalog, "reuse");
  s.journal.append(scope.id, [EIGHT_DAYS.events.at(-1)!]);
  const restored = new EventJournal(s.catalog);
  expect(canonical(restored.replay(scope.id))).toBe(canonical(s.journal.replay(scope.id)));
  expect(storageState(s.catalog).cutoffNs).toBe(day(1));
}));

// Budget-only descriptors: metadata is valid, but these synthetic entries deliberately do NOT
// certify original events. A stub consumer tests preflight without a quadratic 16k-event replay.
function fillDescriptors(s: Store, count: number) {
  const original = s.journal.records()[0];
  s.catalog.transaction(() => {
    let previous = original.checksum;
    for (let i = 2; i <= count; i++) {
      const record = { ...original, position: String(i), previousHash: previous, checksum: checksum(`C1-budget-${i}`) };
      insertIndex(s.catalog, record); previous = record.checksum;
    }
    s.catalog.setManifest({ ...s.catalog.manifest(), recordCount: String(count), head: previous });
    saveStorageState(s.catalog, storageState(s.catalog));
  });
}
it.each([16383, 16384, 16385])("descriptor budget boundary %i is private-write-only", count => withStore(s => {
  v2(s); fillDescriptors(s, count);
  verifyMetadata(s.catalog); expect(indices(s.catalog)).toHaveLength(count); // no public metadata cap
  let consumed = false;
  const run = () => s.catalog.transaction(() => readCommitOriginals(s.catalog, s.scope.id, ds => {
    consumed = true; expect(ds).toHaveLength(count); return [];
  }));
  if (count > 16384) { expect(run).toThrow("READ_BUDGET"); expect(consumed).toBe(false); }
  else expect(run()).toEqual([]);
  expect(s.catalog.manifest().recordCount).toBe(String(count));
}), 15000);

it.each([-1, 0, 1])("serialized UTF-8 budget 16MiB %+i; public replay remains uncapped", delta => withStore(s => {
  v2(s);
  const db = s.catalog.database, row = db.prepare("SELECT payload FROM r15_records WHERE position=1").get() as { payload: string };
  db.prepare("UPDATE r15_records SET payload=? WHERE position=1").run(
    row.payload + " ".repeat(16 * 1024 * 1024 + delta - Buffer.byteLength(row.payload)));
  // JSON whitespace changes serialization bytes, not the protected decoded descriptor/checksum/root.
  expect(s.journal.replay(s.scope.id).lastGoodBook.bids.get(80000)).toBe(40);
  const before = s.catalog.manifest();
  if (delta > 0) expect(() => s.journal.append(s.scope.id, [F01_BOOK.events[1]])).toThrow("READ_BUDGET");
  else expect(s.catalog.transaction(() => originalRead(s))).toHaveLength(1);
  expect(s.catalog.manifest()).toEqual(before);
  expect(s.journal.records()).toHaveLength(1);
}), 15000);

it.each(["before", "after"] as const)("SIGKILL %s native commit recovers without phantom commits", when => withStore(s => {
  v2(s);
  const file = s.catalog.filename; s.catalog.close();
  const script = `
    import {SqliteCatalog} from ${JSON.stringify(new URL("./sqliteCatalog.ts", import.meta.url).href)};
    import {EventJournal} from ${JSON.stringify(new URL("./eventJournal.ts", import.meta.url).href)};
    import {selectCommitReadForDiagnostics} from ${JSON.stringify(new URL("./storageMigration.ts", import.meta.url).href)};
    import {F01_BOOK} from ${JSON.stringify(new URL("./storageFixtures.ts", import.meta.url).href)};
    const c=new SqliteCatalog(process.argv[1]),j=new EventJournal(c),scope=${JSON.stringify(s.scope.id)};
    selectCommitReadForDiagnostics(c,"reuse");
    ${when === "after" ? `const native=c.transaction;c.transaction=function(op){const r=native.call(c,op);process.kill(process.pid,"SIGKILL");return r;};` : ""}
    j.stage(scope,[{type:"EVENT",event:F01_BOOK.events[1]}]).commit(${when === "before" ? '()=>process.kill(process.pid,"SIGKILL")' : ""});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file], { timeout: 10000 });
  expect(child.signal).toBe("SIGKILL");
  const c = new SqliteCatalog(file);
  try {
    const j = new EventJournal(c); j.verify();
    expect(j.records()).toHaveLength(when === "after" ? 2 : 1);
    expect(checksum(j.records().map(r => r.input))).toBe(checksum(F01_BOOK.events.slice(0, when === "after" ? 2 : 1)
      .map(event => ({ type: "EVENT", event }))));
  } finally { c.close(); }
}), 15000);
