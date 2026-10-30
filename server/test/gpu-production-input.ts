/** Explicitly read-only production snapshot. No upload/delete/runtime connection. */
import fs from "node:fs/promises";
import path from "node:path";
import { ReplitObjects, digest } from "../src/store/objects.ts";
import { scanColumnFile, columnFileRange, tradeFileRows } from "../src/store/records.ts";
const out = "data/gpu-heatmap/production-input";
await fs.mkdir(out, { recursive: true });
const objects = new ReplitObjects();
const copied: { name: string; local: string; generation: string; sha256: string; bytes: number }[] = [];
let earlier: any = null;
try { earlier = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8")); } catch {}
async function copy(name: string) {
  const local = path.join(out, name);
  const retained = earlier?.copied?.find((c: any) => c.name === name);
  if (retained && await digest(local) === retained.sha256) {
    copied.push(retained); return local;
  }
  const generation = await objects.downloadVersion(name, local);
  if (!generation) throw Error(`source_missing:${name}`);
  copied.push({ name, local, generation, sha256: await digest(local), bytes: (await fs.stat(local)).size });
  return local;
}
const prefixes = { NQ: "prod/", GC: "prod/instruments/GC/" };
const base = Date.parse("2026-10-29T13:00:00Z") / 1000;
const span = 31 * 3600;
const inventories: Record<string, any> = {};
for (const symbol of ["GC", "NQ"] as const) {
  const prefix = prefixes[symbol];
  const coverageFile = await copy(prefix + "coverage.json");
  const coverage = JSON.parse(await fs.readFile(coverageFile, "utf8"));
  const known = new Uint8Array(span), tickCounts = new Uint32Array(span), tickSizes = new Float64Array(span);
  const files = { book: [] as string[], tick: [] as string[] };
  for (const date of ["2026-10-29","2026-10-30"])
  for (const hour of ["13","14","15","16","17","18","19"]) for (const kind of ["book", "tick"] as const) {
    const name = prefix + (kind === "book" ? `columns/${symbol}/1s/${date}/${hour}.bin.gz`
      : `trades/${symbol}/${date}/${hour}.jsonl.gz`);
    if (!await objects.exists(name)) continue;
    const f = await copy(name); files[kind].push(f);
    if (kind === "book") await scanColumnFile(f, sec => { if (sec >= base && sec < base + span) known[sec - base] = 1; });
    else for await (const t of tradeFileRows(f)) {
      const i = Math.floor(t.tsUs / 1e6) - base;
      if (i >= 0 && i < span) { tickCounts[i]++; tickSizes[i] += t.size; }
    }
  }
  inventories[symbol] = { coverage, known, tickCounts, tickSizes, files };
}
const candidates = [];
for (const day of [0,1]) for (let minute = 0; minute <= 360; minute++) {
  const offset = day*86400+minute*60;
  const c: any = { start: base + offset, offset, symbols: {} };
  for (const symbol of ["GC", "NQ"]) {
    const s = inventories[symbol]; let missing = 0, notCovered = 0, trades = 0, quantity = 0;
    for (let i = offset; i < offset + 3600; i++) {
      if (!s.known[i]) missing++;
      if (!s.coverage.book.some(([a,b]: number[]) => a <= base+i && base+i < b)) notCovered++;
      trades += s.tickCounts[i]; quantity += s.tickSizes[i];
    }
    c.symbols[symbol] = { missing, notCovered, trades, quantity };
  }
  candidates.push(c);
}
// First minimize GC gaps in the specified busy-US candidate period. For ties,
// select the most GC trades; NQ uses precisely the same UTC interval.
candidates.sort((a,b) => a.symbols.GC.missing - b.symbols.GC.missing
  || a.symbols.GC.notCovered - b.symbols.GC.notCovered || b.symbols.GC.trades - a.symbols.GC.trades
  || Math.abs(a.offset-1800)-Math.abs(b.offset-1800));
const chosen = candidates[0]!;
if (chosen.symbols.GC.missing === 3600 || chosen.symbols.NQ.missing === 3600) throw Error("no_usable_common_hour");
const metadata: any = { readOnly: true, candidatePeriodUTC: ["2026-10-29T13:00:00Z..20:00:00Z","2026-10-30T13:00:00Z..20:00:00Z"],
  candidateStepSeconds: 60, chosen, utc: [new Date(chosen.start*1000).toISOString(),
    new Date((chosen.start+3600)*1000).toISOString()], copied, candidates, symbols: {} };
for (const symbol of ["NQ", "GC"]) {
  const s = inventories[symbol], missingSeconds: number[] = [], uncoveredSeconds: number[] = [];
  for (let sec = chosen.start; sec < chosen.start + 3600; sec++) {
    if (!s.known[sec-base]) missingSeconds.push(sec);
    if (!s.coverage.book.some(([a,b]: number[])=> a<=sec && sec<b)) uncoveredSeconds.push(sec);
  }
  metadata.symbols[symbol] = { missingSeconds, uncoveredSeconds,
    tickCoverage: s.coverage.tick.filter(([a,b]: number[])=>a<chosen.start+3600&&chosen.start<b) };
}
// Stream the fixed selected input. Source files and their full content remain unchanged.
const file = path.join(out, "replay.json"), stream = await fs.open(file, "w");
try {
  await stream.write('{"startSec":'+chosen.start+',"boards":{');
  for (const [si,symbol] of ["NQ","GC"].entries()) {
    await stream.write((si?",":"")+JSON.stringify(symbol)+":["); let first = true;
    for (const f of inventories[symbol].files.book) for await (const c of columnFileRange(f, chosen.start, chosen.start+3600)) {
      await stream.write((first?"":",")+JSON.stringify(c)); first=false;
    }
    await stream.write("]");
  }
  await stream.write('},"trades":{');
  for (const [si,symbol] of ["NQ","GC"].entries()) {
    await stream.write((si?",":"")+JSON.stringify(symbol)+":["); let first = true;
    for (const f of inventories[symbol].files.tick) for await (const t of tradeFileRows(f)) {
      if(t.tsUs<chosen.start*1e6||t.tsUs>=(chosen.start+3600)*1e6)continue;
      await stream.write((first?"":",")+JSON.stringify(t)); first=false;
    }
    await stream.write("]");
  }
  await stream.write("}}");
} finally { await stream.close(); }
metadata.input = { file, sha256: await digest(file), bytes:(await fs.stat(file)).size };
await fs.writeFile(path.join(out,"manifest.json"),JSON.stringify(metadata,null,2));
console.log(JSON.stringify({utc:metadata.utc,chosen:chosen.symbols,input:metadata.input,copied:copied.length}));
