import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionStartSec } from "../vp/state.ts";
import { nextSession } from "../labels/features.ts";
import { covered } from "./model.ts";
import { hashFile, optionalHash } from "./snapshot.ts";

async function index(root: string) {
  try {
    const c = JSON.parse(await fs.readFile(path.join(root, "coverage.json"), "utf8")) as { tick: [number, number][]; book: [number, number][] };
    const perSession = new Map<number, { tickSeconds: number; boardSeconds: number }>();
    for (const kind of ["tick", "book"] as const) for (const [a, b] of c[kind]) {
      for (let s = sessionStartSec(a); s < b; s = nextSession(s)) {
        const r = perSession.get(s) ?? { tickSeconds: 0, boardSeconds: 0 };
        r[kind === "tick" ? "tickSeconds" : "boardSeconds"] += Math.max(0, Math.min(b, nextSession(s)) - Math.max(a, s));
        perSession.set(s, r);
      }
    }
    return { root, coverageSha256: await hashFile(path.join(root, "coverage.json")),
      tick: c.tick, book: c.book, perSession: [...perSession].map(([s, r]) => ({ sessionStartUs: String(s * 1e6), ...r })),
      note: "coverage index only; absent bodies and contract/availability are checked separately for pilot" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { root, unreadable: "local_index_missing" };
    throw e;
  }
}
export async function audit() {
  const installed: unknown[] = [], originals: unknown[] = [], sources: unknown[] = [], markWindows: unknown[] = [];
  for (const symbol of ["NQ", "GC"] as const) {
    const base = `data/databento${symbol === "GC" ? "-gc" : ""}-import`;
    try {
      const activeFile = `${base}/active.json`;
      const a = JSON.parse(await fs.readFile(activeFile, "utf8"));
      const inventory = JSON.parse(await fs.readFile(`${base}/inventory.json`, "utf8"));
      originals.push({ symbol, kind: "purchased_original", file: a.original, readable: !!await fs.stat(a.original).catch(() => null),
        archiveSha256IndexedNotRehashed: a.archiveSha256, fromUs: String(a.fromUs), toUs: String(a.toUs),
        contractsIndexed: inventory.source, metadataOnly: true });
      for (const [contract, r] of Object.entries(a.rebuilt) as [string, { totals: unknown; sessions: { sessionStartSec: number; stats: unknown }[] }][]) {
        const root = path.join(a.generation, contract), coverage = await index(root);
        installed.push({ symbol, contract, kind: "isolated_purchased_generation", ...coverage,
          totalsIndexed: r.totals, sessionsIndexed: r.sessions.map(d => ({ sessionStartUs: String(d.sessionStartSec * 1e6), stats: d.stats })),
          unknownMixedContracts: null, unknownMixedReason: "not separately indexed; exact scan restricted to pilot" });
        if (contract === `${symbol}Z26`) {
          const f = `docs/evidence/turning-point-labels/${symbol}.labels.json`;
          const labels = JSON.parse(await fs.readFile(f, "utf8")).labels as { tsSec: number }[];
          const ticks = coverage.tick?.map(([a, b]) => ({ fromUs: a * 1e6, toUs: b * 1e6 })) ?? [];
          markWindows.push({ symbol, contract, annotationSnapshot: f, annotationSource: "prior_isolated_UI_test_not_verified_user_decisions",
            marks: labels.length,
            windowsCovered30mPlus15m: labels.filter(l => covered(ticks, (l.tsSec - 1800) * 1e6, (l.tsSec + 900) * 1e6, "event_time_research", 0)).length,
            arrivalVerified: 0, note: "coverage-only eligibility, not proof every feature/reference/contract is valid" });
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") sources.push({ symbol, kind: "purchased_generation", unreadable: "index_or_annotation_missing" });
      else throw e;
    }
    sources.push({ symbol, kind: "product_local_cache_readonly", ...await index(symbol === "NQ" ? "data" : "data/instruments/GC") });
    const root = `data/gpu-heatmap/production-input/prod${symbol === "GC" ? "/instruments/GC" : ""}`;
    sources.push({ symbol, kind: "prior_production_copy_not_current_cloud", ...await index(root) });
  }
  return { schema: "orderflow.research.audit.v2.1", originals, installed, sources, markWindows,
    currentProductionCloud: "not inventoried; no production hydration/network operation",
    timestampProvenance: {
      tsUs: "exchange event time: normalization / import boundary",
      purchased_recvUs: "server/src/import/databento-csv.ts convert: vendor ts_recv, NOT Replit local arrival",
      tickstream_history_recvUs: "server/src/history/decode.ts historyTrades: set equal to tsUs, NOT arrival",
      live_recvUs: "server/src/ingest/receiver.ts Receiver.receive passes its received timestamp to Receiver.trade; persisted Trade has no source/finalization proof in its base interface",
      columns: "ColumnAggregator emits on next second/expire/finish, but Column stores only tsSec/source/bids/asks; neither contract nor actual emission time is stored",
      strictPolicy: "legacy indexes/recvUs do not prove per-record local arrival plus feature and coverage finalization at as_of"
    }, unscannedRawArchives: true };
}
async function main() {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!out || !path.resolve(out).startsWith(path.resolve("data/research-v2") + path.sep)) throw Error("private_audit_output_required");
  await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  const result = await audit();
  await fs.writeFile(out, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ path: out, installedContractSources: result.installed.length, marks: result.markWindows }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
