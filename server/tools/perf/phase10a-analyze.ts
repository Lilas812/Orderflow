import * as fs from "node:fs/promises";
import path from "node:path";
import { tradeFileRows } from "../../src/store/records.ts";
const dir = "data/phase10a";
const r = JSON.parse(await fs.readFile(path.join(dir, "result.json"), "utf8"));
const jsonl = async (file: string) => (await fs.readFile(path.join(dir, file), "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
const samples = await jsonl("samples.jsonl"), proc = await jsonl("proc-samples.jsonl");
const logs = (await Promise.all(["server-first.log", "server-second.log"].map(async file => {
  const text = await fs.readFile(path.join(dir, file), "utf8");
  return text.split("\n").filter(l => l.startsWith('{"recvUs"')).map(l => JSON.parse(l));
}))).flat();
const a = r.liveStart?.recentTrades.reduce((a: any, b: any) => a.seq > b.seq ? a : b);
const b = r.liveEnd?.recentTrades.reduce((a: any, b: any) => a.seq > b.seq ? a : b);
let count = 0, volume = 0, buy = 0, sell = 0;
if (a && b) {
  const scan = async (base: string) => {
    for (const item of await fs.readdir(base, { withFileTypes: true })) {
      const file = path.join(base, item.name);
      if (item.isDirectory()) await scan(file);
      else if (item.name.endsWith(".jsonl.gz")) for await (const t of tradeFileRows(file)) {
        if ((t.recvUs > a.recvUs || t.recvUs === a.recvUs && t.seq > a.seq)
          && (t.recvUs < b.recvUs || t.recvUs === b.recvUs && t.seq <= b.seq)) {
          count++; volume += t.size; if (t.side === "buy") buy += t.size; else sell += t.size;
        }
      }
    }
  };
  await scan(path.join(dir, "working/trades"));
}
const comparison = a && b ? { ...r.comparison, startRecvUs: a.recvUs, endRecvUs: b.recvUs,
  savedCount: count, savedVolume: volume, buy, sell,
  countsMatch: count === r.comparison.acceptedUpstream && count === r.comparison.browserCount,
  volumesMatch: volume === r.comparison.browserVolume && volume === r.comparison.vpAdded,
  durationSeconds: (b.recvUs - a.recvUs) / 1e6 } : null;
// Keep the original result.json as evidence, but do not carry its older
// sequence-only comparison flag into this receive-time-aligned analysis.
if (comparison) delete comparison.volumeMatches;
const phases: any[] = [];
function measure(name: string, pid: number, start: number, end: number) {
  const p = proc.filter(s => s.pid === pid && s.at >= start && s.at <= end);
  const m = logs.filter(s => s.event === "process_memory" && s.details.pid === pid && s.recvUs / 1000 >= start && s.recvUs / 1000 <= end);
  const api = samples.filter(s => s.memory.pid === pid && s.at >= start && s.at <= end).map(s => s.memory);
  const max = (items: number[]) => items.length ? Math.max(...items) : null;
  const cores = m.map(s => s.details.cpu.average10s).filter(n => typeof n === "number");
  phases.push({ name, pid, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    seconds: (end - start) / 1000,
    rssMaxObserved: max([...p.map(s => s.rss), ...m.map(s => s.details.rss), ...api.map(s => s.rss)]),
    processRssHighWater: max([...p.map(s => s.hwm), ...m.map(s => s.details.rssMaxBytes), ...api.map(s => s.rssMaxBytes)]),
    cpuMax10s: max([...cores, ...api.map(s => s.cpu.average10s).filter(n => typeof n === "number")]),
    cpuMean10s: cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : null,
    cpuFromProc: p.length > 1 ? (p.at(-1)!.cpuSeconds - p[0].cpuSeconds) / ((p.at(-1)!.at - p[0].at) / 1000) : null,
    procCoveredSeconds: p.length ? (p.at(-1)!.at - p[0].at) / 1000 : 0,
    statusSamples: m.length, procSamples: p.length });
}
for (const label of ["first-startup", "restart-startup"]) {
  const rows = samples.filter(s => s.label === label), first = rows[0];
  const last = rows.find(s => s.phase2a.backfill.state === "complete" && s.phase2a.vp.state === "complete") ?? rows.at(-1);
  const pid = first.memory.pid;
  const initial = logs.find(s => s.event === "process_memory" && s.details.pid === pid)!;
  measure(label, pid, initial.recvUs / 1000, last.at);
}
if (r.liveStart && r.liveEnd) measure("live30", r.liveStart.memory.pid,
  r.liveStart.memory.sampledAtUs / 1000, r.liveEnd.memory.sampledAtUs / 1000);
if (r.threeStart && r.threeEnd) {
  const connected = logs.find(l => l.recvUs / 1000 > r.liveEnd.memory.sampledAtUs / 1000 + 1000
    && l.event.includes("hub_connection") && l.event.includes("open"));
  measure("three60", r.threeEnd.memory.pid, connected ? connected.recvUs / 1000
    : r.liveEnd.memory.sampledAtUs / 1000 + 1000, r.threeEnd.memory.sampledAtUs / 1000);
}
const result = { comparison, phases, errors: logs.filter(l => /(?:failed|error|retry|slow_close)/.test(l.event)),
  upstreamClose: logs.filter(l => ["upstream_close", "upstream_stopped", "server_stopped"].includes(l.event)),
  three: r.three, browserClosures: r.browserClosures, isolationAfter: r.isolationAfter,
  externalAdmission: r.externalAdmission, devObjects: r.devObjects };
await fs.writeFile(path.join(dir, "analysis.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
