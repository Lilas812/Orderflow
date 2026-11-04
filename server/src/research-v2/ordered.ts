import * as fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tradeFileEntries } from "../store/records.ts";
import type { Tick } from "./model.ts";

export const SORT_ROWS = 25_000, MAX_RUNS = 256;
type Item = { tick: Tick; order: number; run: number };
const cmp = (a: Item, b: Item) => a.tick.tsUs - b.tick.tsUs || a.tick.seq - b.tick.seq || a.order - b.order;
/** One gzip decode. Stable external sort preserves rewind/ties, without a whole-hour RAM tape. */
export async function* orderedHour(file: string, temporaryParent: string, signal: AbortSignal) {
  const own = await fs.mkdtemp(path.join(temporaryParent, ".order-")), runs: string[] = [];
  const readers: ReturnType<typeof createInterface>[] = [], streams: ReturnType<typeof createReadStream>[] = [];
  let chunk: Item[] = [], order = 0;
  const spill = async () => {
    if (runs.length >= MAX_RUNS) throw Error("v2_batch_sort_run_budget");
    chunk.sort(cmp);
    const name = path.join(own, String(runs.length));
    await fs.writeFile(name, chunk.map(x => JSON.stringify([x.order, x.tick])).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    runs.push(name); chunk = [];
  };
  try {
    for await (const { trade } of tradeFileEntries(file, signal)) {
      signal.throwIfAborted(); chunk.push({ tick: trade, order: order++, run: 0 });
      if (chunk.length === SORT_ROWS) await spill();
    }
    if (!runs.length) { chunk.sort(cmp); for (const x of chunk) { signal.throwIfAborted(); yield x.tick; } return; }
    if (chunk.length) await spill();
    const iterators = runs.map(name => {
      const input = createReadStream(name, { signal, highWaterMark: 16_384 });
      const lines = createInterface({ input, crlfDelay: Infinity });
      streams.push(input); readers.push(lines); return lines[Symbol.asyncIterator]();
    });
    const heap: Item[] = [];
    const push = (x: Item) => {
      heap.push(x); let i = heap.length - 1;
      while (i) { const p = (i - 1) >>> 1; if (cmp(heap[p]!, x) <= 0) break; heap[i] = heap[p]!; i = p; }
      heap[i] = x;
    };
    const pop = () => {
      const x = heap[0]!, tail = heap.pop()!;
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let c = i * 2 + 1;
          if (c + 1 < heap.length && cmp(heap[c + 1]!, heap[c]!) < 0) c++;
          if (cmp(tail, heap[c]!) <= 0) break;
          heap[i] = heap[c]!; i = c;
        }
        heap[i] = tail;
      }
      return x;
    };
    const next = async (run: number) => {
      const line = await iterators[run]!.next();
      if (!line.done) { const [ordinal, tick] = JSON.parse(line.value); push({ tick, order: ordinal, run }); }
    };
    for (let i = 0; i < runs.length; i++) await next(i);
    while (heap.length) { signal.throwIfAborted(); const x = pop(); yield x.tick; await next(x.run); }
  } finally {
    readers.forEach(r => r.close()); streams.forEach(s => s.destroy());
    await fs.rm(own, { recursive: true, force: true });
  }
}
