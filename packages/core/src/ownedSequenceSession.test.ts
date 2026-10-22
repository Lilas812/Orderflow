import { describe, expect, it } from "vitest";
import { F07_SEQUENCE_GAP as F } from "../../fixtures/src/f07-sequence-gap";
import { createMarketQualityState, ingestMarketEvent, type MarketQualityConfig } from "./qualityTimeline";
import { beginOwnedSequenceSession, beginOwnedSequenceSessionFromNative, importMarketState,
  materializeMarketState } from "./ownedSequenceSession";
import { ingestMbpBatch } from "./qualityTimeline";

export const goldenConfig: MarketQualityConfig = {
  identity: (({ environment, source, sourceId, canonicalInstrumentId, sessionId }) =>
    ({ environment, source, sourceId, canonicalInstrumentId, sessionId }))(F.events[0].header),
  depthScope: F.events[0].depthScope,
  rules: Object.fromEntries(["L1", "L2_MBP", "TRADES"].map(c => [c, {
    scope: "CHANNEL", continuity: { contiguous: true, evidence: F.assumptions.continuityEvidence },
  }])) as unknown as MarketQualityConfig["rules"],
  snapshotAlignmentEvidence: F.assumptions.snapshotAlignmentEvidence,
};
function canonical(value: unknown): string {
  if (value instanceof Map) return canonical({ $storageMap: [...value] });
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fingerprintHash(value: unknown) {
  let hash = 14695981039346656037n;
  for (const c of canonical(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(c.charCodeAt(0))) * 1099511628211n);
  return hash.toString(16).padStart(16, "0");
}
export const goldenInputs = [
  ...F.events, F.events[1],
  { ...F.recovery, bids: [...F.recovery.bids, F.recovery.bids[0]] },
  F.recovery,
  { ...F.recovery, header: { ...F.recovery.header, sequenceScope: "NONE", sequence: null } },
];
describe("R16.5 pre-refactor golden", () => {
  it("fixes complete native state, reasons, fingerprints and ordering before kernel extraction", () => {
    let state = createMarketQualityState(goldenConfig, F.startNs);
    const actual = goldenInputs.map(input => {
      const result = ingestMarketEvent(state, input); state = result.state;
      return { hash: fingerprintHash(result), outcome: result.outcome, reason: result.reason };
    });
    // Captured from the unchanged R16.4 reducers BEFORE any product edit.
    expect(actual).toEqual([
      { hash: "6e7a72c6cfe7a262", outcome: "ACCEPTED", reason: "Snapshot coverage and declared alignment verified" },
      { hash: "bfb4edfbb0c06012", outcome: "ACCEPTED", reason: "Contiguous sequence accepted" },
      { hash: "000c9cf9d8cc12a0", outcome: "GAP", reason: "Missing sequence after 10; received 12" },
      { hash: "99b8a33563b7fbc6", outcome: "DUPLICATE", reason: "Identical event ID and content" },
      { hash: "d73d6321f6ad30c4", outcome: "RESYNC_REJECTED", reason: "Duplicate snapshot price on the same side" },
      { hash: "9b720cb062e523b4", outcome: "ACCEPTED", reason: "Snapshot coverage and declared alignment verified" },
      { hash: "8fe5c6dc54b6c9e7", outcome: "SCOPE_MISMATCH", reason: "Sequence scope differs from configured partition" },
    ]);
  });
});

describe("R16.5 private owner",()=>{
  it("matches every complete oracle state including rejected Snapshot undo",()=>{
    let state=createMarketQualityState(goldenConfig,F.startNs);
    const owner=beginOwnedSequenceSessionFromNative(state);
    for(const input of goldenInputs) {
      const oracle=ingestMarketEvent(state,input);
      expect(owner.ingestEvent(input)).toEqual({applied:oracle.applied,outcome:oracle.outcome,reason:oracle.reason});
      state=oracle.state;
      expect(canonical(owner.inspectForVerification())).toBe(canonical(state));
    }
  });
  it("never mutates external base, sealed state or old reader and revokes writers",()=>{
    const base=createMarketQualityState(goldenConfig,F.startNs),hash=canonical(base),sealed=importMarketState(base);
    const a=beginOwnedSequenceSession(sealed),b=beginOwnedSequenceSession(sealed);
    a.ingestEvent(F.events[0]);
    expect(canonical(base)).toBe(hash);expect(canonical(b.inspectForVerification())).toBe(hash);
    const result=a.seal(),snapshot=materializeMarketState(result);
    (snapshot.guard.seen as Map<string,string>).clear();
    expect(materializeMarketState(result).guard.seen.size).toBe(1);
    expect(()=>a.ingestEvent(F.events[1])).toThrow();
    expect(()=>a.condition("L2_MBP","GAP",F.startNs,"late")).toThrow();
    expect(()=>a.discard()).toThrow();
    b.discard();expect(()=>b.seal()).toThrow();
    expect(()=>beginOwnedSequenceSession({} as never)).toThrow();
  });
  it("retains full fingerprint, Native Maps and exact insertion order",()=>{
    let oracle=createMarketQualityState(goldenConfig,F.startNs);
    const owner=beginOwnedSequenceSessionFromNative(oracle);
    for(const event of F.events){oracle=ingestMarketEvent(oracle,event).state;owner.ingestEvent(event);}
    const value=materializeMarketState(owner.seal());
    expect(value.guard.seen).toBeInstanceOf(Map);
    expect([...value.guard.seen]).toEqual([...oracle.guard.seen]);
    expect([...value.guard.seen.values()].every(x=>x.includes('"eventId"')&&x.includes('"receiveTimeNs"'))).toBe(true);
  });
  it("preserves normal batch guard progress rather than undoing all applied=false",()=>{
    let state=ingestMarketEvent(createMarketQualityState(goldenConfig,F.startNs),F.events[0]).state;
    const owner=beginOwnedSequenceSessionFromNative(state);
    const first={...F.events[2],header:{...F.events[2].header,sequence:"11",eventId:"partial-a"}};
    state=ingestMbpBatch(state,[first]).state;owner.ingestBatch([first]);
    const next={...first,header:{...first.header,sequence:"12",eventId:"partial-b"}};
    const result=ingestMbpBatch(state,[first,next]);
    expect(result.applied).toBe(false);expect(result.outcome).toBe("BATCH_REJECTED");
    owner.ingestBatch([first,next]);
    expect(canonical(owner.inspectForVerification())).toBe(canonical(result.state));
  });
  it.each(["qty","sequenceScope","quality"] as const)("matches conflicting %s and rejection effects",field=>{
    let state=ingestMarketEvent(createMarketQualityState(goldenConfig,F.startNs),F.events[0]).state;
    const owner=beginOwnedSequenceSessionFromNative(state);
    for(const e of [F.events[1],{...F.events[1],qty:99},
      {...F.events[2],header:{...F.events[2].header,[field]:field==="sequenceScope"?"NONE":field==="quality"?"GAP":2}}]) {
      try {
        const r=ingestMarketEvent(state,e);owner.ingestEvent(e);state=r.state;
      } catch {expect(()=>owner.ingestEvent(e)).toThrow();}
      expect(canonical(owner.inspectForVerification())).toBe(canonical(state));
    }
  });
});
