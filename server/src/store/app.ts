import * as fs from "node:fs/promises";
import path from "node:path";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import { LocalStore, hourOf, ranges } from "./local.ts";
import type { Coverage, Kind, Range } from "./local.ts";
import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";
import type { Log } from "../logger.ts";
import { columnFileRange, scanColumnFile, tradeFileRows } from "./records.ts";
import { digest, uploadVerified } from "./objects.ts";
import type { Objects } from "./objects.ts";
import { TradeReadPool } from "./trade-read.ts";
import type { TradeReadSource } from "./trade-read.ts";
import { clipRanges, coveredHours, durableHours, sliceBudget, includesRanges } from "./coverage.ts";
import { compactStartupCoverage } from "./coverage-compaction.ts";
import type { CompactionStatus } from "./coverage-compaction.ts";

const empty = (): Coverage => ({ book: [], tick: [] });
function parseCoverage(bytes: string): Coverage {
  const v = JSON.parse(bytes) as Coverage;
  if (!v || !Array.isArray(v.book) || !Array.isArray(v.tick)
    || [...v.book, ...v.tick].some(r => !Array.isArray(r) || r.length !== 2
      || !r.every(Number.isSafeInteger) || r[0] >= r[1])) throw Error("invalid_object_coverage");
  return { ...v, book: ranges(v.book), tick: ranges(v.tick) };
}
function intersect(input: Range[], hour: number): Range[] {
  return clipRanges(input, hour, hour + 3600);
}

/** Working index is disposable local state; only confirmed uploads enter the cloud index. */
export class AppStore extends LocalStore {
  private objects: Objects;
  private prefix: string;
  private clock: () => number;
  private log: Log;
  private cloud = empty();
  private durableIndex: Record<Kind, Set<number>> = { book: new Set(), tick: new Set() };
  private publishedRevision: string | null = null;
  private publishedHour = -Infinity;
  readonly publicationStats = { count: 0, lastMs: 0, maxMs: 0, totalMs: 0,
    preprocessLastMs: 0, preprocessMaxMs: 0, preprocessHours: 0 };
  private confirmed = new Map<string, string>();
  private temporary = new Map<string, string>();
  private tradeReads: TradeReadPool;
  private pins = new Map<string, number>();
  private publisher: Promise<void> | null = null;
  private attempts = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private stopping = false;
  private stopHour = 0;
  private checkpointReady = false;
  private stopAttempted = new Set<string>();
  private activeObject: string | null = null;
  private stopSignal?: AbortSignal;
  private publicationAbort = new AbortController();
  private stopOutcomes = new Map<string, string>();
  private initialStopPlan: Promise<void> = Promise.resolve();
  private stopFiles: { object: string; file: string; reason: string }[] = [];
  readonly cloudStatus = { mode: "app-storage", prefix: "", uploading: false,
    uploads: 0, coverageOnlyUploads: 0, downloads: 0, failures: 0, lastError: null as string | null,
    nextRetryAtUs: null as number | null, pending: [] as string[], cacheHours: 48,
    coverageCompaction: { state: "pending", backups: [] } as CompactionStatus };
  constructor(root: string, objects: Objects, prefix: string, log: Log, now = Date.now, symbol: MarketSymbol = "NQ") {
    super(root, now, fs.rename, symbol); this.objects = objects; this.prefix = prefix; this.log = log; this.clock = now;
    this.cloudStatus.prefix = prefix;
    this.tradeReads = new TradeReadPool(path.join(root, ".trade-read-temporary"), () =>
      this.log("trade_read_cleanup_failed", { symbol: this.symbol }));
  }
  get tradeReadStats() { return { ...this.tradeReads.stats }; }
  override get coverageIntervals() {
    return { ...super.coverageIntervals, cloud: { book: this.cloud.book.length, tick: this.cloud.tick.length },
      cloudCompactionVersion: this.cloud.tickGapCompactionVersion ?? null, publish: { ...this.publicationStats } };
  }
  private async setCloud(value: Coverage) {
    const index = await durableHours(value);
    this.cloud = value; this.durableIndex = index;
  }
  async tradeReadsSettled() { await this.tradeReads.settled(); }
  override tradeReadSession(signal: AbortSignal) {
    return this.tradeReads.session(signal, async hour => {
      let source: TradeReadSource | null = null;
      await this.run(async () => {
      // Only fully durable, closed, cold hours. Partial/unconfirmed/writable files stay on the old path.
      const coverage = intersect(this.cloud.tick, hour);
      if (hour + 3600 > this.clock() / 1000 - 48 * 3600 || this.held.has(hour)
        || coverage.length !== 1 || coverage[0]![0] !== hour || coverage[0]![1] !== hour + 3600) return;
      const name = this.object("tick", hour), base = this.file("tick", hour);
      const cached = await this.exists(base), stamp = this.confirmed.get(name);
      if (cached && stamp !== await this.fingerprint(base)) return;
      // Each active scope pins one immutable downloaded version. Last release removes it;
      // later scopes download anew. Local replacement gets a distinct confirmation identity.
      source = { key: `${this.symbol}:${name}:${stamp ?? "cloud"}`, cached,
        download: async (file: string) => {
          if (cached) {
            let readFailure: unknown;
            await this.run(async () => {
              try {
                if (stamp !== await this.fingerprint(base)) throw Error("trade_read_source_changed");
                await fs.copyFile(base, file);
              } catch (error) { readFailure = error; }
            });
            if (readFailure) throw readFailure;
            return;
          }
          await this.objects.download(name, file);
          this.cloudStatus.downloads++;
        } };
      });
      return source;
    }, (hour, start, end, visit) => this.withRange(hour, hour + 3600,
      () => this.run(() => this.visitTradeHour(hour, start, end, visit)), ["tick"]));
  }
  private key(kind: Kind, hour: number) { return `${kind}:${hour}`; }
  private object(kind: Kind, hour: number) {
    return this.prefix + path.relative(this.root, this.file(kind, hour)).replaceAll("\\", "/")
      + (kind === "book" ? ".gz" : "");
  }
  private async fingerprint(file: string) {
    const s = await fs.stat(file); return `${s.size}:${s.mtimeMs}`;
  }
  protected override async retention() { /* No seven-day deletion in App Storage mode. */ }
  override get savedRange() {
    return this.bounds ? { ...this.bounds } : null;
  }
  override async initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await fs.mkdir(this.root, { recursive: true });
    const index = path.join(this.root, "coverage.json"), fetched = index + ".cloud";
    let cloudFile: string | undefined;
    if (await this.objects.exists(this.prefix + "coverage.json")) {
      signal?.throwIfAborted();
      await this.objects.download(this.prefix + "coverage.json", fetched);
      this.cloud = parseCoverage(await fs.readFile(fetched, "utf8")); cloudFile = fetched;
    } else this.cloud.tickGapCompactionVersion = 1; // No previous cloud index to migrate or back up.
    let working = empty();
    const workingFile = await this.exists(index) ? index : undefined;
    if (workingFile) working = parseCoverage(await fs.readFile(index, "utf8"));
    else working.tickGapCompactionVersion = this.cloud.tickGapCompactionVersion;
    // A lost local hour cannot make an unuploaded interval appear persisted.
    for (const kind of ["book", "tick"] as const) {
      const surviving: Range[] = [];
      for (const [a, b] of working[kind]) for (let h = hourOf(a); h < b; h += 3600) {
        signal?.throwIfAborted();
        const file = this.file(kind, h);
        if (await this.exists(file) || kind === "book" && await this.exists(file + ".gz"))
          surviving.push(...intersect([[a, b]], h));
      }
      working[kind] = ranges([...this.cloud[kind], ...surviving]);
    }
    signal?.throwIfAborted();
    const compacted = await compactStartupCoverage({ objects: this.objects, prefix: this.prefix,
      symbol: this.symbol, root: this.root, now: this.clock(), cloud: this.cloud, working, cloudFile, workingFile });
    await this.setCloud(compacted.cloud); working = compacted.working;
    this.cloudStatus.coverageCompaction = compacted.status;
    this.log("coverage_startup_compaction", { symbol: this.symbol, ...compacted.status });
    if (cloudFile) await fs.rm(cloudFile, { force: true });
    await fs.writeFile(index, JSON.stringify(working));
    await super.initialize(signal);
    for (const [a, b] of [...working.book, ...working.tick]) this.bounds = {
      fromSec: Math.min(this.bounds?.fromSec ?? a, a), toSec: Math.max(this.bounds?.toSec ?? b, b) };
    // Restore confirmation only from actual cloud bytes AND the same covered
    // intervals, never merely from a filename, size, or local working coverage.
    for (const file of await this.allFiles()) {
      signal?.throwIfAborted();
      if (!file.endsWith(".gz")) continue;
      const { hour, kind, name } = this.describe(file);
      if (!this.durable(kind, hour)
        || JSON.stringify(intersect(working[kind], hour)) !== JSON.stringify(intersect(this.cloud[kind], hour))) continue;
      const check = path.join(this.root, ".upload", randomUUID() + ".cache-check");
      try {
        await fs.mkdir(path.dirname(check), { recursive: true });
        await this.objects.download(name, check);
        if (await digest(check) === await digest(file)) {
          this.confirmed.set(name, await this.fingerprint(file));
          this.log("app_storage_cache_verified", { object: name });
        }
      } finally { await fs.rm(check, { force: true }); }
    }
    signal?.throwIfAborted();
    this.log("app_storage_initialized", { prefix: this.prefix, durable: this.cloud });
  }
  private describe(file: string) {
    const m = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
    const hour = Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000;
    const kind: Kind = file.includes("columns/") ? "book" : "tick";
    return { hour, kind, name: this.object(kind, hour) };
  }
  beginShutdown(signal: AbortSignal) {
    if (this.stopping) return;
    this.stopping = true;
    this.stopHour = hourOf(this.clock() / 1000);
    const abort = () => this.publicationAbort.abort();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    this.stopSignal = this.publicationAbort.signal;
    if (this.activeObject) this.stopAttempted.add(this.activeObject);
    this.retryAt.clear(); this.cloudStatus.nextRetryAtUs = null;
    this.initialStopPlan = this.shutdownFiles().catch(() => this.log("app_storage_shutdown_plan_failed", {}));
  }
  shutdownSummary() {
    const uploaded = [...this.stopOutcomes].filter(([, reason]) => reason === "uploaded")
      .map(([object, reason]) => ({ object, file: path.join(this.root, object.slice(this.prefix.length)), reason }));
    const remaining = this.stopFiles.filter(f => this.stopOutcomes.get(f.object) !== "uploaded")
      .map(f => ({ ...f, reason: this.stopOutcomes.get(f.object)
        ?? (this.stopSignal?.aborted && f.reason !== "open_at_signal" ? "deadline" : f.reason) }));
    return { uploaded, remaining, attempted: [...this.stopAttempted],
      active: this.activeObject, cutoffHour: this.stopHour };
  }
  private closed(hour: number) {
    // Orderly shutdown checkpoints the observed open hour too. Normal operation
    // still publishes only closed hours; never invent a future column.
    return this.stopping ? hour < this.stopHour || this.checkpointReady && hour === this.stopHour
      : hour + 3600 <= this.clock() / 1000;
  }
  private async shutdownFiles() {
    if (!this.stopping) return;
    const previous = new Map(this.stopFiles.map(f => [f.object, f.reason]));
    const index = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
    this.stopFiles = [];
    for (const file of await this.allFiles()) {
      const { hour, name, kind } = this.describe(file);
      if (this.confirmed.get(name) === await this.fingerprint(file)
        && includesRanges(this.cloud[kind], intersect(index[kind], hour))) continue;
      this.stopFiles.push({ object: name, file,
        reason: !this.closed(hour) ? "open_at_signal" : previous.get(name) ?? "not_attempted" });
    }
    this.log("app_storage_shutdown_plan", this.shutdownSummary());
  }
  private outcome(name: string, reason: string) {
    if (!this.stopping) return;
    this.stopOutcomes.set(name, reason);
    const entry = this.stopFiles.find(f => f.object === name);
    if (entry) entry.reason = reason;
  }
  private durable(kind: Kind, hour: number) { return this.durableIndex[kind].has(hour); }
  private async hydrate(kind: Kind, hour: number, writable: boolean) {
    const key = this.key(kind, hour), base = this.file(kind, hour);
    if (await this.exists(base) || kind === "book" && await this.exists(base + ".gz")) return;
    // A successful data upload followed by an index failure leaves an orphan
    // object. Never overwrite its first half with a fresh process's second half.
    const orphan = !this.durable(kind, hour);
    if (orphan && (!writable || !await this.objects.exists(this.object(kind, hour)))) return;
    if (!writable && this.temporary.has(key)) return;
    const old = hour + 3600 <= this.clock() / 1000 - 48 * 3600;
    const destination = old && !writable
      ? path.join(this.root, ".read-temporary", randomUUID() + (kind === "book" ? ".bin.gz" : ".jsonl.gz"))
      : base + (kind === "book" ? ".gz" : "");
    const staged = destination + ".download";
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await this.objects.download(this.object(kind, hour), staged);
      const seconds = new Set<number>();
      if (orphan) {
        // Staged suffix is .download, so explicitly retain the gzip extension.
        const inspect = staged + ".gz";
        await fs.rename(staged, inspect);
        try {
          if (kind === "book") await scanColumnFile(inspect, sec => seconds.add(sec));
          else for await (const t of tradeFileRows(inspect)) seconds.add(Math.floor(t.tsUs / 1e6));
          for (const sec of seconds) {
            if (!Number.isSafeInteger(sec) || sec < hour || sec >= hour + 3600)
              throw Error("orphan_record_outside_hour");
          }
          await fs.rename(inspect, staged);
        } finally { await fs.rm(inspect, { force: true }); }
      }
      await fs.rename(staged, destination);
      if (!(old && !writable)) this.filesChanged(destination);
      this.cloudStatus.downloads++;
      if (old && !writable) this.temporary.set(key, destination);
      else if (!orphan) this.confirmed.set(this.object(kind, hour), await this.fingerprint(destination));
      if (orphan) {
        for (const [a, b] of ranges([...seconds].map(s => [s, s + 1]))) this.markCovered(kind, a, b);
        this.log("app_storage_orphan_recovered", { symbol: this.symbol, kind, hour, seconds: seconds.size });
      }
      this.log("app_storage_downloaded", { object: this.object(kind, hour), temporary: old && !writable });
    } finally { await fs.rm(staged, { force: true }); }
  }
  private async withRange<T>(start: number, end: number, work: () => Promise<T>,
    kinds: readonly Kind[] = ["book", "tick"], nonFatalRead = false): Promise<T> {
    const keys: string[] = [];
    for (let h = hourOf(start); h < end; h += 3600) for (const kind of kinds) {
      const k = this.key(kind, h); keys.push(k); this.pins.set(k, (this.pins.get(k) ?? 0) + 1);
    }
    try {
      let readFailure: unknown;
      await this.run(async () => {
        try {
          for (let h = hourOf(start); h < end; h += 3600)
            for (const kind of kinds) await this.hydrate(kind, h, false);
        } catch (e) { if (!nonFatalRead) throw e; readFailure = e; }
      });
      if (readFailure) throw readFailure;
      return await work();
    } finally {
      for (const k of keys) {
        const n = this.pins.get(k)! - 1;
        if (n) this.pins.set(k, n);
        else {
          this.pins.delete(k);
          const file = this.temporary.get(k);
          if (file) { this.temporary.delete(k); await fs.rm(file, { force: true }); }
        }
      }
    }
  }
  protected override tradeInputPath(hour: number) {
    return this.temporary.get(this.key("tick", hour)) ?? super.tradeInputPath(hour);
  }
  protected override async labelColumnPath(hour: number, base: string) {
    return this.temporary.get(this.key("book", hour)) ?? super.labelColumnPath(hour, base);
  }
  override labelHourInput(hour: number, directory: string) {
    return this.withRange(hour, hour + 3600, () => super.labelHourInput(hour, directory), ["book", "tick"], true);
  }
  protected override async readColumnRange(hour: number, start: number, end: number) {
    const base = this.file("book", hour);
    const file = this.temporary.get(this.key("book", hour))
      ?? (await this.exists(base) ? base : base + ".gz");
    const result: Column[] = [];
    if (await this.exists(file)) for await (const c of columnFileRange(file, start, end)) result.push(c);
    return result;
  }
  override readColumns(a: number, b: number) { return this.withRange(a, b, () => super.readColumns(a, b)); }
  override actualBookSeconds(a: number, b: number) {
    return this.withRange(a, b, () => super.actualBookSeconds(a, b), ["book"]);
  }
  override readTrades(a: number, b: number) { return this.withRange(a, b, () => super.readTrades(a, b)); }
  override readView(a: number, b: number) { return this.withRange(a, b, () => super.readView(a, b)); }
  override visitTrades(a: number, b: number, visit: (t: Trade) => void) {
    return this.withRange(a, b, () => super.visitTrades(a, b, visit), ["tick"]);
  }
  private async writable(kind: Kind, hours: number[]) {
    await this.run(async () => { for (const h of new Set(hours)) await this.hydrate(kind, h, true); });
  }
  override async addColumns(columns: Column[]) {
    await this.writable("book", columns.map(c => hourOf(c.tsSec))); await super.addColumns(columns);
  }
  override async addTrades(trades: Trade[]) {
    await this.writable("tick", trades.map(t => hourOf(t.tsUs / 1e6))); await super.addTrades(trades);
  }
  override async replaceTradeRange(a: number, b: number, trades: Trade[]) {
    const hours: number[] = []; for (let h = hourOf(a); h < b; h += 3600) hours.push(h);
    await this.writable("tick", hours); await super.replaceTradeRange(a, b, trades);
  }
  override async insertUncoveredTradeRange(a: number, b: number, trades: Trade[]) {
    if (!trades.length) { await super.insertUncoveredTradeRange(a, b, trades); return; }
    const hours: number[] = []; for (let h = hourOf(a); h < b; h += 3600) hours.push(h);
    await this.writable("tick", hours); await super.insertUncoveredTradeRange(a, b, trades);
  }
  override async repairMissingColumns(a: number, b: number, columns: Column[]) {
    const hours: number[] = [];
    for (let h = hourOf(a); h < b; h += 3600) hours.push(h);
    await this.writable("book", hours);
    return super.repairMissingColumns(a, b, columns);
  }
  override async repairEmptyTradeSeconds(a: number, b: number, trades: Trade[],
    saved: (trades: Trade[], start: number, end: number) => void) {
    const hours: number[] = [];
    for (let h = hourOf(a); h < b; h += 3600) hours.push(h);
    await this.writable("tick", hours);
    return super.repairEmptyTradeSeconds(a, b, trades, saved);
  }
  private async expireCache() {
    await this.run(async () => {
      for (const file of await this.allFiles()) {
        const m = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
        const h = Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000;
        const kind = file.includes("columns/") ? "book" : "tick";
        if (h + 3600 > this.clock() / 1000 - 48 * 3600 || this.held.has(h)
          || this.pins.has(this.key(kind, h))) continue;
        const name = this.object(kind, h);
        if (this.confirmed.get(name) === await this.fingerprint(file)) {
          await fs.rm(file); this.filesChanged(file);
        }
      }
    });
  }
  private async publish() {
    const started = performance.now(); this.publicationStats.count++;
    this.cloudStatus.uploading = true;
    try {
      // Also persist empty covered hours as empty gzip files, so every index interval has an object.
      await this.run(async () => {
        const at = performance.now(), checkpoint = sliceBudget();
        const index = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
        let hours = 0;
        for (const kind of ["book", "tick"] as const) for (const h of coveredHours(index[kind])) {
            hours++; await checkpoint();
            if (!this.closed(h) || this.held.has(h) || this.durable(kind, h)) continue;
            const file = this.file(kind, h) + (kind === "book" ? ".gz" : "");
            if (!await this.exists(file) && !(kind === "book" && await this.exists(this.file(kind, h)))) {
              await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, gzipSync(""));
              this.filesChanged(file);
            }
        }
        this.publicationStats.preprocessHours = hours;
        this.publicationStats.preprocessLastMs = performance.now() - at;
        this.publicationStats.preprocessMaxMs = Math.max(this.publicationStats.preprocessMaxMs,
          this.publicationStats.preprocessLastMs);
      });
      const candidates = await this.allFiles();
      if (this.stopping) candidates.sort((a, b) => this.describe(b).hour - this.describe(a).hour);
      const localIndex = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
      this.cloudStatus.pending = [];
      for (const file of candidates) {
        if (this.stopSignal?.aborted) break;
        if (!file.endsWith(".gz") && !(this.stopping && file.endsWith(".bin"))) continue;
        const m = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
        const h = Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000;
        const kind: Kind = file.includes("columns/") ? "book" : "tick", name = this.object(kind, h);
        if (!this.closed(h) || this.held.has(h)) continue;
        if (this.confirmed.get(name) === await this.fingerprint(file) &&
          includesRanges(this.cloud[kind], intersect(localIndex[kind], h))) continue;
        if (this.stopping && this.stopAttempted.has(name)) continue;
        this.cloudStatus.pending.push(name);
        if (!this.stopping && (this.retryAt.get(name) ?? 0) > this.clock()) continue;
        this.activeObject = name;
        if (this.stopping) this.stopAttempted.add(name);
        const staged = path.join(this.root, ".upload", randomUUID());
        let stamp = "", covered: Range[] = [], coverageOnly = false;
        try {
          await this.run(async () => {
            await fs.mkdir(path.dirname(staged), { recursive: true });
            stamp = await this.fingerprint(file);
            coverageOnly = this.confirmed.get(name) === stamp;
            if (!coverageOnly) {
              if (file.endsWith(".bin")) await streamPipeline(createReadStream(file), createGzip(),
                createWriteStream(staged), { signal: this.publicationAbort.signal });
              else await fs.copyFile(file, staged);
            }
            const index = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
            covered = intersect(index[kind], h);
          });
          if (!coverageOnly) await uploadVerified(this.objects, name, staged, this.publicationAbort.signal);
          this.stopSignal?.throwIfAborted();
          const next: Coverage = { ...this.cloud, book: this.cloud.book.slice(), tick: this.cloud.tick.slice() };
          next[kind] = ranges([...next[kind], ...covered]);
          await fs.writeFile(staged + ".index", JSON.stringify(next));
          await uploadVerified(this.objects, this.prefix + "coverage.json", staged + ".index", this.publicationAbort.signal);
          this.stopSignal?.throwIfAborted();
          await this.setCloud(next); this.confirmed.set(name, stamp);
          this.attempts.delete(name); this.retryAt.delete(name);
          if (coverageOnly) this.cloudStatus.coverageOnlyUploads++; else this.cloudStatus.uploads++;
          this.cloudStatus.pending = this.cloudStatus.pending.filter(n => n !== name);
          this.cloudStatus.lastError = null;
          this.log("app_storage_uploaded", { object: name, covered, sha256Verified: true, coverageOnly });
          let unchanged = stamp === await this.fingerprint(file);
          if (this.stopping && unchanged) await this.run(async () => {
            const index = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
            unchanged = includesRanges(this.cloud[kind], intersect(index[kind], h));
          });
          this.outcome(name, unchanged ? "uploaded" : "changed_after_snapshot");
        } catch {
          if (this.stopping) {
            const reason = this.stopSignal?.aborted ? "deadline" : "upload_or_index_failed";
            this.outcome(name, reason);
            this.log("app_storage_shutdown_upload_failed", { object: name, reason });
            continue;
          }
          const attempts = (this.attempts.get(name) ?? 0) + 1;
          this.attempts.set(name, attempts);
          const at = this.clock() + Math.min(900_000, 60_000 * 2 ** Math.min(attempts - 1, 4));
          this.retryAt.set(name, at);
          this.cloudStatus.failures++; this.cloudStatus.lastError = "object_upload_or_index_failed";
          this.log("app_storage_retry", { object: name, attempts, retryAtUs: at * 1000 });
        } finally {
          this.activeObject = null;
          await fs.rm(staged, { force: true }); await fs.rm(staged + ".index", { force: true });
        }
      }
      const retries = [...this.retryAt.values()];
      this.cloudStatus.nextRetryAtUs = retries.length ? Math.min(...retries) * 1000 : null;
      if (!this.stopping) await this.expireCache();
    } finally {
      this.cloudStatus.uploading = false;
      const elapsed = performance.now() - started;
      this.publicationStats.lastMs = elapsed;
      this.publicationStats.totalMs += elapsed;
      this.publicationStats.maxMs = Math.max(this.publicationStats.maxMs, elapsed);
    }
  }
  private pump(shutdown = false) {
    if (this.stopping && !shutdown) return Promise.resolve();
    const revision = this.publicationRevision, hour = hourOf(this.clock() / 1000);
    const retryDue = [...this.retryAt.values()].some(at => at <= this.clock());
    if (!shutdown && revision === this.publishedRevision && hour === this.publishedHour && !retryDue)
      return this.publisher ?? Promise.resolve();
    if (!this.publisher) {
      this.publishedRevision = revision; this.publishedHour = hour;
      this.publisher = this.publish().catch(() => {
      this.cloudStatus.lastError = "object_publication_failed";
      this.publishedRevision = null;
      this.log("app_storage_publication_error", { reason: this.cloudStatus.lastError });
    }).finally(() => { this.publisher = null; });
    }
    return this.publisher;
  }
  override async maintenance() { if (this.stopping) return; await super.maintenance(); void this.pump(); }
  override async flush() {
    await super.flush();
    if (this.stopping) this.checkpointReady = true;
    await this.initialStopPlan;
    await this.shutdownFiles();
    if (this.stopping && this.stopSignal) {
      const signal = this.stopSignal;
      let abort!: () => void;
      const expired = new Promise<void>(resolve => {
        abort = resolve;
        if (signal.aborted) resolve(); else signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([(async () => { await this.publisher; if (!signal.aborted) await this.pump(true); })(), expired]);
      } finally { signal.removeEventListener("abort", abort); }
      this.log("app_storage_shutdown_summary", this.shutdownSummary());
    } else { await this.publisher; await this.pump(true); }
  }
  async publicationSettled() { await this.publisher; }
}
