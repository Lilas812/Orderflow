/** Finite numeric telemetry only. No events, timers, console output or renderer changes. */
export const ROW_LIMIT = 2048;
const WIDTH = 9;
export const STAGES = ["ingest", "publish", "frame", "react", "received", "raf", "draw", "dom", "gl", "lifecycle"] as const;
export const LAYERS = ["session", "root", "heatmap", "bubble", "delta", "vp"] as const;
type Stage = typeof STAGES[number];
export type Layer = typeof LAYERS[number];
export type Row = { stage: Stage; at: number; ms: number; revision: number; seq: number; layer: Layer; a: number; b: number; c: number };

export function createRecorder(sessionId: number) {
  let data: Float64Array | null = new Float64Array(ROW_LIMIT * WIDTH);
  let size = 0, dropped = 0, saturated = false;
  return {
    add(stage: Stage, revision = -1, seq = -1, layer: Layer = "session", ms = 0, a = 0, b = 0, c = 0) {
      if (!data) return;
      if (saturated) { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); return; }
      const row = [STAGES.indexOf(stage), performance.now(), ms, revision, seq, LAYERS.indexOf(layer), a, b, c];
      if (!row.every(Number.isFinite) || row[0] < 0 || row[5] < 0) { dropped++; return; }
      data.set(row, size++ * WIDTH);
      if (size === ROW_LIMIT) saturated = true;
    },
    snapshot() {
      const rows: Row[] = [];
      if (data) for (let i = 0; i < size; i++) {
        const o = i * WIDTH;
        rows.push({ stage: STAGES[data[o]], at: data[o + 1], ms: data[o + 2], revision: data[o + 3],
          seq: data[o + 4], layer: LAYERS[data[o + 5]], a: data[o + 6], b: data[o + 7], c: data[o + 8] });
      }
      return { sessionId, limit: ROW_LIMIT, allocatedBytes: data?.byteLength ?? 0, saturated, dropped, rows,
        gpuMs: "UNKNOWN", presentationAt: "UNKNOWN" };
    },
    dispose() { data?.fill(0); data = null; size = dropped = 0; saturated = false; },
  };
}
export type Recorder = ReturnType<typeof createRecorder>;
let active: Recorder | undefined;
let reader: (() => unknown) | undefined;
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
}
declare global { interface Window { __orderflowMockDiagnostics?: Bridge } }

export function releaseDiagnostics() {
  active?.dispose(); active = undefined; reader = undefined; draw = undefined;
  if (typeof window !== "undefined") delete window.__orderflowMockDiagnostics;
}
export function startDiagnostics(sessionId: number) {
  releaseDiagnostics();
  const mode = diagnosticMode();
  if (mode === "off") return undefined;
  if (mode === "on") active = createRecorder(sessionId);
  window.__orderflowMockDiagnostics = {
    snapshot: () => active?.snapshot() ?? null,
    // Read on demand, outside timed ingest/frame sections. Derived frame only, never raw input.
    meaning: () => {
      if (!reader) return null;
      const text = JSON.stringify(reader(), (_k, v) => typeof v === "bigint" ? { bigint: v.toString() }
        : v instanceof Map ? { map: [...v] } : v);
      if (text.length > 65536) throw new Error("DIAGNOSTIC_SEMANTIC_LIMIT");
      return text;
    },
    activeDraw: () => draw ? { ...draw } : undefined,
    gl: (layer, kind, ms, a, b) => active?.add("gl", draw?.revision ?? -1, -1, layer, ms, kind, a, b),
  };
  return active;
}
export const setDiagnosticReader = (next: () => unknown) => { if (diagnosticMode() !== "off") reader = next; };
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
