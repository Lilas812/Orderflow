import { expect, it } from "vitest";
import { EventPipeline, LIMITS } from "./eventPipeline";
import { StorageAdapter } from "./storageAdapter";
import { config, deterministicDeliveries, eventAt, FIXTURE, ns, ownedDirectory, recoveryAt, removeOwnedDirectory } from "./r16Fixtures";
import { F04_TRADES } from "@workspace/fixtures";

function testGateway(run: (p: EventPipeline, id: string, advance: (ms:number)=>void) => void, limits = LIMITS) {
  const dir=ownedDirectory(), s=new StorageAdapter(dir); let now=0;
  try { const id=s.register(config(),ns(0)); run(new EventPipeline(s,()=>now,limits),id,ms=>{now+=ms;}); }
  finally { s.close(); removeOwnedDirectory(dir); }
}
it("commits 1010 immutable deliveries, 1000 applications and 10 duplicates in arrival order", () => testGateway((p,id) => {
  for (const e of deterministicDeliveries()) expect(p.receive(id,e)).toBe(true);
  expect(p.metrics.persistedEvents).toBe(0);
  expect(p.drain()).toBe(true);
  expect(p.metrics.snapshot()).toMatchObject({ receivedEvents:1010,appliedEvents:1000,acceptedEvents:1000,
    persistedEvents:1000,duplicateEvents:10,auditRecords:1010,queueDepth:0,explicitlyLostEvents:0 });
  const records=p.storage.journal.records(id);
  expect(records.map(r => r.input)).toEqual(deterministicDeliveries().map(event=>({type:"EVENT",event})));
  expect(p.metrics.latestExchangeEventTime).toBe(ns(999));
  expect(p.metrics.lastPersistedPosition).toBe("1010");
  expect(p.metrics.lastAppliedPosition).toBe("1000");
}),30_000);
it("does not expose failed/uncommitted candidates and retries without losing ownership", () => testGateway((p,id) => {
  p.receive(id,eventAt(0)); p.storage.beforeCommit=()=>{throw new Error("DISK FULL");};
  expect(p.flush()).toBe(false); expect(p.book(id)).toBeNull();
  expect(p.metrics.snapshot()).toMatchObject({ persistedEvents:0,appliedEvents:0,auditRecords:0,queueDepth:1,storageStatus:"STORAGE ERROR" });
  expect(p.storage.journal.records(id)).toHaveLength(0);
  p.storage.beforeCommit=undefined; expect(p.drain()).toBe(true);
  expect(p.metrics.snapshot()).toMatchObject({ persistedEvents:1,appliedEvents:1,storageErrorCount:1,storageStatus:"OK",queueDepth:0 });
  expect(p.book(id)).not.toBeNull();
}));
it("GAP does not reuse the last known book; ordinary updates cannot recover it", () => testGateway((p,id) => {
  p.receive(id,eventAt(0)); p.drain(); expect(p.book(id)).not.toBeNull();
  p.receive(id,eventAt(2)); p.drain(); expect(p.book(id)).toBeNull(); expect(p.quality(id,"L2_MBP")).toBe("GAP");
  expect(p.metrics.sequenceGapCount).toBe(1);
  p.receive(id,eventAt(3)); p.drain(); expect(p.book(id)).toBeNull();
  p.receive(id,recoveryAt(4)); p.drain(); expect(p.book(id)).not.toBeNull();
}));
it("bounds count, records overflow and requires a later covering snapshot", () => testGateway((p,id) => {
  expect(p.receive(id,eventAt(0))).toBe(true); expect(p.receive(id,eventAt(1))).toBe(true);
  expect(p.paused).toBe(true); expect(p.receive(id,eventAt(2))).toBe(false);
  expect(p.metrics.peakQueueDepth).toBe(2); expect(p.book(id)).toBeNull();
  p.drain(); expect(p.paused).toBe(false); expect(p.book(id)).toBeNull();
  expect(p.metrics.snapshot()).toMatchObject({ explicitlyLostEvents:1,overflowEvents:1,appliedEvents:2 });
  p.receive(id,recoveryAt(3)); p.drain(); expect(p.book(id)).not.toBeNull();
}, { ...LIMITS,events:2,batch:1 }));
it("independently enforces byte capacity", () => testGateway((p,id) => {
  expect(p.receive(id,eventAt(0))).toBe(false);
  expect(p.metrics.snapshot()).toMatchObject({ queueDepth:0,queueBytes:0,overflowEvents:1,explicitlyLostEvents:1 });
}, { ...LIMITS,bytes:1 }));
it("has no alias to mutable caller payloads", () => testGateway((p,id) => {
  const e=JSON.parse(JSON.stringify(eventAt(0))); p.receive(id,e); e.bids[0].qty=999;
  p.drain(); expect(p.storage.journal.records(id)[0].input).toEqual({type:"EVENT",event:eventAt(0)});
}));
it("rejects malformed input without saving it as a canonical event", () => testGateway((p,id) => {
  const e=eventAt(1); expect(p.receive(id,{...e,qty:-1})).toBe(false); p.drain();
  expect(p.metrics.rejectedEvents).toBe(1);
  expect(p.storage.journal.records(id).every(r=>r.input.type==="CONDITION")).toBe(true);
  expect(p.book(id)).toBeNull();
}));
it("keeps render/context failure and HISTORY separate from commit and state", () => testGateway((p,id,advance) => {
  p.receive(id,eventAt(0)); p.drain(); const first=p.renderTick()!; expect(p.acknowledgeRender(first)).toBe(true);
  p.setRendererReady(false); p.viewMode="HISTORY"; advance(500);
  p.receive(id,eventAt(1)); p.drain(); const hash=JSON.stringify(p.storage.states.get(id)?.lastGoodBook);
  expect(p.renderTick()).toBeNull(); expect(p.metrics.persistedEvents).toBe(2);
  expect(p.metrics.latestRenderedEventTime).toBe(ns(0)); expect(p.metrics.latestModel?.eventNs).toBe(ns(1));
  expect(p.metrics.snapshot().renderLagMs).toBe(500); expect(p.metrics.storageErrorCount).toBe(0);
  p.setRendererReady(true); const next=p.renderTick()!; expect(p.acknowledgeRender(next)).toBe(true);
  expect(p.metrics.snapshot().renderLagMs).toBe(0); expect(JSON.stringify(p.storage.states.get(id)?.lastGoodBook)).toBe(hash);
}));
it("coalesces render requests at 250ms without discarding any market event", () => testGateway((p,id,advance) => {
  p.receive(id,eventAt(0)); p.drain(); const a=p.renderTick()!; p.acknowledgeRender(a);
  advance(249); p.receive(id,eventAt(1)); p.drain(); expect(p.renderTick()).toBeNull();
  advance(1); expect(p.renderTick()?.position).toBe("2"); expect(p.metrics.persistedEvents).toBe(2);
  expect(p.acknowledgeRender({...a,position:"999"})).toBe(false);
}));
it("distinguishes R08 logical Trade duplicates with different delivery IDs", () => testGateway((p,id) => {
  const t=F04_TRADES.events[0], header={...t.header,...eventAt(0).header,channel:"TRADES" as const};
  p.receive(id,{...t,header}); p.drain();
  p.receive(id,{...t,header:{...header,eventId:"ANOTHER-DELIVERY",sequence:"2",receiveTimeNs:ns(1)}});
  p.drain();
  expect(p.metrics.snapshot()).toMatchObject({ receivedEvents:2,appliedEvents:1,duplicateEvents:1,persistedEvents:1,auditRecords:2 });
  expect(p.storage.trades.get(id)?.trades).toHaveLength(1);
}));
it("L2 GAP leaves a valid independent TRADES channel operating", () => testGateway((p,id) => {
  p.receive(id,eventAt(0)); p.receive(id,eventAt(2)); p.drain();
  const t=F04_TRADES.events[0];
  p.receive(id,{...t,header:{...t.header,...eventAt(3).header,channel:"TRADES",sequence:"1"}});
  p.drain(); expect(p.quality(id,"L2_MBP")).toBe("GAP");
  expect(p.quality(id,"TRADES")).toBe("VALID"); expect(p.storage.trades.get(id)?.trades).toHaveLength(1);
}));
it("is deterministic without mutating fixture bytes", () => {
  const before=JSON.stringify(FIXTURE), events=JSON.stringify(deterministicDeliveries());
  testGateway((p,id)=>{ for(const e of deterministicDeliveries()) p.receive(id,e); p.drain(); });
  expect(JSON.stringify(FIXTURE)).toBe(before); expect(JSON.stringify(deterministicDeliveries())).toBe(events);
},30_000);
it("measures intentionally slow commit and derived computation separately",()=>testGateway((p,id,advance)=>{
  p.receive(id,eventAt(0));p.storage.beforeCommit=()=>advance(25);p.drain();
  expect(p.metrics.storageFlush.report().meanMs).toBe(25);
  expect(p.metrics.processing.report().p95Ms).toBe(25);
  const qty=p.derived(id,state=>{advance(40);return state.lastGoodBook.bids.get(80000);});
  expect(qty).toBe(40);expect(p.metrics.derivedProcessing.report().meanMs).toBe(40);
  expect(p.metrics.lastAppliedPosition).toBe(p.metrics.lastPersistedPosition);
}));
it("rejects conflicting event IDs without counting them as logical applications",()=>testGateway((p,id)=>{
  p.receive(id,eventAt(0));p.drain();
  const e=eventAt(0);p.receive(id,{...e,bids:[{priceTicks:80000,qty:50}]});p.drain();
  expect(p.metrics.snapshot()).toMatchObject({receivedEvents:2,appliedEvents:1,persistedEvents:1,rejectedEvents:1,auditRecords:2});
  expect(p.book(id)).toBeNull();
}));
it("does not allow invalid configuration to create an unbounded queue",()=> {
  for(const limits of [{...LIMITS,events:0},{...LIMITS,bytes:-1},{...LIMITS,high:.4,low:.5}]) {
    expect(()=>testGateway(()=>{},limits)).toThrow();
  }
});
it("reports R08 conflicting trade IDs as INCOMPLETE, not VALID",()=>testGateway((p,id)=>{
  const t=F04_TRADES.events[0],header={...t.header,...eventAt(0).header,channel:"TRADES" as const};
  p.receive(id,{...t,header});p.drain();
  p.receive(id,{...t,qty:99,header:{...header,eventId:"CONFLICT",sequence:"2",receiveTimeNs:ns(1)}});
  p.drain();expect(p.quality(id,"TRADES")).toBe("INCOMPLETE");
  expect(p.metrics.persistedEvents).toBe(1);expect(p.metrics.storageErrorCount).toBe(0);
}));
it("does not misclassify a missing Trade timestamp as a disk failure",()=>testGateway((p,id)=>{
  const t=F04_TRADES.events[0],header={...t.header,...eventAt(0).header,channel:"TRADES" as const,exchangeTimeNs:null};
  expect(p.receive(id,{...t,header})).toBe(false);p.drain();
  expect(p.metrics.rejectedEvents).toBe(1);expect(p.metrics.storageErrorCount).toBe(0);
}));
it("measures oldest queue age without conflating it with exchange UTC",()=>testGateway((p,id,advance)=>{
  p.receive(id,eventAt(0));advance(123);
  expect(p.metrics.snapshot().oldestQueueAgeMs).toBe(123);
  p.drain();expect(p.metrics.snapshot().oldestQueueAgeMs).toBeNull();
}));
