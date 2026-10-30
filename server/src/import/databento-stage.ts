import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { scanCsv, convert, fields } from "./databento-csv.ts";
import { tradeFileEntries } from "../store/records.ts";

export async function sha(file: string) {
  const hash = createHash("sha256"); for await (const b of createReadStream(file)) hash.update(b);
  return hash.digest("hex");
}
export async function atomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temp, file);
}
export function canonical(raw: string, year: number) {
  const m = /^(NQ|GC)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(raw);
  if (!m) throw Error("unknown_contract");
  const years = Array.from({ length: 6 }, (_, n) => year - 1 + n).filter(y =>
    m[3]!.length === 1 ? y % 10 === Number(m[3]) : y % 100 === Number(m[3]));
  if (years.length !== 1) throw Error("ambiguous_contract_year");
  return `${m[1]}${m[2]}${String(years[0]).slice(-2)}`;
}
export type Stats = { count: number; buy: number; sell: number; unknown: number; weighted: number; minUs: number; maxUs: number };
export const emptyStats = (): Stats => ({ count: 0, buy: 0, sell: 0, unknown: 0, weighted: 0, minUs: Infinity, maxUs: -Infinity });
export function count(s: Stats, t: { tsUs: number; price: number; size: number; side: "buy" | "sell" | "unknown" }) {
  s.count++; s[t.side] += t.size; s.weighted += t.price * t.size;
  if (!Number.isSafeInteger(s.weighted)) throw Error("unsafe_weighted_sum");
  s.minUs = Math.min(s.minUs, t.tsUs); s.maxUs = Math.max(s.maxUs, t.tsUs);
}
export class DiskLines {
  private buffers = new Map<string, string>();
  readonly files = new Set<string>();
  async write(file: string, line: string) {
    this.files.add(file); const value = (this.buffers.get(file) ?? "") + line + "\n";
    this.buffers.set(file, value);
    if (value.length >= 65536) await this.flush(file);
    if (this.buffers.size > 32) await this.flush(this.buffers.keys().next().value!);
  }
  private async flush(file: string) {
    const bytes = this.buffers.get(file); if (!bytes) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, bytes); this.buffers.delete(file);
  }
  async close() { for (const f of [...this.buffers.keys()]) await this.flush(f); }
}
export interface StagedFile {
  member: string; sha256: string; rows: number; errors: number; spreads: number;
  contracts: Record<string, Stats>;
  outputs: { path: string; sha256: string; contentHash: string; count: number }[];
}
export async function stageFile(zip: string, root: string, member: string, expected: string, ordinal: number,
  signal?: AbortSignal): Promise<StagedFile> {
  const hash = expected.replace(/^sha256:/, ""), final = path.join(root, hash);
  try {
    const old: StagedFile = JSON.parse(await fs.readFile(path.join(final, "verified.json"), "utf8"));
    if (old.sha256 !== hash || old.member !== member) throw Error("stage_identity_mismatch");
    for (const f of old.outputs) if (await sha(path.join(final, f.path)) !== f.sha256) throw Error("stage_corrupted");
    return old;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const work = path.join(root, ".partial-" + randomUUID());
  await fs.mkdir(work, { recursive: true });
  const writer = new DiskLines(), contracts: Record<string, Stats> = {};
  let errors = 0, spreads = 0;
  const result = await scanCsv(zip, member, expected, async (line, row) => {
    signal?.throwIfAborted();
    let c: ReturnType<typeof convert>, contract: string;
    try {
      c = convert(line, ordinal * 100_000_000 + row);
      contract = canonical(c.rawContract, new Date(c.trade.tsUs / 1000).getUTCFullYear());
    } catch (e) {
      const reason = (e as Error).message;
      if (reason === "calendar_spread") spreads++; else errors++;
      await writer.write(path.join(work, "excluded.jsonl"), JSON.stringify({ row, reason, raw: line, symbol: line.split(",").at(-1) }));
      return;
    }
    const t = { ...c.trade, contract, source: { ...c.trade.source, inputSha256: hash, row, member } };
    count(contracts[contract] ??= emptyStats(), t);
    const hour = new Date(t.tsUs / 1000).toISOString();
    const rel = `${t.side === "unknown" ? "unknown" : "known"}/${contract}/${hour.slice(0, 10)}/${hour.slice(11, 13)}.jsonl`;
    await writer.write(path.join(work, rel), JSON.stringify(t));
  }, signal);
  await writer.close();
  const outputs: StagedFile["outputs"] = [];
  for (const file of writer.files) {
    const gz = file + ".gz", before = await sha(file);
    await pipeline(createReadStream(file), createGzip({ level: 1 }), createWriteStream(gz, { flags: "wx" }), { signal });
    // Verify every saved row in input order, including unknown and excluded records.
    const content = createHash("sha256"); let count = 0;
    for await (const x of tradeFileEntries(gz, signal)) { content.update(x.line + "\n"); count++; }
    if (content.digest("hex") !== before) throw Error("staged_readback_mismatch");
    outputs.push({ path: path.relative(work, gz), sha256: await sha(gz), contentHash: before, count });
    await fs.rm(file); // Only our verified expanded scratch file; ZIP remains untouched.
  }
  const record: StagedFile = { member, sha256: hash, rows: result.rows, contracts, errors, spreads, outputs };
  await atomic(path.join(work, "verified.json"), record);
  await fs.mkdir(root, { recursive: true }); await fs.rename(work, final);
  return record;
}
