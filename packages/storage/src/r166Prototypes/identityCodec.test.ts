import { expect, it } from "vitest";
import { createSequenceGuard, guardEvent, _planGuardEvent } from "@workspace/core/sequence-guard";
import { F01_BOOK } from "../storageFixtures";
import { canonical as storageCanonical } from "../sqliteCatalog";
import { encodeIdentity, guardCanonical, keyScope, sameFingerprint, validateIdentity } from "./identityCodec";

const base = F01_BOOK.events[1];
it.each([
  { environment: "REPLAY_FROM_SAVED_DATA" }, { environment: "LIVE", source: "VENDOR_UNVERIFIED" }, { sourceId: "OTHER" },
  { canonicalInstrumentId: "CME:NQ:2026-06" }, { sessionId: "OTHER" },
  { eventId: "00001" }, { eventId: "1" }, { eventId: " 1 " },
  { eventId: "é" }, { eventId: "e\u0301" }, { eventId: "日本語😀\n\u0001\"\\,[]" },
])("matches private old key/fingerprint oracle for %j", patch => {
  const event = { ...base, header: { ...base.header, ...patch } };
  const plan = _planGuardEvent(createSequenceGuard(), event);
  expect(plan.change).toBe("NEXT");
  if (plan.change !== "NEXT" || !plan.insert) throw new Error("Independent oracle did not insert");
  const encoded = encodeIdentity(event);
  expect(Buffer.from(encoded.key)).toEqual(Buffer.from(plan.insert.key));
  expect(Buffer.from(encoded.fingerprint)).toEqual(Buffer.from(plan.insert.fingerprint));
  expect(() => validateIdentity(encoded.key, encoded.fingerprint)).not.toThrow();
});
it("channel identity follows the unchanged seven-field tuple", () => {
  const quote = { kind: "L1_QUOTE", header: { ...base.header, channel: "L1" },
    bestBidTick: 80000, bestAskTick: 80001, bidQty: 1, askQty: 2 };
  const trade = { kind: "TRADE", header: { ...base.header, channel: "TRADES" },
    tradeId: "t", priceTicks: 80000, qty: 1, aggressor: "BUY", classification: "VENUE" };
  for (const event of [base, quote, trade]) {
    const result = guardEvent(createSequenceGuard(), event);
    expect([...result.state.seen]).toEqual([[encodeIdentity(event).key, encodeIdentity(event).fingerprint]]);
  }
  expect(new Set([base, quote, trade].map(e => encodeIdentity(e).key)).size).toBe(3);
});
it("sequenceScope changes full fingerprint but never identity key", () => {
  const a = encodeIdentity(base), b = encodeIdentity({ ...base, header: { ...base.header, sequenceScope: "INSTRUMENT" } });
  expect(a.key).toBe(b.key); expect(a.fingerprint).not.toBe(b.fingerprint);
  const first = guardEvent(createSequenceGuard(), base);
  expect(guardEvent(first.state, b.event).outcome).toBe("CONFLICT");
});
it("does not normalize Unicode, numeric IDs, spaces, case, or delimiters", () => {
  const ids = ["1", "01", " 1 ", "A", "a", "é", "e\u0301", "[1,2]", "1,2", "1\\2", "1\n2"];
  expect(new Set(ids.map(eventId => encodeIdentity({ ...base, header: { ...base.header, eventId } }).key)).size).toBe(ids.length);
});
it("compares complete bytes even under a simulated digest collision", () => {
  const a = encodeIdentity(base), b = encodeIdentity({ ...base, qty: 81 });
  const collision = (_value: string) => "same digest";
  expect(collision(a.fingerprint)).toBe(collision(b.fingerprint));
  expect(sameFingerprint(a.fingerprint, b.fingerprint, collision)).toBe(false);
  expect(sameFingerprint(a.fingerprint, a.fingerprint, collision)).toBe(true);
});
it("retains core Map/undefined semantics instead of storage Map semantics", () => {
  const a = { ...base, extra: new Map([["a", 1], ["b", 2]]), absent: undefined };
  const b = { ...base, extra: new Map([["b", 2], ["a", 1]]) };
  const oracle = _planGuardEvent(createSequenceGuard(), a);
  if (oracle.change !== "NEXT" || !oracle.insert) throw new Error("Missing oracle insert");
  expect(encodeIdentity(a).fingerprint).toBe(oracle.insert.fingerprint);
  expect(guardCanonical(a)).toBe(guardCanonical(b));
  expect(guardCanonical(a.extra)).toBe("{}");
  expect(storageCanonical(a.extra)).not.toBe(guardCanonical(a.extra));
  expect(guardCanonical({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
});
it.each(["[]", '["MOCK"]', '["a","b","c","d","e","f",1]', ' ["a","b","c","d","e","f","g"]'])
  ("rejects non-exact key encoding %s", key => expect(() => keyScope(key)).toThrow("IDENTITY"));
it("rejects a changed fingerprint paired with another event key", () => {
  const a = encodeIdentity(base), b = encodeIdentity({ ...base, header: { ...base.header, eventId: "different" } });
  expect(() => validateIdentity(a.key, b.fingerprint)).toThrow("IDENTITY");
});
it("distinguishes source alone inside a valid replay environment", () => {
  const events = ["MOCK_DETERMINISTIC", "VENDOR_UNVERIFIED", "VERIFIED_VENDOR"].map(source => ({
    ...base, header: { ...base.header, environment: "REPLAY_FROM_SAVED_DATA", source },
  }));
  const expected = events.map(event => {
    const plan = _planGuardEvent(createSequenceGuard(), event);
    if (plan.change !== "NEXT" || !plan.insert) throw new Error("Oracle did not insert");
    expect(encodeIdentity(event).key).toBe(plan.insert.key);
    return plan.insert.key;
  });
  expect(new Set(expected).size).toBe(3);
});
