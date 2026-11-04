// Metadata/coverage only. Never examines target or feature values when fixing fold boundaries.
import * as fs from "node:fs/promises";
import path from "node:path";
import { setPriority } from "node:os";
import { indexedSessions } from "../src/research-v2/inventory.ts";
const args = process.argv.slice(2), arg = f => args[args.indexOf(f) + 1];
if (!args.includes("--out")) throw Error("usage: prepare-grid.mjs --out data/research-v2/NEW_PLAN");
const out = path.resolve(arg("--out"));
if (!out.startsWith(path.resolve("data/research-v2") + path.sep)) throw Error("private_output_required");
setPriority(process.pid, 19);
const pilot = JSON.parse(await fs.readFile("server/research-v2/pilot.json", "utf8"));
const inventory = [];
for (const s of pilot.sources) inventory.push({ symbol: s.symbol, contract: s.contract, sessions: await indexedSessions(s) });
const dates = [...new Set(inventory.flatMap(s => s.sessions.map(d => d.from_us)))].sort((a, b) => Number(a) - Number(b));
if (dates.length < 5) throw Error("insufficient_sessions_for_chronological_split");
const ntrain = Math.floor(dates.length * 0.6), nval = Math.floor((dates.length - ntrain) / 2);
const end = String(Math.max(...inventory.flatMap(s => s.sessions.map(d => Number(d.to_us)))));
const splits = [
  { fold: "train", fromUs: dates[0], toUs: dates[ntrain] },
  { fold: "validation", fromUs: dates[ntrain], toUs: dates[ntrain + nval] },
  { fold: "test", fromUs: dates[ntrain + nval], toUs: end },
];
const config = { schema: "orderflow.research.v2.2", calculation: pilot.calculation, splits,
  sources: pilot.sources.map(s => ({ symbol: s.symbol, contract: s.contract, root: s.root, sourceKind: s.sourceKind,
    asOfUs: [], grids: inventory.find(i => i.symbol === s.symbol).sessions.map(d => ({ fromUs: d.from_us, toUs: d.to_us, stepUs: "60000000" })) })) };
const sampleCount = inventory.flatMap(i => i.sessions).reduce((n, s) => n + s.samples, 0);
let sharedSeconds = 0;
for (const i of inventory) {
  let until = -Infinity;
  for (const s of i.sessions) {
    const a = Number(s.from_us) - 1800e6, b = Number(s.to_us) - 60e6;
    sharedSeconds += Math.max(0, b - Math.max(a, until)) / 1e6; until = Math.max(until, b);
  }
}
// STORE ZIP, not a fictional gzip ratio. Includes room for quality + sample metadata.
const estimate = { samples: sampleCount, targets: sampleCount * 3, repeatedHistoryRowsAvoided: sampleCount * 1800,
  sharedHistoryRows: sharedSeconds, zipBytesLow: sharedSeconds * 160 + sampleCount * 1800,
  zipBytesHigh: sharedSeconds * 320 + sampleCount * 4500,
  timing: "Requires batch calibration; do not extrapolate the old per-anchor scan to the new route",
  usesOnlyCountsAndCoverage: true };
await fs.mkdir(out, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries({ "config.json": config, "plan.json": { inventory, splits, estimate } }))
  await fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ inventory, splits, estimate }));
