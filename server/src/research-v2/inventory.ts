import * as fs from "node:fs/promises";
import path from "node:path";
import { digest } from "./engine.ts";
import { hashFile } from "./snapshot.ts";
import { sessionStartSec } from "../vp/state.ts";
import { coverageIndex, type Source } from "./model.ts";

export interface InputFile { path: string; name: string; sha256: string; bytes: number; after_sha256?: string; }
export const MAX_SOURCE_FILES = 10_000;
export async function inputPaths(source: Source) {
  const files = [path.join(source.root, "coverage.json")];
  async function walk(dir: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (/\.(jsonl\.gz|bin|bin\.gz)$/.test(e.name)) {
        files.push(path.join(dir, e.name));
        if (files.length > MAX_SOURCE_FILES) throw Error("v2_input_file_budget");
      }
    }
  }
  await walk(path.join(source.root, "trades", source.symbol));
  await walk(path.join(source.root, "columns", source.symbol, "1s"));
  return files.sort();
}
export async function freezeInput(source: Source, signal: AbortSignal) {
  const files: InputFile[] = [];
  for (const file of await inputPaths(source)) {
    signal.throwIfAborted();
    files.push({ path: file, name: path.relative(source.root, file), sha256: await hashFile(file, signal), bytes: (await fs.stat(file)).size });
  }
  return { symbol: source.symbol, contract: source.contract, input_version: digest(files.map(f => [f.name, f.sha256])), files };
}
export async function verifyInput(source: Source, frozen: Awaited<ReturnType<typeof freezeInput>>, signal: AbortSignal) {
  if (JSON.stringify(await inputPaths(source)) !== JSON.stringify(frozen.files.map(f => f.path))) throw Error("v2_input_file_set_changed");
  for (const f of frozen.files) {
    const after = await hashFile(f.path, signal);
    if (after !== f.sha256) throw Error("v2_frozen_input_changed");
    f.after_sha256 = after;
  }
}
export function assertInputVersions(rows: { symbol: string; contract: string; input_version: string }[]) {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (!/^[a-f0-9]{64}$/.test(r.input_version)) throw Error("v2_invalid_input_version");
    const key = `${r.symbol}:${r.contract}`, previous = seen.get(key);
    if (previous && previous !== r.input_version) throw Error("v2_incompatible_input_versions");
    seen.set(key, r.input_version);
  }
}
export const ctDate = (us: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Chicago" }).format(new Date(us / 1000));
export async function indexedSessions(source: Source) {
  const directory = path.join(source.root, "daily"), dates = [];
  const ranges = JSON.parse(await fs.readFile(path.join(source.root, "coverage.json"), "utf8")).tick as [number, number][];
  const known = coverageIndex(ranges.map(([a, b]) => ({ fromUs: a * 1e6, toUs: b * 1e6 })));
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.000Z\.json$/.test(name)) continue;
    const file = await fs.open(path.join(directory, name), "r"), prefix = Buffer.alloc(4096);
    let text: string;
    try { const r = await file.read(prefix, 0, prefix.length, 0); text = prefix.toString("utf8", 0, r.bytesRead); }
    finally { await file.close(); }
    const match = /"sessionStartSec"\s*:\s*(\d+)/.exec(text);
    if (!match) throw Error("v2_session_index_metadata_missing");
    const start = Number(match[1]);
    if (sessionStartSec(start) !== start) throw Error("v2_invalid_ct_session_index");
    const end = sessionStartSec(start + 27 * 3600), from = start * 1e6, to = end * 1e6;
    let coverageSeconds = 0;
    for (let t = from; t < to; t += 1e6) coverageSeconds += +known(t, t + 1e6);
    dates.push({ date: ctDate(from), from_us: String(from), to_us: String(to), samples: (to - from) / 60e6, coverage_seconds: coverageSeconds });
  }
  return dates;
}
