import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowedReplay } from "../src/hub/windowed-replay.ts";
import { Replay } from "../src/hub/replay.ts";
import type { ReplayClock } from "../src/hub/replay.ts";
import type { Column } from "../src/aggregate/columns.ts";
import type { Trade } from "../src/types.ts";

class Clock implements ReplayClock {
  time = 0;
  private id = 0;
  private timers = new Map<number, { at: number; run(): void }>();
  now() { return this.time; }
  later(run: () => void, ms: number) { const id = ++this.id; this.timers.set(id, { at: this.time + ms, run }); return id; }
  cancel(id: unknown) { this.timers.delete(id as number); }
  async advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      await Promise.resolve(); await Promise.resolve();
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].run();
    }
    this.time = target;
    await Promise.resolve(); await Promise.resolve();
  }
}
const column = (tsSec: number): Column => ({ tsSec, source: "history", bids: [], asks: [] });
const trade = (seq: number, tsUs: number) => ({ seq, tsUs }) as Trade;

test("windowed replay is byte-content/order/timing equivalent to the existing virtual clock across windows", async () => {
  const columns = [100, 101, 399, 400, 401, 699, 700, 701].map(column);
  const trades = [trade(1, 100900000), trade(2, 100100000), trade(3, 399900000),
    trade(4, 400000000), trade(5, 700500000)];
  const oldClock = new Clock(), newClock = new Clock();
  const oldEvents: unknown[] = [], newEvents: unknown[] = [], reads: [number, number][] = [];
  const emit = (clock: Clock, output: unknown[]) => ({
    column: (c: Column) => output.push([clock.time, "column", c]),
    trades: (t: Trade[]) => output.push([clock.time, "trades", t]),
    end: () => output.push([clock.time, "end"]),
    error: () => { throw Error("unexpected_read_error"); },
  });
  const read = async (a: number, b: number) => {
    reads.push([a, b]);
    return { columns: columns.filter(c => c.tsSec >= a && c.tsSec < b),
      trades: trades.filter(t => t.tsUs >= a * 1e6 && t.tsUs < b * 1e6) };
  };
  const old = new Replay(columns, trades, 100, 702, 10, emit(oldClock, oldEvents), oldClock);
  const first = await read(100, 400);
  const next = new WindowedReplay(first, 100, 702, 10, read, emit(newClock, newEvents), newClock);
  old.start(); next.start();
  await oldClock.advance(60200); await newClock.advance(60200);
  assert.deepEqual(newEvents, oldEvents);
  assert.deepEqual(reads, [[100, 400], [400, 700], [700, 702]]);
  assert.equal((next as any).current.columns.length, 0);
});
test("closing replay releases current/read-ahead arrays and ignores a late read", async () => {
  const clock = new Clock();
  let resolve!: (view: { columns: Column[]; trades: Trade[] }) => void;
  const future = new Promise<{ columns: Column[]; trades: Trade[] }>(r => { resolve = r; });
  let emitted = 0;
  const replay = new WindowedReplay({ columns: [column(100), column(101)], trades: [] }, 100, 800, 10,
    () => future, { column: () => emitted++, trades: () => {}, end: () => {}, error: () => {} }, clock);
  replay.start(); replay.stop(); resolve({ columns: [column(400)], trades: [] });
  await clock.advance(100000);
  assert.equal(emitted, 1);
  assert.equal((replay as any).current.columns.length, 0);
  assert.equal((replay as any).nextReady, null);
});
test("a failed future window is reported, not silently treated as replay completion", async () => {
  const clock = new Clock(); let errors = 0, ended = 0;
  const replay = new WindowedReplay({ columns: [], trades: [] }, 100, 800, 10,
    async () => { throw Error("disk_failed"); },
    { column: () => {}, trades: () => {}, end: () => ended++, error: () => errors++ }, clock);
  replay.start(); await clock.advance(40000);
  assert.equal(errors, 1); assert.equal(ended, 0);
});
