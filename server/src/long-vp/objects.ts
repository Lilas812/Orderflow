import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { Objects } from "../store/objects.ts";
import { uploadVerified, ObjectGenerationConflict, digest } from "../store/objects.ts";
import type { DayData, RollData } from "./day.ts";
import { validDate, improvesDay } from "./day.ts";
import { validContract, type MarketSymbol } from "../../../lib/market/instruments.ts";

export function validateDay(value: unknown, symbol: MarketSymbol = "NQ"): DayData {
  if (!value || typeof value !== "object") throw Error("invalid_longvp_day");
  const d = value as DayData;
  if (d.version !== 1 || !validDate(d.tradingDate ?? "") || !Number.isInteger(d.startSec)
    || !Number.isInteger(d.endSec) || d.startSec >= d.endSec || !Number.isSafeInteger(d.builtAtUs)
    || !Array.isArray(d.contracts) || !Array.isArray(d.bars1m) || !Array.isArray(d.vp30m)
    || !Array.isArray(d.gaps) || typeof d.complete !== "boolean"
    || (d.complete && d.gaps.length !== 0)) throw Error("invalid_longvp_day");
  for (const c of d.contracts) {
    if (!validContract(c.contract, symbol, true) || !Number.isFinite(c.fromSec) || !Number.isFinite(c.toSec)
      || c.fromSec < d.startSec || c.toSec > d.endSec || c.fromSec >= c.toSec) throw Error("invalid_longvp_contract");
  }
  for (const [rows, length, quantum] of [[d.bars1m, 8, 60], [d.vp30m, 5, 1800]] as const) {
    for (const row of rows) {
      if (!Array.isArray(row) || (row.length !== length && row.length !== length + 1) || !row.every(Number.isSafeInteger)
        || row[0] % quantum !== 0 || row[0] < d.startSec || row[0] >= d.endSec
        || row[length - 1]! < 0 || row[length - 1]! >= d.contracts.length
        || (row[length] ?? 0) < 0) throw Error("invalid_longvp_rows");
      if (length === 8 && (row[5]! < 0 || row[6]! < 0 || row[2] < Math.max(row[1], row[3], row[4])
        || row[3] > Math.min(row[1], row[2], row[4]))) throw Error("invalid_longvp_bar");
      if (length === 5 && (row[2] < 0 || row[3] < 0)) throw Error("invalid_longvp_volume");
    }
  }
  for (const g of d.gaps) if (!Array.isArray(g) || g.length !== 2 || !g.every(Number.isFinite)
    || g[0] < d.startSec || g[1] > d.endSec || g[0] >= g[1]) throw Error("invalid_longvp_gap");
  return d;
}
export function validateRolls(value: unknown, symbol: MarketSymbol = "NQ"): RollData[] {
  if (!Array.isArray(value)) throw Error("invalid_longvp_rolls");
  let previous = -Infinity;
  for (const r of value as RollData[]) {
    if (!r || !validContract(r.from, symbol) || !validContract(r.to, symbol)
      || r.from === r.to || !Number.isFinite(r.atSec) || r.atSec <= previous
      || !Number.isSafeInteger(r.diffTicks) || r.method !== "edge" || !r.detail
      || ![r.detail.beforeUs, r.detail.afterUs, r.detail.beforePrice, r.detail.afterPrice].every(Number.isSafeInteger)
      || r.detail.beforeUs >= r.atSec * 1e6 || r.detail.afterUs < r.atSec * 1e6
      || r.diffTicks !== r.detail.afterPrice - r.detail.beforePrice
      || (r.detail.fromSinceUs !== undefined && (!Number.isSafeInteger(r.detail.fromSinceUs)
        || r.detail.fromSinceUs >= r.atSec * 1e6))
      || r.detail.gapSeconds !== (r.detail.afterUs - r.detail.beforeUs) / 1e6)
      throw Error("invalid_longvp_roll");
    previous = r.atSec;
  }
  return value;
}
export class LongObjects {
  readonly symbol: MarketSymbol;
  private objects: Objects;
  private prefix: string;
  private root: string;
  private cache = new Map<string, { day: DayData; bytes: number }>();
  readonly records = new Map<string, { complete: boolean; gaps: [number, number][]; contracts: DayData["contracts"] }>();
  readonly maxDays = 8;
  readonly maxBytes = 32 * 1024 * 1024;
  private bytes = 0;
  private reads = new Map<string, Promise<DayData>>();
  constructor(objects: Objects, prefix: string, root: string, symbol: MarketSymbol = "NQ") {
    this.symbol = symbol;
    if (!["prod/", "dev/"].includes(prefix)) throw Error("invalid_longvp_prefix");
    this.objects = objects; this.prefix = prefix + `longvp/${symbol}/`; this.root = root;
  }
  snapshot() { return { days: this.cache.size, estimatedBytes: this.bytes,
    maxDays: this.maxDays, maxBytes: this.maxBytes }; }
  private remember(day: DayData) {
    const date = day.tradingDate;
    this.records.set(date, { complete: day.complete, gaps: day.gaps.map(g => [...g]),
      contracts: day.contracts.map(c => ({ ...c })) });
    this.bytes -= this.cache.get(date)?.bytes ?? 0; this.cache.delete(date);
    // Include array overhead and transient JSON/output copies in the cache budget.
    const bytes = Buffer.byteLength(JSON.stringify(day)) * 8;
    if (bytes > this.maxBytes) throw Error("longvp_day_exceeds_memory_budget");
    this.cache.set(date, { day, bytes }); this.bytes += bytes;
    while (this.cache.size > this.maxDays || this.bytes > this.maxBytes) {
      const key = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(key)!.bytes; this.cache.delete(key);
    }
  }
  private async temporary<T>(work: (file: string) => Promise<T>) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, randomUUID());
    try { return await work(file); } finally { await fs.rm(file, { force: true }); }
  }
  async initialize() {
    const names = await this.objects.list(this.prefix + "days/");
    for (const name of names.sort()) {
      const match = name.match(/\/days\/(\d{4}-\d\d-\d\d)\.json\.gz$/);
      if (match) await this.day(match[1]);
    }
  }
  async day(date: string): Promise<DayData> {
    if (!validDate(date)) throw Error("invalid_date");
    const cached = this.cache.get(date);
    if (cached) {
      this.cache.delete(date); this.cache.set(date, cached); return cached.day;
    }
    const existing = this.reads.get(date);
    if (existing) return existing;
    const promise = this.temporary(async file => {
      await this.objects.download(this.prefix + `days/${date}.json.gz`, file);
      const day = validateDay(JSON.parse(gunzipSync(await fs.readFile(file),
        { maxOutputLength: this.maxBytes / 8 }).toString("utf8")), this.symbol);
      if (day.tradingDate !== date) throw Error("longvp_date_mismatch");
      this.remember(day); return day;
    });
    this.reads.set(date, promise);
    try { return await promise; } finally { this.reads.delete(date); }
  }
  async save(day: DayData, signal?: AbortSignal) {
    validateDay(day, this.symbol);
    const json = Buffer.from(JSON.stringify(day)), compressed = gzipSync(json);
    if (json.length * 8 > this.maxBytes) throw Error("longvp_day_exceeds_memory_budget");
    let { downloadVersion, uploadConditional } = this.objects;
    // Operator/test adapters expose the same CAS through ConditionalCloud. Keep one save loop,
    // including the current-generation check after readback, for both storage interfaces.
    if ((!downloadVersion || !uploadConditional) && this.objects.conditional) {
      const cloud = this.objects.conditional;
      const conflict = (error: unknown): never => {
        if ([404, 409, 412].includes(Number((error as { code?: number }).code)))
          throw new ObjectGenerationConflict();
        throw error;
      };
      downloadVersion = async (name, file, generation) => {
        try {
          const latest = generation ?? (await cloud.stat(name))?.generation;
          if (!latest) return null;
          await cloud.download(name, latest, file);
          return latest;
        } catch (error) { return conflict(error); }
      };
      uploadConditional = async (name, file, generation) => {
        try { return await cloud.put(name, file, generation === "0" ? null : generation,
          {}, { contentType: "application/gzip" }); }
        catch (error) { return conflict(error); }
      };
    }
    if (!downloadVersion || !uploadConditional) throw Error("longvp_generation_support_required");
    const name = this.prefix + `days/${day.tradingDate}.json.gz`;
    return this.temporary(async file => {
      const latestFile = file + ".latest", verify = file + ".verify";
      try {
        await fs.writeFile(file, compressed, { mode: 0o600 });
        for (let attempt = 0; attempt < 5; attempt++) {
          signal?.throwIfAborted();
          try {
            const generation = await downloadVersion.call(this.objects, name, latestFile);
            if (generation !== null) {
              const latest = validateDay(JSON.parse(gunzipSync(await fs.readFile(latestFile),
                { maxOutputLength: this.maxBytes / 8 }).toString("utf8")), this.symbol);
              if (latest.tradingDate !== day.tradingDate) throw Error("longvp_date_mismatch");
              if (!improvesDay(latest, day)) {
                this.remember(latest);
                return { saved: false, generation, jsonBytes: 0, gzipBytes: 0 };
              }
            }
            signal?.throwIfAborted();
            const written = await uploadConditional.call(this.objects, name, file, generation ?? "0");
            signal?.throwIfAborted();
            await downloadVersion.call(this.objects, name, verify, written);
            if (await digest(file) !== await digest(verify)) throw Error("object_verification_failed");
            // Re-read the current generation too: an external writer may have won after our upload.
            const current = await downloadVersion.call(this.objects, name, latestFile);
            if (current !== written) throw new ObjectGenerationConflict();
            this.remember(day);
            return { saved: true, generation: written, jsonBytes: json.length, gzipBytes: compressed.length };
          } catch (error) {
            if (!(error instanceof ObjectGenerationConflict)) throw error;
          }
        }
        throw Error("longvp_generation_conflict_exhausted");
      } finally { await Promise.all([latestFile, verify].map(f => fs.rm(f, { force: true }))); }
    });
  }
  async rolls() {
    if (!await this.objects.exists(this.prefix + "rolls.json")) return [];
    return this.temporary(async file => {
      await this.objects.download(this.prefix + "rolls.json", file);
      return validateRolls(JSON.parse(await fs.readFile(file, "utf8")), this.symbol);
    });
  }
  async saveRolls(rolls: RollData[], signal?: AbortSignal) {
    validateRolls(rolls, this.symbol);
    await this.temporary(async file => {
      await fs.writeFile(file, JSON.stringify(rolls), { mode: 0o600 });
      await uploadVerified(this.objects, this.prefix + "rolls.json", file, signal);
    });
  }
}
