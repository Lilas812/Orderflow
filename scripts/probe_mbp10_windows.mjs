/** Read-only window selection; never creates AppStore or upstream connections. */
import fs from "node:fs";
import path from "node:path";
import { ReplitObjects, digest } from "../server/src/store/objects.ts";
import { columnFileRange } from "../server/src/store/records.ts";
const dir = path.resolve("data/research-v2/mbp10-check-01");
fs.mkdirSync(path.join(dir, "app-copy"), { recursive: true });
const cloud = new ReplitObjects();
const candidates = [
  { label: "us", start: "2026-11-03T14:00:00Z" },
  { label: "asia", start: "2026-11-03T05:00:00Z" },
  { label: "session-open", start: "2026-11-03T23:00:00Z" },
];
const rows = [];
for (const row of candidates) {
  const start = Date.parse(row.start) / 1000, end = start + 3600;
  const date = row.start.slice(0, 10), hh = row.start.slice(11, 13);
  const object = `prod/instruments/GC/columns/GC/1s/${date}/${hh}.bin.gz`;
  const file = path.join(dir, "app-copy", `${date}-${hh}.bin.gz`);
  let generation;
  try { generation = await cloud.downloadVersion(object, file); }
  catch { throw Error("read_only_app_copy_failed"); }
  let columns = 0, first = null, last = null;
  if (generation) for await (const c of columnFileRange(file, start, end)) {
    if (!c.bids.length || !c.asks.length) continue;
    columns++; first ??= c.tsSec; last = c.tsSec;
  }
  rows.push({ ...row, end: new Date(end * 1000).toISOString(), object, generation,
    sha256: generation ? await digest(file) : null, columns, first, last });
}
fs.writeFileSync(path.join(dir, "windows.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
if (rows.some(x => x.columns < 1800)) process.exitCode = 2;
