import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { LocalStore, hourOf, ranges } from "./local.ts";
import type { Coverage, Kind, Range } from "./local.ts";
import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";
import type { Log } from "../logger.ts";
import { columnFileRange } from "./records.ts";
import { digest, uploadVerified } from "./objects.ts";
import type { Objects } from "./objects.ts";

const empty = (): Coverage => ({ book: [], tick: [] });
function parseCoverage(bytes: string): Coverage {
  const v = JSON.parse(bytes) as Coverage;
  if (!v || !Array.isArray(v.book) || !Array.isArray(v.tick)
    || [...v.book, ...v.tick].some(r => !Array.isArray(r) || r.length !== 2
      || !r.every(Number.isSafeInteger) || r[0] >= r[1])) throw Error("invalid_object_coverage");
  return v;
}
function intersect(input: Range[], hour: number): Range[] {
  return input.filter(([a, b]) => a < hour + 3600 && b > hour)
    .map(([a, b]) => [Math.max(a, hour), Math.min(b, hour + 3600)]);
}

/** Working index is disposable local state; only confirmed uploads enter the cloud index. */
export class AppStore extends LocalStore {
  private objects: Objects;
  private prefix: string;
  private clock: () => number;
  private log: Log;
  private cloud = empty();
  private confirmed = new Map<string, string>();
  private temporary = new Map<string, string>();
  private pins = new Map<string, number>();
  private publisher: Promise<void> | null = null;
  private attempts = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private stopping = false;
  private stopHour = 0;
  private stopAttempted = new Set<string>();
  private activeObject: string | null = null;
  private stopSignal?: AbortSignal;
  private publicationAbort = new AbortController();
  private stopOutcomes = new Map<string, string>();
  private initialStopPlan: Promise<void> = Promise.resolve();
  private stopFiles: { object: string; file: string; reason: string }[] = [];
  readonly cloudStatus = { mode: "app-storage", prefix: "", uploading: false,
    uploads: 0, downloads: 0, failures: 0, lastError: null as string | null,
    nextRetryAtUs: null as number | null, pending: [] as string[], cacheHours: 48 };
  constructor(root: string, objects: Objects, prefix: string, log: Log, now = Date.now) {
    super(root, now); this.objects = objects; this.prefix = prefix; this.log = log; this.clock = now;
    this.cloudStatus.prefix = prefix;
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
  override async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    const index = path.join(this.root, "coverage.json"), fetched = index + ".cloud";
    if (await this.objects.exists(this.prefix + "coverage.json")) {
      await this.objects.download(this.prefix + "coverage.json", fetched);
      this.cloud = parseCoverage(await fs.readFile(fetched, "utf8")); await fs.rm(fetched);
    }
    let working = empty();
    if (await this.exists(index)) working = parseCoverage(await fs.readFile(index, "utf8"));
    // A lost local hour cannot make an unuploaded interval appear persisted.
    for (const kind of ["book", "tick"] as const) {
      const surviving: Range[] = [];
      for (const [a, b] of working[kind]) for (let h = hourOf(a); h < b; h += 3600) {
        const file = this.file(kind, h);
        if (await this.exists(file) || kind === "book" && await this.exists(file + ".gz"))
          surviving.push(...intersect([[a, b]], h));
      }
      working[kind] = ranges([...this.cloud[kind], ...surviving]);
    }
    await fs.writeFile(index, JSON.stringify(working));
    await super.initialize();
    for (const [a, b] of [...working.book, ...working.tick]) this.bounds = {
      fromSec: Math.min(this.bounds?.fromSec ?? a, a), toSec: Math.max(this.bounds?.toSec ?? b, b) };
    // Restore confirmation only from actual cloud bytes AND the same covered
    // intervals, never merely from a filename, size, or local working coverage.
    for (const file of await this.allFiles()) {
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
    return this.stopping ? hour < this.stopHour : hour + 3600 <= this.clock() / 1000;
  }
  private async shutdownFiles() {
    if (!this.stopping) return;
    const previous = new Map(this.stopFiles.map(f => [f.object, f.reason]));
    this.stopFiles = [];
    for (const file of await this.allFiles()) {
      const { hour, name } = this.describe(file);
      if (this.confirmed.get(name) === await this.fingerprint(file)) continue;
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
  private durable(kind: Kind, hour: number) { return intersect(this.cloud[kind], hour).length > 0; }
  private async hydrate(kind: Kind, hour: number, writable: boolean) {
    const key = this.key(kind, hour), base = this.file(kind, hour);
    if (await this.exists(base) || kind === "book" && await this.exists(base + ".gz")) return;
    if (!this.durable(kind, hour)) return;
    if (!writable && this.temporary.has(key)) return;
    const old = hour + 3600 <= this.clock() / 1000 - 48 * 3600;
    const destination = old && !writable
      ? path.join(this.root, ".read-temporary", randomUUID() + (kind === "book" ? ".bin.gz" : ".jsonl.gz"))
      : base + (kind === "book" ? ".gz" : "");
    const staged = destination + ".download";
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await this.objects.download(this.object(kind, hour), staged);
      await fs.rename(staged, destination);
      this.cloudStatus.downloads++;
      if (old && !writable) this.temporary.set(key, destination);
      else this.confirmed.set(this.object(kind, hour), await this.fingerprint(destination));
      this.log("app_storage_downloaded", { object: this.object(kind, hour), temporary: old && !writable });
    } finally { await fs.rm(staged, { force: true }); }
  }
  private async withRange<T>(start: number, end: number, work: () => Promise<T>,
    kinds: readonly Kind[] = ["book", "tick"]): Promise<T> {
    const keys: string[] = [];
    for (let h = hourOf(start); h < end; h += 3600) for (const kind of kinds) {
      const k = this.key(kind, h); keys.push(k); this.pins.set(k, (this.pins.get(k) ?? 0) + 1);
    }
    try {
      await this.run(async () => {
        for (let h = hourOf(start); h < end; h += 3600)
          for (const kind of kinds) await this.hydrate(kind, h, false);
      });
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
  protected override async readColumnRange(hour: number, start: number, end: number) {
    const base = this.file("book", hour);
    const file = this.temporary.get(this.key("book", hour))
      ?? (await this.exists(base) ? base : base + ".gz");
    const result: Column[] = [];
    if (await this.exists(file)) for await (const c of columnFileRange(file, start, end)) result.push(c);
    return result;
  }
  override readColumns(a: number, b: number) { return this.withRange(a, b, () => super.readColumns(a, b)); }
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
    const hours: number[] = []; for (let h = hourOf(a); h < b; h += 3600) hours.push(h);
    await this.writable("tick", hours); await super.insertUncoveredTradeRange(a, b, trades);
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
        if (this.confirmed.get(name) === await this.fingerprint(file)) await fs.rm(file);
      }
    });
  }
  private async publish() {
    this.cloudStatus.uploading = true;
    try {
      // Also persist empty covered hours as empty gzip files, so every index interval has an object.
      await this.run(async () => {
        const index = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
        for (const kind of ["book", "tick"] as const) for (const [a, b] of index[kind])
          for (let h = hourOf(a); h < b; h += 3600) {
            if (!this.closed(h) || this.held.has(h) || this.durable(kind, h)) continue;
            const file = this.file(kind, h) + (kind === "book" ? ".gz" : "");
            if (!await this.exists(file)) {
              await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, gzipSync(""));
            }
          }
      });
      const candidates = await this.allFiles();
      this.cloudStatus.pending = [];
      for (const file of candidates) {
        if (this.stopSignal?.aborted) break;
        if (!file.endsWith(".gz")) continue;
        const m = file.match(/(\d{4}-\d\d-\d\d)[/\\](\d\d)\./)!;
        const h = Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000;
        const kind: Kind = file.includes("columns/") ? "book" : "tick", name = this.object(kind, h);
        if (!this.closed(h) || this.held.has(h)) continue;
        if (this.confirmed.get(name) === await this.fingerprint(file)) continue;
        if (this.stopping && this.stopAttempted.has(name)) continue;
        this.cloudStatus.pending.push(name);
        if (!this.stopping && (this.retryAt.get(name) ?? 0) > this.clock()) continue;
        this.activeObject = name;
        if (this.stopping) this.stopAttempted.add(name);
        const staged = path.join(this.root, ".upload", randomUUID());
        let stamp = "", covered: Range[] = [];
        try {
          await this.run(async () => {
            await fs.mkdir(path.dirname(staged), { recursive: true });
            stamp = await this.fingerprint(file); await fs.copyFile(file, staged);
            const index = parseCoverage(await fs.readFile(path.join(this.root, "coverage.json"), "utf8"));
            covered = intersect(index[kind], h);
          });
          await uploadVerified(this.objects, name, staged, this.publicationAbort.signal);
          this.stopSignal?.throwIfAborted();
          const next: Coverage = { book: this.cloud.book.slice(), tick: this.cloud.tick.slice() };
          next[kind] = ranges([...next[kind], ...covered]);
          await fs.writeFile(staged + ".index", JSON.stringify(next));
          await uploadVerified(this.objects, this.prefix + "coverage.json", staged + ".index", this.publicationAbort.signal);
          this.stopSignal?.throwIfAborted();
          this.cloud = next; this.confirmed.set(name, stamp);
          this.attempts.delete(name); this.retryAt.delete(name); this.cloudStatus.uploads++;
          this.cloudStatus.pending = this.cloudStatus.pending.filter(n => n !== name);
          this.cloudStatus.lastError = null;
          this.log("app_storage_uploaded", { object: name, covered, sha256Verified: true });
          this.outcome(name, "uploaded");
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
    } finally { this.cloudStatus.uploading = false; }
  }
  private pump(shutdown = false) {
    if (this.stopping && !shutdown) return Promise.resolve();
    if (!this.publisher) this.publisher = this.publish().catch(() => {
      this.cloudStatus.lastError = "object_publication_failed";
      this.log("app_storage_publication_error", { reason: this.cloudStatus.lastError });
    }).finally(() => { this.publisher = null; });
    return this.publisher;
  }
  override async maintenance() { if (this.stopping) return; await super.maintenance(); void this.pump(); }
  override async flush() {
    await super.flush();
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
    } else { await this.publisher; await this.pump(); }
  }
  async publicationSettled() { await this.publisher; }
}
