import { expect,it } from "vitest";
import { checkSafety,expectedCopies,LIMITS,runCase,validateCount,isolatedCase } from "./r164Diagnostics";

it.each([100,400,1000,2000])("exact actual native copy formula for %i",n=>{
  expect(expectedCopies("A",n)).toEqual({copies:n,entries:100*n+n*(n-1)/2});
  const b=expectedCopies("B",n),c=expectedCopies("C",n);
  expect(b.copies-c.copies).toBe(1);expect(b.entries-c.entries).toBe(100);
});
it("explicit stop on unmeasured/exceeded RSS, time or input; exact boundary is allowed",()=>{
  expect(()=>checkSafety(LIMITS.workerRss,256*1024*1024,30000)).not.toThrow();
  for(const tuple of[[NaN,0,0],[1,NaN,0],[0,0,Infinity],[LIMITS.workerRss+1,0,1],
    [LIMITS.workerRss,256*1024*1024+1,1],[1,1,30001]]){
    expect(()=>checkSafety(...tuple as [number,number,number])).toThrow();
  }
  for(const n of[0,-1,100.5,2001,NaN])expect(()=>validateCount(n)).toThrow();
});
it("A/B/C measured counts match oracle and include real rollback without persistence claims",async()=>{
  const results=[];
  for(const mode of["A","B","C"] as const)results.push(await runCase(mode,100));
  expect(new Set(results.map(r=>r.actualHash)).size).toBe(1);
  for(const r of results){
    expect(r.logicalEvents).toBe(100);expect(r.rollbackUnchanged).toBe(true);
    expect(r.copied.copies).toBe(expectedCopies(r.mode,100).copies);
    expect(r.persistenceEventsPerSecond).toBe("NOT_MEASURED");
    expect(r.sqliteCommit).toBe("NOT_EXECUTED");
    expect(r.logicalLatencyMs).toMatchObject({count:100,exactPercentiles:true});
    expect(r.copied.copiedEntries).toBe(expectedCopies(r.mode,100).entries);
    expect(r.copied.copyMs+r.copied.setMs+r.copied.lookupMs).toBeGreaterThan(0);
  }
});
it("finite child IPC returns summary and exits, no service/DB/port created",async()=>{
  const r=await isolatedCase("B",100);
  expect(r.safeCompleted).toBe(true);expect(r.actualHash).toBe(r.oracleHash);
  expect(r.baseUnchanged&&r.inputUnchanged&&r.rollbackUnchanged).toBe(true);
},15000);
