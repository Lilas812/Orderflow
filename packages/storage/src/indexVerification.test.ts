import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { withStore, F01_BOOK, EIGHT_DAYS, at, day, DAY, mockConfig, mockEvidence } from "./r15Fixtures";
import { canonical, checksum, StorageError } from "./sqliteCatalog";
import { indices, migrateToV2, selectIndexLookupForDiagnostics, storageState, verifyIndexColumns,
  verifyMetadata, type IndexLookupMode, type RecordIndex, type IndexLookupMeasurement } from "./storageMigration";
import { SegmentWriter } from "./segmentWriter";
import { segmentPath } from "./segmentReader";
import { Retention } from "./retention";

const modes = ["find-reference", "map"] as const;
function columns(index: readonly RecordIndex[]) {
  return index.map(d=>({position:BigInt(d.position),scope_id:d.scopeId,channel:d.channel,
    event_ns:d.eventNs===null?null:BigInt(d.eventNs),receive_ns:BigInt(d.receiveNs)}));
}
function outcome(run:()=>void) {
  try {run();return "ACCEPT";}
  catch(error){if(error instanceof StorageError)return error.code;throw error;}
}
function input() {
  return withStore(({journal,scope,catalog})=>{
    journal.append(scope.id,F01_BOOK.events);migrateToV2(journal);
    return structuredClone(indices(catalog));
  });
}
function compare(index:RecordIndex[], rows:ReturnType<typeof columns>, expected:string) {
  expect(modes.map(mode=>outcome(()=>verifyIndexColumns(index,rows,mode)))).toEqual([expected,expected]);
}
describe("E temporary Map and find reference: every position and every protected column",()=>{
  it("accepts all rows, including reordered rows, empty input, with equal observed coverage",()=>{
    const index=input(),rows=columns(index).reverse(),stats:IndexLookupMeasurement[]=[];
    for(const mode of modes)verifyIndexColumns(index,rows,mode,m=>stats.push(m));
    expect(stats.map(m=>m.matchedRows)).toEqual([index.length,index.length]);
    expect(stats.map(m=>m.mapEntries)).toEqual([0,index.length]);
    compare([],[],"ACCEPT");
  });
  it("preserves bigint precision above 2^53 without Number conversion",()=>{
    const index=input().slice(0,2).map((d,i)=>({...d,position:(9007199254740993n+BigInt(i)).toString()}));
    compare(index,columns(index),"ACCEPT");
  });
  it.each([
    "duplicate descriptor","duplicate row","descriptor count","row count","unknown row",
    "tampered descriptor","leading zero","number descriptor","negative row","number row",
    "string row","overflow row","null descriptor","scope","channel","event time","receive time",
  ])("rejects %s identically in both modes",kind=>{
    const index=input(),rows=columns(index),last=index.length-1;
    switch(kind){
      case "duplicate descriptor":index[last]={...index[0]};break;
      case "duplicate row":rows[last]={...rows[0]};break;
      case "descriptor count":index.pop();break;
      case "row count":rows.pop();break;
      case "unknown row":rows[last].position=999n;break;
      case "tampered descriptor":index[last].position="999";break;
      case "leading zero":index[0].position="01";break;
      case "number descriptor":Reflect.set(index[0],"position",1);break;
      case "negative row":rows[0].position=-1n;break;
      case "number row":Reflect.set(rows[0],"position",1);break;
      case "string row":Reflect.set(rows[0],"position","1");break;
      case "overflow row":rows[0].position=1n<<63n;break;
      case "null descriptor":Reflect.set(index[0],"position",null);break;
      case "scope":rows[last].scope_id="foreign";break;
      case "channel":rows[last].channel="TRADES";break;
      case "event time":rows[last].event_ns=(rows[last].event_ns??0n)+1n;break;
      case "receive time":rows[last].receive_ns+=1n;break;
    }
    compare(index,rows,"CATALOG_INDEX");
  });
  it("does not retain a lookup Map or descriptors between calls",()=>{
    const index=input(),rows=columns(index);
    for(const mode of modes){
      verifyIndexColumns(index,rows,mode);
      const saved=index[0];index[0]={...saved,scopeId:"modified"};
      expect(()=>verifyIndexColumns(index,rows,mode)).toThrow("CATALOG_INDEX");
      index[0]=saved;
      verifyIndexColumns(index,rows,mode);
    }
  });
  it("isolates diagnostic reference selection and observers by catalog instance",()=>withStore(a=>withStore(b=>{
    for(const s of [a,b]){s.journal.append(s.scope.id,F01_BOOK.events);migrateToV2(s.journal);}
    const first:IndexLookupMode[]=[],second:IndexLookupMode[]=[];
    const restoreA=selectIndexLookupForDiagnostics(a.catalog,"find-reference",m=>first.push(m.mode));
    const restoreB=selectIndexLookupForDiagnostics(b.catalog,"map",m=>second.push(m.mode));
    try{
      verifyMetadata(a.catalog);verifyMetadata(b.catalog);verifyMetadata(a.catalog);
      expect(first).toEqual(["find-reference","find-reference"]);expect(second).toEqual(["map"]);
    }finally{restoreB();restoreA();}
  })));
});
describe.each(modes)("E real v2 database: %s",mode=>{
  it("checks all stored rows without changing records, manifest or roots",()=>withStore(({journal,scope,catalog})=>{
    journal.append(scope.id,F01_BOOK.events);migrateToV2(journal);
    const restore=selectIndexLookupForDiagnostics(catalog,mode);
    try{
      const before={records:canonical(journal.records()),manifest:catalog.manifest(),state:storageState(catalog)};
      verifyMetadata(catalog);journal.verify();
      expect({records:canonical(journal.records()),manifest:catalog.manifest(),state:storageState(catalog)}).toEqual(before);
    }finally{restore();}
  }));
  it.each(["scope_id","channel","event_ns","receive_ns"])("rejects final row %s corruption",field=>withStore(({journal,scope,catalog})=>{
    journal.append(scope.id,F01_BOOK.events);migrateToV2(journal);
    const other=journal.register({...scope.config,identity:{...scope.config.identity,sessionId:"MOCK-E-OTHER"}},scope.startNs);
    const restore=selectIndexLookupForDiagnostics(catalog,mode);
    try{
      const value=field==="scope_id"?other.id:field==="channel"?"TRADES":BigInt(at(99));
      catalog.database.prepare(`UPDATE r15_records SET ${field}=? WHERE position=(SELECT MAX(position) FROM r15_records)`).run(value);
      expect(()=>verifyMetadata(catalog)).toThrow("CATALOG_INDEX");
    }finally{restore();}
  }));
  it.each(["position","missing","checksum","root"])("rejects %s corruption before a lookup can hide it",kind=>withStore(({journal,scope,catalog})=>{
    journal.append(scope.id,F01_BOOK.events);migrateToV2(journal);
    const restore=selectIndexLookupForDiagnostics(catalog,mode);
    try{
      if(kind==="position")catalog.database.prepare("UPDATE r15_records SET position=999 WHERE position=1").run();
      if(kind==="missing")catalog.database.prepare("DELETE FROM r15_records WHERE position=1").run();
      if(kind==="checksum")catalog.database.prepare("UPDATE r15_records SET checksum=? WHERE position=1").run("0".repeat(64));
      if(kind==="root"){
        const value={...storageState(catalog),indexRoot:"0".repeat(64)};
        catalog.database.prepare("UPDATE r15_meta SET payload=?,checksum=? WHERE id=1").run(canonical(value),checksum(value));
      }
      expect(()=>verifyMetadata(catalog)).toThrow(/CATALOG_/);
    }finally{restore();}
  }));
  it("verifies matching SQL/chunk copies, chunk-only originals and refuses damaged originals",()=>withStore(({journal,scope,catalog})=>{
    journal.append(scope.id,F01_BOOK.events);migrateToV2(journal);
    const restore=selectIndexLookupForDiagnostics(catalog,mode);
    try{
      const before=checksum(journal.records()),writer=new SegmentWriter(journal);
      const info=writer.write(scope.id,"L2_MBP",indices(catalog).map(d=>d.position));
      journal.verify();expect(checksum(journal.records())).toBe(before);
      writer.releaseSqliteCopies(info);verifyMetadata(catalog);journal.verify();
      expect(checksum(journal.records())).toBe(before);
      writeFileSync(segmentPath(catalog,info),"damaged\n");
      expect(()=>journal.verify()).toThrow();
    }finally{restore();}
  }));
  it("verifies all remaining positions and deletion proof after seven-day retention",()=>withStore(s=>{
    const restore=selectIndexLookupForDiagnostics(s.catalog,mode);
    try{
      const scope=s.journal.register(mockConfig(EIGHT_DAYS.events[0]),at(0));
      s.journal.append(scope.id,EIGHT_DAYS.events);
      s.snapshots.capture(scope.id,at(0));
      s.snapshots.capture(scope.id,(BigInt(at(0))+3n*DAY/4n).toString(),mockEvidence(scope,day(8)));
      migrateToV2(s.journal);
      const writer=new SegmentWriter(s.journal);
      for(const positions of [["1"],["2","3"],["4","5","6","7","8","9","10"]])
        writer.releaseSqliteCopies(writer.write(scope.id,"L2_MBP",positions));
      expect(new Retention(s.journal,()=>day(8)).run().deleted).toBe(1);
      expect(storageState(s.catalog).floorPosition).toBe("1");
      expect(indices(s.catalog)[0].position).toBe("2");
      verifyMetadata(s.catalog);s.journal.verify();
      expect(new Retention(s.journal,()=>day(8)).run().deleted).toBe(0);
    }finally{restore();}
  }));
});
