import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { dayBounds, serializeDay } from "../src/long-vp/day.ts";
import { sha } from "../src/import/databento-stage.ts";
import { verifyRawDay, verifyExistingNqAssignments, type RawDayEvidence } from "../src/import/longvp-evidence.ts";
import { dayObject, fillDay } from "../src/import/longvp-promotion.ts";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longvp-raw-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bounds = dayBounds("2026-10-22"), start = bounds.startUs / 1e6;
  const a = new LongAggregate(), old = new LongAggregate();
  const trades = [
    { tsUs: bounds.startUs + 100, recvUs: bounds.startUs + 500, seq: 1, price: 100, size: 3, side: "buy" as const, contract: "NQZ26" },
    { tsUs: bounds.startUs + 200, recvUs: bounds.startUs + 500, seq: 2, price: 101, size: 4, side: "unknown" as const, contract: "NQZ26" },
    // Identical content with a distinct original row is deliberately counted twice.
    { tsUs: bounds.startUs + 200, recvUs: bounds.startUs + 500, seq: 3, price: 101, size: 4, side: "unknown" as const, contract: "NQZ26" },
    { tsUs: bounds.startUs + 150, recvUs: bounds.startUs + 500, seq: 4, price: 99, size: 2, side: "sell" as const, contract: "NQZ26" },
  ];
  for (const row of trades) a.add(row, "NQZ26");
  old.add({ ...trades[0]!, tsUs: bounds.startUs + 1800e6, size: 99 }, "NQZ6");
  const gaps: [number, number][] = [[start + 1800, bounds.endUs / 1e6]];
  const source = serializeDay("2026-10-22", a, [{ contract: "NQZ26", sinceUs: bounds.startUs }], gaps, bounds.endUs);
  const base = serializeDay("2026-10-22", old, [{ contract: "NQZ6", sinceUs: bounds.startUs }],
    [[start, start + 1800], [start + 3600, bounds.endUs / 1e6]], bounds.endUs);
  const assignments = [{ fromSec: start, toSec: bounds.endUs / 1e6,
    sourceContract: "NQZ26", targetContract: "NQZ6", evidence: "fixture snapshot" }];
  const filled = fillDay(base, source, assignments, "NQ", bounds.endUs);
  const pin = async (file: string, data: Buffer | string) => {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
    return { file, sha256: await sha(file) };
  };
  const rawFiles = [];
  for (let h = start; h < bounds.endUs / 1e6; h += 3600) {
    const iso = new Date(h * 1000).toISOString();
    rawFiles.push(await pin(path.join(root, `trades/NQ/${iso.slice(0, 10)}/${iso.slice(11, 13)}.jsonl.gz`),
      gzipSync(h === start ? trades.map(t => JSON.stringify(t) + "\n").join("") : "")));
  }
  const coverage = await pin(path.join(root, "coverage.json"), JSON.stringify({ book: [], tick: [[start, start + 1800]] }));
  const input: RawDayEvidence = { symbol: "NQ", source, candidate: filled.day, base,
    sourceContract: "NQZ26", targetContract: "NQZ6", accepted: filled.audit.accepted, rawFiles, coverage };
  return { root, input, assignments, pin, start };
}
test("raw proof preserves unknown, duplicate prints and timestamp rewinds; purchased-only continuity is separate", async t => {
  const { input } = await fixture(t), proof = await verifyRawDay(input);
  assert.equal(proof.acceptedTrades, 4); assert.equal(proof.buy, 3); assert.equal(proof.sell, 2);
  assert.equal(proof.unknown, 8); assert.equal(proof.weightedTicks, "1306");
  assert.equal(proof.rawBarsAndPricesMatch, true);
  assert.equal(proof.purchasedOnlyRebuildPreservesCandidate, false);
  assert.equal(proof.productionWriteAuthorized, false);
});
test("missing/duplicate hour, tampered raw bytes and missing coverage fail closed", async t => {
  const { input, pin, root } = await fixture(t);
  await assert.rejects(verifyRawDay({ ...input, rawFiles: input.rawFiles.slice(1) }), /missing_adopted_hour/);
  await assert.rejects(verifyRawDay({ ...input, rawFiles: [...input.rawFiles, input.rawFiles[0]!] }), /hour_inventory/);
  const coverage = await pin(path.join(root, "missing-coverage.json"), '{"tick":[]}');
  await assert.rejects(verifyRawDay({ ...input, coverage }), /coverage_or_overlap/);
  await fs.appendFile(input.rawFiles[0]!.file, "changed");
  await assert.rejects(verifyRawDay(input), /hash_changed/);
});
test("matching slot totals cannot hide a price or OHLC mismatch", async t => {
  const { input } = await fixture(t);
  const price = { ...input, candidate: structuredClone(input.candidate) }; price.candidate.vp30m[0]![1]++;
  await assert.rejects(verifyRawDay(price), /raw_vp30m_mismatch/);
  const bar = { ...input, candidate: structuredClone(input.candidate) }; bar.candidate.bars1m[0]![4] = 100;
  await assert.rejects(verifyRawDay(bar), /raw_bars1m_mismatch/);
});
test("existing tuple changes, raw overlap and candidate gap claims are rejected", async t => {
  const { input } = await fixture(t);
  const altered = { ...input, candidate: structuredClone(input.candidate) }; altered.candidate.bars1m.at(-1)![5]++;
  await assert.rejects(verifyRawDay(altered), /existing_rows_changed/);
  const overlap = structuredClone(input); overlap.base!.bars1m[0]![0] = input.accepted[0]!;
  await assert.rejects(verifyRawDay(overlap), /coverage_or_overlap/);
  const gaps = structuredClone(input); gaps.candidate.gaps.push([input.accepted[0]!, input.accepted[0]! + 1]);
  await assert.rejects(verifyRawDay(gaps), /coverage_or_overlap/);
});
test("NQ assignment evidence is hash-pinned and cannot extend beyond recorded contract spans", async t => {
  const { root, pin, input, assignments } = await fixture(t);
  const object = await pin(path.join(root, "day.gz"), gzipSync(JSON.stringify(input.base)));
  const inventory = { version: 1 as const, symbol: "NQ" as const, capturedAt: "2026-10-30T00:00:00Z",
    objects: [{ ...object, name: dayObject("NQ", input.source.tradingDate) }] };
  const proof = await verifyExistingNqAssignments(assignments, inventory);
  assert.equal(proof.authorizesGc, false); assert.equal(proof.authorizesNewDates, false);
  await assert.rejects(verifyExistingNqAssignments([{ ...assignments[0]!, fromSec: assignments[0]!.fromSec - 1 }], inventory),
    /not_supported/);
  await assert.rejects(verifyExistingNqAssignments([{ ...assignments[0]!, sourceContract: "NQH27" }], inventory),
    /not_supported/);
  await fs.appendFile(object.file, "changed");
  await assert.rejects(verifyExistingNqAssignments(assignments, inventory), /hash_changed/);
});
