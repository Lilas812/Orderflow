import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import { makeWorkload, type Workload } from "../bench/finiteMockWorkload";
import type { AnalysisRenderFrame, AnalysisScope, AnalysisInput, AnalysisRenderQuery } from "@workspace/core/analysis-hub";

export interface DiagnosticDisplay {
  id: "baseline13" | "cells128" | "cells512";
  sourceId: string; sessionId: string; inputs: number; markets: number; trades: number;
  seed: { endNs: string; spanNs: bigint; priceMinTick: number; priceMaxTick: number };
}
export interface DiagnosticCase {
  id: DiagnosticDisplay["id"];
  scope: AnalysisScope; inputs: readonly AnalysisInput[]; query: AnalysisRenderQuery;
  display: DiagnosticDisplay; expected: Workload["expected"] | null;
}
/** Whitelist only; construction is lazy, once per explicit diagnostic page. No generator parameters. */
export function selectDiagnosticCase(): DiagnosticCase {
  const requested = diagnosticMode() === "off" ? "baseline13"
    : new URLSearchParams(window.location.search).get("mockCase") ?? "baseline13";
  if (requested !== "baseline13" && requested !== "cells128" && requested !== "cells512")
    throw new Error("UNKNOWN_DIAGNOSTIC_CASE");
  if (requested === "baseline13") return {
    id: requested, ...UNIFIED_MOCK_STREAM, expected: null,
    display: { id: requested, sourceId: UNIFIED_MOCK_STREAM.scope.config.identity.sourceId,
      sessionId: UNIFIED_MOCK_STREAM.scope.config.identity.sessionId, inputs: 13, markets: 11, trades: 6,
      seed: { endNs: (BigInt(UNIFIED_MOCK_STREAM.query.startNs) + 15_000_000_000n).toString(),
        spanNs: 16_000_000_000n, priceMinTick: 79998, priceMaxTick: 80005 } },
  };
  const w = makeWorkload(requested);
  return { ...w, id: requested, display: { id: requested, sourceId: w.scope.config.identity.sourceId,
    sessionId: w.scope.config.identity.sessionId, inputs: w.inputs.length,
    markets: w.expected.acceptedMarkets, trades: w.expected.acceptedTrades,
    // Explicit diagnostic range includes Snapshot ask 80065 and SETs at 80064, not only Trades.
    seed: { endNs: "1767225607000000000", spanNs: 8_000_000_000n, priceMinTick: 79998, priceMaxTick: 80067 } } };
}
export function caseChecks(frame: AnalysisRenderFrame, c: DiagnosticCase) {
  if (!c.expected) throw new Error("BASELINE_REQUIRES_EXISTING_GOLDEN");
  const e = c.expected, vp = frame.volumeProfile.value;
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return [
    { name: "VP B/S/U/V", ok: !!vp && equal([vp.totals.buyVolume, vp.totals.sellVolume,
      vp.totals.unknownVolume, vp.totals.totalVolume].map(String), [e.B, e.S, e.U, e.V]), detail: e.V },
    { name: "VP POC/VAL/VAH", ok: !!vp && equal([vp.pocTick, vp.valueArea.valTick, vp.valueArea.vahTick],
      [e.poc, e.val, e.vah]), detail: `${e.poc}/${e.val}/${e.vah}` },
    { name: "Trade count", ok: !!vp && String(vp.totals.tradeCount) === String(e.acceptedTrades), detail: String(e.acceptedTrades) },
    { name: "Bubble B/S/U/V", ok: equal(["B", "S", "U", "V_raw"].map(k =>
      frame.bubbles.items.reduce((sum, b) => sum + b.bucket[k as "B" | "S" | "U" | "V_raw"], 0n).toString()),
      [e.B, e.S, e.U, e.V]), detail: e.V },
    { name: "TWA and coverage", ok: equal(frame.heatmap.cells.map(v => v.twa), e.twa) &&
      equal(frame.heatmap.cells.map(v => v.coverageRatio), e.coverage), detail: String(c.query.cells.length) },
    { name: "Delta bins", ok: equal(frame.delta.items.map(v => v.delta === null ? null : String(v.delta)), e.delta), detail: e.delta.join(",") },
    { name: "Common revision", ok: [frame.book, frame.heatmap, frame.bubbles, frame.delta,
      frame.volumeProfile, frame.quality].every(v => v.revision === frame.revision), detail: String(frame.revision) },
    { name: "Quality", ok: frame.quality.channels.L2_MBP.status === "VALID" &&
      frame.quality.channels.TRADES.status === "VALID" && frame.status !== "STOPPED", detail: frame.quality.channels.L2_MBP.status },
  ];
}

/** Finite numeric telemetry only. No events, timers, console output or renderer changes. */
export const ROW_LIMIT = 2048;
const WIDTH = 9;
export const STAGES = ["ingest", "publish", "frame", "react", "received", "raf", "draw", "dom", "gl", "lifecycle"] as const;
export const LAYERS = ["session", "root", "heatmap", "bubble", "delta", "vp"] as const;
type Stage = typeof STAGES[number];
export type Layer = typeof LAYERS[number];
export type Row = { stage: Stage; at: number; ms: number; revision: number; seq: number; layer: Layer; a: number; b: number; c: number };
export type RecordingVersion = 1 | 2;
export interface Receipt {
  recordIndex: number; revision: number; at: number; mask: number;
  heatmapAt: number | null; bubbleAt: number | null; deltaAt: number | null; vpAt: number | null; domAt: number | null;
}
const RECEIPT_CODE = STAGES.length;

export function createRecorder(sessionId: number, version: RecordingVersion = 1) {
  let data: Float64Array | null = new Float64Array(ROW_LIMIT * WIDTH);
  let size = 0, dropped = 0, saturated = false;
  let receiptOffset = -1, observations = 0, mergedReceipts = 0, delegatedGL = 0;
  return {
    add(stage: Stage, revision = -1, seq = -1, layer: Layer = "session", ms = 0, a = 0, b = 0, c = 0) {
      if (!data) return;
      observations++;
      const stageId = STAGES.indexOf(stage), layerId = LAYERS.indexOf(layer), at = performance.now();
      if (![stageId, at, ms, revision, seq, layerId, a, b, c].every(Number.isFinite) || stageId < 0 || layerId < 0) {
        dropped++; return;
      }
      // v2 delegates GL API telemetry to the driver's exact bounded counters.
      // This is an explicit schema change, not sampling or a missing time sample.
      if (version === 2 && stage === "gl") { delegatedGL++; return; }
      if (saturated) { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); return; }
      const member = version !== 2 ? -1 : stage === "dom" && layer === "vp" ? 4
        : stage === "received" ? ["heatmap", "bubble", "delta", "vp"].indexOf(layer) : -1;
      if (member >= 0) {
        const bit = 1 << member;
        // One timestamp per member. Repeated members, older revisions and interleaving
        // allocate another group rather than overwrite evidence or grow a Map.
        if (receiptOffset >= 0 && data[receiptOffset + 3] === revision && !(data[receiptOffset + 2] & bit)) {
          data[receiptOffset + 2] |= bit;
          data[receiptOffset + 4 + member] = at;
          mergedReceipts++;
          return;
        }
        receiptOffset = size++ * WIDTH;
        data.set([RECEIPT_CODE, at, bit, revision, 0, 0, 0, 0, 0], receiptOffset);
        data[receiptOffset + 4 + member] = at;
        if (size === ROW_LIMIT) saturated = true;
        return;
      }
      const row = [stageId, at, ms, revision, seq, layerId, a, b, c];
      data.set(row, size++ * WIDTH);
      if (size === ROW_LIMIT) saturated = true;
    },
    snapshot() {
      const rows: Row[] = [];
      const receipts: Receipt[] = [];
      if (data) for (let i = 0; i < size; i++) {
        const o = i * WIDTH;
        if (data[o] === RECEIPT_CODE) {
          const mask = data[o + 2];
          receipts.push({ recordIndex: i, revision: data[o + 3], at: data[o + 1], mask,
            heatmapAt: mask & 1 ? data[o + 4] : null, bubbleAt: mask & 2 ? data[o + 5] : null,
            deltaAt: mask & 4 ? data[o + 6] : null, vpAt: mask & 8 ? data[o + 7] : null,
            domAt: mask & 16 ? data[o + 8] : null });
          continue;
        }
        rows.push({ stage: STAGES[data[o]], at: data[o + 1], ms: data[o + 2], revision: data[o + 3],
          seq: data[o + 4], layer: LAYERS[data[o + 5]], a: data[o + 6], b: data[o + 7], c: data[o + 8] });
      }
      return { version, sessionId, limit: ROW_LIMIT, allocatedBytes: data?.byteLength ?? 0, saturated, dropped,
        records: size, observations, mergedReceipts, delegatedGL, rows, receipts,
        gpuMs: "UNKNOWN", presentationAt: "UNKNOWN" };
    },
    stats() { return { version, records: size, observations, mergedReceipts, delegatedGL, dropped, saturated,
      allocatedBytes: data?.byteLength ?? 0 }; },
    dispose() {
      data?.fill(0); data = null; size = dropped = observations = mergedReceipts = delegatedGL = 0;
      receiptOffset = -1; saturated = false;
    },
  };
}
export type Recorder = ReturnType<typeof createRecorder>;
let active: Recorder | undefined;
let reader: (() => unknown) | undefined;
let progress: (() => unknown) | undefined;
let draw: { layer: Layer; revision: number; start: number; origin: number } | undefined;

export function diagnosticMode(): "off" | "control" | "on" {
  if (typeof window === "undefined") return "off";
  const v = new URLSearchParams(window.location.search).get("mockDiagnostics");
  return v === "1" ? "on" : v === "control" ? "control" : "off";
}
interface Bridge {
  snapshot(): ReturnType<Recorder["snapshot"]> | null;
  meaning(): string | null;
  activeDraw(): typeof draw;
  gl(layer: Layer, kind: number, ms: number, a: number, b: number): void;
  progress(): { status: unknown; recording: ReturnType<Recorder["stats"]> | null };
  inspectMeaning(): { bytes: number; limit: number; allowed: boolean; summary: unknown };
}
declare global { interface Window { __orderflowMockDiagnostics?: Bridge } }

export function releaseDiagnostics() {
  active?.dispose(); active = undefined; reader = undefined; progress = undefined; draw = undefined;
  if (typeof window !== "undefined") delete window.__orderflowMockDiagnostics;
}
export function startDiagnostics(sessionId: number) {
  releaseDiagnostics();
  const mode = diagnosticMode();
  if (mode === "off") return undefined;
  if (mode === "on") active = createRecorder(sessionId,
    new URLSearchParams(window.location.search).get("mockCase") === "cells128" ? 2 : 1);
  const text = () => reader ? JSON.stringify(reader(), (_k, v) => typeof v === "bigint" ? { bigint: v.toString() }
    : v instanceof Map ? { map: [...v] } : v) : null;
  window.__orderflowMockDiagnostics = {
    snapshot: () => active?.snapshot() ?? null,
    // Read on demand, outside timed ingest/frame sections. Derived frame only, never raw input.
    meaning: () => {
      if (!reader) return null;
      const value = text()!;
      if (new TextEncoder().encode(value).byteLength > 65536) throw new Error("DIAGNOSTIC_SEMANTIC_LIMIT");
      return value;
    },
    activeDraw: () => draw ? { ...draw } : undefined,
    gl: (layer, kind, ms, a, b) => active?.add("gl", draw?.revision ?? -1, -1, layer, ms, kind, a, b),
    progress: () => ({ status: progress?.(), recording: active?.stats() ?? null }),
    inspectMeaning: () => {
      const content = reader?.() as { frame?: AnalysisRenderFrame; checks?: unknown; counts?: unknown } | undefined;
      const value = content === undefined ? null : JSON.stringify(content, (_k, v) =>
        typeof v === "bigint" ? { bigint: v.toString() } : v instanceof Map ? { map: [...v] } : v);
      const bytes = value === null ? 0 : new TextEncoder().encode(value).byteLength;
      const f = content?.frame, vp = f?.volumeProfile.value;
      // Explicit summary, NOT a truncated replacement for the full semantic payload or its hash.
      const summary = f ? { summaryOnly: true, revision: f.revision, stateRevision: f.stateRevision,
        scope: f.scope, checks: content?.checks, counts: content?.counts,
        layerRevisions: [f.book, f.heatmap, f.bubbles, f.delta, f.volumeProfile, f.quality].map(v => v.revision),
        cellCount: f.heatmap.cells.length, noDataCells: f.heatmap.cells.filter(v => v.status === "NO DATA").length,
        quality: f.quality.channels, book: f.book.levels,
        bubbles: f.bubbles.items.map(b => ({ revision: b.revision, status: b.status,
          minTick: b.bucket.minTick, maxTick: b.bucket.maxTick, startNs: b.bucket.startNs, endNs: b.bucket.endNs,
          B: String(b.bucket.B), S: String(b.bucket.S), U: String(b.bucket.U), V: String(b.bucket.V_raw) })),
        vp: vp ? { B: String(vp.totals.buyVolume), S: String(vp.totals.sellVolume),
          U: String(vp.totals.unknownVolume), V: String(vp.totals.totalVolume),
          poc: vp.pocTick, val: vp.valueArea.valTick, vah: vp.valueArea.vahTick } : null,
      } : null;
      return { bytes, limit: 65536, allowed: bytes <= 65536, summary };
    },
  };
  return active;
}
export const setDiagnosticReader = (next: () => unknown) => { if (diagnosticMode() !== "off") reader = next; };
export const setDiagnosticProgress = (next: () => unknown) => { if (diagnosticMode() !== "off") progress = next; };
export const diagnostics = () => active;
export function profiler(layer: Layer, actual: number, start: number, commit: number, mount: boolean, revision: number) {
  active?.add("react", revision, -1, layer, actual, start, commit, Number(mount));
}
export function beginDraw(layer: Layer, revision: number | undefined, origin = 0) {
  if (!active || revision === undefined) return undefined;
  const token = { layer, revision, start: performance.now(), origin };
  draw = token;
  return token;
}
export function endDraw(token: ReturnType<typeof beginDraw>, vertices = 0) {
  if (!token) return;
  active?.add("draw", token.revision, -1, token.layer, performance.now() - token.start, vertices, token.origin);
  if (draw === token) draw = undefined;
}
if (import.meta.hot) import.meta.hot.dispose(releaseDiagnostics);
