import { expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSequenceGuard, guardEvent, _planGuardEvent } from "@workspace/core/sequence-guard";
import { F01_BOOK } from "../storageFixtures";
import { checksum } from "../sqliteCatalog";
import { encodeIdentity } from "./identityCodec";
import { SqliteLedger } from "./sqliteLedger";
import { HistoricalLedgerView, type Cursor } from "./historicalLedgerView";
import { PendingBranch, type PendingInsert } from "./pendingBranch";

function withLedger(run: (ledger: SqliteLedger) => void, coverage?: "UNPROVEN") {
  const ledger = SqliteLedger.create({ scopeId: encodeIdentity(F01_BOOK.events[0]).scopeId,
    epoch: "E1", evidence: "Fixed complete MOCK from empty start, independent core oracle", coverage });
  try { run(ledger); } finally { ledger.close(); rmSync(ledger.location.directory, { recursive: true, force: true }); }
}
function oracleInserts() {
  let state = createSequenceGuard();
  const inserts: PendingInsert[] = [], states = [state];
  for (const [i, event] of F01_BOOK.events.entries()) {
    const next = guardEvent(state, event);
    for (const [key, fingerprint] of next.state.seen) if (!state.seen.has(key))
      inserts.push({ key, fingerprint, first: { position: String(Math.floor(i / 2) + 1), ordinal: i % 2 } });
    state = next.state; states.push(state);
  }
  return { inserts, states };
}
it("persists full bytes/birth/order, reopens, and replays BEFORE/AFTER each oracle cursor", () => withLedger(ledger => {
  const { inserts, states } = oracleInserts();
  const receipt = ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  const location = ledger.location; ledger.close();
  const reopened = SqliteLedger.open(location, receipt);
  try {
    for (let i = 0; i < inserts.length; i++) {
      expect([...reopened.view(inserts[i].first).materializeNative()]).toEqual([...states[i].seen]);
      expect([...reopened.view(inserts[i].first, true).materializeNative()]).toEqual([...states[i + 1].seen]);
    }
    expect(reopened.receipt()).toEqual(receipt);
  } finally { reopened.close(); }
}));
it("independently compares private old decisions using historical ledger lookup", () => withLedger(ledger => {
  const { inserts } = oracleInserts(); ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  let native = createSequenceGuard();
  for (const [i, event] of F01_BOOK.events.entries()) {
    const port = ledger.view(inserts[i].first), expected = guardEvent(native, event);
    const actual = _planGuardEvent({ heads: native.heads, seen: port }, event);
    expect({ outcome: actual.outcome, reason: actual.reason, apply: actual.apply, verification: actual.verification })
      .toEqual({ outcome: expected.outcome, reason: expected.reason, apply: expected.apply, verification: expected.verification });
    native = expected.state;
  }
}));
it("pending -> ledger persists exactly the adopted Native Map, including successful retry after SQL rollback", () => withLedger(ledger => {
  const old = ledger.receipt(), base = ledger.verify(), view = ledger.view(base.through, true);
  const p = new PendingBranch({ snapshot: base, get: k => view.get(k), materializeNative: () => view.materializeNative() });
  let oracle = createSequenceGuard();
  for (const [i, event] of F01_BOOK.events.entries()) {
    oracle = guardEvent(oracle, event).state; p.stage([event], oracle, { position: String(i + 1), ordinal: 0 });
  }
  const sealed = p.seal();
  expect(() => ledger.commit(sealed.inserts, sealed.through, old, () => { throw new Error("SQL failure"); })).toThrow("SQL failure");
  expect(ledger.receipt()).toEqual(old); expect(ledger.verify().count).toBe(0);
  const location = ledger.location; ledger.close();
  const reopened = SqliteLedger.open(location, old);
  try {
    reopened.commit(sealed.inserts, sealed.through, old);
    expect([...reopened.view(sealed.through, true).materializeNative()]).toEqual([...oracle.seen]);
  } finally { reopened.close(); }
}));
it("re-delivery and CONFLICT never overwrite first fingerprint, including across epoch changes", () => withLedger(ledger => {
  const { inserts } = oracleInserts(); ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  const root = ledger.receipt().root, first = inserts[0];
  const before = ledger.view(inserts.at(-1)!.first, true).get(first.key);
  ledger.switchEpoch("E2", ledger.receipt());
  expect(ledger.receipt().root).toBe(root);
  expect(ledger.view(inserts.at(-1)!.first, true).get(first.key)).toBe(before);
  expect(() => new HistoricalLedgerView(ledger.port(), first.first, { epoch: "E1" })).toThrow("EPOCH_MISMATCH");
  const freshBirth = { ...first, first: { position: "4", ordinal: 0 } };
  expect(() => ledger.commit([freshBirth], freshBirth.first, ledger.receipt())).toThrow();
  expect(ledger.verify().count).toBe(5); expect(ledger.receipt().root).toBe(root);
  const pbase = ledger.verify(), view = ledger.view(pbase.through, true);
  const p = new PendingBranch({ snapshot: pbase, get: k => view.get(k), materializeNative: () => view.materializeNative() });
  const native = { heads: createSequenceGuard().heads, seen: view.materializeNative() };
  const duplicate = guardEvent(native, F01_BOOK.events[0]); expect(duplicate.outcome).toBe("DUPLICATE");
  p.stage([F01_BOOK.events[0]], duplicate.state, { position: "4", ordinal: 0 });
  const conflict = guardEvent(duplicate.state, { ...F01_BOOK.events[0], impliedPolicy: "EXCLUDE" });
  expect(conflict.outcome).toBe("CONFLICT");
  p.stage([{ ...F01_BOOK.events[0], impliedPolicy: "EXCLUDE" }], conflict.state, { position: "5", ordinal: 0 });
  ledger.commit(p.seal().inserts, p.seal().through, ledger.receipt());
  expect(ledger.receipt().root).toBe(root); expect(ledger.verify().count).toBe(5);
}));
it.each(["missing", "extra", "birth-position", "birth-ordinal", "insert-order", "fp-part-missing", "fp-part-changed", "extra-part", "orphan-part"])
  ("detects %s corruption without a success fallback", mode => withLedger(ledger => {
    const { inserts } = oracleInserts(); ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
    const key = inserts[1].key;
    ledger.db.pragma("foreign_keys=OFF");
    if (mode === "missing") ledger.db.prepare("DELETE FROM ledger_entries WHERE key=?").run(key);
    if (mode === "extra") {
      const e = encodeIdentity({ ...F01_BOOK.events[1], header: { ...F01_BOOK.events[1].header, eventId: "extra" } });
      ledger.db.prepare(`INSERT INTO ledger_entries SELECT ?,namespace,scope_id,first_epoch,9,0,99,
        byte_count,part_count,fp_digest,checksum FROM ledger_entries LIMIT 1`).run(e.key);
    }
    if (mode === "birth-position") ledger.db.prepare("UPDATE ledger_entries SET first_position=2 WHERE key=?").run(key);
    if (mode === "birth-ordinal") ledger.db.prepare("UPDATE ledger_entries SET first_ordinal=7 WHERE key=?").run(key);
    if (mode === "insert-order") ledger.db.prepare("UPDATE ledger_entries SET insert_order=99 WHERE key=?").run(key);
    if (mode === "fp-part-missing") ledger.db.prepare("DELETE FROM fingerprint_parts WHERE key=? AND part=0").run(key);
    if (mode === "fp-part-changed") ledger.db.prepare("UPDATE fingerprint_parts SET bytes=x'FF' WHERE key=? AND part=0").run(key);
    if (mode === "extra-part") ledger.db.prepare("INSERT INTO fingerprint_parts VALUES(?,99,x'00')").run(key);
    if (mode === "orphan-part") ledger.db.exec("INSERT INTO fingerprint_parts VALUES('orphan',0,x'00')");
    expect(() => ledger.verify()).toThrow();
  }));
it("duplicate complete key is constrained independently of epoch", () => withLedger(ledger => {
  const { inserts } = oracleInserts(); ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  expect(() => ledger.db.exec(`INSERT INTO ledger_entries SELECT key,namespace,scope_id,'E999',
    9,0,99,byte_count,part_count,fp_digest,checksum FROM ledger_entries LIMIT 1`)).toThrow(/UNIQUE/);
}));
it("full fingerprint spans parts, and any missing part is fatal", () => withLedger(ledger => {
  const event = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, eventId: "日本語😀".repeat(6000) } };
  const oracle = guardEvent(createSequenceGuard(), event), pair = [...oracle.state.seen][0];
  ledger.commit([{ key: pair[0], fingerprint: pair[1], first: { position: "1", ordinal: 0 } }],
    { position: "1", ordinal: 0 }, ledger.receipt());
  expect(ledger.view({ position: "1", ordinal: 0 }, true).get(pair[0])).toBe(pair[1]);
  expect((ledger.db.prepare("SELECT count(*) AS n FROM fingerprint_parts").get() as { n: number }).n).toBeGreaterThan(1);
  ledger.db.exec("DELETE FROM fingerprint_parts WHERE part=1");
  expect(() => ledger.verify()).toThrow("LEDGER_CORRUPT");
}));
it("binds anchor seed, reopens, and refuses missing/orphan seed", () => withLedger(ledger => {
  const { inserts, states } = oracleInserts();
  ledger.commit(inserts.slice(0, 2), inserts[1].first, ledger.receipt());
  const receipt = ledger.bindSeed("seed", "anchor", ledger.receipt()), location = ledger.location;
  ledger.close(); const reopened = SqliteLedger.open(location, receipt);
  try {
    expect(reopened.view(inserts[1].first).materializeNative()).toEqual(states[2].seen);
    expect(() => reopened.view(inserts[0].first)).toThrow("BEFORE_SEED");
    reopened.db.exec("DELETE FROM ledger_seed");
    expect(() => reopened.verify()).toThrow("SEED_BINDING");
  } finally { reopened.close(); }
}));
it("rejects an orphan seed even if no binding was requested", () => withLedger(ledger => {
  ledger.db.prepare("INSERT INTO ledger_seed VALUES('orphan',?,?)").run("{}", checksum({}));
  expect(() => ledger.verify()).toThrow("SEED_BINDING");
}));
it("stops unproven scope coverage rather than accepting a lookup miss", () => withLedger(ledger => {
  expect(() => ledger.view({ position: "0", ordinal: 0 }, true)).toThrow("COVERAGE_UNPROVEN");
  expect(() => ledger.commit([], { position: "1", ordinal: 0 }, ledger.receipt())).toThrow("COVERAGE_UNPROVEN");
}, "UNPROVEN"));
it("rejects stale receipt, missing marker and unsupported DB without opening product DBs", () => withLedger(ledger => {
  const old = ledger.receipt(), { inserts } = oracleInserts();
  ledger.commit(inserts, inserts.at(-1)!.first, old);
  const location = ledger.location; ledger.close();
  expect(() => SqliteLedger.open(location, old)).toThrow("LEDGER_RECEIPT");
  writeFileSync(join(location.directory, ".r166-p1b-owner"), "wrong");
  expect(() => SqliteLedger.open(location, old)).toThrow("LEDGER_OWNERSHIP");
  expect(() => SqliteLedger.open({ directory: "/not-a-prototype", token: location.token }, old)).toThrow();
}));
it("rejects oversized fingerprint/commit without losing prior root", () => withLedger(ledger => {
  const old = ledger.receipt(), { inserts } = oracleInserts();
  const giant = encodeIdentity({ ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, eventId: "x".repeat(1024 * 1024) } });
  expect(() => ledger.commit([{ key: giant.key, fingerprint: giant.fingerprint, first: { position: "1", ordinal: 0 } }],
    { position: "1", ordinal: 0 }, old)).toThrow("BUDGET_EXCEEDED");
  expect(() => ledger.commit(Array(129).fill(inserts[0]), { position: "1", ordinal: 0 }, old)).toThrow("BUDGET_EXCEEDED");
  expect(ledger.receipt()).toEqual(old);
}));
it("refuses a view pinned before a later commit instead of mixing generations", () => withLedger(ledger => {
  const view = ledger.view({ position: "0", ordinal: 0 }, true), { inserts } = oracleInserts();
  ledger.commit([inserts[0]], inserts[0].first, ledger.receipt());
  expect(() => view.get(inserts[0].key)).toThrow("LEDGER_RECEIPT");
}));
it("real SQLite UNIQUE failure rolls back earlier inserts in the same transaction and survives reopen", () => withLedger(ledger => {
  const { inserts } = oracleInserts();
  ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  const before = ledger.receipt();
  const fresh = encodeIdentity({ ...F01_BOOK.events[1], header: { ...F01_BOOK.events[1].header, eventId: "new-before-failure" } });
  const additions = [
    { key: fresh.key, fingerprint: fresh.fingerprint, first: { position: "4", ordinal: 0 } },
    { ...inserts[0], first: { position: "5", ordinal: 0 } },
  ];
  expect(() => ledger.commit(additions, additions[1].first, before)).toThrow(/UNIQUE constraint/);
  expect(ledger.receipt()).toEqual(before);
  const location = ledger.location; ledger.close();
  const reopened = SqliteLedger.open(location, before);
  try { expect(reopened.port().entry(fresh.key)).toBeUndefined(); expect(reopened.verify().count).toBe(5); }
  finally { reopened.close(); }
}));
it("does not lose full first fingerprints when only a visibility epoch changes", () => withLedger(ledger => {
  const { inserts } = oracleInserts(); ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  ledger.bindSeed("seed", "anchor", ledger.receipt());
  const receipt = ledger.switchEpoch("E2", ledger.receipt()), location = ledger.location;
  ledger.close(); const reopened = SqliteLedger.open(location, receipt);
  try {
    expect(reopened.view(inserts.at(-1)!.first).materializeNative().size).toBe(5);
    for (const input of inserts) expect(reopened.view(inserts.at(-1)!.first).get(input.key)).toBe(input.fingerprint);
  } finally { reopened.close(); }
}));
it.each(["seed-checksum", "seed-anchor", "seed-root"])("rejects %s tampering", kind => withLedger(ledger => {
  const { inserts } = oracleInserts(); ledger.commit(inserts, inserts.at(-1)!.first, ledger.receipt());
  ledger.bindSeed("seed", "anchor", ledger.receipt());
  if (kind === "seed-checksum") ledger.db.exec("UPDATE ledger_seed SET checksum='corrupt'");
  if (kind === "seed-anchor") ledger.db.exec(`UPDATE ledger_seed SET payload=replace(payload,'anchor','different')`);
  if (kind === "seed-root") ledger.db.exec(`UPDATE ledger_seed SET payload=replace(payload,'entriesRoot','otherRoot')`);
  expect(() => ledger.verify()).toThrow("SEED_BINDING");
}));
it("refuses a rewritten ledger against an independently retained receipt", () => withLedger(ledger => {
  const { inserts } = oracleInserts(), old = ledger.receipt();
  ledger.commit(inserts, inserts.at(-1)!.first, old);
  const valid = ledger.receipt();
  expect(valid.root).not.toBe(old.root);
  const location = ledger.location; ledger.close();
  expect(() => SqliteLedger.open(location, old)).toThrow("LEDGER_RECEIPT");
  const reopened = SqliteLedger.open(location, valid);
  reopened.close();
}));
it("refuses corrupt header and ownership mismatch instead of treating an arbitrary DB as a ledger", () => withLedger(ledger => {
  const receipt = ledger.receipt(), location = ledger.location;
  ledger.db.pragma("application_id=123"); ledger.close();
  expect(() => SqliteLedger.open(location, receipt)).toThrow("LEDGER_OWNERSHIP");
}));
