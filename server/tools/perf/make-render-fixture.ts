import * as fs from "node:fs/promises";
import path from "node:path";
import { LocalStore } from "../../src/store/local.ts";
import { encodeColumns } from "../../src/store/binary.ts";

const toSec = 1793022000; // Fixed saved replay head: 2026-10-26 13:40 UTC.
const fromSec = toSec - 7200;
const root = path.resolve("data/perf-memory/render-fixture");
await fs.mkdir(root, { recursive: true });
// No initialize/backfill/upstream: read the existing saved data without changing it.
const view = await new LocalStore(path.resolve("data")).readView(fromSec, toSec);
await fs.writeFile(path.join(root, "columns.bin"), encodeColumns(view.columns));
await fs.writeFile(path.join(root, "trades.json"), JSON.stringify(view.trades));
await fs.writeFile(path.join(root, "metadata.json"), JSON.stringify({
  fromSec, toSec, columns: view.columns.length, trades: view.trades.length,
  lastColumn: view.columns.at(-1)?.tsSec ?? null,
}, null, 2));
process.stdout.write(JSON.stringify({ fromSec, toSec, columns: view.columns.length, trades: view.trades.length }) + "\n");
