import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { session, sessionAt, atET } from "../src/long-vp/calendar.ts";
import { purchasedVolumes, selectFrontMonths } from "../src/import/databento-front-month.ts";
import { sha, type StagedFile } from "../src/import/databento-stage.ts";

const bounds = { from: session("2026-10-01").startUs, to: session("2026-10-05").endUs };
test("daily volume picks all-out-right leader and never goes back to an earlier expiry", () => {
  const daily = new Map([
    ["2026-10-01", new Map([["GCZ26", 100], ["GCG27", 90]])],
    ["2026-10-02", new Map([["GCZ26", 100], ["GCG27", 101]])],
    ["2026-10-05", new Map([["GCZ26", 999], ["GCG27", 50], ["GCJ27", 49]])],
  ]);
  const days = selectFrontMonths(daily, bounds.from, bounds.to);
  assert.deepEqual(days.map(d => d.front?.contract), ["GCZ26", "GCG27", "GCG27"]);
  assert.equal(days[2]!.monotonicHeld, true);
  assert.equal(days[2]!.runnerUp?.contract, "GCZ26");
  assert.equal(days[2]!.front?.volume, 50);
});
test("ties keep previous front; otherwise earliest expiry, missing day keeps zero-volume front", () => {
  const daily = new Map([
    ["2026-10-01", new Map([["NQH27", 12], ["NQZ26", 12]])],
    ["2026-10-02", new Map([["NQH27", 12], ["NQZ26", 12]])],
  ]);
  const days = selectFrontMonths(daily, bounds.from, bounds.to);
  assert.deepEqual(days.map(d => d.front?.contract), ["NQZ26", "NQZ26", "NQZ26"]);
  assert.equal(days[2]!.front?.volume, 0);
});
test("canonical existing contracts match, different/mixed/unknown identities mark mismatch", () => {
  const daily = new Map([["2026-10-01", new Map([["NQZ26", 10]])]]);
  for (const [old, expected] of [[["NQZ6"], "match"], [["NQH27"], "mismatch"],
    [["NQZ6", "NQH27"], "mismatch"], [["unknown"], "mismatch"]] as const) {
    const days = selectFrontMonths(daily, bounds.from, session("2026-10-01").endUs, new Map([["2026-10-01", [...old]]]));
    assert.equal(days[0]!.existingStatus, expected);
  }
});
test("CT17 to next16 means ET18 to next17; maintenance excluded and partial purchase edges explicit", () => {
  assert.equal(sessionAt(atET("2026-10-01", 18))!.date, "2026-10-02");
  assert.equal(sessionAt(atET("2026-10-02", 17)), null);
  assert.equal(sessionAt(atET("2026-10-02", 16, 59))!.date, "2026-10-02");
  const b = session("2026-10-01");
  assert.equal(b.endUs - b.startUs, 23 * 3600e6);
  const days = selectFrontMonths(new Map(), b.startUs + 1, b.endUs - 1);
  assert.equal(days[0]!.partialPurchasePeriod, true);
  assert.equal(days[0]!.front, null);
});
test("UTC purchase end at midnight still includes the next CT trading date as a partial day", () => {
  const days = selectFrontMonths(new Map([["2026-10-30", new Map([["NQZ26", 22_880]])]]),
    Date.parse("2026-10-29T00:00:00Z") * 1000, Date.parse("2026-10-30T00:00:00Z") * 1000);
  assert.deepEqual(days.map(d => d.date), ["2026-10-29", "2026-10-30"]);
  assert.equal(days[1]!.partialPurchasePeriod, true);
  assert.equal(days[1]!.front?.volume, 22_880);
});
test("purchased raw scan verifies excluded spreads, includes N, excludes maintenance and never deduplicates", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "front-month-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage"), hash = "a".repeat(64);
  const known = [1, 2].map(seq => ({ contract: "GCZ26", side: "buy", size: 3, seq, tsUs: atET("2026-10-01", 10) }));
  known.push({ contract: "GCZ26", side: "buy", size: 20, seq: 3, tsUs: atET("2026-10-01", 17, 30) });
  const outputs: StagedFile["outputs"] = [];
  for (const [rel, rows] of [
    ["known/GCZ26/2026-10-01/14.jsonl.gz", known],
    ["unknown/GCZ26/2026-10-01/14.jsonl.gz", [{ contract: "GCZ26", side: "unknown", size: 4, tsUs: atET("2026-10-01", 10) }]],
    ["excluded.jsonl.gz", [{ reason: "calendar_spread", raw: "dummy spread" }]],
  ] as const) {
    const file = path.join(stage, hash, rel), content = rows.map(r => JSON.stringify(r) + "\n").join("");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, gzipSync(content));
    outputs.push({ path: rel, count: rows.length, sha256: await sha(file),
      contentHash: createHash("sha256").update(content).digest("hex") });
  }
  const staged = { sha256: hash, member: "fixture", rows: 5, errors: 0, spreads: 1, outputs,
    contracts: { GCZ26: { count: 4, buy: 26, sell: 0, unknown: 4 } } };
  await fs.writeFile(path.join(stage, hash, "verified.json"), JSON.stringify(staged));
  const active = path.join(root, "active.json");
  await fs.writeFile(active, JSON.stringify({ state: "verified_isolated", stage, staged: [staged],
    fromUs: session("2026-10-01").startUs, toUs: session("2026-10-02").endUs }));
  const result = await purchasedVolumes(active, "GC");
  assert.equal(result.daily.get("2026-10-01")!.get("GCZ26"), 10);
  assert.equal(result.audit.quantity, 30);
  assert.equal(result.audit.excludedMaintenanceVolume, 20);
  assert.equal(result.audit.excludedSpreadRows, 1);
  await fs.appendFile(path.join(stage, hash, outputs[0]!.path), "corrupt");
  await assert.rejects(purchasedVolumes(active, "GC"), /hash_changed/);
});
