import * as fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2), arg = f => args[args.indexOf(f) + 1];
if (!["--plan", "--calibration", "--out"].every(f => args.includes(f))) throw Error("usage: check-grid-budget.mjs --plan PLAN_DIR --calibration RUN_DIR --out NEW_DIR");
const out = path.resolve(arg("--out"));
if (!out.startsWith(path.resolve("data/research-v2") + path.sep)) throw Error("private_output_required");
const planDir = arg("--plan"), calDir = arg("--calibration");
const p = JSON.parse(await fs.readFile(path.join(planDir, "plan.json")));
const c = JSON.parse(await fs.readFile(path.join(calDir, "dataset/manifest.json")));
const metrics = JSON.parse(await fs.readFile(path.join(calDir, "run-metrics.json")));
const calBytes = (await fs.stat(path.join(calDir, "dataset/dataset-v2.zip"))).size;
const ratio = Math.max(p.estimate.samples / c.counts.samples, p.estimate.sharedHistoryRows / c.counts.sharedHistoryRows);
const estimate = { samples: p.estimate.samples, sharedHistoryRows: p.estimate.sharedHistoryRows, targets: p.estimate.targets,
  zipBytesPoint: Math.ceil(calBytes * ratio), zipBytesUpper: Math.max(p.estimate.zipBytesHigh, Math.ceil(calBytes * ratio * 2)),
  elapsedSecondsPoint: Math.ceil(metrics.elapsedMs * ratio / 1000),
  elapsedSecondsUpper: Math.ceil(metrics.elapsedMs * ratio * 2 / 1000 + 60),
  calibration: { directory: calDir, samples: c.counts.samples, elapsedMs: metrics.elapsedMs, zipBytes: calBytes, peakRssKiB: metrics.peakRssKiB },
  approach: "linear count/row scaling, twice measured cost + 60s timing margin; STORE ZIP; no X/Y distribution inspection" };
const allowed = estimate.zipBytesUpper <= 2_000_000_000 && estimate.elapsedSecondsUpper <= 7200;
const config = JSON.parse(await fs.readFile(path.join(planDir, "config.json")));
if (!allowed) for (const s of config.sources) s.grids = s.grids.slice(0, 3);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(out, "forecast.json"), JSON.stringify({ allowedFullExport: allowed, fallback: allowed ? null : "first_three_indexed_sessions_per_symbol_then_stop", estimate }, null, 2), { mode: 0o600, flag: "wx" });
await fs.writeFile(path.join(out, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ allowedFullExport: allowed, estimate }, null, 2));
