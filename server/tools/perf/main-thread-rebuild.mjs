// All writes are isolated. Source snapshot remains immutable.
import * as fs from "node:fs/promises";
import path from "node:path";
import { digest, ObjectGenerationConflict } from "../../src/store/objects.ts";
import { AppStore } from "../../src/store/app.ts";
import { LongObjects } from "../../src/long-vp/objects.ts";
import { AppLongVp } from "../../src/long-vp/app-service.ts";
import { LongRest } from "../../src/long-vp/rest.ts";
import { Metrics } from "../../src/ingest/metrics.ts";
import { dayBounds, serializeDay } from "../../src/long-vp/day.ts";
import { MainThreadMonitor, namedWork } from "../../src/diagnostics/main-thread.ts";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const source = path.resolve("data/dev/main-thread-snapshot"), output = path.resolve("data/dev/main-thread-rebuild");
const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
const fileMap = new Map(manifest.files.map(f => [f.source.replace(/^prod\//, "dev/"), f.file]));
const resolve = async name => {
  if (!/^dev\/[\w./-]+$/.test(name) || name.includes("..")) throw Error("unsafe_isolated_name");
  const written = path.join(output, "objects", name);
  try { await fs.access(written); return written; } catch { return fileMap.get(name) ?? null; }
};
const objects = {
  async exists(name) { return !!await resolve(name); },
  async list(prefix) { return [...fileMap.keys()].filter(k => k.startsWith(prefix)); },
  async download(name, file) { const src = await resolve(name); if (!src) throw Error("snapshot_object_missing"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile(src, file); },
  async upload() { throw Error("unconditional_write_forbidden"); },
  async downloadVersion(name, file, generation) {
    const src = await resolve(name); if (!src) return null;
    const hash = await digest(src); if (generation && generation !== hash) throw new ObjectGenerationConflict();
    await this.download(name, file); return hash;
  },
  async uploadConditional(name, file, generation) {
    const old = await resolve(name), hash = old ? await digest(old) : "0";
    if (hash !== generation) throw new ObjectGenerationConflict();
    const dst = path.join(output, "objects", name);
    await fs.mkdir(path.dirname(dst), { recursive: true }); await fs.copyFile(file, dst + ".tmp");
    await fs.rename(dst + ".tmp", dst); fileMap.set(name, dst); return digest(dst);
  },
};
const events = [], monitor = new MainThreadMonitor((e, f) => events.push({ event: e, ...f }));
monitor.start();
const result = [];
try {
  for (const symbol of ["NQ", "GC"]) {
    const prefix = symbol === "NQ" ? "dev/" : "dev/instruments/GC/";
    const store = new AppStore(path.join(output, "working", symbol), objects, prefix, () => {}, Date.now, symbol);
    await namedWork("rebuild-store", () => store.initialize());
    const repo = new LongObjects(objects, "dev/", path.join(output, "longvp-working", symbol), symbol);
    const log = (event, f) => { if (/day_saved|failed/.test(event)) events.push({ event, ...f }); };
    // GET /roll metadata only; no upstream WS, no history request, no production write.
    // It provides verified expiry activation, never infer it from filenames.
    const metadata = new LongRest(process.env.TICKSTREAM_API_KEY,
      (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) }),
      async () => {}, symbol);
    let seq = 1;
    const service = new AppLongVp({ repository: repo, store,
      history: { symbol, get() { throw Error("real_history_forbidden"); } },
      metadata, metrics: new Metrics(log), nextSeq: () => seq++, log });
    try {
      await repo.initialize();
      try { await service.refreshMetadata(); }
      catch { if (symbol !== "GC") throw Error("verified_NQ_metadata_unavailable"); }
      const date = "2026-11-02", bounds = dayBounds(date), start = performance.now();
      const built = await namedWork("rebuild-longvp", () => service.build(date, bounds.endUs, Infinity, Infinity, true));
      const day = serializeDay(date, built.aggregate, service.timeline, built.gaps, Date.now() * 1000, false, symbol === "GC", built.contracts);
      const saved = await repo.save(day);
      const name = `dev/longvp/${symbol}/days/${date}.json.gz`;
      const file = await resolve(name);
      const readback = JSON.parse((await promisify(gunzip)(await fs.readFile(file))).toString());
      const quantity = d => d.vp30m.reduce((s, r) => s + r[2] + r[3] + (r[5] ?? 0), 0);
      if (quantity(day) !== quantity(readback)) throw Error("readback_quantity_mismatch");
      result.push({ symbol, date, trades: built.aggregate.count, quantity: quantity(day),
        complete: day.complete, gaps: day.gaps.length, contracts: day.contracts,
        elapsedMs: performance.now() - start, saved, file, sha256: await digest(file) });
    } catch { result.push({ symbol, state: "not_rebuilt", reason: "see_safe_stage_evidence; no_production_write" }); }
    finally { await service.stop(); }
  }
} finally {
  monitor.stop();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ result, events,
    diagnostics: monitor.snapshot(), sourceManifest: await digest(path.join(source, "manifest.json")) }, null, 2));
}
console.log(JSON.stringify(result));
