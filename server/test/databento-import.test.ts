import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { priceTicks, timestamp, convert, fields } from "../src/import/databento-csv.ts";
import { canonical, sha } from "../src/import/databento-stage.ts";
import { rebuild } from "../src/import/databento-rebuild.ts";
import { replaceHour } from "../src/import/databento-install.ts";
import { tradeFileEntries } from "../src/store/records.ts";
const stamp = "2026-09-30T00:00:00.003307752Z";
test("empty contract interval rebuilds zero without inventing coverage or hiding I/O errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "databento-empty-"));
  try {
    const result = await rebuild(root, "GCF27");
    assert.equal(result.totals.count, 0);
    assert.deepEqual(result.sessions, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
function csv(side = "B", symbol = "NQZ6", price = "30712.500000000") {
  return `${stamp},2026-09-30T00:00:00.002976833Z,0,1,261401,T,${side},0,${price},2,0,12785,250063934,${symbol}`;
}
test("Databento decimal/UTC ns conversion keeps original precision; B/A/N separate", () => {
  assert.equal(priceTicks("30712.500000000", "0.25"), 122850);
  assert.equal(priceTicks("2700.100000000", "0.10"), 27001);
  assert.throws(() => priceTicks("30712.100000000", "0.25"), /off_tick/);
  assert.equal(timestamp(stamp).us, 1790726400003307);
  assert.equal(timestamp(stamp).ns, "1790726400003307752");
  assert.throws(() => timestamp("2026-02-30T00:00:00Z"), /invalid_utc/);
  assert.equal(convert(csv(), 1).trade.tsUs, 1790726400002976);
  assert.equal(convert(csv("B"), 1).trade.side, "buy");
  assert.equal(convert(csv("A"), 1).trade.side, "sell");
  assert.equal(convert(csv("N"), 1).trade.side, "unknown");
  assert.throws(() => convert(csv("X"), 1), /invalid_side/);
  assert.throws(() => convert(csv("A", "NQZ6-NQH7", "369.05"), 1), /calendar_spread/);
  assert.equal(canonical("NQZ6", 2026), "NQZ26");
  assert.equal(canonical("NQH7", 2026), "NQH27");
  assert.equal(fields('"a,b","c""d"')[1], 'c"d');
});
test("isolated range replacement keeps identical distinct trades, outside rows/order, readback and rerun", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "databento-test-"));
  try {
    const file = path.join(root, "base.jsonl.gz"), fresh = path.join(root, "source.jsonl.gz"), baseline = path.join(root, "baseline.jsonl.gz");
    const row = (tsUs: number, seq: number, contract = "NQZ26") =>
      ({ tsUs, recvUs: tsUs, seq, contract, price: 120000, size: 2, side: "buy" as const });
    const old = [row(1, 1), row(20, 2), row(90, 3), row(91, 4, "NQH27")];
    const next = [row(21, 10), row(21, 11), row(19, 12), row(50, 13)]; // valid timestamp rewind
    await fs.writeFile(file, gzipSync(old.map(x => JSON.stringify(x) + "\n").join("")));
    await fs.copyFile(file, baseline);
    await fs.writeFile(fresh, gzipSync(next.map(x => JSON.stringify(x) + "\n").join("")));
    const result = await replaceHour(file, [fresh], "NQZ26", 10, 80, false);
    assert.equal(result.adopted.count, 4);
    const entries = []; for await (const x of tradeFileEntries(file)) entries.push(x.trade);
    assert.deepEqual(entries, [old[0], ...next, old[2], old[3]]);
    const once = await sha(file);
    await replaceHour(file, [fresh], "NQZ26", 10, 80, false);
    assert.equal(await sha(file), once); // no additional rows on rerun
    const resumed = await replaceHour(file, [fresh], "NQZ26", 10, 80, false, undefined, baseline);
    assert.equal(resumed.adopted.count, 4); assert.equal(await sha(file), once);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(replaceHour(file, [fresh], "NQZ26", 10, 80, false, abort.signal));
    assert.equal(await sha(file), once);
    await fs.writeFile(file, gzipSync(JSON.stringify({ ...old[1], contract: undefined }) + "\n"));
    const unknown = await sha(file);
    assert.equal((await replaceHour(file, [fresh], "NQZ26", 10, 80, false)).blocked, "existing_contract_unknown");
    assert.equal(await sha(file), unknown);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
