import * as fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import { exportV2 } from "./export.ts";
import { hashFile } from "./snapshot.ts";
import { digest } from "./engine.ts";
import type { Config } from "./model.ts";

export async function codeIdentity() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const files: string[] = [];
  async function walk(p: string) {
    for (const e of await fs.readdir(p, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(p, e.name));
      else if (e.name.endsWith(".ts")) files.push(path.join(p, e.name));
    }
  }
  await walk(path.join(root, "server/src")); await walk(path.join(root, "lib/market"));
  files.sort();
  return { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHash: digest(await Promise.all(files.map(async p => [path.relative(root, p), await hashFile(p)]))) };
}
async function main() {
  const args = process.argv.slice(2), get = (flag: string) => args[args.indexOf(flag) + 1];
  if (!args.includes("--config") || !args.includes("--out")) throw Error("usage: node --max-old-space-size=256 server/src/research-v2/cli.ts --config FILE --out data/research-v2/NEW_RUN");
  const out = path.resolve(get("--out")!), allowed = path.resolve("data/research-v2") + path.sep;
  if (!out.startsWith(allowed)) throw Error("output_must_be_under_private_ignored_data_research_v2");
  const config = JSON.parse(await fs.readFile(get("--config")!, "utf8")) as Config;
  for (const s of config.sources) if (path.resolve(s.root).startsWith(out + path.sep) || path.resolve(s.root) === out) throw Error("output_overlaps_input");
  setPriority(process.pid, 19);
  const controller = new AbortController(), abort = () => controller.abort(Error("v2_cancelled"));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const before = process.cpuUsage(), started = performance.now();
  try {
    const result = await exportV2(config, out, await codeIdentity(), controller.signal);
    const metrics = { pid: process.pid, priority: 19, elapsedMs: performance.now() - started,
      cpuUs: process.cpuUsage(before), finalRss: process.memoryUsage().rss,
      peakRssKiB: process.resourceUsage().maxRSS, sourceUnchanged: true, temporarySnapshotsRemaining: false };
    await fs.writeFile(path.join(out, "run-metrics.json"), JSON.stringify(metrics, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...result.manifest.counts, directory: result.directory,
      contentHash: result.manifest.content_hash, zipSha256: result.zipSha256, metrics }));
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(e => { console.error(e instanceof Error ? e.message : "v2_export_failed"); process.exitCode = 1; });
