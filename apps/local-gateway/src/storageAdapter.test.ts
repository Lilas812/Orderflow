import { expect, it } from "vitest";
import { checksum } from "@workspace/storage/catalog";
import { EventPipeline } from "./eventPipeline";
import { StorageAdapter } from "./storageAdapter";
import { config, eventAt, ns, ownedDirectory, recoveryAt, removeOwnedDirectory } from "./r16Fixtures";
function isolated(run:(s:StorageAdapter,p:EventPipeline,id:string)=>void) {
  const dir=ownedDirectory(),s=new StorageAdapter(dir);
  try{const id=s.register(config(),ns(0));run(s,new EventPipeline(s),id);}
  finally{s.close();removeOwnedDirectory(dir);}
}
it("uses actual patched SQLite, FULL durability and WAL", ()=>isolated(s=>{
  const version=s.catalog.database.prepare("SELECT sqlite_version() AS v").get() as {v:string};
  const [major,minor,patch]=version.v.split(".").map(Number);
  expect(major*1e6+minor*1e3+patch).toBeGreaterThanOrEqual(3e6+51e3+3);
  expect(s.catalog.database.pragma("journal_mode",{simple:true})).toBe("wal");
  expect(s.catalog.database.pragma("synchronous",{simple:true})).toBe(2);
}));
it("transaction failure leaves both stored bytes and canonical model untouched", ()=>isolated((s,p,id)=>{
  p.receive(id,eventAt(0));p.drain();const before=checksum(s.journal.records(id));
  s.beforeCommit=()=>{throw Error("FAIL BEFORE COMMIT");};p.receive(id,eventAt(1));p.flush();
  expect(checksum(s.journal.records(id))).toBe(before);
  expect(s.states.get(id)?.lastGoodBook.bids.get(80000)).toBe(40);
  expect(s.catalog.manifest().recordCount).toBe("1");
}));
it("bounds paused transport notifications at high and low watermarks", ()=>isolated((s,_p,id)=>{
  const notifications:boolean[]=[],p=new EventPipeline(s,()=>0,{events:4,bytes:8*1024*1024,high:.75,low:.5,batch:1},x=>notifications.push(x));
  for(let i=0;i<3;i++)p.receive(id,eventAt(i));
  expect(notifications).toEqual([true]);p.flush();expect(notifications).toEqual([true,false]);
  expect(p.metrics.pauseRequests).toBe(1);
}));
it("persists a disconnect independently and cannot restore merely by reconnecting", ()=>isolated((s,p,id)=>{
  p.receive(id,eventAt(0));p.drain();
  const rc=p.reconnectController(id,["L2_MBP"],()=>ns(1));rc.disconnect();p.drain();
  expect(p.book(id)).toBeNull();rc.connected();expect(rc.synchronized(!!p.book(id))).toBe(false);
  p.receive(id,eventAt(2));p.drain();expect(p.book(id)).toBeNull();
  p.receive(id,recoveryAt(3));p.drain();expect(rc.synchronized(!!p.book(id))).toBe(true);
  expect(s.journal.records(id).some(r=>r.input.type==="CONDITION")).toBe(true);
}));
it("keeps source/session scopes separate and preserves interleaved global arrival order", ()=>isolated((s,p,id)=>{
  const cfg=config(), other={...cfg,identity:{...cfg.identity,sessionId:"MOCK-R16-OTHER"}};
  const id2=s.register(other,ns(0)),first=eventAt(0);
  p.receive(id,first);p.receive(id2,{...first,header:{...first.header,sessionId:"MOCK-R16-OTHER"}});
  p.receive(id,eventAt(2));p.drain();
  expect(s.journal.records().map(r=>r.scopeId)).toEqual([id,id2,id]);
  expect(p.book(id)).toBeNull();expect(p.book(id2)).not.toBeNull();
}));
