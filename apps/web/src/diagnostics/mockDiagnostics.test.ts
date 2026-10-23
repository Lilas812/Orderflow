import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import { createMockAnalysisSession } from "../lib/mockAnalysisSession";
import { unifiedChecks } from "../hooks/useMockAnalysisSession";
import {
  ROW_LIMIT, createRecorder, startDiagnostics, releaseDiagnostics, setDiagnosticReader,
  diagnostics, beginDraw, endDraw, diagnosticMode,
  selectDiagnosticCase, setDiagnosticProgress, caseChecks, encodeCompactMeaning,
} from "./mockDiagnostics";

afterEach(() => { releaseDiagnostics(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("allocates exactly a fixed numeric slab and returns defensive copies", () => {
  const d = createRecorder(7);
  d.add("ingest", 3, 2);
  const s = d.snapshot();
  expect(s.allocatedBytes).toBe(ROW_LIMIT * 9 * 8);
  s.rows[0].revision = 999;
  expect(d.snapshot().rows[0].revision).toBe(3);
});
it("stops recording at the fixed limit without growing the slab", () => {
  const d = createRecorder(1);
  for (let i = 0; i < ROW_LIMIT + 25; i++) d.add("frame", i);
  expect(d.snapshot()).toMatchObject({ saturated: true, dropped: 25 });
  expect(d.snapshot().rows).toHaveLength(ROW_LIMIT);
});
it("rejects nonfinite metadata", () => {
  const d = createRecorder(1); d.add("frame", NaN);
  expect(d.snapshot().rows).toHaveLength(0);
  expect(d.snapshot().dropped).toBe(1);
});
it("dispose releases the slab and makes stale callbacks inert", () => {
  const d = createRecorder(1); d.add("frame", 1); d.dispose(); d.add("frame", 2);
  expect(d.snapshot()).toMatchObject({ allocatedBytes: 0, rows: [] });
});
it("default mode creates no collector or bridge", () => {
  vi.stubGlobal("window", { location: { search: "" } });
  expect(diagnosticMode()).toBe("off");
  expect(startDiagnostics(1)).toBeUndefined();
  expect(window.__orderflowMockDiagnostics).toBeUndefined();
});
it("control mode exposes derived meaning but allocates no telemetry slab", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=control" } });
  expect(startDiagnostics(1)).toBeUndefined();
  setDiagnosticReader(() => ({ quantity: 900719925474099312345n }));
  expect(window.__orderflowMockDiagnostics?.snapshot()).toBeNull();
  expect(window.__orderflowMockDiagnostics?.meaning()).toContain("900719925474099312345");
});
it("caps diagnostic semantic output", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=control" } });
  startDiagnostics(1); setDiagnosticReader(() => "x".repeat(65537));
  expect(() => window.__orderflowMockDiagnostics?.meaning()).toThrow("SEMANTIC_LIMIT");
});
it("records actual draw revision separately from received/DOM revision", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  startDiagnostics(1);
  diagnostics()?.add("received", 4, -1, "heatmap");
  const token = beginDraw("heatmap", 3, 1);
  window.__orderflowMockDiagnostics?.gl("heatmap", 3, .01, 18, 0);
  endDraw(token, 18);
  expect(diagnostics()?.snapshot().rows.map(r => r.revision)).toEqual([4, 3, 3]);
  expect(window.__orderflowMockDiagnostics?.activeDraw()).toBeUndefined();
});
it("restart clears old records, slab, reader and active draw", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  const first = startDiagnostics(1)!;
  first.add("frame", 1); setDiagnosticReader(() => "old"); beginDraw("bubble", 1);
  startDiagnostics(2);
  expect(first.snapshot().allocatedBytes).toBe(0);
  expect(diagnostics()?.snapshot()).toMatchObject({ sessionId: 2, rows: [] });
  expect(window.__orderflowMockDiagnostics?.meaning()).toBeNull();
  expect(window.__orderflowMockDiagnostics?.activeDraw()).toBeUndefined();
});
it("release removes the public diagnostic bridge and all retained references", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  const d = startDiagnostics(1)!; setDiagnosticReader(() => "derived");
  releaseDiagnostics();
  expect(d.snapshot().allocatedBytes).toBe(0);
  expect(diagnostics()).toBeUndefined();
  expect(window.__orderflowMockDiagnostics).toBeUndefined();
});
it("baseline13 ON/OFF has exactly equal frames, counts, quality, bubbles and golden", () => {
  vi.useFakeTimers();
  const run = (enabled: boolean) => {
    const d = enabled ? createRecorder(1) : undefined;
    const s = createMockAnalysisSession({ ...UNIFIED_MOCK_STREAM, inputEveryMs: 300, diagnostics: d });
    s.setNotificationsEnabled(false); s.start(); vi.advanceTimersByTime(4000);
    const frame = s.readFrame(), status = s.getStatus(), rows = d?.snapshot().rows;
    expect(unifiedChecks(frame).every(c => c.ok)).toBe(true);
    expect(status.processedInputs).toBe(13);
    if (enabled) {
      expect(rows?.filter(r => r.stage === "ingest").map(r => r.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
      expect(rows?.some(r => r.stage === "frame")).toBe(true);
    }
    s.dispose(); expect(d?.snapshot().allocatedBytes ?? 0).toBe(0);
    return { frame, status };
  };
  expect(run(true)).toEqual(run(false));
});
it("session stop releases recording and leaves no timer after dispose", () => {
  vi.useFakeTimers(); const d = createRecorder(1);
  const s = createMockAnalysisSession({ ...UNIFIED_MOCK_STREAM, inputEveryMs: 300, diagnostics: d });
  s.setNotificationsEnabled(false); s.start(); vi.advanceTimersByTime(300);
  s.stop(); expect(d.snapshot().allocatedBytes).toBe(0);
  s.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it("normal mode ignores diagnostic case selection and preserves the original source", () => {
  vi.stubGlobal("window", { location: { search: "?mockCase=cells512" } });
  const c = selectDiagnosticCase();
  expect(c.id).toBe("baseline13"); expect(c.inputs).toBe(UNIFIED_MOCK_STREAM.inputs);
  expect(c.expected).toBeNull();
});
it("rejects unlisted diagnostic cases instead of generating arbitrary input", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1&mockCase=near500" } });
  expect(selectDiagnosticCase).toThrow("UNKNOWN_DIAGNOSTIC_CASE");
});
it("cells128 has an independent explicit source, query, budget and viewport", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1&mockCase=cells128" } });
  const c = selectDiagnosticCase(), s = c.display.seed;
  expect(c.inputs.length).toBe(128); expect(c.query.cells.length).toBe(128);
  expect(c.scope.config.identity.sessionId).toBe("MOCK-BENCH-cells128-SESSION");
  expect(c.query.cells.every(v => BigInt(v.startNs) >= BigInt(s.endNs) - s.spanNs &&
    BigInt(v.endNs) <= BigInt(s.endNs) && v.priceTicks >= s.priceMinTick &&
    v.priceTicks <= s.priceMaxTick)).toBe(true);
  expect([s.priceMinTick, s.priceMaxTick]).toEqual([79998, 80067]);
  expect(c.scope.budget.inputs).toBe(512);
});
it("measures UTF-8 bytes and refuses an oversized semantic export without truncation", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=control" } });
  startDiagnostics(1); setDiagnosticReader(() => "あ".repeat(22000));
  expect(window.__orderflowMockDiagnostics?.inspectMeaning()).toMatchObject({ bytes: 66002, allowed: false, limit: 65536 });
  expect(() => window.__orderflowMockDiagnostics?.meaning()).toThrow("SEMANTIC_LIMIT");
});
it("progress is bounded metadata, cleared on release and does not copy the row slab", () => {
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1" } });
  startDiagnostics(1); setDiagnosticProgress(() => ({ processedInputs: 3 }));
  diagnostics()?.add("ingest", 3);
  expect(window.__orderflowMockDiagnostics?.progress()).toMatchObject({
    status: { processedInputs: 3 }, recording: { records: 1, saturated: false, dropped: 0 } });
  releaseDiagnostics(); startDiagnostics(2);
  expect(window.__orderflowMockDiagnostics?.progress().status).toBeUndefined();
});
it("labels identical-object frame reads as HIT without introducing additional reads", () => {
  vi.useFakeTimers(); const d = createRecorder(1);
  const s = createMockAnalysisSession({ ...UNIFIED_MOCK_STREAM, diagnostics: d });
  s.setNotificationsEnabled(false); s.start(); vi.advanceTimersByTime(50);
  expect(s.readFrame()).toBe(s.readFrame());
  expect(d.snapshot().rows.filter(r => r.stage === "frame").map(r => r.a)).toEqual([0, 1]);
  s.dispose();
});
it("v2 packs receipt timestamps, keeps duplicates and old revisions without overwrite", () => {
  let t = 0; vi.spyOn(performance, "now").mockImplementation(() => t++ / 10);
  const d = createRecorder(1, 2);
  for (const layer of ["heatmap", "bubble", "delta", "vp"] as const) d.add("received", 7, -1, layer);
  d.add("dom", 7, -1, "vp");
  d.add("received", 7, -1, "heatmap");
  d.add("received", 6, -1, "bubble");
  const s = d.snapshot();
  expect(s).toMatchObject({ version: 2, records: 3, observations: 7, mergedReceipts: 4, dropped: 0 });
  expect(s.receipts[0]).toMatchObject({ revision: 7, mask: 31,
    heatmapAt: 0, bubbleAt: .1, deltaAt: .2, vpAt: .3, domAt: .4 });
  expect(s.receipts[1]).toMatchObject({ revision: 7, heatmapAt: .5, bubbleAt: null });
  expect(s.receipts[2]).toMatchObject({ revision: 6, heatmapAt: null, bubbleAt: .6 });
  s.receipts[0].heatmapAt = 999;
  expect(d.snapshot().receipts[0].heatmapAt).toBe(0);
});
it("v2 preserves every required time sample and its exact timestamp and revision", () => {
  let at = 0; vi.spyOn(performance, "now").mockImplementation(() => at);
  const old = createRecorder(1), compact = createRecorder(1, 2);
  for (let revision = 0; revision <= 128; revision++) {
    for (const stage of ["ingest", "frame", "react", "draw", "raf"] as const) {
      at++;
      for (const d of [old, compact]) d.add(stage, revision, revision, "heatmap", at / 10, 1, 2, 3);
    }
  }
  expect(compact.snapshot().rows).toEqual(old.snapshot().rows);
  expect(compact.snapshot().dropped).toBe(0);
});
it("v2 explicitly delegates GL samples and accounts for every original observation", () => {
  const d = createRecorder(1, 2);
  d.add("gl", 1, -1, "heatmap", .1, 2, 192);
  d.add("received", 1, -1, "heatmap");
  d.add("received", 1, -1, "bubble");
  d.add("draw", 1, -1, "heatmap", .4, 6);
  expect(d.stats()).toMatchObject({ version: 2, records: 2, observations: 4,
    delegatedGL: 1, mergedReceipts: 1, dropped: 0 });
});
it("v2 hard limit never wraps or hides missing observations and dispose clears its cursor", () => {
  const d = createRecorder(1, 2);
  for (let i = 0; i < ROW_LIMIT; i++) d.add("received", i, -1, "heatmap");
  d.add("received", ROW_LIMIT - 1, -1, "bubble");
  expect(d.stats()).toMatchObject({ records: ROW_LIMIT, saturated: true, dropped: 1, allocatedBytes: 147456 });
  expect(d.snapshot().receipts[0].revision).toBe(0);
  d.dispose(); d.add("received", 9999, -1, "heatmap");
  expect(d.snapshot()).toMatchObject({ records: 0, receipts: [], rows: [], allocatedBytes: 0 });
});
it("v2's conservative finite 128-input envelope fits the unchanged 2048/144KiB budget", () => {
  const d = createRecorder(1, 2);
  for (let rev = 0; rev <= 128; rev++) {
    if (rev) d.add("ingest", rev, rev);
    d.add("frame", rev);
    d.add("publish", rev);
    for (let i = 0; i < 3; i++) d.add("react", rev);
    for (const layer of ["heatmap", "bubble", "delta", "vp"] as const) d.add("received", rev, -1, layer);
    d.add("dom", rev, -1, "vp");
    for (const layer of ["heatmap", "bubble"] as const) {
      d.add("gl", rev, -1, layer, .1, 2, 24576);
      d.add("gl", rev, -1, layer, .1, 3, 768);
      d.add("draw", rev, -1, layer);
      for (let i = 0; i < 2; i++) d.add("raf", rev, -1, layer);
    }
    d.add("draw", rev, -1, "delta");
  }
  // 44.4-second finite completion deadline: at most 178 planned polling ticks.
  for (let i = 129; i < 178; i++) d.add("publish", 128);
  for (let i = 0; i < 16; i++) d.add("received", 0, -1, "heatmap");
  for (let i = 0; i < 8; i++) { d.add("react", 0); d.add("raf", 0); }
  for (let i = 0; i < 4; i++) d.add("draw", 0);
  const s = d.snapshot();
  expect(s.records).toBe(1890);
  expect(s).toMatchObject({ allocatedBytes: 147456, saturated: false, dropped: 0 });
  expect(s.rows.filter(r => r.stage === "ingest")).toHaveLength(128);
  expect(s.rows.filter(r => r.stage === "frame")).toHaveLength(129);
  expect(s.rows.filter(r => r.stage === "react")).toHaveLength(395);
  expect(s.rows.filter(r => r.stage === "raf")).toHaveLength(524);
  expect(s.observations).toBe(s.records + s.mergedReceipts + s.delegatedGL);
});
it("baseline13's unchanged v1 conservative envelope also fits before browser execution", () => {
  const d = createRecorder(1);
  for (let rev = 0; rev <= 13; rev++) {
    if (rev) d.add("ingest", rev, rev);
    d.add("frame", rev); d.add("publish", rev);
    for (let i = 0; i < 3; i++) d.add("react", rev);
    for (const layer of ["heatmap", "bubble", "delta", "vp"] as const) d.add("received", rev, -1, layer);
    d.add("dom", rev, -1, "vp");
    for (const layer of ["heatmap", "bubble"] as const) {
      d.add("gl", rev, -1, layer); d.add("gl", rev, -1, layer);
      d.add("draw", rev, -1, layer); d.add("raf", rev, -1, layer); d.add("raf", rev, -1, layer);
    }
    d.add("draw", rev, -1, "delta");
  }
  for (let i = 14; i < 40; i++) d.add("publish", 13);
  for (let i = 0; i < 16; i++) d.add("received", 0);
  for (let i = 0; i < 8; i++) { d.add("react", 0); d.add("raf", 0); d.add("gl", 0); }
  for (let i = 0; i < 4; i++) d.add("draw", 0);
  expect(d.snapshot()).toMatchObject({ version: 1, records: 377, allocatedBytes: 147456, dropped: 0, saturated: false });
});
it("pre-browser baseline13/cells128 output sizes and existing hashes remain exact", () => {
  vi.useFakeTimers();
  for (const id of ["baseline13", "cells128"] as const) {
    vi.stubGlobal("window", { location: { search: `?mockDiagnostics=1&mockCase=${id}` } });
    const c = selectDiagnosticCase(), d = startDiagnostics(1)!;
    expect(d.snapshot().version).toBe(id === "baseline13" ? 1 : 2);
    const s = createMockAnalysisSession({ scope: c.scope, inputs: c.inputs, query: c.query,
      inputEveryMs: 300, diagnostics: d });
    s.setNotificationsEnabled(false); s.start(); vi.advanceTimersByTime(c.inputs.length * 300);
    const frame = s.readFrame(), status = s.getStatus();
    const content = { frame, checks: c.expected ? caseChecks(frame, c) : unifiedChecks(frame), counts: status.counts,
      revision: status.revision, processedInputs: status.processedInputs, state: status.state };
    setDiagnosticReader(() => content);
    const bytes = id === "baseline13" ? 14349 : 40689;
    expect(window.__orderflowMockDiagnostics?.inspectMeaning()).toMatchObject({ bytes, allowed: true });
    const text = window.__orderflowMockDiagnostics!.meaning()!;
    expect(content.checks.every(v => v.ok)).toBe(true);
    expect(createHash("sha256").update(text).digest("hex")).toBe(id === "baseline13"
      ? "dfe56d920917807ed5265bae6ba1c3039a36a3729207c4d1ae38da2c0dc54d27"
      : "5fd67038dc8ee736d2134ec52d097aab9d5f58c91be8d33508c274f3acd1c34c");
    s.dispose();
  }
});

/** Evaluate only the observer function in a fake GL sandbox: never import/run the CLI. */
function glHarness(commitMarkers = false) {
  const text = readFileSync(new URL("./baseline13-driver.mjs", import.meta.url), "utf8");
  const source = text.slice(text.indexOf("function installGLObserver("), text.indexOf("function captureViewport("));
  class GL {
    error = 0;
    createBuffer() { return {}; }
    deleteBuffer(_buffer: object) {}
    bufferData(_target: number, _data: Float32Array, _usage: number) {}
    drawArrays(_mode: number, _first: number, _count: number) { return "native-draw-result"; }
    getError() { const e = this.error; this.error = 0; return e; }
  }
  class Canvas {
    readonly gl = new GL();
    readonly dataset: Record<string, string> = {};
    readonly events = new Map<string, () => void>();
    readonly classList: { contains: (name: string) => boolean };
    constructor(layer: string) { this.classList = { contains: name => name === (layer === "heatmap" ? "hm-canvas" : "bb-canvas") }; }
    getContext(_name: string) { return this.gl; }
    addEventListener(name: string, cb: () => void) { this.events.set(name, cb); }
    removeEventListener(name: string) { this.events.delete(name); }
  }
  type Counters = Record<string, number>;
  let token: { layer: string; revision: number; start: number } | undefined;
  let delegated = 0;
  const win: { __b2gl?: { snapshot: () => { frames: { revision: number; layers: Record<string, Counters> }[];
    totals: Record<string, Counters>; limited: boolean; unrecordedApiCalls: number;
    lastDraws: Record<string, { revision: number; revisionSource: string; vertices: number; uploadedBytes: number }> }; dispose: () => void };
    __orderflowMockDiagnostics: { activeDraw: () => typeof token; gl: () => void } } = {
    __orderflowMockDiagnostics: { activeDraw: () => token, gl: () => { delegated++; } } };
  const native = GL.prototype.drawArrays;
  const install = runInNewContext(`(${source})`, {
    window: win, WebGL2RenderingContext: GL, HTMLCanvasElement: Canvas, performance: { now: () => 0 },
  });
  install(true, commitMarkers);
  return { GL, Canvas, win, native, setToken: (v: typeof token) => { token = v; }, delegated: () => delegated };
}
it("v2 GL groups both layers and repeated draws by actual revision with exact counters", () => {
  const h = glHarness(), canvases = [new h.Canvas("heatmap"), new h.Canvas("bubble")];
  for (const c of canvases) c.getContext("webgl2").createBuffer();
  for (let rev = 0; rev <= 128; rev++) for (let layer = 0; layer < 2; layer++) {
    const name = layer ? "bubble" : "heatmap", gl = canvases[layer].gl;
    for (let repeat = 0; repeat < (rev === 0 ? 2 : 1); repeat++) {
      h.setToken({ layer: name, revision: rev, start: rev * 2 + repeat });
      gl.bufferData(1, new Float32Array(48), 2);
      expect(gl.drawArrays(4, 0, 6)).toBe("native-draw-result");
    }
  }
  const s = h.win.__b2gl!.snapshot();
  expect(s.frames).toHaveLength(130); expect(s.limited).toBe(false);
  for (const name of ["heatmap", "bubble"]) {
    expect(s.totals[name]).toMatchObject({ draws: 130, vertices: 780, uploads: 130, bytes: 24960, buffers: 1 });
    for (const key of ["draws", "vertices", "uploads", "bytes", "buffers"])
      expect(s.frames.reduce((n, f) => n + f.layers[name][key], 0)).toBe(s.totals[name][key]);
    expect(s.frames.find(f => f.revision === 0)!.layers[name].draws).toBe(2);
  }
  h.setToken(undefined);
  canvases[0].events.get("webglcontextlost")!(); canvases[0].events.get("webglcontextrestored")!();
  canvases[0].gl.error = 1280; expect(canvases[0].gl.getError()).toBe(1280);
  expect(s.totals.heatmap).toMatchObject({ loss: 1, restore: 1, errors: 1 });
  expect(h.delegated()).toBe(523);
  h.win.__b2gl!.dispose();
  expect(h.win.__b2gl).toBeUndefined(); expect(h.GL.prototype.drawArrays).toBe(h.native);
  expect(canvases.every(c => c.events.size === 0)).toBe(true);
});
it("v2 GL refuses the 257th revision without wrapping and exposes the missing detail", () => {
  const h = glHarness(), c = new h.Canvas("heatmap"), gl = c.getContext("webgl2");
  for (let rev = 1; rev <= 257; rev++) {
    h.setToken({ layer: "heatmap", revision: rev, start: rev }); gl.drawArrays(4, 0, 6);
  }
  const s = h.win.__b2gl!.snapshot();
  expect(s.frames).toHaveLength(256);
  expect(s.frames[0].revision).toBe(1);
  expect(s).toMatchObject({ limited: true, unrecordedApiCalls: 1 });
  expect(s.totals.heatmap.draws).toBe(257);
  h.win.__b2gl!.dispose();
});

const driverUrl = new URL("./baseline13-driver.mjs", import.meta.url).href;
const legacyJson = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? { bigint: x.toString() }
  : x instanceof Map ? { map: [...x] } : x);
function compactFixture() {
  return { frame: { scope: { padding: "" }, heatmap: { revision: 128, status: "AVAILABLE",
    cells: Array.from({ length: 512 }, (_, i) => ({ side: "BID", binId: 80000, width: 1,
      startNs: String(1767225600000000000n + BigInt(i)), endNs: String(1767225600000000001n + BigInt(i)),
      coveredDuration: "1", coverageRatio: 1, partialTWA: 40, integralQuantityNs: "40", status: "VALID", twa: 40 })) } } };
}
/** Test-only forged self-consistent proof, to ensure reference checks do more than hash checks. */
function forgeProof(packet: ReturnType<typeof JSON.parse>) {
  const body = JSON.parse(JSON.stringify(packet.body));
  body.frame.heatmap.cells = packet.rows.map((r: unknown[]) =>
    Object.fromEntries(packet.schemas[r[0] as number].map((k: string, i: number) => [k, r[i + 1]])));
  const text = JSON.stringify(body);
  packet.legacyBytes = Buffer.byteLength(text);
  packet.sha256 = createHash("sha256").update(text).digest("hex");
  return JSON.stringify(packet);
}
it("v3 independently restores all 512 ordered cells, structure, ordered bytes and SHA-256", async () => {
  const { verifyCompactMeaning } = await import(driverUrl);
  const reference = legacyJson(compactFixture()), encoded = await encodeCompactMeaning(reference);
  const decoded = verifyCompactMeaning(encoded.wire, reference);
  expect(JSON.parse(encoded.wire).version).toBe(3);
  expect(decoded.value.frame.heatmap.cells).toHaveLength(512);
  expect(decoded.value.frame.heatmap.cells.map((c: { startNs: string }) => c.startNs))
    .toEqual(compactFixture().frame.heatmap.cells.map(c => c.startNs));
  expect(decoded.text).toBe(reference);
  expect(decoded.verified).toEqual({ structure: true, fieldAndArrayOrder: true, bytes: true, sha256: true });
});
it("v3 retains distinct ordered schemas, NO DATA/null and all fields", async () => {
  const { verifyCompactMeaning } = await import(driverUrl), value = compactFixture();
  const cell = value.frame.heatmap.cells[1];
  const reordered = { ...cell, status: "NO DATA", twa: null, partialTWA: null, coverageRatio: .5 };
  value.frame.heatmap.cells[1] = Object.fromEntries(Object.entries(reordered).reverse()) as typeof cell;
  const reference = legacyJson(value), p = await encodeCompactMeaning(reference);
  expect(JSON.parse(p.wire).schemas).toHaveLength(2);
  expect(verifyCompactMeaning(p.wire, reference).text).toBe(reference);
});
it("v3 preserves the old JSON contract, not native undefined/BigInt/Map identity", async () => {
  const { verifyCompactMeaning } = await import(driverUrl);
  const value = compactFixture();
  Object.assign(value.frame.scope, { omitted: undefined, explicitNull: null,
    array: [undefined, NaN, Infinity, -0], big: 900719925474099312345n,
    map: new Map([["z", 1n], ["a", undefined]]) });
  const reference = legacyJson(value), p = await encodeCompactMeaning(reference), d = verifyCompactMeaning(p.wire, reference);
  expect(d.value.frame.scope).not.toHaveProperty("omitted");
  expect(d.value.frame.scope).toMatchObject({ explicitNull: null, array: [null, null, null, 0],
    big: { bigint: "900719925474099312345" }, map: { map: [["z", { bigint: "1" }], ["a", null]] } });
  expect(d.value.frame.scope.map).not.toBeInstanceOf(Map);
});
it("v3 encoder refuses unknown/missing TWA fields and noncanonical legacy JSON", async () => {
  const unknown = compactFixture(); Object.assign(unknown.frame.heatmap.cells[0], { futureField: 1 });
  await expect(encodeCompactMeaning(legacyJson(unknown))).rejects.toThrow("COMPACT_CELL_FIELDS");
  const absent = JSON.parse(legacyJson(compactFixture())); delete absent.frame.heatmap.cells[0].twa;
  await expect(encodeCompactMeaning(JSON.stringify(absent))).rejects.toThrow("COMPACT_CELL_FIELDS");
  await expect(encodeCompactMeaning('{"a":1,"a":2}')).rejects.toThrow("COMPACT_NONCANONICAL_LEGACY");
});
it.each(["duplicate", "unknown", "missing", "id", "arity", "count", "extra-envelope", "unused"])(
  "v3 decoder refuses malformed schema/envelope: %s", async mode => {
    const { decodeCompactMeaning } = await import(driverUrl), p = JSON.parse((await encodeCompactMeaning(legacyJson(compactFixture()))).wire);
    if (mode === "duplicate") p.schemas[0][1] = p.schemas[0][0];
    if (mode === "unknown") p.schemas[0][1] = "futureField";
    if (mode === "missing") p.schemas[0].pop();
    if (mode === "id") p.rows[0][0] = 999;
    if (mode === "arity") p.rows[0].pop();
    if (mode === "count") p.rows.pop();
    if (mode === "extra-envelope") p.extra = 1;
    if (mode === "unused") p.schemas.push([...p.schemas[0]].reverse());
    expect(() => decodeCompactMeaning(JSON.stringify(p))).toThrow();
  });
it("v3 rejects duplicate JSON keys even when JSON.parse would silently overwrite", async () => {
  const { decodeCompactMeaning } = await import(driverUrl), p = await encodeCompactMeaning(legacyJson(compactFixture()));
  expect(() => decodeCompactMeaning(p.wire.replace('"version":3', '"version":3,"version":3')))
    .toThrow("COMPACT_NONCANONICAL_OR_DUPLICATE_KEY");
});
it("v3 rejects cell order tampering even with an internally consistent forged hash", async () => {
  const { decodeCompactMeaning, verifyCompactMeaning } = await import(driverUrl);
  const reference = legacyJson(compactFixture()), p = JSON.parse((await encodeCompactMeaning(reference)).wire);
  [p.rows[0], p.rows[1]] = [p.rows[1], p.rows[0]];
  expect(() => decodeCompactMeaning(JSON.stringify(p))).toThrow("COMPACT_SHA256_MISMATCH");
  expect(() => verifyCompactMeaning(forgeProof(p), reference)).toThrow("COMPACT_STRUCTURE_MISMATCH");
});
it("v3 detects field order changes even when values and a forged digest are consistent", async () => {
  const { decodeCompactMeaning, verifyCompactMeaning } = await import(driverUrl);
  const reference = legacyJson(compactFixture()), p = JSON.parse((await encodeCompactMeaning(reference)).wire);
  [p.schemas[0][0], p.schemas[0][1]] = [p.schemas[0][1], p.schemas[0][0]];
  for (const r of p.rows) [r[1], r[2]] = [r[2], r[1]];
  const forged = forgeProof(p);
  expect(decodeCompactMeaning(forged).sha256).toBe(JSON.parse(forged).sha256);
  expect(() => verifyCompactMeaning(forged, reference)).toThrow("COMPACT_FIELD_ORDER");
});
it("v3 detects omitted fields and type conflation outside the cell table", async () => {
  const { verifyCompactMeaning } = await import(driverUrl), value = compactFixture();
  Object.assign(value.frame.scope, { big: 42n, explicitNull: null });
  const reference = legacyJson(value), original = JSON.parse((await encodeCompactMeaning(reference)).wire);
  for (const change of ["missing", "type", "unknown"]) {
    const p = JSON.parse(JSON.stringify(original));
    if (change === "missing") delete p.body.frame.scope.explicitNull;
    else if (change === "type") p.body.frame.scope.big = "42";
    else p.body.frame.scope.unexpected = 1;
    expect(() => verifyCompactMeaning(forgeProof(p), reference)).toThrow("COMPACT_STRUCTURE_MISMATCH");
  }
});
it("v3 enforces the exact UTF-8 boundary and refuses oversize output without truncation", async () => {
  const { decodeCompactMeaning } = await import(driverUrl), value = compactFixture();
  const first = await encodeCompactMeaning(legacyJson(value)), room = 65536 - Buffer.byteLength(first.wire);
  value.frame.scope.padding = "あ".repeat(Math.floor(room / 3)) + "x".repeat(room % 3);
  const boundary = await encodeCompactMeaning(legacyJson(value));
  expect(Buffer.byteLength(boundary.wire)).toBe(65536);
  expect(boundary.wire.length).toBeLessThan(65536);
  expect(decodeCompactMeaning(boundary.wire).wireBytes).toBe(65536);
  value.frame.scope.padding += "あ";
  await expect(encodeCompactMeaning(legacyJson(value))).rejects.toMatchObject({
    message: "DIAGNOSTIC_SEMANTIC_LIMIT", bytes: 65539, limit: 65536 });
  expect(() => decodeCompactMeaning(boundary.wire + " ")).toThrow("DIAGNOSTIC_SEMANTIC_LIMIT");
});
it("v3 exposes missing SHA/type/schema version evidence rather than accepting it", async () => {
  const { decodeCompactMeaning } = await import(driverUrl), original = JSON.parse((await encodeCompactMeaning(legacyJson(compactFixture()))).wire);
  for (const change of ["sha", "version", "type", "missing-sha"]) {
    const p = JSON.parse(JSON.stringify(original));
    if (change === "sha") p.sha256 = "0".repeat(64);
    if (change === "version") p.version = 4;
    if (change === "missing-sha") delete p.sha256;
    if (change === "type") p.rows[0][p.schemas[0].indexOf("startNs") + 1] = 1;
    expect(() => decodeCompactMeaning(JSON.stringify(p))).toThrow();
  }
});
it("cells512 opts into v3 without replacing v1/v2 meaning() or growing the numeric slab", async () => {
  for (const [id, version] of [["baseline13", 1], ["cells128", 2], ["cells512", 3]] as const) {
    vi.stubGlobal("window", { location: { search: `?mockDiagnostics=1&mockCase=${id}` } });
    const d = startDiagnostics(1)!;
    expect(d.snapshot()).toMatchObject({ version, allocatedBytes: 147456, rows: [], receipts: [] });
    if (id !== "cells512") await expect(window.__orderflowMockDiagnostics!.compactMeaning()).rejects.toThrow("COMPACT_CASE_NOT_ENABLED");
    else {
      const reference = legacyJson(compactFixture()); setDiagnosticReader(() => JSON.parse(reference));
      expect(() => window.__orderflowMockDiagnostics!.meaning()).toThrow("DIAGNOSTIC_SEMANTIC_LIMIT");
      expect(JSON.parse((await window.__orderflowMockDiagnostics!.compactMeaning())!).version).toBe(3);
      d.add("received", 1, -1, "heatmap"); d.add("received", 1, -1, "bubble"); d.add("gl", 1);
      expect(d.stats()).toMatchObject({ records: 1, mergedReceipts: 1, delegatedGL: 1, dropped: 0 });
    }
  }
});
it.each([["baseline13", 1, "meaning", false], ["cells128", 2, "meaning", true], ["cells512", 3, "compactMeaning", true]])(
  "browser driver routes %s explicitly without changing legacy readouts", async (id, version, method, compactGL) => {
    const driver = await import(driverUrl);
    expect(driver.browserCasePolicy(id)).toEqual({ version, method, compactGL });
    const expression = driver.browserReadoutExpression(id);
    const calls: string[] = [];
    const wire = "opaque";
    const value = await runInNewContext(expression, { window: { __orderflowMockDiagnostics: {
      meaning: () => { calls.push("meaning"); return wire; },
      compactMeaning: async () => { calls.push("compactMeaning"); return wire; }, snapshot: () => null,
    } }, document: { querySelectorAll: () => [] } });
    expect(calls).toEqual([method]); expect(value.meaning).toBe(wire);
    expect(value.telemetry).toBeNull();
  });
it("cells512 OFF and ON use the same independently verified v3 resolver", async () => {
  const driver = await import(driverUrl), reference = legacyJson(compactFixture());
  const { wire } = await encodeCompactMeaning(reference);
  const results = ["OFF", "ON"].map(() => driver.resolveBrowserMeaning("cells512", wire, reference));
  expect(results[0].text).toBe(reference); expect(results[1].text).toBe(reference);
  expect(results[0].verified).toEqual(results[1].verified);
  expect(results[0].sha256).toBe(results[1].sha256);
  expect(() => driver.resolveBrowserMeaning("cells512", wire)).toThrow("MISSING_INDEPENDENT_LEGACY_REFERENCE");
});
it("legacy browser limits and case whitelist remain fail-closed", async () => {
  const driver = await import(driverUrl), reference = '{"x":1}';
  for (const id of ["baseline13", "cells128"]) {
    expect(driver.resolveBrowserMeaning(id, reference).text).toBe(reference);
    expect(() => driver.resolveBrowserMeaning(id, " ".repeat(65537))).toThrow("DIAGNOSTIC_SEMANTIC_LIMIT");
  }
  expect(() => driver.browserCasePolicy("unknown")).toThrow("CASE_NOT_APPROVED");
});
it("OFF native GL observations distinguish commit markers from active draw tokens", () => {
  const h = glHarness(true), c = new h.Canvas("heatmap"), gl = c.getContext("webgl2");
  c.dataset.revision = "128"; gl.bufferData(1, new Float32Array(3072 * 8), 2); gl.drawArrays(4, 0, 3072);
  const first = h.win.__b2gl!.snapshot();
  expect(first.lastDraws.heatmap).toEqual({ revision: 128, revisionSource: "CANVAS_COMMIT_MARKER",
    vertices: 3072, uploadedBytes: 98304 });
  h.setToken({ layer: "heatmap", revision: 127, start: 1 }); gl.drawArrays(4, 0, 6);
  expect(h.win.__b2gl!.snapshot().lastDraws.heatmap.revision).toBe(127);
  expect(h.win.__b2gl!.snapshot().lastDraws.heatmap.revisionSource).toBe("ACTIVE_DRAW_TOKEN");
  expect(first.frames.find(f => f.revision === 128)!.layers.heatmap.draws).toBe(1);
  h.win.__b2gl!.dispose();
});
it("driver resource observer forwards native timers and releases one-shot RAF IDs", () => {
  const text = readFileSync(new URL("./baseline13-driver.mjs", import.meta.url), "utf8");
  const source = text.slice(text.indexOf("function installResourceObserver("), text.indexOf("async function browserGroup("));
  const callbacks = new Map<number, (t: number) => void>(); let id = 0;
  const nativeSet = vi.fn(() => ++id), nativeClear = vi.fn(), nativeCancel = vi.fn();
  const win: Record<string, any> = { setInterval: nativeSet, clearInterval: nativeClear,
    requestAnimationFrame: (fn: (t: number) => void) => { callbacks.set(++id, fn); return id; },
    cancelAnimationFrame: nativeCancel };
  runInNewContext(`(${source})()`, { window: win });
  const interval = win.setInterval(() => {}, 250), fn = vi.fn(), raf = win.requestAnimationFrame(fn);
  expect(win.__b2resources.snapshot()).toEqual({ intervals: 1, raf: 1 });
  callbacks.get(raf)!(42); expect(fn).toHaveBeenCalledWith(42);
  win.clearInterval(interval);
  expect(win.__b2resources.snapshot()).toEqual({ intervals: 0, raf: 0 });
  const cancelled = win.requestAnimationFrame(fn); win.cancelAnimationFrame(cancelled);
  expect(nativeCancel).toHaveBeenCalledWith(cancelled);
  win.__b2resources.dispose(); expect(win.setInterval).toBe(nativeSet); expect(win.__b2resources).toBeUndefined();
});
