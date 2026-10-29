import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Trade } from "../types.ts";
import { tradeFileEntries } from "./records.ts";

export interface TradeReadSession {
  visit(start: number, end: number, visit: (trade: Trade) => void): Promise<void>;
  close(): Promise<void>;
}
export interface TradeReadSource {
  key: string;
  cached?: boolean;
  download(file: string): Promise<void>;
}
type Snapshot = { directory: string; files: string[]; rows: number[]; sha256: string };
type Entry = {
  refs: number; abort: AbortController; ready: Promise<Snapshot>; directory: Promise<string>;
};
const hourOf = (sec: number) => Math.floor(sec / 3600) * 3600;
const ABORT = () => new DOMException("Trade read cancelled", "AbortError");

/** Request-lifetime disk snapshots; no market data or parsed rows are retained in a RAM cache. */
export class TradeReadPool {
  private entries = new Map<string, Entry>();
  private cleanup = new Set<Promise<void>>();
  readonly stats = { bodyDownloads: 0, bodyBytes: 0, gzipScans: 0, compressedBytes: 0,
    sourceRows: 0, partitionBytes: 0, partitionReads: 0, activeRefs: 0, activeSnapshots: 0,
    cleanupFailures: 0, lastSnapshotSha256: null as string | null };
  constructor(privateRoot: string, cleanupError: () => void = () => {}) {
    this.root = privateRoot; this.cleanupError = cleanupError;
  }
  private root: string;
  private cleanupError: () => void;

  private async build(directory: string, hour: number, source: TradeReadSource, signal: AbortSignal): Promise<Snapshot> {
    const gzip = path.join(directory, "source.jsonl.gz");
    signal.throwIfAborted();
    if (!source.cached) this.stats.bodyDownloads++;
    await source.download(gzip);
    if (!source.cached) this.stats.bodyBytes += (await fs.stat(gzip)).size;
    signal.throwIfAborted();
    const files = Array.from({ length: 5 }, (_, i) => path.join(directory, `${i}.jsonl`));
    const handles: fs.FileHandle[] = [];
    const buffers: Buffer[][] = files.map(() => []);
    const sizes = files.map(() => 0);
    const rows = files.map(() => 0);
    const flush = async (i: number) => {
      if (!sizes[i]) return;
      await handles[i]!.writeFile(Buffer.concat(buffers[i]!, sizes[i]));
      buffers[i] = []; sizes[i] = 0;
    };
    const hash = createHash("sha256");
    try {
      for (const file of files) handles.push(await fs.open(file, "wx", 0o600));
      let ordinal = 0;
      this.stats.gzipScans++;
      for await (const { line, trade } of tradeFileEntries(gzip, signal, bytes => {
        hash.update(bytes); this.stats.compressedBytes += bytes.length;
      })) {
        // The spill partition also preserves valid legacy rows outside their filename's hour.
        const q = Math.floor((trade.tsUs / 1e6 - hour) / 900);
        const bucket = q >= 0 && q < 4 ? q : 4;
        rows[bucket]!++;
        // Copy into bounded byte buffers: retained substring/rope strings can otherwise
        // keep much larger readline chunks alive even when the buffered text is small.
        const encoded = Buffer.from(`${ordinal++}\t${line}\n`);
        const length = encoded.length;
        buffers[bucket]!.push(encoded); sizes[bucket]! += length;
        this.stats.sourceRows++; this.stats.partitionBytes += length;
        if (sizes[bucket]! >= 64 * 1024) await flush(bucket);
      }
      for (let i = 0; i < files.length; i++) await flush(i);
      signal.throwIfAborted();
      const sha256 = hash.digest("hex");
      this.stats.lastSnapshotSha256 = sha256;
      return { directory, files, rows, sha256 };
    } finally {
      await Promise.all(handles.map(h => h.close()));
    }
  }

  private async acquire(hour: number, source: TradeReadSource, signal: AbortSignal) {
    signal.throwIfAborted();
    let entry = this.entries.get(source.key);
    if (!entry) {
      const abort = new AbortController();
      const directory = fs.mkdir(this.root, { recursive: true }).then(() => fs.mkdtemp(path.join(this.root, "hour-")));
      entry = { refs: 0, abort, directory, ready: directory.then(dir => this.build(dir, hour, source, abort.signal)) };
      // A cancelled downloader may settle later; always observe its rejection.
      void entry.ready.catch(() => {});
      this.entries.set(source.key, entry); this.stats.activeSnapshots++;
    }
    const retained = entry;
    retained.refs++; this.stats.activeRefs++;
    let released = false;
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      released = true; retained.refs--; this.stats.activeRefs--;
      if (retained.refs) return Promise.resolve();
      if (this.entries.get(source.key) === retained) this.entries.delete(source.key);
      retained.abort.abort();
      // Do not unlink while an uncancellable SDK download is still writing the directory.
      const cleaning = retained.ready.catch(() => {}).then(async () => {
        try { await fs.rm(await retained.directory, { recursive: true, force: true }); }
        finally { this.stats.activeSnapshots--; }
      });
      this.cleanup.add(cleaning);
      void cleaning.then(() => this.cleanup.delete(cleaning), () => {
        this.cleanup.delete(cleaning); this.stats.cleanupFailures++; this.cleanupError();
      });
      return cleaning;
    };
    let abort!: () => void;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? ABORT());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      const snapshot = await Promise.race([retained.ready, cancelled]);
      signal.throwIfAborted();
      return { snapshot, release };
    } catch (error) {
      // Cancellation releases the reference promptly; cleanup follows completion of any SDK write.
      const cleaning = release();
      if (signal.aborted) void cleaning.catch(() => {});
      else await cleaning;
      throw error;
    } finally { signal.removeEventListener("abort", abort); }
  }

  private async *partition(file: string, signal: AbortSignal) {
    const stream = createReadStream(file, { signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let failure: Error | null = null;
    const fail = (error: Error) => { failure = error; lines.close(); };
    stream.on("error", fail);
    lines.on("error", fail);
    try {
      for await (const line of lines) {
        signal.throwIfAborted();
        const tab = line.indexOf("\t");
        yield { ordinal: Number(line.slice(0, tab)), trade: JSON.parse(line.slice(tab + 1)) as Trade };
      }
      if (failure) throw failure;
      signal.throwIfAborted();
    } finally { lines.close(); stream.destroy(); }
  }

  private async visit(snapshot: Snapshot, hour: number, start: number, end: number,
    signal: AbortSignal, visit: (t: Trade) => void) {
    const selected = [0, 1, 2, 3].filter(q => snapshot.rows[q]! > 0
      && hour + q * 900 < end && hour + (q + 1) * 900 > start);
    if (snapshot.rows[4]! > 0) selected.push(4);
    const streams = selected.map(q => this.partition(snapshot.files[q]!, signal));
    this.stats.partitionReads += streams.length;
    try {
      const heads = await Promise.all(streams.map(s => s.next()));
      for (;;) {
        signal.throwIfAborted();
        let next = -1;
        for (let i = 0; i < heads.length; i++)
          if (!heads[i]!.done && (next < 0 || heads[i]!.value!.ordinal < heads[next]!.value!.ordinal)) next = i;
        if (next < 0) return;
        const t = heads[next]!.value!.trade;
        if (t.tsUs >= start * 1e6 && t.tsUs < end * 1e6) visit(t);
        heads[next] = await streams[next]!.next();
      }
    } finally { await Promise.all(streams.map(s => s.return(undefined))); }
  }

  session(signal: AbortSignal, resolve: (hour: number) => Promise<TradeReadSource | null>,
    fallback: (hour: number, start: number, end: number, visit: (t: Trade) => void) => Promise<void>): TradeReadSession {
    const leases = new Map<number, Awaited<ReturnType<TradeReadPool["acquire"]>>>();
    let closed = false;
    let queue: Promise<void> = Promise.resolve();
    return {
      visit: (start, end, visit) => {
        const work = queue.then(async () => {
          signal.throwIfAborted();
          if (closed) throw Error("trade_read_session_closed");
          // A monotone history walk keeps at most the current/boundary hours, not seven days.
          for (const [h, lease] of leases) if (h + 3600 <= hourOf(start)) {
            leases.delete(h); await lease.release();
          }
          for (let h = hourOf(start); h < end; h += 3600) {
            signal.throwIfAborted();
            let lease = leases.get(h);
            if (!lease) {
              const source = await resolve(h);
              if (!source) {
                await fallback(h, start, end, t => { signal.throwIfAborted(); visit(t); }); continue;
              }
              lease = await this.acquire(h, source, signal); leases.set(h, lease);
            }
            await this.visit(lease.snapshot, h, start, end, signal, visit);
          }
        });
        queue = work.catch(() => {});
        return work;
      },
      close: async () => {
        closed = true; await queue;
        const held = [...leases.values()]; leases.clear();
        await Promise.all(held.map(x => x.release()));
      },
    };
  }
  async settled() { await Promise.all([...this.cleanup]); }
}
