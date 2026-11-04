import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { nqOnly, emptyBaseline, census, hourCauses } from "../research-v2/rebuild-nq-generation.ts";
import { install } from "../src/import/databento-install.ts";
import { tradeFileEntries } from "../src/store/records.ts";
import { sha, emptyStats, type StagedFile } from "../src/import/databento-stage.ts";

test("research NQ caller: empty baseline adopts B/A/N, no foreign contract, rewinds/identical rows kept; existing files immutable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-nq-empty-"));
  try {
    const stage = path.join(dir, "stage"), baseline = path.join(dir, "empty"), generation = path.join(dir, "generation");
    const hour = Date.parse("2026-10-26T22:00:00Z") * 1000;
    const buy = { tsUs: hour + 10, price: 100, size: 2, side: "buy", seq: 1, contract: "NQZ26" };
    const rows = [buy, { ...buy, side: "unknown", size: 7, seq: 2, tsUs: hour + 5 },
      { ...buy, seq: 3 }, { ...buy, side: "sell", size: 3, seq: 4 }];
    const outputs = [];
    for (const kind of ["known", "unknown"]) {
      const p = `${kind}/NQZ26/2026-10-26/22.jsonl.gz`;
      const file = path.join(stage, "abc", p); await fs.mkdir(path.dirname(file), { recursive: true });
      const subset = rows.filter(r => kind === "unknown" ? r.side === "unknown" : r.side !== "unknown");
      await fs.writeFile(file, gzipSync(subset.map(r => JSON.stringify(r)).join("\n") + "\n"));
      outputs.push({ path: p, sha256: await sha(file), contentHash: "", count: subset.length });
    }
    outputs.push({ path: "known/NQH27/2026-10-26/22.jsonl.gz", sha256: "", contentHash: "", count: 1 });
    const staged = [{ member: "fixture", sha256: "abc", rows: 5, errors: 0, spreads: 0,
      contracts: { NQZ26: emptyStats(), NQH27: emptyStats() }, outputs }] as StagedFile[];
    const selected = nqOnly(staged); assert.deepEqual(Object.keys(selected[0]!.contracts), ["NQZ26"]);
    assert.equal(staged[0]!.outputs.length, 3); assert.equal(selected[0]!.outputs.length, 2);
    const before = await census([stage]);
    await emptyBaseline(baseline);
    const result = await install(selected, stage, generation, baseline, hour, hour + 3600e6, new Set(["2026-10-26"]));
    assert.deepEqual(Object.keys(result), ["NQZ26"]);
    const out = path.join(generation, "NQZ26"), actual = [];
    for await (const x of tradeFileEntries(path.join(out, "trades/NQ/2026-10-26/22.jsonl.gz"))) actual.push(x.trade);
    assert.deepEqual(actual, rows);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, "coverage.json"), "utf8")), { book: [], tick: [[hour / 1e6, hour / 1e6 + 3600]] });
    assert.deepEqual(await census([stage]), before);
    assert.equal(await fs.stat(path.join(out, "trades/GC")).then(() => true, () => false), false);
    await assert.rejects(emptyBaseline(baseline), /EEXIST/);
    const causes = hourCauses([{ hour: "2026-10-26/22", unknownSide: true, blocked: "existing_contract_unknown" }], []);
    assert.equal(causes.length, 1); assert.equal(causes[0]!.missing_seconds, 3600);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
