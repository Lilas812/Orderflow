/** Explicit read-only cloud snapshot. No runtime/upstream, upload or delete calls. */
import { ReplitObjects } from "../src/store/objects.ts";
import { captureInventory } from "../src/import/longvp-package.ts";
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--(symbol|out)=(.+)$/.exec(arg);
  if (!m || args.has(m[1]!)) throw Error("unsupported_or_duplicate_option");
  args.set(m[1]!, m[2]!);
}
const symbol = args.get("symbol");
if (args.size !== 2 || (symbol !== "NQ" && symbol !== "GC") || !args.get("out"))
  throw Error("Use --symbol=NQ|GC --out=NEW_LOCAL_DIRECTORY");
console.log(JSON.stringify(await captureInventory(new ReplitObjects(), symbol, args.get("out")!)));
