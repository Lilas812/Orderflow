import { expect, it } from "vitest";
import { withStore, F01_BOOK, EIGHT_DAYS, day, at, mockConfig, mockEvidence } from "./r15Fixtures";
import { EventJournal, selectJournalSeenForFiniteMock } from "./eventJournal";
import { canonical, checksum } from "./sqliteCatalog";
import { migrateToV2, storageState, segments } from "./storageMigration";
import { SegmentWriter } from "./segmentWriter";
import { Retention, resumeRetention, type RetentionPhase } from "./retention";
import { RangeQuery } from "./rangeQuery";
import { F03_GAP_TWA } from "@workspace/fixtures";
import { writeFileSync } from "node:fs";
import { segmentPath } from "./segmentReader";

function result(mode:"immutable"|"owned",scenario:"v1"|"v2"|"chunk"|"retention") {
  return withStore(s=>{
    const fixture=scenario==="retention"?EIGHT_DAYS:F01_BOOK;
    const scope=s.journal.register(mockConfig(fixture.events[0]),at(0));
    if(scenario!=="v1")migrateToV2(s.journal);
    const off=selectJournalSeenForFiniteMock(s.journal,{mode,scopeIds:[scope.id],traceHash:checksum("same-input"),
      expectedAuditInputs:100,c1Mode:"reference"});
    for(const event of fixture.events)s.journal.append(scope.id,[event]);
    const snapshot=s.snapshots.capture(scope.id,scenario==="retention"?day(8):at(10));
    if(scenario==="chunk"||scenario==="retention") {
      const writer=new SegmentWriter(s.journal);
      const seg=writer.write(scope.id,"L2_MBP",s.journal.records(scope.id).map(r=>r.position));
      writer.releaseSqliteCopies(seg);
    }
    if(scenario==="retention") {
      new Retention(s.journal,()=>day(8)).run();
      const last=EIGHT_DAYS.events.at(-1)!;
      s.journal.append(scope.id,[{...last,header:{...last.header,eventId:"R165-AFTER-RETENTION",
        sequence:"11",exchangeTimeNs:(BigInt(day(8))+1n).toString(),receiveTimeNs:(BigInt(day(8))+1n).toString()},
        snapshotCoversSequence:"11"}]);
    }
    s.journal.verify();
    const rows=s.journal.records(scope.id),state=s.journal.replay(scope.id);
    const recovered=s.snapshots.recover(scope.id,scenario==="retention"?day(8):at(10));
    const output={rows,state,snapshot,recovered,
      root:scenario==="v1"?null:storageState(s.catalog).indexRoot};
    off();return canonical(output);
  });
}
it.each(["v1","v2","chunk","retention"] as const)("matches complete persisted/replayed/Snapshot state in %s",scenario=>{
  expect(result("owned",scenario)).toBe(result("immutable",scenario));
});
it.each(["immutable","owned"] as const)("keeps F01 and F03 numerical oracles under %s",mode=>withStore(s=>{
  migrateToV2(s.journal);
  const gap=s.journal.register(mockConfig(F03_GAP_TWA.events[0]),at(8));
  selectJournalSeenForFiniteMock(s.journal,{mode,scopeIds:[s.scope.id,gap.id],traceHash:checksum("oracles"),
    expectedAuditInputs:100,c1Mode:"reference"});
  s.journal.append(s.scope.id,F01_BOOK.events);
  const query=new RangeQuery(s.journal,s.snapshots),proof=mockEvidence(s.scope,at(10));
  expect(query.depth(s.scope.id,{side:"BID",priceTicks:80000,width:1,startNs:at(0),endNs:at(10)},proof).twa).toBe(38);
  expect([0,2,4,6,8].map(t=>query.depth(s.scope.id,{side:"BID",priceTicks:80000,width:1,
    startNs:at(t),endNs:at(t+2)},proof).twa)).toEqual([60,40,30,60,0]);
  s.journal.append(gap.id,[F03_GAP_TWA.events[0]]);
  s.journal.stage(gap.id,[{type:"CONDITION",channel:"L2_MBP",status:"GAP",atNs:at(9),reason:"F03 exact MOCK gap"}]).commit();
  s.journal.append(gap.id,[F03_GAP_TWA.events[1]]);
  expect(query.depth(gap.id,{side:"BID",priceTicks:80000,width:1,startNs:at(8),endNs:at(12)},
    {...mockEvidence(gap,at(12)),description:F03_GAP_TWA.timeAlignmentEvidence}))
    .toMatchObject({twa:null,coverageRatio:0.5,status:"NO DATA"});
}));
it.each(["immutable","owned"] as const)("rolls back real INSERT failure with %s and retries same stage",mode=>withStore(s=>{
  migrateToV2(s.journal);
  selectJournalSeenForFiniteMock(s.journal,{mode,scopeIds:[s.scope.id],traceHash:checksum("rollback"),
    expectedAuditInputs:100,c1Mode:"reference"});
  const stage=s.journal.stage(s.scope.id,F01_BOOK.events.map(event=>({type:"EVENT",event})));
  s.catalog.database.exec("CREATE TRIGGER r165_fail BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'R165 disk error'); END");
  expect(()=>stage.commit()).toThrow("R165 disk error");expect(stage.committed).toBe(false);
  expect(s.journal.records()).toHaveLength(0);
  s.catalog.database.exec("DROP TRIGGER r165_fail");
  stage.commit();s.journal.verify();expect(s.journal.records()).toHaveLength(5);
}));
it.each((["immutable","owned"] as const).flatMap(mode=>
  (["SQL","chunk"] as const).map(kind=>[mode,kind] as const)))("rejects corruption under %s (%s)",(mode,kind)=>withStore(s=>{
  migrateToV2(s.journal);
  selectJournalSeenForFiniteMock(s.journal,{mode,scopeIds:[s.scope.id],traceHash:checksum("corruption"),
    expectedAuditInputs:100,c1Mode:"reference"});
  s.journal.append(s.scope.id,F01_BOOK.events);
  const seg=new SegmentWriter(s.journal).write(s.scope.id,"L2_MBP",["1","2","3","4","5"]);
  expect(segments(s.catalog)).toHaveLength(1);
  if(kind==="SQL")s.catalog.database.prepare("UPDATE records SET payload='{}' WHERE position=1").run();
  else writeFileSync(segmentPath(s.catalog,seg),"corrupt chunk");
  expect(()=>new EventJournal(s.catalog)).toThrow();
  expect(()=>s.journal.append(s.scope.id,[F01_BOOK.events[0]])).toThrow();
}));
it.each(["after-intent","after-unlink","before-final-commit"] as RetentionPhase[])(
  "resumes retention proof after %s then writes owned",phase=>withStore(s=>{
    const scope=s.journal.register(mockConfig(EIGHT_DAYS.events[0]),at(0));
    migrateToV2(s.journal);s.journal.append(scope.id,EIGHT_DAYS.events);
    s.snapshots.capture(scope.id,day(0));
    new SegmentWriter(s.journal).write(scope.id,"L2_MBP",["1","2"]);
    expect(()=>new Retention(s.journal,()=>day(8)).run(p=>{if(p===phase)throw Error("interrupt");})).toThrow("interrupt");
    resumeRetention(s.catalog);
    const journal=new EventJournal(s.catalog);
    selectJournalSeenForFiniteMock(journal,{mode:"owned",scopeIds:[scope.id],traceHash:checksum("resume"),
      expectedAuditInputs:100,c1Mode:"reference"});
    // A duplicate within retention remains audit-only and must not alter the restored book.
    const before=checksum(journal.replay(scope.id).lastGoodBook);
    journal.append(scope.id,[EIGHT_DAYS.events.at(-1)!]);
    expect(checksum(journal.replay(scope.id).lastGoodBook)).toBe(before);journal.verify();
  }));
