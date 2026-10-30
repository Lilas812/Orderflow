import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { tradeFileEntries } from "../store/records.ts";
import { ranges, type Coverage } from "../store/local.ts";
import { atomic, canonical, count, emptyStats, sha, type StagedFile } from "./databento-stage.ts";
import type { Trade } from "../types.ts";

export async function snapshot(base: string, target: string) {
  const files: { path: string; sha256: string }[] = [];
  for (const dir of ["trades/NQ", "trades/GC", "columns/NQ", "columns/GC", "instruments/GC"]) {
    let names: string[]; try { names = await fs.readdir(path.join(base, dir), { recursive: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const n of names.filter(n => /\.(?:gz|bin|json)$/.test(n))) {
      const rel = path.join(dir, n), src = path.join(base, rel), dst = path.join(target, rel);
      if (!(await fs.stat(src)).isFile()) continue;
      const before = await sha(src);
      await fs.mkdir(path.dirname(dst), { recursive: true }); await fs.copyFile(src, dst);
      if (await sha(src) !== before || await sha(dst) !== before) throw Error("baseline_changed_during_copy");
      files.push({ path: rel, sha256: before });
    }
  }
  let coverage: Coverage = { book: [], tick: [] };
  try { coverage = JSON.parse(await fs.readFile(path.join(base, "coverage.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await atomic(path.join(target, "coverage.json"), coverage);
  await atomic(path.join(target, "snapshot.json"), { files, coverage });
  return { files, coverage };
}

export async function replaceHour(file: string, incoming: string[], contract: string,
  fromUs: number, toUs: number, unknown: boolean, signal?: AbortSignal, resumeBaseline?: string) {
  const input = resumeBaseline ?? file;
  let exists = true;
  try { await fs.access(input); } catch { exists = false; }
  const blocked = async (reason: string) => {
    if (resumeBaseline && await sha(file) !== await sha(input)) throw Error("resume_protected_file_changed");
    return { blocked: reason, adopted: emptyStats() };
  };
  if (exists) for await (const { trade: t } of tradeFileEntries(input, signal)) {
    if (t.tsUs < fromUs || t.tsUs >= toUs) continue;
    if (!t.contract || !/^(NQ|GC)[FGHJKMNQUVXZ]\d{2}$/.test(t.contract)) return blocked("existing_contract_unknown");
  }
  const content = createHash("sha256"), adopted = emptyStats(), kept = createHash("sha256");
  const target = file + "." + randomUUID() + ".tmp.jsonl.gz", before = exists ? await sha(input) : null;
  let injected = false, keptRows = 0;
  async function* fresh() {
    injected = true;
    for await (const { line, trade } of mergeIncoming(incoming, signal)) {
      if (trade.tsUs < fromUs || trade.tsUs >= toUs) continue;
      if (trade.contract !== contract || !["buy", "sell", "unknown"].includes(trade.side)) throw Error("incoming_identity_mismatch");
      count(adopted, trade); yield line + "\n";
    }
  }
  async function* merged() {
    if (exists) for await (const { line, trade: t } of tradeFileEntries(input, signal)) {
      if (!injected && t.tsUs >= fromUs) yield* fresh();
      if (t.tsUs >= fromUs && t.tsUs < toUs && t.contract === contract) continue;
      kept.update(line + "\n"); keptRows++; yield line + "\n";
    }
    if (!injected) yield* fresh();
  }
  async function* metered() {
    for await (const line of merged()) { signal?.throwIfAborted(); content.update(line); yield line; }
  }
  if (resumeBaseline) {
    // The installed generation is never trusted by its name or timestamp.
    // Reconstruct the intended stream from immutable baseline + verified input,
    // then compare every output row/order before reusing it (NO gzip rewrite).
    for await (const _ of metered()) { /* streaming hash and counters only */ }
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await pipeline(Readable.from(metered()), createGzip({ level: 1 }), createWriteStream(target, { flags: "wx" }), { signal });
  }
  const expected = content.digest("hex"), checked = createHash("sha256");
  for await (const x of tradeFileEntries(resumeBaseline ? file : target, signal)) checked.update(x.line + "\n");
  if (expected !== checked.digest("hex")) throw Error("replacement_readback_mismatch");
  if (exists && await sha(input) !== before) throw Error("isolated_file_changed");
  signal?.throwIfAborted(); if (!resumeBaseline) await fs.rename(target, file);
  return { blocked: null, adopted, keptRows, keptContentHash: kept.digest("hex"), sha256: await sha(file) };
}

/** Merge split known/N tapes by original CSV ordinal, NOT event time.
 * Retains timestamp rewinds and distinct identical trades; bounded to one row/stream. */
export async function* mergeIncoming(files: string[], signal?: AbortSignal) {
  const streams = files.map(file => tradeFileEntries(file, signal));
  try {
    const heads = await Promise.all(streams.map(s => s.next()));
    while (true) {
      signal?.throwIfAborted();
      let index = -1;
      for (let i = 0; i < heads.length; i++) if (!heads[i]!.done
        && (index < 0 || heads[i]!.value.trade.seq < heads[index]!.value.trade.seq)) index = i;
      if (index < 0) break;
      yield heads[index]!.value!;
      heads[index] = await streams[index]!.next();
    }
  } finally { await Promise.all(streams.map(s => s.return(undefined))); }
}

export async function install(staged: StagedFile[], stage: string, generation: string,
  baseline: string, fromUs: number, toUs: number, availableDays: Set<string>, signal?: AbortSignal, resume = false) {
  const snap = JSON.parse(await fs.readFile(path.join(baseline, "snapshot.json"), "utf8"));
  const contracts = [...new Set(staged.flatMap(f => Object.keys(f.contracts)))].sort();
  const result: Record<string, unknown> = {};
  for (const contract of contracts) {
    const symbol = contract.startsWith("NQ") ? "NQ" : "GC", root = path.join(generation, contract);
    if (!resume) await fs.cp(baseline, root, { recursive: true });
    const coverage: Coverage = structuredClone(snap.coverage);
    const groups = new Map<string, { incoming: string[]; unknown: boolean; valid: boolean; day: string }>();
    for (const f of staged) for (const item of f.outputs) {
      const m = /^(known|unknown)\/([^/]+)\/(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/.exec(item.path);
      if (!m || m[2] !== contract) continue;
      const hour = Date.parse(`${m[3]}T${m[4]}:00:00Z`) * 1000;
      if (hour + 3600e6 <= fromUs || hour >= toUs) continue;
      const key = `${m[3]}/${m[4]}`, group = groups.get(key) ?? {
        incoming: [], unknown: false, valid: true, day: m[3]!,
      };
      group.incoming.push(path.join(stage, f.sha256, item.path));
      if (m[1] === "unknown") group.unknown = true;
      group.valid &&= f.errors === 0 && availableDays.has(m[3]!);
      groups.set(key, group);
    }
    const hours = [];
    for (const [hour, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      signal?.throwIfAborted();
      const sec = Date.parse(`${hour.slice(0, 10)}T${hour.slice(11)}:00:00Z`) / 1000;
      const start = Math.max(fromUs, sec * 1e6), end = Math.min(toUs, (sec + 3600) * 1e6);
      if (!group.valid) { hours.push({ hour, blocked: "source_day_or_parse_unverified" }); continue; }
      const file = path.join(root, `trades/${symbol}`, hour + ".jsonl.gz");
      const outcome = await replaceHour(file, group.incoming, contract, start, end, group.unknown, signal,
        resume ? path.join(baseline, `trades/${symbol}`, hour + ".jsonl.gz") : undefined);
      hours.push({ hour, fromUs: start, toUs: end, unknownSide: group.unknown, ...outcome });
      // recorded coverage is only certified for whole microsecond-aligned SECONDS.
      // N is now adopted, so direction alone no longer invalidates volume coverage.
      if (!outcome.blocked) coverage.tick.push([Math.ceil(start / 1e6), Math.floor(end / 1e6)]);
    }
    coverage.tick = ranges(coverage.tick.filter(([a, b]) => a < b));
    await atomic(path.join(root, "coverage.json"), coverage);
    result[contract] = { root, hours, coverage, note: "N included in volume, never allocated to buy/sell; spreads excluded; board unchanged" };
  }
  return result;
}
