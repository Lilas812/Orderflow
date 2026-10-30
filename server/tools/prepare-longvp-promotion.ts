/** Offline CLI. Unknown options (including --apply/--upload) are rejected. */
import * as fs from "node:fs/promises";
import { preparePromotion, recheckPromotion, type PromotionPlan } from "../src/import/longvp-package.ts";
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--(plan|out|manifest|recheck)=(.+)$/.exec(arg);
  if (!m || args.has(m[1]!)) throw Error("unsupported_or_duplicate_option");
  args.set(m[1]!, m[2]!);
}
const control = new AbortController();
process.once("SIGTERM", () => control.abort()); process.once("SIGINT", () => control.abort());
if (args.size === 2 && args.has("manifest") && args.has("recheck")) {
  const manifest = JSON.parse(await fs.readFile(args.get("manifest")!, "utf8"));
  console.log(JSON.stringify(await recheckPromotion(manifest, args.get("recheck")!)));
} else if (args.size === 2 && args.has("plan") && args.has("out")) {
  const plan = JSON.parse(await fs.readFile(args.get("plan")!, "utf8")) as PromotionPlan;
  const result = await preparePromotion(plan, args.get("out")!, { signal: control.signal });
  console.log(JSON.stringify({ state: result.state, generation: result.generation,
    changedDays: result.manifest.days.filter(d => d.changed).map(d => d.date),
    acceptedBuckets: result.manifest.days.flatMap(d => d.audits).reduce((n, a) => n + a.accepted.length, 0),
    warning: result.manifest.warning }));
} else throw Error("Use --plan=FILE --out=ISOLATED_DIR or --manifest=FILE --recheck=FRESH_LOCAL_INVENTORY");
