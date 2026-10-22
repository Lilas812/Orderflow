import { describe, expect, it } from "vitest";
import { F07_SEQUENCE_GAP as F07 } from "../../fixtures/src/index";
import {
  createSequenceGuard, guardEvent, rebaseSequenceGuard, sequencePartition,
  type ContinuityRule,
} from "./sequenceGuard";
import type { EventHeader } from "./events";

const rule: ContinuityRule = { contiguous: true, evidence: F07.assumptions.continuityEvidence };
const alignment = F07.assumptions.snapshotAlignmentEvidence;
const initial = F07.events[0];
it("R165 public immutable guards keep base Native Maps independent",()=>{
  const base=createSequenceGuard(),next=guardEvent(base,initial,rule);
  expect(base.seen.size).toBe(0);expect(next.state.seen).not.toBe(base.seen);
  expect(next.state.seen).toBeInstanceOf(Map);
  expect(guardEvent(next.state,initial,rule).state).toBe(next.state);
});
function update(sequence: string, eventId = `MOCK-U-${sequence}`) {
  return { ...F07.events[2], header: { ...F07.events[2].header, sequence, eventId } };
}

describe("R03 sequence guard", () => {
  it("accepts a normal guaranteed consecutive sequence using exact decimal strings", () => {
    const a = guardEvent(createSequenceGuard(), initial, rule);
    const b = guardEvent(a.state, update("11"), rule);
    expect(a.outcome).toBe("ACCEPTED");
    expect(b.outcome).toBe("ACCEPTED");
    expect(b.verification).toBe("CONTIGUOUS");
    expect(b.apply).toBe(true);
    expect([...a.state.heads.values()][0].lastSequence).toBe("10");
    expect([...b.state.heads.values()][0].lastSequence).toBe("11");
  });

  it("F-07 detects 10 -> 12 without creating sequence 11", () => {
    const a = guardEvent(createSequenceGuard(), initial, rule);
    const gap = guardEvent(a.state, F07.events[2], rule);
    expect(gap.outcome).toBe("GAP");
    expect(gap.apply).toBe(false);
    expect(gap.reason).toContain("10");
    expect(gap.reason).toContain("12");
    expect(gap.state.seen.size).toBe(2);
    expect([...gap.state.heads.values()][0]).toMatchObject({
      lastSequence: "10", highWatermark: "12", blocked: true,
    });
  });

  it("does not claim a gap when contiguity has not been guaranteed", () => {
    const a = guardEvent(createSequenceGuard(), initial);
    const b = guardEvent(a.state, F07.events[2]);
    expect(b.outcome).toBe("ACCEPTED");
    expect(b.verification).toBe("ORDER_ONLY");
    expect(b.reason).toContain("not guaranteed");
  });

  it("NONE is explicitly UNVERIFIABLE, never a fictional gap detector", () => {
    const a = { ...initial, header: { ...initial.header, sequenceScope: "NONE", sequence: null } };
    const result = guardEvent(createSequenceGuard(), a);
    expect(result.apply).toBe(true);
    expect(result.verification).toBe("UNVERIFIABLE");
    expect([...result.state.heads.values()][0].lastSequence).toBeNull();
  });

  it.each(["NONE", "CHANNEL"])("cannot satisfy a continuity guarantee without sequence (%s)", (scope) => {
    const event = { ...initial, header: { ...initial.header, sequenceScope: scope, sequence: null } };
    const result = guardEvent(createSequenceGuard(), event, rule);
    expect(result.outcome).toBe("UNVERIFIABLE");
    expect(result.apply).toBe(false);
  });

  it("requires explicit nonempty evidence for a continuity guarantee", () => {
    expect(() => guardEvent(createSequenceGuard(), initial, { contiguous: true, evidence: "" })).toThrow();
  });

  it("deduplicates identical content regardless of object property insertion order", () => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    const reordered = Object.fromEntries(Object.entries(initial).reverse());
    const second = guardEvent(first.state, reordered, rule);
    expect(second.outcome).toBe("DUPLICATE");
    expect(second.apply).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it("reports same-ID conflicting content and never replaces the original fingerprint", () => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    const conflict = guardEvent(first.state, {
      ...initial, bids: [{ priceTicks: 80000, qty: 999 }],
    }, rule);
    expect(conflict.outcome).toBe("CONFLICT");
    expect(conflict.apply).toBe(false);
    expect(guardEvent(conflict.state, initial, rule).outcome).toBe("DUPLICATE");
    expect([...conflict.state.heads.values()][0].blocked).toBe(true);
  });

  it("changing sequenceScope on an existing ID is a conflict, not a fresh event", () => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    expect(guardEvent(first.state, {
      ...initial, header: { ...initial.header, sequenceScope: "INSTRUMENT" },
    }, rule).outcome).toBe("CONFLICT");
  });

  it.each(["9", "10"])("rejects old/reused sequence %s even with a different ID", (sequence) => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    const old = guardEvent(first.state, update(sequence), rule);
    expect(old.outcome).toBe("OLD");
    expect(old.apply).toBe(false);
    expect([...old.state.heads.values()][0].lastSequence).toBe("10");
  });

  it("late seq11 after seq12 is not silently sorted or used to heal the gap", () => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    const gap = guardEvent(first.state, update("12"), rule);
    const late = guardEvent(gap.state, update("11"), rule);
    expect(late.outcome).toBe("OLD");
    expect(late.apply).toBe(false);
    expect(guardEvent(late.state, update("13"), rule).apply).toBe(false);
  });

  it("rejects backwards exchange time even when sequence is unavailable", () => {
    const first = guardEvent(createSequenceGuard(), {
      ...initial, header: { ...initial.header, sequenceScope: "NONE", sequence: null },
    });
    const late = guardEvent(first.state, {
      ...initial, header: { ...initial.header, eventId: "MOCK-LATE", sequenceScope: "NONE",
        sequence: null, exchangeTimeNs: "1767225600000000001" },
    });
    expect(late.outcome).toBe("OLD");
    expect(late.apply).toBe(false);
  });

  it("does not round sequence IDs larger than Number.MAX_SAFE_INTEGER", () => {
    const first = guardEvent(createSequenceGuard(), {
      ...initial, header: { ...initial.header, sequence: "900719925474099312345" },
    }, rule);
    const next = guardEvent(first.state, update("900719925474099312346"), rule);
    expect(next.apply).toBe(true);
    expect([...next.state.heads.values()][0].lastSequence).toBe("900719925474099312346");
  });

  it.each([
    { sourceId: "MOCK-OTHER" }, { canonicalInstrumentId: "CME:NQ:2026-06" },
    { sessionId: "MOCK-OTHER" }, { channel: "TRADES" }, { sequenceScope: "INSTRUMENT" },
    { sequenceScope: "PACKET" }, { environment: "REPLAY_FROM_SAVED_DATA" },
  ])("uses independent sequence partition identity %j", (patch) => {
    const header = { ...initial.header, ...patch } as EventHeader;
    expect(sequencePartition(header)).not.toBe(sequencePartition(initial.header));
  });

  it("different contracts and channels cannot create cross-partition gaps", () => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    const other = guardEvent(first.state, {
      ...initial, header: { ...initial.header, canonicalInstrumentId: "CME:NQ:2026-06", sequence: "99" },
    }, rule);
    const trade = guardEvent(other.state, F07.events[1], rule);
    expect(other.apply).toBe(true);
    expect(trade.apply).toBe(true);
    expect(trade.state.heads.size).toBe(3);
  });

  it("invalid input throws without mutating the guard or fixture", () => {
    const first = guardEvent(createSequenceGuard(), initial, rule);
    const raw = JSON.stringify(F07);
    expect(() => guardEvent(first.state, { ...F07.events[2], qty: -1 }, rule)).toThrow();
    expect(first.state.seen.size).toBe(1);
    expect(JSON.stringify(F07)).toBe(raw);
  });
});

describe("R03 explicit snapshot sequence rebase", () => {
  const first = guardEvent(createSequenceGuard(), initial, rule);
  const gap = guardEvent(first.state, F07.events[2], rule);

  it("rebases only to a new covering snapshot and then accepts the next sequence", () => {
    const sync = rebaseSequenceGuard(gap.state, F07.recovery, rule, alignment);
    expect(sync.apply).toBe(true);
    expect(guardEvent(sync.state, {
      ...update("14"), header: { ...update("14").header,
        exchangeTimeNs: "1767225606000000000" },
    }, rule).apply).toBe(true);
    expect([...gap.state.heads.values()][0].blocked).toBe(true);
    expect(sync.state.seen.size).toBe(3);
  });

  it.each([
    { snapshotCoversSequence: null }, { snapshotCoversSequence: "12" },
    { header: { ...F07.recovery.header, quality: "SUSPECT" } },
    { header: { ...F07.recovery.header, sequence: "11" }, snapshotCoversSequence: "11" },
    { header: { ...F07.recovery.header, exchangeTimeNs: "1767225600000000000" } },
  ])("refuses insufficient snapshot sequence proof %j", (patch) => {
    const result = rebaseSequenceGuard(gap.state, { ...F07.recovery, ...patch }, rule, alignment);
    expect(result.apply).toBe(false);
    expect(result.state).toBe(gap.state);
  });

  it("does not recover from a previously seen snapshot", () => {
    const result = rebaseSequenceGuard(gap.state, initial, rule, alignment);
    expect(result.outcome).toBe("DUPLICATE");
    expect(result.apply).toBe(false);
  });

  it("rejects a conflicting snapshot ID", () => {
    const result = rebaseSequenceGuard(gap.state, {
      ...F07.recovery, header: { ...F07.recovery.header, eventId: initial.header.eventId },
    }, rule, alignment);
    expect(result.outcome).toBe("CONFLICT");
    expect(result.apply).toBe(false);
  });

  it("does not infer alignment evidence or continuity from a snapshot label", () => {
    expect(rebaseSequenceGuard(gap.state, F07.recovery, rule, "").apply).toBe(false);
    expect(rebaseSequenceGuard(gap.state, F07.recovery, { contiguous: false }, alignment).apply).toBe(false);
  });
});
