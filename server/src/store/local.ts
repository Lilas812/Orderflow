import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { encodeColumns, decodeColumns } from "./binary.ts";
import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
export type Kind = "book" | "tick";
type Range = [number, number];
type Coverage = Record<Kind, Range[]>;
export interface Store {
  initialize(): Promise<void>;
  hold(start: number, end: number): void;
  addColumns(columns: Column[]): Promise<void>;
  addTrades(trades: Trade[]): Promise<void>;
  covered(kind: Kind, second: number): boolean;
  markCovered(kind: Kind, start: number, end: number): void;
  releaseHour(hour: number): Promise<void>;
  readColumns(start: number, end: number): Promise<Column[]>;
  readTrades(start: number, end: number): Promise<Trade[]>;
  flush(): Promise<void>;
}

function ranges(input: Range[]): Range[] {
  const result: Range[] = [];
  for (const [a, b] of input.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
export const hourOf = (sec: number) => Math.floor(sec / 3600) * 3600;

/** One serialization queue protects live append, history merge, rotation and readers. */
export class LocalStore implements Store {
  readonly root: string;
  readonly stats = { files: 0, bytes: 0, latestColumnSec: null as number | null, pendingColumns: 0, pendingTrades: 0 };
  private coverage: Coverage = { book: [], tick: [] };
  private held = new Set<number>();
  private columns = new Map<number, Map<number, Column>>();
  private trades = new Map<number, Trade[]>();
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private now: () => number;
  constructor(root: string, now: () => number = Date.now) { this.root = root; this.now = now; }

  private run(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      await work();
    });
    this.queue = job.catch((e: unknown) => { this.failure = e instanceof Error ? e : Error("store_failed"); });
    return job;
  }
  private file(kind: Kind, hour: number) {
    const date = new Date(hour * 1000).toISOString();
    return path.join(this.root, kind === "book" ? "columns/NQ/1s" : "trades/NQ", date.slice(0, 10),
      date.slice(11, 13) + (kind === "book" ? ".bin" : ".jsonl.gz"));
  }
  private async exists(file: string) {
    try { await fs.access(file); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  private async atomic(file: string, bytes: Buffer | string) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file + ".tmp", bytes, { mode: 0o600 });
    await fs.rename(file + ".tmp", file);
  }
  private async allFiles(): Promise<string[]> {
    const result: string[] = [];
    for (const dir of ["columns/NQ/1s", "trades/NQ"]) {
      const base = path.join(this.root, dir);
      if (!await this.exists(base)) continue;
      for (const name of await fs.readdir(base, { recursive: true })) {
        if (/^\d{4}-\d\d-\d\d[/\\]\d\d\.(?:bin(?:\.gz)?|jsonl\.gz)$/.test(name)) result.push(path.join(base, name));
      }
    }
    return result;
  }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const index = path.join(this.root, "coverage.json");
    if (await this.exists(index)) {
      const value: unknown = JSON.parse(await fs.readFile(index, "utf8"));
      const v = value as Coverage;
      if (!v || !Array.isArray(v.book) || !Array.isArray(v.tick)
        || [...v.book, ...v.tick].some(r => !Array.isArray(r) || r.length !== 2
          || !r.every(Number.isSafeInteger) || r[0] >= r[1])) throw Error("invalid_coverage_index");
      this.coverage = v;
    }
    await this.retention();
    // Recover actually persisted seconds even if a crash preceded index replacement.
    for (const file of await this.allFiles()) {
      if (file.endsWith(".bin") || file.endsWith(".bin.gz")) {
        let bytes = await fs.readFile(file);
        if (file.endsWith(".gz")) bytes = await gunzip(bytes);
        for (const c of decodeColumns(bytes)) {
          this.markCovered("book", c.tsSec, c.tsSec + 1);
          this.stats.latestColumnSec = Math.max(this.stats.latestColumnSec ?? 0, c.tsSec);
        }
      } else {
        const text = (await gunzip(await fs.readFile(file))).toString();
        for (const line of text.split("\n").filter(Boolean)) {
          const trade = JSON.parse(line) as Trade;
          const sec = Math.floor(trade.tsUs / 1_000_000);
          this.markCovered("tick", sec, sec + 1);
        }
      }
    }
    await this.refreshStats();
  }
  hold(start: number, end: number) {
    for (let hour = hourOf(start); hour < end; hour += 3600) this.held.add(hour);
  }
  covered(kind: Kind, second: number) {
    return this.coverage[kind].some(([a, b]) => a <= second && second < b);
  }
  markCovered(kind: Kind, start: number, end: number) {
    this.coverage[kind] = ranges([...this.coverage[kind], [start, end]]);
  }
  addColumns(columns: Column[]) {
    return this.run(async () => {
      const hours = new Set<number>();
      for (const c of columns) {
        const hour = hourOf(c.tsSec);
        const pending = this.columns.get(hour) ?? new Map<number, Column>();
        // Existing seconds always win. L separates historical and live ownership.
        if (!pending.has(c.tsSec)) pending.set(c.tsSec, c);
        this.columns.set(hour, pending); hours.add(hour);
      }
      for (const hour of hours) if (!this.held.has(hour)) await this.writeHour(hour);
      this.pendingStats();
    });
  }
  addTrades(trades: Trade[]) {
    return this.run(async () => {
      const hours = new Set<number>();
      for (const t of trades) {
        const hour = hourOf(Math.floor(t.tsUs / 1_000_000));
        const pending = this.trades.get(hour) ?? [];
        pending.push(t); this.trades.set(hour, pending); hours.add(hour);
      }
      for (const hour of hours) if (!this.held.has(hour)) await this.writeHour(hour);
      this.pendingStats();
    });
  }
  releaseHour(hour: number) {
    return this.run(async () => {
      await this.writeHour(hour);
      this.held.delete(hour);
      await this.saveCoverage();
      this.pendingStats();
      await this.refreshStats();
    });
  }
  private async columnBytes(hour: number): Promise<Buffer> {
    const bin = this.file("book", hour);
    if (await this.exists(bin)) return fs.readFile(bin);
    if (await this.exists(bin + ".gz")) return gunzip(await fs.readFile(bin + ".gz"));
    return Buffer.alloc(0);
  }
  private async tradeRows(hour: number): Promise<Trade[]> {
    const file = this.file("tick", hour);
    if (!await this.exists(file)) return [];
    return (await gunzip(await fs.readFile(file))).toString().split("\n").filter(Boolean).map(l => JSON.parse(l) as Trade);
  }
  private async writeHour(hour: number) {
    const pending = this.columns.get(hour);
    if (pending?.size) {
      const file = this.file("book", hour);
      const incoming = [...pending.values()].sort((a, b) => a.tsSec - b.tsSec);
      const existing = decodeColumns(await this.columnBytes(hour));
      const existingSeconds = new Set(existing.map(c => c.tsSec));
      const fresh = incoming.filter(c => !existingSeconds.has(c.tsSec));
      const closed = hour + 3600 <= Math.floor(this.now() / 1000);
      if (!closed && (!existing.length || fresh.every(c => c.tsSec > existing.at(-1)!.tsSec))
        && !await this.exists(file + ".gz")) {
        if (fresh.length) {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.appendFile(file, encodeColumns(fresh), { mode: 0o600 });
        }
      } else if (fresh.length || closed) {
        const bytes = encodeColumns([...existing, ...fresh].sort((a, b) => a.tsSec - b.tsSec));
        await this.atomic(file + (closed ? ".gz" : ""), closed ? await gzip(bytes) : bytes);
        await fs.rm(closed ? file : file + ".gz", { force: true });
      }
      for (const c of incoming) this.markCovered("book", c.tsSec, c.tsSec + 1);
      this.stats.latestColumnSec = Math.max(this.stats.latestColumnSec ?? 0, incoming.at(-1)!.tsSec);
      this.columns.delete(hour);
    }
    const trades = this.trades.get(hour);
    if (trades?.length) {
      const file = this.file("tick", hour);
      const incoming = trades.slice();
      // Preserve arrival order even when exchange timestamps move backwards.
      if (this.held.has(hour)) {
        const all = [...await this.tradeRows(hour), ...incoming];
        await this.atomic(file, await gzip(all.map(t => JSON.stringify(t) + "\n").join("")));
      } else {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        // Concatenated gzip members are a standard gzip stream and support inexpensive live append.
        await fs.appendFile(file, await gzip(incoming.map(t => JSON.stringify(t) + "\n").join("")), { mode: 0o600 });
      }
      this.trades.delete(hour);
      for (const t of incoming) {
        const sec = Math.floor(t.tsUs / 1_000_000);
        this.markCovered("tick", sec, sec + 1);
      }
    }
  }
  private async saveCoverage() {
    const persisted: Coverage = { book: [], tick: [] };
    for (const kind of ["book", "tick"] as const) {
      for (const [start, end] of this.coverage[kind]) {
        for (let a = start; a < end;) {
          const b = Math.min(end, hourOf(a) + 3600);
          if (!this.held.has(hourOf(a))) persisted[kind].push([a, b]);
          a = b;
        }
      }
      persisted[kind] = ranges(persisted[kind]);
    }
    await this.atomic(path.join(this.root, "coverage.json"), JSON.stringify(persisted));
  }
  private pendingStats() {
    this.stats.pendingColumns = [...this.columns.values()].reduce((a, m) => a + m.size, 0);
    this.stats.pendingTrades = [...this.trades.values()].reduce((a, m) => a + m.length, 0);
  }
  async readColumns(start: number, end: number): Promise<Column[]> {
    await this.queue;
    if (this.failure) throw this.failure;
    const rows: Column[] = [];
    for (let h = hourOf(start); h < end; h += 3600) rows.push(...decodeColumns(await this.columnBytes(h)));
    return rows.filter(c => c.tsSec >= start && c.tsSec < end).sort((a, b) => a.tsSec - b.tsSec);
  }
  async readTrades(start: number, end: number): Promise<Trade[]> {
    await this.queue;
    if (this.failure) throw this.failure;
    const rows: Trade[] = [];
    for (let h = hourOf(start); h < end; h += 3600) rows.push(...await this.tradeRows(h));
    return rows.filter(t => t.tsUs >= start * 1_000_000 && t.tsUs < end * 1_000_000)
      .sort((a, b) => a.seq - b.seq);
  }
  private async retention() {
    const cutoff = Math.floor(this.now() / 1000) - 7 * 86400;
    for (const file of await this.allFiles()) {
      const match = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
      const hour = Date.parse(`${match[1]}T${match[2]}:00:00Z`) / 1000;
      if (hour + 3600 <= cutoff) await fs.unlink(file);
    }
    for (const kind of ["book", "tick"] as const) {
      this.coverage[kind] = this.coverage[kind].filter(([, b]) => b > cutoff).map(([a, b]) => [Math.max(a, cutoff), b]);
    }
  }
  async refreshStats() {
    const files = await this.allFiles();
    this.stats.files = files.length;
    this.stats.bytes = (await Promise.all(files.map(f => fs.stat(f)))).reduce((a, s) => a + s.size, 0);
  }
  maintenance() {
    return this.run(async () => {
      for (const file of await this.allFiles()) {
        if (!file.endsWith(".bin")) continue;
        const match = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
        const hour = Date.parse(`${match[1]}T${match[2]}:00:00Z`) / 1000;
        if (!this.held.has(hour) && hour + 3600 <= this.now() / 1000) {
          await this.atomic(file + ".gz", await gzip(await fs.readFile(file)));
          await fs.unlink(file);
        }
      }
      await this.retention(); await this.saveCoverage(); await this.refreshStats();
    });
  }
  flush() {
    return this.run(async () => {
      // Also persists an interrupted backfill's partial hours on orderly shutdown.
      for (const hour of new Set([...this.columns.keys(), ...this.trades.keys()])) await this.writeHour(hour);
      this.held.clear();
      for (const file of await this.allFiles()) {
        if (!file.endsWith(".bin")) continue;
        const match = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
        if (Date.parse(`${match[1]}T${match[2]}:00:00Z`) + 3600000 <= this.now()) {
          await this.atomic(file + ".gz", await gzip(await fs.readFile(file)));
          await fs.unlink(file);
        }
      }
      await this.retention(); await this.saveCoverage(); await this.refreshStats(); this.pendingStats();
    });
  }
}
