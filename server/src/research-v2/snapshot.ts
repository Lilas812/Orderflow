import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { LocalStore } from "../store/local.ts";
import type { LabelHourInput } from "../labels/input.ts";
import { columnFileRange, tradeFileEntries } from "../store/records.ts";
import { SampleBuilder } from "./engine.ts";
import type { Source, MarketInput } from "./model.ts";

export async function hashFile(file: string, signal?: AbortSignal) {
  const h = createHash("sha256"), stream = createReadStream(file, { signal });
  try { for await (const bytes of stream) h.update(bytes); return h.digest("hex"); }
  finally { stream.destroy(); }
}
export async function optionalHash(file: string) {
  try { return await hashFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
/** Only a read API is used; initialize/append/flush/hydration are never invoked. */
export class Snapshot {
  readonly source: Source; readonly directory: string; readonly signal: AbortSignal;
  private store: LocalStore;
  private hours = new Map<number, LabelHourInput>();
  readonly proofs: { path: string; before: string; after?: string; snapshot: string }[] = [];
  constructor(source: Source, directory: string, signal: AbortSignal) {
    this.source = source; this.directory = directory; this.signal = signal;
    this.store = new LocalStore(source.root, Date.now, fs.rename, source.symbol);
  }
  async hour(hour: number) {
    this.signal.throwIfAborted();
    const cached = this.hours.get(hour); if (cached) return cached;
    const date = new Date(hour * 1000).toISOString(), suffix = `${date.slice(0, 10)}/${date.slice(11, 13)}`;
    const candidates = [path.join(this.source.root, "coverage.json"),
      path.join(this.source.root, `trades/${this.source.symbol}/${suffix}.jsonl.gz`),
      path.join(this.source.root, `columns/${this.source.symbol}/1s/${suffix}.bin`),
      path.join(this.source.root, `columns/${this.source.symbol}/1s/${suffix}.bin.gz`)];
    const before = await Promise.all(candidates.map(optionalHash));
    const input = await this.store.labelHourInput(hour, path.join(this.directory, String(hour)));
    this.signal.throwIfAborted();
    for (let i = 0; i < candidates.length; i++) {
      const after = await optionalHash(candidates[i]!);
      if (after !== before[i]) throw Error("v2_source_changed_while_snapshotting");
      if (after) {
        const copy = i === 1 ? input.tick : i > 1 && input.book?.endsWith(".gz") === candidates[i]!.endsWith(".gz") ? input.book : null;
        const snapshot = copy ? await hashFile(copy, this.signal) : after;
        if (copy && snapshot !== after) throw Error("v2_snapshot_body_hash_mismatch");
        if (!this.proofs.some(p => p.path === candidates[i])) this.proofs.push({ path: candidates[i]!, before: after, snapshot });
      }
    }
    this.hours.set(hour, input); return input;
  }
  async prepare(fromUs: number, toUs: number): Promise<MarketInput> {
    const ticks: MarketInput["ticks"] = [], books: MarketInput["books"] = [];
    for (let hour = Math.floor(fromUs / 3_600e6) * 3600; hour * 1e6 < toUs; hour += 3600) {
      const v = await this.hour(hour);
      ticks.push(...v.tickCoverage.map(([a, b]) => ({ fromUs: a * 1e6, toUs: b * 1e6 })));
      books.push(...v.bookCoverage.map(([a, b]) => ({ fromUs: a * 1e6, toUs: b * 1e6 })));
    }
    return { ticks, books };
  }
  async feed(builder: SampleBuilder) {
    const from = Math.min(builder.startUs, builder.sessionUs), until = builder.anchor.asOfUs + Math.max(...builder.config.horizonsSeconds) * 1e6;
    for (let hour = Math.floor(from / 3_600e6) * 3600; hour * 1e6 < until; hour += 3600) {
      this.signal.throwIfAborted();
      const v = await this.hour(hour);
      if (v.tick) for await (const { trade } of tradeFileEntries(v.tick, this.signal)) builder.accept(trade);
      if (v.book) for await (const column of columnFileRange(v.book, hour, hour + 3600))
        builder.acceptBoard({ column, contract: null }); // The stored Column has neither contract nor arrival/finalization proof.
    }
  }
  async verifyOriginals() {
    for (const p of this.proofs) {
      this.signal.throwIfAborted(); p.after = await hashFile(p.path, this.signal);
      if (p.after !== p.before) throw Error("v2_original_changed_during_job_retry_on_closed_snapshot");
    }
  }
}
