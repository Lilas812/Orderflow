import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { checksum, decode } from "@workspace/storage/catalog";
import { ResearchProbe, sampledCategories } from "./r162Diagnostics";

describe("R16.2 diagnostic hooks do not optimize or change storage semantics",()=>{
  it("preserves canonical checksum and restores builtin functions",async()=>{
    const hash=crypto.createHash,parse=JSON.parse,find=Array.prototype.find;
    const input={timeNs:"1792614112028000001",value:0},expected=checksum(input);
    const probe=new ResearchProbe();
    try {
      probe.attach();
      expect(checksum(input)).toBe(expected);
      const measured=probe.report().totals["ingest:sha256.lifecycle_INCLUSIVE"];
      expect(measured.calls).toBeGreaterThanOrEqual(1);
      expect(measured.ms).toBeGreaterThanOrEqual(0);
      await probe.settle();
    }finally{probe.detach();}
    expect(crypto.createHash).toBe(hash);expect(JSON.parse).toBe(parse);expect(Array.prototype.find).toBe(find);
  });
  it("preserves JSON precision, revivers, Map decode and thrown errors",()=>{
    const probe=new ResearchProbe();
    try {
      probe.attach();
      expect(JSON.parse('{"ns":"1792614112028000001"}').ns).toBe("1792614112028000001");
      expect(JSON.parse("2",(_k,v)=>typeof v==="number"?v+1:v)).toBe(3);
      expect(decode('{"$storageMap":[["known",0]]}')).toEqual(new Map([["known",0]]));
      expect(()=>JSON.parse("{")).toThrow(SyntaxError);
      expect(()=>checksum({invalid:undefined})).toThrow();
    }finally{probe.detach();}
  });
  it("times the original metadata join without replacing its predicate/result",()=>{
    const probe=new ResearchProbe();
    try {
      probe.attach();
      const index=[{position:"1"},{position:"2"}],r={position:2n};
      expect(index.find(v=>v.position===r.position.toString())).toBe(index[1]);
      expect(index.find(v=>v.position==="missing")).toBeUndefined();
      expect(probe.report().totals["ingest:catalog.index_join_find"].calls).toBe(1);
    }finally{probe.detach();}
  });
  it("does not double-count recursive sampled ancestors and labels missing categories",()=>{
    const frame=(functionName:string,url="file:///sqliteCatalog.ts")=>({functionName,url});
    const out=sampledCategories({nodes:[
      {id:1,callFrame:frame("checksum"),children:[2]},
      {id:2,callFrame:frame("canonical"),children:[3]},
      {id:3,callFrame:frame("canonical")},
    ],samples:[3],timeDeltas:[1000]});
    expect(out.categories.storageCanonical).toEqual({samples:1,estimatedInclusiveMs:1});
    expect(out.categories.checksum.estimatedInclusiveMs).toBe(1);
    expect(out.categories.sequence).toBeUndefined();
  });
  it("refuses double attachment rather than leaving nested global hooks",()=>{
    const probe=new ResearchProbe();
    try{probe.attach();expect(()=>probe.attach()).toThrow("already attached");}finally{probe.detach();}
  });
});
