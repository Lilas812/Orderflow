import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, crc32 } from "node:zlib";
import { LabelsStore } from "../src/labels/store.ts";
import { LabelsCloudFixture } from "./labels-cloud-fixture.ts";
import { DayData, calculate, FEATURES, valueArea, boardFeatures, sessionClock, nextSession, precedingSession } from "../src/labels/features.ts";
import { sessionStartSec } from "../src/vp/state.ts";
import { labelContext, approachBefore, type TurningLabel } from "../../lib/market/labels.ts";
import { LocalStore } from "../src/store/local.ts";
import { HistoryProcess } from "../src/history/process.ts";
import { COLUMNS } from "../src/labels/export.ts";
import { exportLabels } from "../src/labels/export.ts";
import { enrichDivergence } from "../src/labels/reader.ts";
import express from "express";
import { createServer } from "node:http";
import { labelsRouter } from "../src/labels/routes.ts";

const t = Math.floor(Date.parse("2026-10-29T18:20:00Z") / 1000);
const label = (id = "test-label-1", symbol: "NQ" | "GC" = "NQ"): TurningLabel => ({
  id, symbol, tsSec: t, priceTicks: 100, kind: "top", confidence: 2, note: "ISOLATED SYNTHETIC",
  expectedDirection: "down", futureSeconds: 0, viewMode: "blind", screen: "heatmap", createdUs: 1, updatedUs: 1,
});
test("labels CAS CRUD / same-input retry / symbol isolation / immutable origin", async () => {
  const cloud = new LabelsCloudFixture(), store = new LabelsStore(cloud, "dev/");
  assert.deepEqual((await store.get("NQ")).labels, []); assert.equal(cloud.writes, 0);
  const a = await store.mutate("NQ", "0", "POST", label());
  assert.equal(a.generation, "1"); assert.equal(a.labels.length, 1);
  assert.deepEqual(await store.mutate("NQ", "0", "POST", label()), a); assert.equal(cloud.writes, 1);
  await assert.rejects(store.mutate("NQ", "0", "POST", label("test-label-2")), /generation_conflict/);
  const edited = { ...a.labels[0]!, kind: "failed" as const, note: "edited" };
  const b = await store.mutate("NQ", a.generation, "PUT", edited, undefined, edited.updatedUs);
  assert.ok(b.labels[0]!.updatedUs > edited.updatedUs); assert.equal(b.labels[0]!.futureSeconds, 0);
  await assert.rejects(store.mutate("NQ", b.generation, "PUT", { ...b.labels[0]!, tsSec: t + 1 },
    undefined, b.labels[0]!.updatedUs), /origin_immutable/);
  assert.equal((await store.get("GC")).labels.length, 0);
  await store.mutate("GC", "0", "POST", label("gc-label-1", "GC"));
  await store.mutate("NQ", b.generation, "DELETE", null, edited.id, b.labels[0]!.updatedUs);
  assert.equal((await store.get("NQ")).labels.length, 0); assert.equal((await store.get("GC")).labels.length, 1);
});
test("concurrent CAS writes preserve exactly one winner; failures/corruption never create defaults", async () => {
  const cloud = new LabelsCloudFixture(), a = new LabelsStore(cloud, "dev/"), b = new LabelsStore(cloud, "dev/");
  const results = await Promise.allSettled([a.mutate("NQ", "0", "POST", label("parallel-1")),
    b.mutate("NQ", "0", "POST", label("parallel-2"))]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await a.get("NQ")).labels.length, 1);
  const bytes = Buffer.from("broken original");
  cloud.data.set("dev/labels/GC.json", { bytes, generation: "5" });
  await assert.rejects(a.get("GC"), /io_failed/); assert.deepEqual(cloud.data.get("dev/labels/GC.json")!.bytes, bytes);
  cloud.failRead = true; const writes = cloud.writes;
  await assert.rejects(a.mutate("NQ", "1", "POST", label("unreadable-1")), /io_failed/);
  assert.equal(cloud.writes, writes);
});
test("viewMode and known-future seconds / approach uses only past, unordered distinct prices", () => {
  assert.deepEqual(labelContext(t, t * 1e6 + 300_000, true, false), { viewMode: "blind", futureSeconds: .3 });
  assert.equal(labelContext(t, (t + 2) * 1e6, true, true).viewMode, "hindsight");
  assert.equal(labelContext(t, (t + 2) * 1e6, false, true).viewMode, "live");
  assert.equal(labelContext(t, t * 1e6, false, false).viewMode, "hindsight");
  assert.equal(approachBefore([{ tsUs: 2, price: 101 }, { tsUs: 1, price: 100 }, { tsUs: 4, price: 50 }], 3), "up");
  assert.equal(approachBefore([{ tsUs: 1, price: 100 }], 3), null);
});
test("CT17 reset and US cash open survive 25-hour DST session", () => {
  const start = sessionStartSec(Date.parse("2026-10-31T23:00:00Z") / 1000);
  assert.equal(nextSession(start) - start, 25 * 3600);
  assert.equal(sessionClock(Date.parse("2026-11-02T14:30:00Z") / 1000).minutesFromUsOpen, 0);
  assert.equal(sessionClock(start).minutesFromSession, 0);
  assert.equal(new Date(precedingSession(Date.parse("2026-11-01T23:00:00Z") / 1000) * 1000).toISOString(),
    "2026-10-29T22:00:00.000Z");
});
function synthetic() {
  const data = new DayData(sessionStartSec(t));
  data.cover(data.start, data.end);
  let seq = 0;
  for (let s = t - 1800; s < t; s++) data.add({ tsUs: s * 1e6, recvUs: s * 1e6, seq: ++seq,
    price: 100, size: 1, side: "buy", contract: "NQZ6" });
  for (let s = t - 30; s < t; s++) data.add({ tsUs: s * 1e6 + 1, recvUs: s * 1e6 + 1, seq: ++seq,
    price: 100, size: 2, side: "sell", contract: "NQZ6" });
  data.add({ tsUs: (t - 1) * 1e6 + 2, recvUs: (t - 1) * 1e6 + 2, seq: ++seq, price: 100, size: 4,
    side: "unknown", contract: "NQZ6" }); data.finish(); return data;
}
test("hand-calculated quantities, unknown excluded only from direction; zero is not missing", () => {
  const data = synthetic(), out = calculate(label(), data);
  assert.equal(out.values.buy_30s, 30); assert.equal(out.values.sell_30s, 60); assert.equal(out.values.delta_30s, -30);
  assert.equal(out.values.rv_30m, 0); assert.equal(out.values.max_size_5m, 4); assert.equal(out.values.absorption_60s, 60);
  assert.equal(out.values.direction_30m, null); assert.equal(out.reasons.direction_30m, "coverage_contract_or_zero_range");
  assert.deepEqual(valueArea(new Map([[100, 5], [101, 5]])), { poc: 101, vah: 101, val: 100 });
});
test("every feature is invariant to arbitrary post-mark mutation; outcomes may change", () => {
  const a = synthetic(), before = calculate(label(), a);
  for (let s = t; s < t + 900; s++) a.add({ tsUs: s * 1e6, recvUs: s * 1e6, seq: 10_000 + s,
    price: 1000, size: 10000, side: "sell", contract: "GCG7" });
  a.finish(); const after = calculate(label(), a);
  for (const k of Object.keys(FEATURES)) assert.equal(before.values[k], after.values[k], k);
  assert.notEqual(before.values.move_15m, after.values.move_15m);
});
test("missing coverage and mixed contracts never silently become zero", () => {
  const data = synthetic(); data.known[t - 1 - data.start] = 0; data.finish();
  assert.equal(calculate(label(), data).values.buy_30s, null);
  const b = synthetic(); b.add({ tsUs: (t - 1) * 1e6 + 50, recvUs: t * 1e6, seq: 9999, price: 101,
    size: 1, side: "buy", contract: "NQH7" }); b.finish();
  assert.equal(calculate(label(), b).values.buy_30s, null);
});
test("board ratio, exact 60s changes, known depth vs out-of-range cancellation", () => {
  const data = synthetic(), out = calculate(label(), data);
  const rows = new Map<number, { tsSec: number; source: "live"; bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }>();
  for (let s = t - 61; s < t; s++) rows.set(s, { tsSec: s, source: "live",
    bids: [{ price: 99, size: 20 - (s === t - 1 ? 5 : 0) }], asks: [{ price: 101, size: 10 }] });
  boardFeatures(label(), rows, new Map([[t - 1, new Map([[99, 2]])]]), true, out);
  assert.equal(out.values.imbalance_1, .2); assert.equal(out.values.bid10_change_60s, -5);
  assert.equal(out.values.estimated_pull_60s, 3);
  rows.delete(t - 10); boardFeatures(label(), rows, new Map(), true, out);
  assert.equal(out.values.estimated_pull_60s, null);
});
test("read-only snapshots: persisted bodies, own lifetime, missing file is UNKNOWN", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "labels-snapshot-test-"));
  try {
    const hour = Math.floor(t / 3600) * 3600, iso = new Date(hour * 1000).toISOString();
    const trades = path.join(root, "trades/NQ", iso.slice(0, 10));
    await fs.mkdir(trades, { recursive: true });
    await fs.writeFile(path.join(trades, iso.slice(11, 13) + ".jsonl.gz"), gzipSync(""));
    await fs.writeFile(path.join(root, "coverage.json"), JSON.stringify({ book: [[hour, hour + 3600]], tick: [[hour, hour + 3600]] }));
    const store = new LocalStore(root);
    const a = await store.labelHourInput(hour, path.join(root, "a")), b = await store.labelHourInput(hour, path.join(root, "b"));
    assert.deepEqual(a.bookCoverage, []); assert.deepEqual(a.tickCoverage, [[hour, hour + 3600]]);
    await fs.rm(path.join(root, "a"), { recursive: true });
    assert.ok((await fs.stat(b.tick!)).size); assert.equal((await store.labelHourInput(hour + 3600, path.join(root, "c"))).tickCoverage.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

export function readStoredZip(bytes: Buffer) {
  const files = new Map<string, Buffer>();
  let end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 24), len = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + len).toString(), local = bytes.readUInt32LE(offset + 42);
    const begin = local + 30 + bytes.readUInt16LE(local + 26);
    const body = bytes.subarray(begin, begin + size);
    assert.equal(crc32(body), bytes.readUInt32LE(offset + 16)); files.set(name, body);
    offset += 46 + len + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return files;
}
test("empty export uses the real nice-19 IPC worker, valid ZIP/schema, abort cleanup, no REST", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "labels-worker-test-"));
  const worker = new HistoryProcess("ISOLATED-NO-API", () => {}, undefined, "http://127.0.0.1:1");
  try {
    const response = await worker.labelsExport({ symbol: "NQ", fromSec: t, toSec: t + 60, labels: [],
      tickRanges: [], directory: root }, async () => { throw Error("empty_export_must_not_read"); }, new AbortController().signal);
    assert.equal(worker.snapshot().priority, 19);
    const files = readStoredZip(await fs.readFile(response.zip));
    assert.deepEqual([...files.keys()], ["events.csv", "columns.md", "summary.json"]);
    assert.equal(files.get("events.csv")!.toString().trim(), Object.keys(COLUMNS).join(","));
    assert.equal(JSON.parse(files.get("summary.json")!.toString()).rawMarketDataIncluded, false);
  } finally { await worker.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
test("real worker cancellation drains owned input work and a following export still succeeds", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "labels-abort-test-"));
  const worker = new HistoryProcess("ISOLATED-NO-API", () => {});
  const abort = new AbortController();
  let providerFinished = false;
  try {
    const work = worker.labelsExport({ symbol: "NQ", fromSec: t, toSec: t + 1,
      labels: [label()], tickRanges: [], directory: root }, async hour => {
      abort.abort();
      await new Promise(r => setTimeout(r, 20)); providerFinished = true;
      return { hour, tickCoverage: [], bookCoverage: [] };
    }, abort.signal);
    await assert.rejects(work, /aborted/); assert.equal(providerFinished, true);
    const again = await fs.mkdtemp(path.join(root, "again-"));
    const result = await worker.labelsExport({ symbol: "NQ", fromSec: t, toSec: t + 1,
      labels: [], tickRanges: [], directory: again }, async () => { throw Error("unexpected"); }, new AbortController().signal);
    assert.ok((await fs.stat(result.zip)).size > 0);
  } finally { await worker.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
test("divergence uses exact timestamp/sequence order, including winding and legitimate equal trades", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "labels-divergence-test-"));
  try {
    const file = path.join(root, "tick.gz"), d = synthetic();
    const trades = [
      { tsUs: (t - 590) * 1e6, recvUs: t * 1e6, seq: 1, price: 100, side: "buy", size: 10 },
      { tsUs: (t - 500) * 1e6, recvUs: t * 1e6, seq: 2, price: 90, side: "sell", size: 10 },
      { tsUs: (t - 250) * 1e6, recvUs: t * 1e6, seq: 3, price: 101, side: "unknown", size: 100 },
      { tsUs: (t - 200) * 1e6, recvUs: t * 1e6, seq: 4, price: 91, side: "sell", size: 1 },
    ];
    await fs.writeFile(file, gzipSync([trades[2], trades[0], trades[3], trades[1]].map(v => JSON.stringify(v)).join("\n")));
    const out = calculate(label(), d);
    await enrichDivergence(label(), d, out, async (hour, visit) =>
      visit({ hour, tick: file, tickCoverage: [[hour, hour + 3600]], bookCoverage: [] }));
    assert.equal(out.values.cvd_divergence, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("nonempty streamed export: three matched sessions, no fabricated near-misses, schema and quantity provenance", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "labels-matching-test-"));
  try {
    const firstDay = sessionStartSec(t) - 3 * 86400, fileMap = new Map<number, string>(), byHour = new Map<number, object[]>();
    let sequence = 0;
    for (let day = 0; day < 4; day++) {
      const center = t - (3 - day) * 86400;
      for (let second = center - 1800; second < center + 900; second++) {
        const hour = Math.floor(second / 3600) * 3600, rows = byHour.get(hour) ?? [];
        // Explicit SYNTHETIC known-empty seconds outside this interval.
        rows.push({ tsUs: second * 1e6, recvUs: second * 1e6, seq: ++sequence, price: 1000 + second - (center - 1800),
          size: 2, side: second % 2 ? "buy" : "sell", contract: day === 3 ? "NQH7" : "NQZ6" });
        byHour.set(hour, rows);
      }
    }
    for (const [hour, rows] of byHour) {
      const file = path.join(root, `${hour}.gz`); await fs.writeFile(file, gzipSync(rows.map(x => JSON.stringify(x)).join("\n"))); fileMap.set(hour, file);
    }
    const empty = path.join(root, "empty.gz"); await fs.writeFile(empty, gzipSync(""));
    const directory = path.join(root, "export"); await fs.mkdir(directory);
    const mark = { ...label(), priceTicks: 2800 };
    const exported = await exportLabels({ symbol: "NQ", fromSec: firstDay, toSec: nextSession(sessionStartSec(t)),
      labels: [mark], tickRanges: [[firstDay, nextSession(sessionStartSec(t))]], directory },
    async (hour, visit) => visit({ hour, tick: fileMap.get(hour) ?? empty, bookCoverage: [],
      tickCoverage: [[Math.max(hour, firstDay), Math.min(hour + 3600, nextSession(sessionStartSec(t)))]] }));
    const files = readStoredZip(await fs.readFile(exported.zip)), summary = exported.summary;
    assert.equal(summary.counts.mark, 1); assert.equal(summary.counts.random, 3); assert.equal(summary.counts.nearmiss, 0);
    assert.equal(summary.rawMarketDataIncluded, false);
    const csv = files.get("events.csv")!.toString();
    const parseLine = (line: string) => {
      const fields: string[] = []; let quoted = false, value = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
        else if (c === '"') quoted = !quoted;
        else if (c === "," && !quoted) { fields.push(value); value = ""; } else value += c;
      }
      fields.push(value); return fields;
    };
    const records = csv.trimEnd().split("\r\n").map(parseLine), header = records.shift()!;
    assert.deepEqual(header, Object.keys(COLUMNS));
    for (const record of records) assert.equal(record.length, header.length);
    for (const name of header) assert.ok(files.get("columns.md")!.toString().includes(`**${name}**`));
    const rows = records.map(row => Object.fromEntries(header.map((k, i) => [k, row[i]!])));
    const random = rows.filter(r => r.row_type === "random");
    assert.equal(new Set(random.map(r => sessionStartSec(+r.tsSec!))).size, 3);
    for (const row of random) {
      assert.notEqual(sessionStartSec(+row.tsSec!), sessionStartSec(t));
      assert.equal(Math.floor(sessionClock(+row.tsSec!).minutesFromUsOpen / 30), Math.floor(sessionClock(t).minutesFromUsOpen / 30));
      assert.equal(row.matched_mark_id, mark.id); assert.equal(row.label, "none"); assert.equal(row.viewMode, "");
    }
    const actual = rows.find(r => r.row_type === "mark")!;
    assert.equal(+actual.buy_30s!, 30); assert.equal(+actual.sell_30s!, 30);
    assert.ok(Number.isFinite(+actual.distance_poc!)); assert.ok(!header.includes("recvUs") && !header.includes("bids"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("real HTTP handlers: validation, cross-site rejection, uncertain committed save and idempotent retry", async () => {
  const cloud = new LabelsCloudFixture(), labels = new LabelsStore(cloud, "dev/");
  const worker = new HistoryProcess("ISOLATED-NO-API", () => {});
  const app = express(); app.use("/api/labels", labelsRouter({ labels, history: worker,
    store: () => { throw Error("not_needed"); } }));
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/labels`;
  const send = (body: unknown, extra: Record<string, string> = {}) => fetch(base, { method: "POST",
    headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + "?symbol=INVALID")).status, 400);
    assert.equal((await send({ label: label(), generation: "0" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await send({ label: { ...label(), expectedDirection: undefined }, generation: "0" })).status, 400);
    const upload = cloud.uploadConditional.bind(cloud);
    cloud.uploadConditional = async (...args) => { const next = await upload(...args); cloud.failRead = true; return next; };
    const unknown = await send({ label: label(), generation: "0" });
    assert.equal(unknown.status, 503); assert.match(JSON.stringify(await unknown.json()), /result_unknown/);
    assert.equal(cloud.writes, 1); cloud.failRead = false;
    const reread = await fetch(base + "?symbol=NQ");
    assert.equal(reread.status, 200); assert.equal((await reread.json()).labels.length, 1);
    const retry = await send({ label: label(), generation: "0" });
    assert.equal(retry.status, 200); assert.equal((await retry.json()).labels.length, 1); assert.equal(cloud.writes, 1);
  } finally { await new Promise<void>(r => server.close(() => r())); await worker.stop(); }
});
