import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { encodeColumns, decodeColumns } from "./binary.ts";
import { scanColumnFile, tradeFileRows, tradeFileEntries, decodeColumnRange, mergeColumnRecords } from "./records.ts";
import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
export type Kind = "book" | "tick";
export type Range = [number, number];
export type Coverage = Record<Kind, Range[]>;
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

export function ranges(input: Range[]): Range[] {
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
  // Keep VP's interval record separate from startup's best-effort file recovery.
  // Finding a row in a partial old file is not proof of a complete tick second.
  private recordedTicks: Range[] = [];
  private recoveringFiles = false;
  protected held = new Set<number>();
  private columns = new Map<number, Map<number, Buffer>>();
  private columnLastSeconds = new Map<number, number>();
  private trades = new Map<number, Trade[]>();
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private now: () => number;
  private replaceVpFile: typeof fs.rename;
  protected bounds: { fromSec: number; toSec: number } | null = null;
  private includeSecond(sec: number) {
    this.bounds = { fromSec: Math.min(this.bounds?.fromSec ?? sec, sec),
      toSec: Math.max(this.bounds?.toSec ?? sec + 1, sec + 1) };
  }
  get savedRange() {
    return this.bounds ? { ...this.bounds, fromSec: Math.max(this.bounds.fromSec, Math.floor(this.now() / 1000) - 7 * 86400) } : null;
  }
  constructor(root: string, now: () => number = Date.now,
    replaceVpFile: typeof fs.rename = fs.rename) {
    this.root = root; this.now = now; this.replaceVpFile = replaceVpFile;
  }

  protected run(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      await work();
    });
    this.queue = job.catch((e: unknown) => { this.failure = e instanceof Error ? e : Error("store_failed"); });
    return job;
  }
  protected file(kind: Kind, hour: number) {
    const date = new Date(hour * 1000).toISOString();
    return path.join(this.root, kind === "book" ? "columns/NQ/1s" : "trades/NQ", date.slice(0, 10),
      date.slice(11, 13) + (kind === "book" ? ".bin" : ".jsonl.gz"));
  }
  protected async exists(file: string) {
    try { await fs.access(file); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  private async atomic(file: string, bytes: Buffer | string) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file + ".tmp", bytes, { mode: 0o600 });
    await fs.rename(file + ".tmp", file);
  }
  protected async allFiles(): Promise<string[]> {
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
      this.recordedTicks = v.tick.map(([a, b]) => [a, b]);
    }
    await this.retention();
    // Recover actually persisted seconds even if a crash preceded index replacement.
    this.recoveringFiles = true;
    for (const file of await this.allFiles()) {
      if (file.endsWith(".bin") || file.endsWith(".bin.gz")) {
        const match = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
        const hour = Date.parse(`${match[1]}T${match[2]}:00:00Z`) / 1000;
        await scanColumnFile(file, second => {
          this.includeSecond(second);
          this.markCovered("book", second, second + 1);
          this.stats.latestColumnSec = Math.max(this.stats.latestColumnSec ?? 0, second);
          this.columnLastSeconds.set(hour, Math.max(this.columnLastSeconds.get(hour) ?? -1, second));
        });
      } else {
        for await (const trade of tradeFileRows(file)) {
          const sec = Math.floor(trade.tsUs / 1_000_000);
          this.includeSecond(sec);
          this.markCovered("tick", sec, sec + 1);
        }
      }
    }
    this.recoveringFiles = false;
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
    if (kind === "tick" && !this.recoveringFiles) this.recordedTicks = ranges([...this.recordedTicks, [start, end]]);
  }
  addColumns(columns: Column[]) {
    return this.run(async () => {
      const hours = new Set<number>();
      for (const c of columns) {
        this.includeSecond(c.tsSec);
        const hour = hourOf(c.tsSec);
        const pending = this.columns.get(hour) ?? new Map<number, Buffer>();
        // Existing seconds always win. L separates historical and live ownership.
        if (!pending.has(c.tsSec)) pending.set(c.tsSec, encodeColumns([c]));
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
        this.includeSecond(Math.floor(t.tsUs / 1_000_000));
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
    const rows: Trade[] = [];
    for await (const trade of tradeFileRows(file)) rows.push(trade);
    return rows;
  }
  private async writeHour(hour: number) {
    const pending = this.columns.get(hour);
    if (pending?.size) {
      const file = this.file("book", hour);
      const incoming = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      const closed = hour + 3600 <= Math.floor(this.now() / 1000);
      const compressed = await this.exists(file + ".gz");
      const knownLast = this.columnLastSeconds.get(hour);
      let last: number;
      if (!closed && knownLast !== undefined && incoming[0][0] > knownLast && !compressed) {
        // The only writer owns this metadata; ordinary live append never needs
        // to decode or copy the entire growing hour.
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.appendFile(file, Buffer.concat(incoming.map(([, bytes]) => bytes)), { mode: 0o600 });
        last = incoming.at(-1)![0];
      } else {
        const merged = mergeColumnRecords(await this.columnBytes(hour), pending);
        if (!closed && merged.appendOnly && !compressed) {
          if (merged.freshCount) {
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await fs.appendFile(file, merged.fresh, { mode: 0o600 });
          }
        } else if (merged.freshCount || closed) {
          await this.atomic(file + (closed ? ".gz" : ""), closed ? await gzip(merged.bytes) : merged.bytes);
          await fs.rm(closed ? file : file + ".gz", { force: true });
        }
        last = merged.lastSecond;
      }
      if (last >= 0) this.columnLastSeconds.set(hour, last);
      for (const [second] of incoming) this.markCovered("book", second, second + 1);
      this.stats.latestColumnSec = Math.max(this.stats.latestColumnSec ?? 0, incoming.at(-1)![0]);
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
      for (const [start, end] of kind === "tick" ? this.recordedTicks : this.coverage[kind]) {
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
    for (let h = hourOf(start); h < end; h += 3600) rows.push(...await this.readColumnRange(h, start, end));
    return rows.sort((a, b) => a.tsSec - b.tsSec);
  }
  async readTrades(start: number, end: number): Promise<Trade[]> {
    await this.queue;
    if (this.failure) throw this.failure;
    const rows: Trade[] = [];
    for (let h = hourOf(start); h < end; h += 3600) {
      const file = this.tradeInputPath(h);
      if (await this.exists(file)) for await (const t of tradeFileRows(file)) {
        if (t.tsUs >= start * 1e6 && t.tsUs < end * 1e6) rows.push(t);
      }
    }
    return rows.sort((a, b) => a.seq - b.seq);
  }
  protected tradeInputPath(hour: number) { return this.file("tick", hour); }
  protected readColumnRange(hour: number, start: number, end: number): Promise<Column[]> {
    return this.columnBytes(hour).then(bytes => decodeColumnRange(bytes, start, end));
  }
  /** VP uses the persisted Phase2a interval record, never file existence alone. */
  async recordedTickCoverage(): Promise<[number, number][]> {
    await this.queue;
    if (this.failure) throw this.failure;
    const file = path.join(this.root, "coverage.json");
    if (!await this.exists(file)) return [];
    return (JSON.parse(await fs.readFile(file, "utf8")) as Coverage).tick;
  }
  /** Bounded-memory, serialized walk of the unchanged gzip JSONL files. */
  visitTrades(start: number, end: number, visit: (trade: Trade) => void): Promise<void> {
    return this.run(async () => {
      for (let h = hourOf(start); h < end; h += 3600) {
        const file = this.tradeInputPath(h);
        if (await this.exists(file)) for await (const t of tradeFileRows(file)) {
          if (t.tsUs >= start * 1e6 && t.tsUs < end * 1e6) visit(t);
        }
      }
    });
  }
  replaceTradeRange(start: number, end: number, trades: Trade[]): Promise<void> {
    return this.run(async () => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end
        || trades.some(t => t.tsUs < start * 1e6 || t.tsUs >= end * 1e6)) throw Error("invalid_vp_insert_range");
      if (this.recordedTicks.some(([a, b]) => a < end && start < b)) throw Error("vp_insert_overlaps_coverage");
      const staged: { file: string; temporary: string }[] = [];
      // Stage every affected hour before replacing any original. Never remove or
      // reorder old rows, including when exchange timestamps arrive backwards.
      try {
        for (let h = hourOf(start); h < end; h += 3600) {
          const file = this.file("tick", h), temporary = file + ".vp.tmp";
          const exists = await this.exists(file);
          const incoming = trades.filter(t => t.tsUs >= h * 1e6 && t.tsUs < (h + 3600) * 1e6)
            .sort((a, b) => a.tsUs - b.tsUs);
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          staged.push({ file, temporary });
          async function* lines() {
            let inserted = false;
            const fresh = function* () { for (const t of incoming) yield JSON.stringify(t) + "\n"; };
            if (exists) for await (const { line, trade } of tradeFileEntries(file)) {
              if (trade.tsUs >= start * 1e6 && trade.tsUs < end * 1e6)
                throw Error("vp_insert_existing_rows_in_missing_range");
              if (!inserted && trade.tsUs >= end * 1e6) { yield* fresh(); inserted = true; }
              yield line + "\n";
            }
            if (!inserted) yield* fresh();
          }
          await streamPipeline(Readable.from(lines()), createGzip(), createWriteStream(temporary, { mode: 0o600 }));
        }
        for (const { file, temporary } of staged) await this.replaceVpFile(temporary, file);
        // Index replacement is strictly after all data-file replacements.
        this.markCovered("tick", start, end); await this.saveCoverage();
      } finally { for (const { temporary } of staged) await fs.rm(temporary, { force: true }); }
    });
  }
  /** Atomic delivery view: persisted data plus confirmed writes held for backfill.
   * Existing disk columns win, just as in writeHour. No unconfirmed column or filled second.
   * Serialized with writers so a moving pending batch cannot appear twice/disappear.
   */
  readView(start: number, end: number): Promise<{ columns: Column[]; trades: Trade[] }> {
    let result: { columns: Column[]; trades: Trade[] };
    return this.run(async () => {
      const columns = new Map<number, Column>(), trades: Trade[] = [];
      for (let h = hourOf(start); h < end; h += 3600) {
        for (const c of await this.readColumnRange(h, start, end)) columns.set(c.tsSec, c);
        for (const [second, bytes] of this.columns.get(h) ?? []) {
          if (second >= start && second < end && !columns.has(second)) columns.set(second, decodeColumns(bytes)[0]);
        }
        const file = this.tradeInputPath(h);
        if (await this.exists(file)) for await (const t of tradeFileRows(file)) {
          if (t.tsUs >= start * 1e6 && t.tsUs < end * 1e6) trades.push(t);
        }
        for (const t of this.trades.get(h) ?? []) if (t.tsUs >= start * 1e6 && t.tsUs < end * 1e6) trades.push(t);
      }
      result = { columns: [...columns.values()].filter(c => c.tsSec >= start && c.tsSec < end)
        .sort((a, b) => a.tsSec - b.tsSec),
      trades: trades.filter(t => t.tsUs >= start * 1e6 && t.tsUs < end * 1e6).sort((a, b) => a.seq - b.seq) };
    }).then(() => result);
  }
  protected async retention() {
    const cutoff = Math.floor(this.now() / 1000) - 7 * 86400;
    for (const hour of this.columnLastSeconds.keys()) if (hour + 3600 <= cutoff) this.columnLastSeconds.delete(hour);
    for (const file of await this.allFiles()) {
      const match = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
      const hour = Date.parse(`${match[1]}T${match[2]}:00:00Z`) / 1000;
      if (hour + 3600 <= cutoff) await fs.unlink(file);
    }
    for (const kind of ["book", "tick"] as const) {
      this.coverage[kind] = this.coverage[kind].filter(([, b]) => b > cutoff).map(([a, b]) => [Math.max(a, cutoff), b]);
    }
    this.recordedTicks = this.recordedTicks.filter(([, b]) => b > cutoff).map(([a, b]) => [Math.max(a, cutoff), b]);
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
