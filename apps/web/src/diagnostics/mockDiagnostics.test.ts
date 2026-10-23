import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { transpileModule, ModuleKind, JsxEmit } from "typescript";
import { HeatmapRenderer as RealHeatmapRenderer, projectHeatmap } from "@workspace/render";
import { BubbleRenderer as RealBubbleRenderer, projectBubbles } from "@workspace/render/bubbles";
import { createViewport } from "@workspace/core/viewport";
import { UNIFIED_MOCK_STREAM, R09_SCENARIOS } from "@workspace/fixtures";
import { createBubbleFinality, ingestBubbleTrade } from "@workspace/core/bubble-finality";
import { createMockAnalysisSession } from "../lib/mockAnalysisSession";
import { unifiedChecks } from "../hooks/useMockAnalysisSession";
import {
  ROW_LIMIT, createRecorder, startDiagnostics, releaseDiagnostics, setDiagnosticReader,
  diagnostics, beginDraw, endDraw, diagnosticMode,
  selectDiagnosticCase, setDiagnosticProgress, caseChecks, encodeCompactMeaning,
} from "./mockDiagnostics";

afterEach(() => { releaseDiagnostics(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

// Offline component-hook harness: execute the actual Canvas function, not a copy
// of its scheduler. The renderer/DOM/clock are artificial; real renderer and
// projection correctness remain covered by @workspace/render's existing tests.
type CanvasLayer = "heatmap" | "bubble";
const canvasPrograms = new Map<CanvasLayer, string>();
function canvasSchedulerHarness(layer: CanvasLayer, scheduler: "frame" | "interval" = "frame", real = false) {
  const name = layer === "heatmap" ? "HeatmapCanvas" : "BubbleCanvas";
  if (!canvasPrograms.has(layer)) {
    const source = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");
    canvasPrograms.set(layer, transpileModule(
      `import { useRef, useState, useEffect, useLayoutEffect } from "react";\n${source.slice(source.indexOf(`export function ${name}(`))}`,
      { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: 9 } },
    ).outputText);
  }
  // The VM boundary intentionally has dynamic React-element/hook payloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Value = any;
  const hooks: { value?: Value; deps?: Value[]; cleanup?: () => void; create?: () => void | (() => void) }[] = [];
  const rafs = new Map<number, (stamp: number) => void>(), allRafs = new Map<number, (stamp: number) => void>();
  const intervals = new Map<number, () => void>(), canceled: number[] = [];
  const records: Value[] = [], renderers: ArtificialRenderer[] = [];
  let cursor = 0, nextId = 0, now = 0, stateDirty = false, tree: Value, effects: (() => void)[] = [];
  const parentEvents = new Map<string, Value>();
  const canvasEvents = new Map<string, { f: Value; capture: boolean }[]>();
  const glState = { lost: false, uploads: [] as Float32Array[], draws: [] as Float32Array[], trace: [] as string[], failCompile: false };
  const gl: Value = {
    NO_ERROR: 0, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, ARRAY_BUFFER: 34962,
    getShaderParameter: () => !glState.failCompile, getProgramParameter: () => true,
    getShaderInfoLog: () => "artificial compile failure", getError: () => 0, isContextLost: () => glState.lost,
    bufferData: (_target: Value, data: Float32Array) => {
      if (glState.lost) throw new Error("GL upload while lost");
      glState.uploads.push(new Float32Array(data)); glState.trace.push("upload");
    },
    drawArrays: () => {
      if (glState.lost) throw new Error("GL draw while lost");
      glState.draws.push(glState.uploads.at(-1)!); glState.trace.push("gpu-draw");
    },
  };
  for (const method of ["createShader", "createProgram", "createBuffer", "createVertexArray", "getUniformLocation"])
    gl[method] = () => ({});
  for (const method of ["shaderSource", "compileShader", "attachShader", "linkProgram", "bindVertexArray", "bindBuffer",
    "enableVertexAttribArray", "vertexAttribPointer", "deleteShader", "deleteBuffer", "deleteVertexArray", "deleteProgram",
    "viewport", "enable", "disable", "scissor", "clearColor", "clear", "blendFunc", "blendFuncSeparate", "useProgram", "uniform2f"])
    gl[method] = vi.fn();
  const dispatchCanvas = (type: string) => {
    // DOM AT_TARGET capture listeners precede target non-capture listeners,
    // irrespective of registration order. Node EventTarget does not model this.
    const listeners = [...canvasEvents.get(type) ?? []].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const listener of listeners) if (canvasEvents.get(type)?.includes(listener)) listener.f({ preventDefault() {} });
  };
  const canvas = {
    width: 0, height: 0, getContext: () => gl,
    addEventListener: (k: string, f: Value, capture = false) => {
      canvasEvents.set(k, [...canvasEvents.get(k) ?? [], { f, capture }]);
    },
    removeEventListener: (k: string, f: Value, capture = false) => {
      canvasEvents.set(k, (canvasEvents.get(k) ?? []).filter(l => l.f !== f || l.capture !== capture));
    },
    parentElement: { addEventListener: (k: string, f: Value) => parentEvents.set(k, f),
    removeEventListener: (k: string) => parentEvents.delete(k),
    getBoundingClientRect: () => ({ left: 0, top: 0 }) } };
  const hook = () => hooks[cursor++] ?? (hooks[cursor - 1] = {});
  const effect = (create: () => void | (() => void), deps?: Value[]) => {
    const h = hook(), changed = !h.create || !deps || deps.some((v, i) => !Object.is(v, h.deps?.[i]));
    if (changed) {
      h.deps = deps; h.create = create;
      effects.push(() => { h.cleanup?.(); h.cleanup = create() || undefined; });
    }
  };
  const react = {
    useRef: (initial: Value) => { const h = hook(); return h.value ?? (h.value = { current: initial }); },
    useState: (initial: Value) => {
      const h = hook();
      if (!("value" in h)) h.value = typeof initial === "function" ? initial() : initial;
      return [h.value, (next: Value) => {
        const value = typeof next === "function" ? next(h.value) : next;
        if (!Object.is(value, h.value)) { h.value = value; stateDirty = true; }
      }];
    },
    useEffect: effect, useLayoutEffect: effect,
  };
  class ArtificialRenderer {
    status = "READY";
    draws: Value[][] = [];
    lastFrame = { vertexCount: 6, rects: [], clusters: [], bubbles: [] };
    disposed = false;
    failNext = false;
    saved: Value[] | null = null;
    constructor(readonly target: unknown, readonly statusChanged: (s: string, e: string | null) => void) {
      renderers.push(this); statusChanged("READY", null);
    }
    draw(...args: Value[]) {
      if (this.disposed) throw new Error("invalid draw");
      this.saved = args;
      if (this.status === "CONTEXT LOST") return this.lastFrame;
      if (this.failNext) { this.failNext = false; throw new Error("artificial draw failure"); }
      if (this.status !== "READY") { this.status = "READY"; this.statusChanged("READY", null); }
      this.saved = args; this.draws.push(args); return this.lastFrame;
    }
    loss() { this.status = "CONTEXT LOST"; this.statusChanged(this.status, "artificial context loss"); }
    restore() {
      for (const l of canvasEvents.get("webglcontextrestored") ?? []) if (l.capture) l.f();
      this.status = "READY"; this.statusChanged("READY", null);
      // Match the existing renderer's automatic replay *after* its READY callback.
      if (this.saved) this.draw(...this.saved);
    }
    dispose() { this.disposed = true; }
  }
  const jsx = (type: Value, props: Value) => ({ type, props });
  const module = { exports: {} as Record<string, (props: Value) => Value> };
  runInNewContext(canvasPrograms.get(layer)!, {
    module, exports: module.exports, Error,
    require: (id: string) => id === "react" ? react : { jsx, jsxs: jsx, Fragment: "fragment" },
    HeatmapRenderer: real ? class {
      constructor(target: HTMLCanvasElement, statusChanged: Value) {
        const renderer: Value = new RealHeatmapRenderer(target, (s, e) => { glState.trace.push(s); statusChanged(s, e); });
        renderer.loss = () => { glState.lost = true; dispatchCanvas("webglcontextlost"); };
        renderer.restore = () => { glState.lost = false; dispatchCanvas("webglcontextrestored"); };
        renderers.push(renderer); return renderer;
      }
    } : ArtificialRenderer,
    BubbleRenderer: real ? class {
      constructor(target: HTMLCanvasElement, statusChanged: Value) {
        const renderer: Value = new RealBubbleRenderer(target, (s, e) => { glState.trace.push(s); statusChanged(s, e); });
        renderer.loss = () => { glState.lost = true; dispatchCanvas("webglcontextlost"); };
        renderer.restore = () => { glState.lost = false; dispatchCanvas("webglcontextrestored"); };
        renderers.push(renderer); return renderer;
      }
    } : ArtificialRenderer,
    useTimeFormat: () => ({ fmt: String }), hitTestCell: () => null, hitTestProjectedBubble: () => null,
    BubbleTooltip: () => null, DISPLAY_INTERVAL_MS: 250,
    diagnostics: () => ({ add: (...v: Value[]) => records.push(v) }),
    beginDraw: (l: string, revision: number) => { records.push(["begin", revision, l]); return {}; },
    endDraw: () => {},
    performance: { now: () => now },
    window: {
      requestAnimationFrame: (f: (stamp: number) => void) => {
        const id = nextId++; rafs.set(id, f); allRafs.set(id, f); return id;
      },
      cancelAnimationFrame: (id: number) => { canceled.push(id); rafs.delete(id); },
      setInterval: (f: () => void) => { const id = nextId++; intervals.set(id, f); return id; },
      clearInterval: (id: number) => intervals.delete(id),
    },
  });
  let props: Value = { cells: [], bubbles: [], vp: { bounds: { left: 0, top: 0, width: 403, height: 324 },
    time: { minNs: "0", maxNs: "100" }, price: { minTick: 79990, maxTick: 80010 }, dpr: 1 }, revision: 1, scheduler };
  const attach = (node: Value) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "canvas") node.props.ref.current = canvas;
    const children = node.props?.children;
    for (const c of Array.isArray(children) ? children : [children]) attach(c);
  };
  const render = (patch: Value = {}) => {
    props = { ...props, ...patch };
    let passes = 0;
    do {
      if (++passes > 15) throw new Error("unexpected render loop");
      cursor = 0; effects = []; stateDirty = false;
      tree = module.exports[name](props); attach(tree);
      for (const run of effects) run();
    } while (stateDirty);
  };
  const unmount = () => { for (const h of hooks) { h.cleanup?.(); h.cleanup = undefined; } };
  const advance = () => {
    now += 16;
    for (const [id, f] of [...rafs]) { rafs.delete(id); f(now); }
    render();
  };
  const canvasProps = () => tree.props.children.find((v: Value) => v?.type === "canvas").props;
  render();
  return { render, advance, unmount, props: () => props, rafs, allRafs, canceled, records, renderers, intervals, canvasProps,
    gl, glState, canvasEvents, dispatchCanvas,
    strictReplay: () => {
      unmount();
      for (const h of hooks) if (h.create) h.cleanup = h.create() || undefined;
      render();
    } };
}

function restoreFixture(layer: CanvasLayer) {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { search: "?mockDiagnostics=1&mockCase=baseline13" } });
  const c = selectDiagnosticCase(), seed = c.display.seed;
  const session = createMockAnalysisSession({ scope: c.scope, inputs: c.inputs, query: c.query, inputEveryMs: 300 });
  session.setNotificationsEnabled(false); session.start(); vi.advanceTimersByTime(c.inputs.length * 300);
  const frame = session.readFrame(); session.dispose();
  const vp = createViewport({ bounds: { left: 0, top: 0, width: 403, height: 324 }, dpr: 1,
    latestNs: seed.endNs, price: { minTick: seed.priceMinTick, maxTick: seed.priceMaxTick } });
  if (layer === "bubble") {
    const scenario = R09_SCENARIOS.find(s => s.id === "F04")!;
    let state = createBubbleFinality(scenario.events[0].header, scenario.quality);
    for (const event of scenario.events) state = ingestBubbleTrade(state, event);
    const origin = BigInt(scenario.events[0].header.exchangeTimeNs!);
    return { cells: [], bubbles: state.bubbles,
      vp: { ...vp, time: { minNs: (origin - 2_000_000_000n).toString(), maxNs: (origin + 6_000_000_000n).toString() } } };
  }
  return { cells: frame.heatmap.cells.map((result, i) => ({
    id: `restore-${i}`, priceTicks: c.query.cells[i].priceTicks, result,
  })), bubbles: [],
  vp: { ...vp, time: { minNs: (BigInt(seed.endNs) - seed.spanNs).toString(), maxNs: seed.endNs } } };
}

for (const layer of ["heatmap", "bubble"] as const) {
  for (const revisions of [[], [4], [3, 4], [3, 4, 5, 6]]) {
    it(`${layer}: actual renderer capture stages latest input before READY/native replay (${revisions.join(",") || "unchanged"})`, () => {
      const data = restoreFixture(layer), h = canvasSchedulerHarness(layer, "frame", true), renderer = h.renderers[0];
      h.render({ ...data, revision: 2 }); h.advance();
      const before = new Float32Array(h.glState.draws.at(-1)!);
      const count = h.glState.draws.length;
      const draw = vi.spyOn(renderer, "draw");
      renderer.loss(); h.render();
      for (const revision of revisions) h.render({ revision,
        vp: { ...data.vp, bounds: { ...data.vp.bounds, width: 403 - revision * 3 } } });
      expect(h.glState.draws).toHaveLength(count);
      expect(h.rafs.size).toBe(0);
      h.glState.trace.length = 0;
      renderer.restore(); h.render();
      expect(h.canvasProps()["data-status"], String((renderer as unknown as { error?: string }).error)).toBe("READY");
      // The real renderer, not a convenient mock READY, supplies this ordering.
      expect(draw).toHaveBeenCalledTimes(2); // CPU-only staging + one native replay
      expect(h.glState.trace).toEqual(["READY", "upload", "gpu-draw"]);
      expect(h.glState.draws).toHaveLength(count + 1);
      const p = h.props();
      const expected = layer === "heatmap" ? projectHeatmap(p.cells, p.vp) : projectBubbles(p.bubbles, p.vp);
      expect(expected.vertexData.length).toBeGreaterThan(0);
      expect(h.glState.draws.at(-1)).toEqual(expected.vertexData);
      if (revisions.length) expect(h.glState.draws.at(-1)).not.toEqual(before);
      else expect(h.glState.draws.at(-1)).toEqual(before);
      expect(h.canvasProps()["data-status"]).toBe("READY");
      expect(h.rafs.size).toBe(0);
      h.render(); expect(h.rafs.size).toBe(0);
      h.render({ revision: 10, vp: { ...p.vp } }); h.advance();
      expect(h.glState.draws).toHaveLength(count + 2);
      h.unmount();
      expect(h.intervals.size).toBe(0); expect(h.rafs.size).toBe(0);
      expect([...h.canvasEvents.values()].flat()).toHaveLength(0);
      expect(h.gl.deleteBuffer).toHaveBeenCalled();
    });
  }
  it(`${layer}: actual restore failure retains dirty input and recovers on the next context lifecycle`, () => {
    const h = canvasSchedulerHarness(layer, "frame", true), renderer = h.renderers[0];
    h.render({ ...restoreFixture(layer), revision: 2 }); h.advance();
    renderer.loss(); h.render({ revision: 4 });
    const count = h.glState.draws.length;
    h.glState.failCompile = true; renderer.restore(); h.render();
    expect(h.canvasProps()["data-status"]).toBe("RENDER ERROR");
    expect(h.glState.draws).toHaveLength(count);
    h.glState.failCompile = false; renderer.loss(); h.render({ revision: 5 });
    renderer.restore(); h.render();
    expect(h.glState.draws).toHaveLength(count + 1);
    expect(h.canvasProps()["data-status"]).toBe("READY");
    h.unmount();
  });
  it(`${layer}: actual renderer cannot replay after unmount; remount stages its own latest inputs`, () => {
    const h = canvasSchedulerHarness(layer, "frame", true), renderer = h.renderers[0];
    const data = restoreFixture(layer); h.render({ ...data, revision: 2 });
    const stale = [...h.allRafs.values()].at(-1)!;
    renderer.loss(); h.render({ revision: 4 });
    h.unmount(); const count = h.glState.draws.length;
    stale(40); renderer.restore();
    expect(h.glState.draws).toHaveLength(count);
    h.strictReplay();
    const replacement = h.renderers.at(-1)!;
    expect(replacement).not.toBe(renderer);
    replacement.loss(); h.render({ revision: 6 }); replacement.restore(); h.render();
    expect(h.canvasProps()["data-status"]).toBe("READY");
    h.unmount(); expect([...h.canvasEvents.values()].flat()).toHaveLength(0);
  });
  it(`${layer}: a new revision queued during real restore is processed after native replay`, async () => {
    const h = canvasSchedulerHarness(layer, "frame", true), renderer = h.renderers[0];
    const data = restoreFixture(layer); h.render({ ...data, revision: 2 }); h.advance();
    renderer.loss(); h.render({ revision: 4 });
    const count = h.glState.draws.length;
    // JavaScript restore/initialize/READY/native replay is one synchronous task.
    const next = Promise.resolve().then(() => h.render({ revision: 5, vp: { ...data.vp } }));
    renderer.restore(); h.render(); expect(h.glState.draws).toHaveLength(count + 1);
    await next; expect(h.rafs.size).toBe(1); h.advance();
    expect(h.glState.draws).toHaveLength(count + 2); h.unmount();
  });
  it(`${layer}: mount draws once; statistics-only render does not schedule rAF`, () => {
    const h = canvasSchedulerHarness(layer);
    expect(h.renderers[0].draws).toHaveLength(1);
    expect(h.rafs.size).toBe(0); h.render(); expect(h.rafs.size).toBe(0); h.unmount();
  });
  it(`${layer}: dirty requests coalesce, use latest revision/props and do not reschedule after draw`, () => {
    const h = canvasSchedulerHarness(layer), cells: unknown[] = [], bubbles: unknown[] = [];
    h.render({ revision: 2 }); h.render({ revision: 3, cells, bubbles });
    expect(h.rafs.size).toBe(1); h.advance();
    expect(h.renderers[0].draws).toHaveLength(2);
    expect(h.renderers[0].draws.at(-1)![0]).toBe(layer === "heatmap" ? cells : bubbles);
    expect(h.records.filter(v => v[0] === "begin").at(-1)![1]).toBe(3);
    expect(h.rafs.size).toBe(0); expect(h.canceled).toHaveLength(0);
    h.render({ revision: 4 }); expect(h.rafs.size).toBe(1); h.unmount();
  });
  for (const change of ["viewport", "zoom", "pan", "resize", "DPR", "color", "threshold"] as const) {
    it(`${layer}: same-revision ${change} invalidates and redraws`, () => {
      const h = canvasSchedulerHarness(layer), p = h.props();
      const vp = { ...p.vp, bounds: { ...p.vp.bounds } };
      if (change === "DPR") vp.dpr = 2;
      else if (change === "resize") vp.bounds.width = 500;
      else if (change === "zoom") vp.time = { ...vp.time, maxNs: "50" };
      else if (change === "pan") vp.time = { minNs: "10", maxNs: "110" };
      if (change === "color") h.render({ style: {}, colors: {} });
      else if (change === "threshold") h.render({ style: {}, filters: {}, sizing: {} });
      else h.render({ vp });
      expect(h.rafs.size).toBe(1); h.advance();
      expect(h.renderers[0].draws).toHaveLength(2);
      expect(h.rafs.size).toBe(0); h.unmount();
    });
  }
  it(`${layer}: unmount cancels even id=0; stale callback cannot draw`, () => {
    const h = canvasSchedulerHarness(layer);
    h.render({ revision: 2 }); const stale = h.allRafs.get(0)!;
    h.unmount(); expect(h.canceled).toContain(0); expect(h.rafs.size).toBe(0);
    stale(100); expect(h.renderers[0].draws).toHaveLength(1); expect(h.intervals.size).toBe(0);
  });
  it(`${layer}: context loss cancels requests; restore replays latest inputs, never old revision`, () => {
    const h = canvasSchedulerHarness(layer), renderer = h.renderers[0];
    h.render({ revision: 2 }); const stale = h.allRafs.get(0)!;
    renderer.loss(); h.render({ revision: 3, cells: [], bubbles: [] });
    expect(h.rafs.size).toBe(0); stale(100); expect(renderer.draws).toHaveLength(1);
    expect(h.canvasProps()["data-status"]).toBe("CONTEXT LOST");
    const latest = h.props()[layer === "heatmap" ? "cells" : "bubbles"];
    renderer.restore(); h.render();
    expect(renderer.draws.slice(1).every(args => args[0] === latest)).toBe(true);
    expect(renderer.draws.length).toBeGreaterThan(1);
    expect(h.canvasProps()["data-status"]).toBe("READY");
    expect(h.rafs.size).toBe(0); h.unmount();
  });
  it(`${layer}: StrictMode-style cleanup/setup, stop/resume and remount isolate old renderer`, () => {
    const h = canvasSchedulerHarness(layer);
    h.render({ revision: 2 }); const stale = h.allRafs.get(0)!;
    h.strictReplay(); stale(100);
    expect(h.renderers[0].disposed).toBe(true);
    expect(h.renderers[0].draws).toHaveLength(1);
    expect(h.renderers[1].draws).toHaveLength(1);
    h.render(); expect(h.rafs.size).toBe(0); // stopped, unchanged frame
    h.render({ revision: 3 }); h.advance(); // resumed
    expect(h.renderers[1].draws).toHaveLength(2); h.unmount();
    const next = canvasSchedulerHarness(layer); stale(200);
    expect(next.renderers[0].draws).toHaveLength(1); next.unmount();
  });
  it(`${layer}: unchanged context restore uses native replay without extra component draw/rAF`, () => {
    const h = canvasSchedulerHarness(layer), renderer = h.renderers[0];
    renderer.loss(); h.render(); renderer.restore(); h.render();
    expect(renderer.draws).toHaveLength(2);
    expect(h.records.filter(v => v[0] === "begin")).toHaveLength(1);
    expect(h.rafs.size).toBe(0); h.unmount();
  });
  it(`${layer}: a recoverable renderer error retries on new input, without recursive READY draw`, () => {
    const h = canvasSchedulerHarness(layer), renderer = h.renderers[0];
    renderer.status = "RENDER ERROR"; renderer.statusChanged(renderer.status, "artificial GL error");
    h.render({ revision: 2 }); expect(h.rafs.size).toBe(1); h.advance();
    expect(renderer.draws).toHaveLength(2);
    expect(h.canvasProps()["data-status"]).toBe("READY");
    expect(h.rafs.size).toBe(0); h.unmount();
  });
  it(`${layer}: legacy interval mode and visible error/statistics remain functional`, () => {
    const h = canvasSchedulerHarness(layer, "interval"), renderer = h.renderers[0];
    expect(h.intervals.size).toBe(1); expect(h.rafs.size).toBe(0);
    h.render({ revision: 2 }); renderer.failNext = true;
    [...h.intervals.values()][0](); h.render();
    expect(h.canvasProps()["data-error"]).toBe("artificial draw failure");
    h.render({ revision: 3 }); [...h.intervals.values()][0](); h.render();
    expect(h.canvasProps()["data-error"]).toBe("");
    expect(h.canvasProps()["data-draw-count"]).toBe(2);
    h.unmount(); expect(h.intervals.size).toBe(0);
  });
}
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

function ownerHarness() {
  const text = readFileSync(new URL("./baseline13-driver.mjs", import.meta.url), "utf8");
  const source = text.slice(text.indexOf("function installResourceObserver("), text.indexOf("async function browserGroup("));
  let path = "/@vite/client", id = 0, reused: number | undefined, noStack = false, oversized = false;
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  const nativeSet = vi.fn((fn: (...args: unknown[]) => void) => {
    const next = reused ?? ++id; reused = undefined; callbacks.set(next, fn); return next;
  });
  const nativeClear = vi.fn((n: number) => { callbacks.delete(n); });
  const win: Record<string, any> = { location: { origin: new URL("http://127.0.0.1:80").origin },
    setInterval: nativeSet, clearInterval: nativeClear, clearTimeout: nativeClear,
    requestAnimationFrame: () => ++id, cancelAnimationFrame: vi.fn() };
  class Stack {
    stack = noStack ? undefined : oversized ? "x".repeat(8193) :
      `Error\n at provenance (orderflow-resource-observer.js:1:1)\n at caller (http://127.0.0.1:80${path}:123:4)`;
  }
  runInNewContext(`(${source})()`, { window: win, Error: Stack, URL });
  return { win, observer: win.__b2resources, nativeSet, nativeClear, callbacks,
    path: (value: string) => { path = value; }, noStack: () => { noStack = true; },
    oversized: () => { oversized = true; }, reuse: (value: number) => { reused = value; } };
}
it("same pre-start Vite interval remains background, without cancelling or running it", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness(), fn = vi.fn();
  const background = h.win.setInterval(fn, 30000, "native argument");
  h.observer.beginSession(1); h.path("/src/lib/mockAnalysisSession.ts?t=ignored");
  const owned = h.win.setInterval(fn, 300); h.win.clearInterval(owned);
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("PASS");
  expect(h.observer.ownership().records[0]).toMatchObject({ owner: "BACKGROUND", source: "/@vite/client",
    sameInitialIdentity: true, createdBeforeFirstStart: true, nativeId: background });
  expect(h.callbacks.has(background)).toBe(true); expect(fn).not.toHaveBeenCalled();
  expect(h.nativeSet.mock.calls[0]).toEqual([fn, 30000, "native argument"]);
  h.observer.dispose(); expect(h.callbacks.has(background)).toBe(true);
});
it.each([["/src/lib/mockAnalysisSession.ts", "SESSION"], ["/src/hooks/useMockAnalysisSession.ts", "APP"]])(
  "%s remaining interval is FAIL, not a background allowance", async (path, owner) => {
    const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
    h.observer.beginSession(1); h.path(path); h.win.setInterval(() => {}, 250);
    expect(h.observer.ownership().records[0]).toMatchObject({ owner, session: 1, createdBeforeFirstStart: false });
    expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership())).toMatchObject({
      status: "FAIL", reason: "OWNED_INTERVAL_REMAINING" });
  });
it("unknown source is HOLD even if its interval has already been cleared", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  h.observer.beginSession(1); h.path("/unclassified/module.js?key=do-not-store");
  const id = h.win.setInterval(() => {}, 1);
  expect(h.observer.ownership().records[0].source).toBe("/unclassified/module.js");
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
  h.win.clearInterval(id);
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
  expect(JSON.stringify(h.observer.ownership())).not.toContain("do-not-store");
});
it("post-start Vite interval and a reused native ID are not the original background identity", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  const first = h.win.setInterval(() => {}, 30000); h.observer.beginSession(1);
  const oldToken = h.observer.ownership().records[0].token;
  h.win.clearTimeout(first); h.reuse(first); h.win.setInterval(() => {}, 30000);
  expect(h.observer.ownership().records[0].token).not.toBe(oldToken);
  expect(h.observer.ownership().records[0]).toMatchObject({ nativeId: first, owner: "UNKNOWN", sameInitialIdentity: false });
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
});
it("start timing alone never classifies an unknown pre-start interval as background", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  h.path("/third-party.js"); h.win.setInterval(() => {}, 1); h.observer.beginSession(1);
  expect(h.observer.ownership().records[0].createdBeforeFirstStart).toBe(true);
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
});
it.each(["missing", "oversized"])("unavailable bounded provenance (%s) is HOLD", async mode => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  h.observer.beginSession(1); if (mode === "missing") h.noStack(); else h.oversized();
  h.win.setInterval(() => {}, 1);
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
  expect(h.observer.ownership().records[0].source).toBeNull();
});
it("observation overflow is explicit, bounded and does not suppress native interval execution", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  h.observer.beginSession(1); h.path("/src/lib/mockAnalysisSession.ts");
  const ids = Array.from({ length: 65 }, () => h.win.setInterval(() => {}, 1));
  expect(h.nativeSet).toHaveBeenCalledTimes(65); expect(h.callbacks.size).toBe(65);
  expect(h.observer.ownership()).toMatchObject({ limited: true, unrecorded: 1 });
  expect(h.observer.ownership().records).toHaveLength(64);
  for (const id of ids) h.win.clearInterval(id);
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
});
it("restart ownership generations, shared clearTimeout IDs and defensive snapshots are retained", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  h.win.setInterval(() => {}, 30000); h.observer.beginSession(1); h.path("/src/hooks/useMockAnalysisSession.ts");
  const first = h.win.setInterval(() => {}, 250); h.win.clearTimeout(first);
  h.observer.beginSession(2); const second = h.win.setInterval(() => {}, 250);
  expect(h.observer.ownership().records.find((r: { owner: string }) => r.owner === "APP").session).toBe(2);
  h.win.clearInterval(second);
  h.observer.ownership().initial[0].source = "/forged";
  expect(h.observer.ownership().initial[0].source).toBe("/@vite/client");
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("PASS");
});
it("release without a recorded baseline or with unmatched identities is HOLD", async () => {
  const { resourceReleaseGate } = await import(driverUrl), h = ownerHarness();
  expect(resourceReleaseGate(h.observer.snapshot(), h.observer.ownership()).status).toBe("HOLD");
  h.win.setInterval(() => {}, 30000); h.observer.beginSession(1);
  const changed = h.observer.ownership(); changed.initial[0].token++;
  expect(resourceReleaseGate(h.observer.snapshot(), changed).status).toBe("HOLD");
  expect(resourceReleaseGate({ intervals: 999, raf: 0 }, h.observer.ownership()).status).toBe("HOLD");
});

// E1 protocol tests use synthetic runners, never Chromium or market input.
function evidenceRow(revision = 1, stage = "ingest") {
  return { stage, at: 10, ms: .25, revision, seq: revision, layer: "session", a: 5, b: 8, c: 1 };
}

// D1: only injected operations/fake time. Never launch Chromium or send an OS signal.
function terminationHarness(options: { stuck?: boolean; groupResidual?: boolean; killFails?: boolean;
  unknown?: boolean; reuse?: boolean; foreign?: boolean; membershipChange?: boolean } = {}) {
  const started = { pid: 400, ppid: 20, pgid: 400, sid: 400, startTicks: "100", uid: 1000, state: "S" };
  const child = { ...started, pid: 401, ppid: 400, startTicks: "101" };
  let processes = [started, child], exited = false, inspections = 0;
  const calls: string[] = [];
  const io = {
    close: vi.fn(async () => {
      calls.push("close");
      if (options.stuck) throw Error("synthetic close failure");
      exited = true; processes = options.groupResidual ? [child] : [];
    }),
    exited: () => exited,
    holdsLeader: () => !exited,
    waitExit: vi.fn(async () => { calls.push("grace"); }),
    inspect: vi.fn(async () => {
      calls.push("inspect"); inspections++;
      if (options.unknown) throw Error("synthetic unreadable metadata");
      let current = processes;
      if (options.reuse) current = current.map(p => ({ ...p, startTicks: "900" }));
      if (options.foreign) current = [...current, { ...child, pid: 402, ppid: 99 }];
      if (options.membershipChange && inspections === 2) current = [...current, { ...child, pid: 403 }];
      return { processes: current, live: current.map(p => p.pid), zombies: [] };
    }),
    signal: vi.fn((_target: number, _signal: string) => {
      calls.push("signal");
      if (options.killFails) throw Error("synthetic denied signal");
      processes = []; exited = true;
    }),
    recover: vi.fn(async () => { calls.push("recover"); }),
  };
  return { io, started, calls };
}

it("D1 normal close preserves PASS, is single-flight, and does not signal", async () => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness();
  const c = createBrowserTermination(h.io, { trialId: "cells128-1-control", started: h.started });
  const a = c.finish(); expect(c.finish()).toBe(a);
  expect(await a).toMatchObject({ status: "PASS", liveAfter: 0, zombiesAfter: 0,
    signal: { attempted: false }, close: "OK" });
  expect(h.io.close).toHaveBeenCalledTimes(1); expect(h.io.signal).not.toHaveBeenCalled();
});
it("D1 wall expiry records FAIL before close and keeps FAIL even after graceful success", async () => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness();
  const c = createBrowserTermination(h.io, { trialId: "wall", started: h.started });
  const done = c.wallTimeout(); expect(c.expired()).toBe(true);
  expect(await done).toMatchObject({ status: "FAIL", reason: "BROWSER_WALL_TIMEOUT",
    paths: ["WALL_TIMEOUT"], close: "OK", liveAfter: 0, subsequentTrial: "BLOCKED" });
  expect(h.calls).toEqual(["close", "inspect"]); expect(h.io.signal).not.toHaveBeenCalled();
});
it.each(["wall", "close"])("D1 %s failure waits, verifies twice, signals only the owned group, and remains FAIL", async path => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness({ stuck: true });
  const c = createBrowserTermination(h.io, { trialId: path, started: h.started });
  const result = await (path === "wall" ? c.wallTimeout() : c.finish());
  expect(result).toMatchObject({ status: "FAIL", close: "ERROR", grace: "EXPIRED",
    ownership: { status: "PASS" }, signal: { attempted: true, result: "SENT" }, liveAfter: 0,
    subsequentTrial: "BLOCKED" });
  expect(h.io.signal).toHaveBeenCalledExactlyOnceWith(-400, "SIGKILL");
  expect(h.calls).toEqual(["close", "grace", "inspect", "inspect", "signal", "recover", "inspect"]);
});
it("D1 remaining descendants after leader exit are FAIL and cannot authorize a group signal", async () => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness({ groupResidual: true });
  const result = await createBrowserTermination(h.io, { trialId: "group", started: h.started }).finish();
  expect(result).toMatchObject({ status: "FAIL", paths: ["GROUP_RESIDUAL", "REMAINDER"],
    ownership: { status: "FAIL", reason: "LEADER_NOT_VERIFIABLE" }, liveAfter: 1 });
  expect(h.io.signal).not.toHaveBeenCalled();
});
it.each(["unknown", "reuse", "foreign", "membershipChange"])("D1 %s ownership cannot authorize SIGKILL", async kind => {
  const { createBrowserTermination } = await import(driverUrl);
  const h = terminationHarness({ stuck: true, [kind]: true });
  const result = await createBrowserTermination(h.io, { trialId: kind, started: h.started }).finish();
  expect(result.status).toBe("FAIL"); expect(result.ownership.status).toBe("FAIL");
  expect(h.io.signal).not.toHaveBeenCalled(); expect(result.signal.attempted).toBe(false);
});
it("D1 independently detects PID, PGID, session reuse, orphaned and ambiguous identities", async () => {
  const { verifyBrowserOwnership } = await import(driverUrl), h = terminationHarness();
  const s = await h.io.inspect();
  expect(verifyBrowserOwnership(h.started, s).status).toBe("PASS");
  for (const key of ["startTicks", "pgid", "sid", "uid"]) {
    const modified = structuredClone(s);
    (modified.processes[0] as any)[key] = key === "startTicks" ? "200" : 999;
    expect(verifyBrowserOwnership(h.started, modified).status).toBe("FAIL");
  }
  expect(verifyBrowserOwnership(null, s).status).toBe("FAIL");
  expect(verifyBrowserOwnership(h.started, { ...s, processes: [s.processes[1]] }).status).toBe("FAIL");
  expect(verifyBrowserOwnership(h.started, { ...s, live: [400, 400] }).status).toBe("FAIL");
  expect(verifyBrowserOwnership(h.started, { ...s, processes: [...s.processes, s.processes[0]] }).status).toBe("FAIL");
});
it("D1 release of the spawning ChildProcess between metadata checks and signal denies SIGKILL", async () => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness({ stuck: true });
  h.io.holdsLeader = () => false;
  const result = await createBrowserTermination(h.io, { trialId: "released", started: h.started }).finish();
  expect(result).toMatchObject({ status: "FAIL",
    ownership: { status: "FAIL", reason: "LEADER_IDENTITY_RELEASED" }, signal: { attempted: false } });
  expect(h.io.signal).not.toHaveBeenCalled();
});
it("D1 failed recovery or denied signal never changes FAIL to PASS", async () => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness({ stuck: true, killFails: true });
  const result = await createBrowserTermination(h.io, { trialId: "denied", started: h.started }).finish();
  expect(result).toMatchObject({ status: "FAIL", signal: { attempted: true, result: "ERROR" }, liveAfter: 2 });
});
it("D1 unavailable close, exit, inspection and recovery operations have finite deadlines", async () => {
  const { createBrowserTermination } = await import(driverUrl);
  vi.useFakeTimers();
  const never = () => new Promise(() => {});
  const h = terminationHarness({ stuck: true });
  h.io.close.mockImplementation(never as any); h.io.waitExit.mockImplementation(never as any);
  h.io.recover.mockImplementation(never as any); h.io.signal.mockImplementation(() => {});
  const done = createBrowserTermination(h.io, { trialId: "bounded", started: h.started,
    closeMs: 10, graceMs: 2, inspectMs: 2, recoveryMs: 2 }).wallTimeout();
  await vi.runAllTimersAsync();
  expect(await done).toMatchObject({ status: "FAIL", close: "TIMEOUT", grace: "EXPIRED",
    recovery: "TIMEOUT", liveAfter: 2, signal: { attempted: true } });
  expect(vi.getTimerCount()).toBe(0);
  h.io.inspect.mockImplementation(never as any);
  const unknown = createBrowserTermination(h.io, { trialId: "unknown", started: h.started,
    closeMs: 10, graceMs: 2, inspectMs: 2 }).finish();
  await vi.runAllTimersAsync();
  expect(await unknown).toMatchObject({ status: "FAIL", liveAfter: null,
    ownership: { status: "FAIL", reason: "OWNERSHIP_UNKNOWN" } });
  expect(vi.getTimerCount()).toBe(0);
});
it("D1 timeout during an existing normal shutdown uses one close and permanently invalidates it", async () => {
  const { createBrowserTermination } = await import(driverUrl), h = terminationHarness();
  let release!: () => void;
  const original = h.io.close.getMockImplementation()!;
  h.io.close.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); await original(); });
  const c = createBrowserTermination(h.io, { trialId: "race", started: h.started });
  const done = c.finish(); await Promise.resolve();
  expect(c.wallTimeout()).toBe(done); release();
  expect((await done).status).toBe("FAIL"); expect(h.io.close).toHaveBeenCalledTimes(1);
});
it("D1 forced cleanup fails validation, preserves diagnostics losslessly, and prevents the next formal job", async () => {
  const { createBrowserTermination, comparisonPlan, executeComparison, validateFormalTrial,
    boundedEvidence, decodeEvidence } = await import(driverUrl);
  let attempts = 0;
  const saved: any[] = [];
  const baseline = (await syntheticE2()).baseline;
  const report = await executeComparison(comparisonPlan("both", "formal"), async (job: any) => {
    attempts++; const h = terminationHarness({ stuck: true });
    const termination = await createBrowserTermination(h.io, { trialId: job.id, started: h.started }).finish();
    const trial = { ...protocolTrial(job), termination };
    expect(() => validateFormalTrial(trial, job, baseline)).toThrow("BROWSER_TERMINATION_FAILED");
    const error: any = Error(termination.reason); error.partialResult = trial; throw error;
  }, async (r: any) => { saved.push(decodeEvidence(boundedEvidence(r).trim()).value); }, baseline);
  expect(attempts).toBe(1); expect(report.status).toBe("HOLD"); expect(saved).toHaveLength(1);
  const t = saved[0].runs[0];
  expect(t).toMatchObject({ failed: true, termination: { trialId: "cells128-1-control",
    status: "FAIL", subsequentTrial: "BLOCKED", signal: { attempted: true, result: "SENT" } } });
  expect(Buffer.byteLength(JSON.stringify(t.termination))).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(boundedEvidence(saved[0]))).toBeLessThanOrEqual(2 * 1024 * 1024);
});
it("D1 startup identity is copied, missing identity is FAIL, and malformed observations never authorize signaling", async () => {
  const { createBrowserTermination, verifyBrowserOwnership } = await import(driverUrl);
  const h = terminationHarness(), c = createBrowserTermination(h.io, { trialId: "copy", started: h.started });
  h.started.startTicks = "999";
  expect((await c.finish()).started.startTicks).toBe("100");
  const missing = terminationHarness();
  const result = await createBrowserTermination(missing.io, { trialId: "missing", started: null }).finish();
  expect(result).toMatchObject({ status: "FAIL", reason: "START_IDENTITY_UNVERIFIED", liveAfter: 0 });
  expect(missing.io.signal).not.toHaveBeenCalled();
  expect(verifyBrowserOwnership(h.started, { processes: [null], live: [400] }).status).toBe("FAIL");
  expect(() => createBrowserTermination(h.io, { trialId: "x".repeat(97), started: h.started }))
    .toThrow("TERMINATION_TRIAL_ID_LIMIT");
});
it("D1 browser wiring has only the ownership-gated signal and routes wall/cleanup failures into stop diagnostics", () => {
  const text = readFileSync(new URL("./baseline13-driver.mjs", import.meta.url), "utf8");
  expect(text.match(/process\.kill\(/g)).toHaveLength(1);
  expect(text).toContain('signal: (pid, signal) => process.kill(pid, signal)');
  expect(text).toContain('termination.wallTimeout()');
  expect(text).toContain('const error = Error(ended.reason)');
  expect(text).toContain('chromiumCleanup: { ...cleanup, profile: dir }, termination: ended');
  expect(text).toContain('if (ended.liveAfter === 0 && ended.zombiesAfter === 0)');
});

function protocolTrial(job: { workload: string; mode: string; repetition: number }) {
  const vertices = job.workload === "cells128" ? 768 : 3072;
  const counters = { draws: 1, vertices, uploads: 1, bytes: vertices * 32, buffers: 2, deletes: 2,
    errors: 0, loss: 0, restore: 0, contexts: 1, errorChecks: 1,
    cpuMs: job.mode === "on" ? 1 : "UNKNOWN" };
  return { ...job, chromium: "SYNTHETIC Chromium", gpu: { webgl2: true, renderer: "SYNTHETIC SwiftShader" },
    completionLimitMs: 44400, browserLimitMs: 59400, completionObservedMs: 38000,
    counts: { inputs: 128, accepted: 128, duplicate: 0, rejected: 0 }, revision: 128,
    layerRevisions: [128, 128, 128, 128, 128, 128], golden: Array.from({ length: 8 }, () => ({ ok: true })),
    meaningHash: (job.workload === "cells128" ? "a" : "b").repeat(64),
    meaningEncoding: { wireBytes: 64043, version: job.workload === "cells128" ? 2 : 3 },
    inspection: { summary: { cellCount: job.workload === "cells128" ? 128 : 512,
      scope: { environment: "MOCK", sourceId: `SYNTHETIC-${job.workload}`, sessionId: "SYNTHETIC-SESSION" } } },
    progress: { status: { sourceInputs: 128 } },
    afterReleaseGate: { status: "PASS" }, afterReleaseGL: { heatmap: { ...counters }, bubble: { ...counters } },
    chromiumCleanup: { live: [], zombies: [], profileRemoved: true },
    viewport: { source: `SYNTHETIC fixture ${job.workload}`,
      viewport: { dpr: 1, bounds: { width: 403, height: 324 }, time: { minNs: "0", maxNs: "8" },
      price: { minTick: 79998, maxTick: 80067 } },
      heatmap: { width: 403, height: 324, status: "READY", rects: job.workload === "cells128" ? 128 : 512,
        minNs: "0", maxNs: "8" },
      bubble: { width: 403, height: 324, status: "READY", vertices: 24 } },
    gl: { version: job.mode === "on" ? 2 : 0, observation: job.mode === "on" ? "PERFORMANCE_OBSERVER" : "OFF_SAFETY_ONLY",
      limited: false, unrecordedApiCalls: 0, totals: { heatmap: { ...counters }, bubble: { ...counters } },
      lastDraws: { heatmap: { revision: 128, vertices }, bubble: { revision: 128, vertices: 24 } }, frames: [] },
    telemetry: job.mode === "on" ? { sessionId: 1, records: 1, allocatedBytes: 147456,
      saturated: false, dropped: 0, rows: [evidenceRow()], receipts: [] } : null };
}
// Portable artificial E2-shaped evidence; the pristine anchor is outside all mutable files.
async function syntheticE2(mutate?: (runs: any[]) => void) {
  const d = await import(driverUrl), root = ".local/diagnostics/task28-b2-b2-e2";
  const plan = d.comparisonPlan("both", "formal"), runs = plan.map(protocolTrial);
  mutate?.(runs);
  const files = new Map<string, string>(), refs: any[] = [];
  for (const [i, job] of plan.entries()) {
    const file = `${job.id}-completed.json`, wire = d.boundedEvidence({ job, trial: runs[i], failure: null });
    files.set(`${root}/formal.json.trials/${file}`, wire);
    refs.push({ file, bytes: Buffer.byteLength(wire), sha256: createHash("sha256").update(wire).digest("hex") });
  }
  files.set(`${root}/formal.json`, d.boundedEvidence({
    phase: "formal", plan, runs, failure: null, status: "PASS", trialFiles: refs }));
  for (const p of ["analysis.json", "driver.log", "environment-observations.json", "launch-and-exit.log", "report.md", "timings.csv"])
    files.set(`${root}/${p}`, p.endsWith(".json") ? "{}" : "SYNTHETIC ONLY\n");
  const manifest = { status: "PASS", fixture: { inputs: 128, intervalMs: 300, cases: ["cells128", "cells512"] },
    observed: { chromium: runs[0].chromium, renderer: runs[0].gpu.renderer, dpr: 1, webgl2: true },
    node: "SYNTHETIC NODE", cpu: "SYNTHETIC CPU", logicalCpu: 8, cpuMax: "800000 100000",
    memoryMax: "17179869184", e2Files: Object.fromEntries([...files].map(([p, text]) =>
      [p, createHash("sha256").update(text).digest("hex")])) };
  const wire = JSON.stringify(manifest), anchor = createHash("sha256").update(wire).digest("hex");
  return { ...d, files, manifest, wire, anchor, root, plan, runs,
    baseline: d.verifyE2Evidence(wire, files, anchor) };
}

it.each(["cells128", "cells512"].flatMap(workload => [1, 2, 3].flatMap(repetition =>
  ["control", "on"].map(mode => ({ workload, repetition, mode })))))
("D3 $workload $mode repetition $repetition requires the independently verified fixed hash", async job => {
  const s = await syntheticE2(), t = protocolTrial(job);
  expect(() => s.validateFormalTrial(t, job, s.baseline)).not.toThrow();
  t.meaningHash = "c".repeat(64);
  expect(() => s.validateFormalTrial(t, job, s.baseline)).toThrow("E2_FIXED_HASH_MISMATCH");
});

const badE2Conditions: [string, (t: any) => void][] = [
  ["Chrome", t => { t.chromium = "Chrome/0.0.0.0"; }],
  ["renderer exact spelling", t => { t.gpu.renderer += " "; }],
  ["WebGL2", t => { t.gpu.webgl2 = false; }],
  ["DPR", t => { t.viewport.viewport.dpr = 2; }],
  ["Canvas width", t => { t.viewport.heatmap.width = 404; }],
  ["Canvas height", t => { t.viewport.bubble.height = 325; }],
  ["fixture description", t => { t.viewport.source = "different fixture"; }],
  ["session", t => { t.inspection.summary.scope.sessionId = "different"; }],
  ["query time", t => { t.viewport.viewport.time.maxNs = "9"; }],
  ["query price", t => { t.viewport.viewport.price.maxTick++; }],
  ["drawn query range", t => { t.viewport.heatmap.maxNs = "9"; }],
  ["cell count", t => { t.inspection.summary.cellCount++; }],
  ["drawn cell count", t => { t.viewport.heatmap.rects++; }],
  ["input count", t => { t.progress.status.sourceInputs = 127; }],
  ["input cadence policy", t => { t.completionLimitMs++; }],
  ["wire query encoding", t => { t.meaningEncoding.version = 99; }],
  ["mode", t => { t.mode = "different"; }],
  ["revision", t => { t.layerRevisions[5] = 127; }],
];
it.each(badE2Conditions)("D3 rejects nonbaseline %s, even when the semantic hash is unchanged", async (_name, mutate) => {
  const s = await syntheticE2(), t = protocolTrial(s.plan[0]);
  mutate(t);
  expect(() => s.validateFormalTrial(t, s.plan[0], s.baseline)).toThrow();
});

it("D3 the same wrong hash for all future repetitions fails the first job and saves all failed evidence", async () => {
  const s = await syntheticE2(), seen: any[] = [], saved: any[] = [];
  const r = await s.executeComparison(s.plan, async (job: any) => {
    seen.push(job); return { ...protocolTrial(job), meaningHash: "f".repeat(64) };
  }, async (report: any) => { saved.push(s.decodeEvidence(s.boundedEvidence(report).trim()).value); }, s.baseline);
  expect(seen).toHaveLength(1);
  expect(r.status).toBe("HOLD"); expect(r.failure).toContain("E2_FIXED_HASH_MISMATCH");
  expect(saved[0].runs[0]).toMatchObject({ failed: true, meaningHash: "f".repeat(64) });
  expect(saved[0].e2Reference.manifestSha256).toBe(s.anchor);
});
it("D3 rejects missing or cloned/unverified baselines before starting any trial", async () => {
  const s = await syntheticE2(), run = vi.fn(), save = vi.fn();
  await expect(s.executeComparison(s.plan, run, save)).rejects.toThrow("E2_BASELINE_UNVERIFIED_HOLD");
  await expect(s.executeComparison(s.plan, run, save, structuredClone(s.baseline))).rejects.toThrow("E2_BASELINE_UNVERIFIED_HOLD");
  expect(run).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(Object.isFrozen(s.baseline.trials[s.plan[0].id].conditions.scope)).toBe(true);
});
it("D3 missing manifest or required reference file is HOLD, with no reader fallback", async () => {
  const s = await syntheticE2(), read = vi.fn(async () => { throw Object.assign(Error(), { code: "ENOENT" }); });
  await expect(s.loadE2Baseline(read)).rejects.toThrow("E2_BASELINE_LOAD_OR_VERIFY_HOLD");
  expect(read).toHaveBeenCalledTimes(1);
  const missing = new Map(s.files); missing.delete(`${s.root}/formal.json`);
  expect(() => s.verifyE2Evidence(s.wire, missing, s.anchor)).toThrow("E2_FILES_MISSING_HOLD");
});
it("D3 independently pinned manifest rejects coordinated file/checksum tampering", async () => {
  const s = await syntheticE2(), files = new Map(s.files);
  files.set(`${s.root}/driver.log`, "tampered");
  expect(() => s.verifyE2Evidence(s.wire, files, s.anchor)).toThrow("E2_FILE_INTEGRITY_HOLD");
  const m = structuredClone(s.manifest);
  m.e2Files[`${s.root}/driver.log`] = createHash("sha256").update("tampered").digest("hex");
  expect(() => s.verifyE2Evidence(JSON.stringify(m), files, s.anchor)).toThrow("E2_MANIFEST_TRUST_HOLD");
});
it("D3 authenticated but inconsistent reference hashes/schema cannot become a baseline", async () => {
  await expect(syntheticE2(r => { r[1].meaningHash = "c".repeat(64); })).rejects.toThrow("E2_HASH_INCONSISTENT_HOLD");
  await expect(syntheticE2(r => { r[0].meaningHash = "invalid"; })).rejects.toThrow("MISSING_HASH");
  await expect(syntheticE2(r => { r[0].inspection.summary.cellCount = 1; })).rejects.toThrow("E2_CELL_COUNT_HOLD");
  await expect(syntheticE2(r => { r[1].viewport.viewport.dpr = 2; })).rejects.toThrow("E2_ENVIRONMENT_INCONSISTENT_HOLD");
});
it("D3 reference file schema and per-trial/aggregate mismatch are rejected even with valid outer checksums", async () => {
  const s = await syntheticE2();
  const verifyReanchored = (files: Map<string, string>) => {
    // Represents malformed evidence signed by an independent synthetic publisher;
    // it tests schema/cross-file validation, not production anchor substitution.
    const manifest = structuredClone(s.manifest);
    manifest.e2Files = Object.fromEntries([...files].map(([p, b]) => [p, createHash("sha256").update(b).digest("hex")]));
    const text = JSON.stringify(manifest), anchor = createHash("sha256").update(text).digest("hex");
    return s.verifyE2Evidence(text, files, anchor);
  };
  const broken = new Map<string, string>(s.files); broken.set(`${s.root}/formal.json`, "{");
  expect(() => verifyReanchored(broken)).toThrow();
  const files = new Map<string, string>(s.files), aggregate = s.decodeEvidence(files.get(`${s.root}/formal.json`)!.trim()).value;
  const ref = aggregate.trialFiles[0], p = `${s.root}/formal.json.trials/${ref.file}`;
  const child = s.decodeEvidence(files.get(p)!.trim()).value; child.trial.revision = 127;
  const wire = s.boundedEvidence(child);
  files.set(p, wire); ref.bytes = Buffer.byteLength(wire); ref.sha256 = createHash("sha256").update(wire).digest("hex");
  files.set(`${s.root}/formal.json`, s.boundedEvidence(aggregate));
  expect(() => verifyReanchored(files)).toThrow("E2_TRIAL_AGGREGATE_HOLD");
});
it("D3 retains the 2MiB bound without dropping records or accepting an oversized reference", async () => {
  const s = await syntheticE2(), files = new Map(s.files);
  files.set(`${s.root}/driver.log`, "x".repeat(2 * 1024 * 1024 + 1));
  expect(() => s.verifyE2Evidence(s.wire, files, s.anchor)).toThrow("E2_FILE_MISSING_OR_LIMIT_HOLD");
  const r = await s.executeComparison(s.plan, async (job: any) => protocolTrial(job), async () => {}, s.baseline);
  const wire = s.boundedEvidence(r), decoded = s.decodeEvidence(wire.trim(), r);
  expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(decoded.value.runs).toHaveLength(12);
  expect(decoded.value.runs.map((t: any) => t.telemetry?.records)).toEqual(r.runs.map((t: any) => t.telemetry?.records));
  expect(decoded.value.e2Reference.manifestSha256).toBe(s.anchor);
});
it("D3 production wiring loads its trusted baseline before any browser and preserves D1 finally cleanup", () => {
  const source = readFileSync(new URL("./baseline13-driver.mjs", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function formalComparison("), source.indexOf("export function browserCasePolicy("));
  expect(fn.indexOf("await loadE2Baseline()")).toBeLessThan(fn.indexOf("return browserRun("));
  expect(fn).toContain('failure: "E2_BASELINE_OR_EXTERNAL_PREFLIGHT_HOLD", browsersStarted: 0');
  expect(fn).toContain("validateE2ExternalEnvironment(baseline,");
  expect(fn).toContain('capacityOnly(undefined, true)');
  expect(fn).toContain("reference, baseline)");
  expect(source).toContain("try { ended = await termination.finish(); } finally { clearTimeout(hardStop); }");
  expect(source).toContain('if (ended.status === "FAIL")');
});
it("D3 startup/external environment are exact matches and cells512 independent verification stays required", async () => {
  const s = await syntheticE2(), t = s.runs[0];
  expect(() => s.validateE2BrowserStartup(t.chromium, t.gpu, 1, s.baseline)).not.toThrow();
  expect(() => s.validateE2BrowserStartup(t.chromium + " ", t.gpu, 1, s.baseline)).toThrow("E2_CHROME_MISMATCH");
  expect(() => s.validateE2BrowserStartup(t.chromium, { ...t.gpu, renderer: t.gpu.renderer + " " }, 1, s.baseline))
    .toThrow("E2_GPU_MISMATCH");
  expect(() => s.validateE2BrowserStartup(t.chromium, t.gpu, 2, s.baseline)).toThrow("E2_DPR_MISMATCH");
  expect(() => s.validateE2ExternalEnvironment(s.baseline, { ...s.baseline.external })).not.toThrow();
  for (const field of ["cpu", "cpuMax", "logicalCpu", "memoryMax", "node"])
    expect(() => s.validateE2ExternalEnvironment(s.baseline, { ...s.baseline.external, [field]: "UNKNOWN" }))
      .toThrow("E2_EXTERNAL_ENVIRONMENT_MISMATCH_HOLD");
  expect(() => s.resolveBrowserMeaning("cells512", "{}", undefined)).toThrow("MISSING_INDEPENDENT_LEGACY_REFERENCE");
});
it("D3 condition, revision, fixed hash, then safety gates run in order without skipping failure checkpoint", async () => {
  const s = await syntheticE2(), t = protocolTrial(s.plan[0]);
  t.meaningHash = "d".repeat(64); t.afterReleaseGate.status = "FAIL";
  t.viewport.viewport.dpr = 2;
  expect(() => s.validateFormalTrial(t, s.plan[0], s.baseline)).toThrow("COMPARISON_ENVIRONMENT_MISMATCH");
  t.viewport.viewport.dpr = 1; t.revision = 0;
  expect(() => s.validateFormalTrial(t, s.plan[0], s.baseline)).not.toThrow("E2_FIXED_HASH_MISMATCH");
  t.revision = 128;
  expect(() => s.validateFormalTrial(t, s.plan[0], s.baseline)).toThrow("E2_FIXED_HASH_MISMATCH");
  t.meaningHash = s.runs[0].meaningHash;
  expect(() => s.validateFormalTrial(t, s.plan[0], s.baseline)).toThrow("RESOURCE_GATE");
});
it("formal whitelist fixes 12 trials while all three preflights retain one OFF/ON pair", async () => {
  const { comparisonPlan, browserCasePolicy } = await import(driverUrl);
  expect(comparisonPlan("both", "formal").map((j: { id: string }) => j.id)).toEqual(
    ["cells128", "cells512"].flatMap(w => [1, 2, 3].flatMap(r => ["control", "on"].map(m => `${w}-${r}-${m}`))));
  for (const w of ["baseline13", "cells128", "cells512"]) {
    expect(comparisonPlan(w, "preflight").map((j: { mode: string }) => j.mode)).toEqual(["control", "on"]);
    expect(browserCasePolicy(w).version).toBe(w === "baseline13" ? 1 : w === "cells128" ? 2 : 3);
    expect(() => comparisonPlan(w, "formal")).toThrow("FORMAL_REQUIRES_BOTH_CASES");
  }
  expect(() => comparisonPlan("both", "preflight")).toThrow();
  expect(() => comparisonPlan("cells128", "other")).toThrow("COMPARISON_PHASE");
});
it("synthetic formal runner creates 12 distinct trials with checkpoints and no retry", async () => {
  const { comparisonPlan, executeComparison } = await import(driverUrl);
  const plan = comparisonPlan("both", "formal"), calls: unknown[] = [], checkpoints: unknown[] = [];
  const r = await executeComparison(plan, async (job: any) => {
    calls.push(job); return protocolTrial(job);
  }, async (_r: unknown, trial: unknown) => { checkpoints.push(trial); }, (await syntheticE2()).baseline);
  expect(r.status).toBe("PASS"); expect(r.failure).toBeNull();
  expect(calls).toHaveLength(12); expect(new Set(calls).size).toBe(12);
  expect(new Set(r.runs).size).toBe(12); expect(checkpoints).toEqual(r.runs);
  await expect(executeComparison(plan.slice(1), vi.fn(), vi.fn())).rejects.toThrow("FORMAL_PLAN_INVALID");
});
it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
  "failure/UNKNOWN/capacity at trial %i stops the plan with preserved evidence", async at => {
    const { comparisonPlan, executeComparison } = await import(driverUrl);
    for (const failure of ["throw", "unknown", "capacity"]) {
      let calls = 0; const evidence: any[] = [];
      const r = await executeComparison(comparisonPlan("both", "formal"), async (job: any) => {
        calls++;
        if (calls === at && failure === "throw") throw Object.assign(Error("ARTIFICIAL_FAILURE"), {
          partialResult: { diagnosticMarker: "partial-evidence" } });
        const t: any = protocolTrial(job);
        if (calls === at && failure === "unknown") t.afterReleaseGate.status = "HOLD";
        return t;
      }, async (report: any, trial: any) => {
        if (calls === at && failure === "capacity" && !report.failure) throw Error("REPORT_SIZE_LIMIT");
        evidence.push({ trial: JSON.parse(JSON.stringify(trial)), failure: report.failure });
      }, (await syntheticE2()).baseline);
      expect(calls).toBe(at); expect(r.runs).toHaveLength(at); expect(r.status).toBe("HOLD");
      expect(r.runs.at(-1).failed).toBe(true); expect(evidence.at(-1).failure).toBeTruthy();
      if (at <= 6) expect(r.runs.every((v: any) => v.workload === "cells128")).toBe(true);
      if (failure === "throw") expect(r.runs.at(-1).diagnosticMarker).toBe("partial-evidence");
    }
  });
it("environment mismatch and missing trials stop instead of silently proceeding", async () => {
  const { comparisonPlan, executeComparison } = await import(driverUrl);
  let count = 0;
  const r = await executeComparison(comparisonPlan("both", "formal"), async (job: any) => {
    const t = protocolTrial(job); if (++count === 2) t.viewport.viewport.dpr = 2; return t;
  }, async () => {}, (await syntheticE2()).baseline);
  expect(count).toBe(2); expect(r.failure).toContain("COMPARISON_ENVIRONMENT_MISMATCH");
  const missing = await executeComparison(comparisonPlan("both", "formal"), async () => undefined, async () => {},
    (await syntheticE2()).baseline);
  expect(missing.runs).toHaveLength(1); expect(missing.failure).toContain("MISSING_TRIAL");
});
it.each(["cells128", "cells512"])("%s requires owned-resource PASS and OFF safety only", async workload => {
  const { validateFormalTrial } = await import(driverUrl);
  const job = { workload, mode: "control", repetition: 1 }, t: any = protocolTrial(job);
  const baseline = (await syntheticE2()).baseline;
  expect(() => validateFormalTrial(t, job, baseline)).not.toThrow();
  for (const status of ["HOLD", "UNKNOWN", "FAIL"]) {
    t.afterReleaseGate.status = status; expect(() => validateFormalTrial(t, job, baseline)).toThrow("RESOURCE_GATE");
  }
  t.afterReleaseGate.status = "PASS"; t.gl.observation = "PERFORMANCE_OBSERVER";
  expect(() => validateFormalTrial(t, job, baseline)).toThrow("OFF_NOT_SAFETY_ONLY");
});

function evidenceFixture() {
  return { runs: [{ telemetry: { version: 3, allocatedBytes: 147456, rows: [evidenceRow(1), evidenceRow(2)],
    receipts: [{ revision: 1, heatmapAt: 12.5, bubbleAt: null }] } }],
    explicitNull: null, omitted: undefined, encodedQuantity: { bigint: "900719925474099312345" } };
}
it("fixed-schema evidence preserves all normalized fields, order, nulls and SHA", async () => {
  const { encodeEvidence, decodeEvidence, boundedEvidence } = await import(driverUrl);
  const value: any = evidenceFixture(); value.runs[0].telemetry.rows[1].b = null;
  const legacy = JSON.stringify(value), wire = encodeEvidence(value), p = JSON.parse(wire);
  expect(p.version).toBe(1); expect(p.tables[0].count).toBe(2);
  expect(p.tables[0].tuples[1][7]).toBeNull();
  const d = decodeEvidence(wire, value);
  expect(d.text).toBe(legacy); expect(d.value).toEqual(JSON.parse(legacy));
  expect(Object.keys(d.value.runs[0].telemetry.rows[0])).toEqual(p.rowKeys);
  expect(d.sha256).toBe(createHash("sha256").update(legacy).digest("hex"));
  expect(boundedEvidence(value)).toBe(wire + "\n");
});
it.each(["version", "schema", "missing-row", "missing-value", "row-order", "value", "missing-table",
  "duplicate-table", "hash", "bytes", "unknown-envelope"])("evidence rejects %s tampering", async mode => {
  const { encodeEvidence, decodeEvidence } = await import(driverUrl), p = JSON.parse(encodeEvidence(evidenceFixture()));
  if (mode === "version") p.version = 99;
  if (mode === "schema") [p.rowKeys[0], p.rowKeys[1]] = [p.rowKeys[1], p.rowKeys[0]];
  if (mode === "missing-row") p.tables[0].tuples.pop();
  if (mode === "missing-value") p.tables[0].tuples[0].pop();
  if (mode === "row-order") p.tables[0].tuples.reverse();
  if (mode === "value") p.tables[0].tuples[0][2] = null;
  if (mode === "missing-table") p.tables.pop();
  if (mode === "duplicate-table") p.tables.push(p.tables[0]);
  if (mode === "hash") p.sha256 = "0".repeat(64);
  if (mode === "bytes") p.legacyBytes++;
  if (mode === "unknown-envelope") p.extra = 1;
  expect(() => decodeEvidence(JSON.stringify(p))).toThrow();
});
it("coherent forged evidence, unknown row keys and changed field order are rejected", async () => {
  const { encodeEvidence, decodeEvidence } = await import(driverUrl), original = evidenceFixture();
  const altered = evidenceFixture(); altered.runs[0].telemetry.rows.reverse();
  expect(() => decodeEvidence(encodeEvidence(altered), original)).toThrow("EVIDENCE_REFERENCE");
  const unknown: any = evidenceFixture(); unknown.runs[0].telemetry.rows[0].extra = 1;
  expect(() => encodeEvidence(unknown)).toThrow("EVIDENCE_ROW_SCHEMA");
  unknown.runs[0].telemetry.rows[0] = Object.fromEntries(Object.entries(evidenceRow()).reverse());
  expect(() => encodeEvidence(unknown)).toThrow("EVIDENCE_ROW_SCHEMA");
});
it("evidence preserves all tables in encounter order and rejects a permuted table registry", async () => {
  const { encodeEvidence, decodeEvidence } = await import(driverUrl), v = evidenceFixture();
  v.runs.push(evidenceFixture().runs[0]);
  const p = JSON.parse(encodeEvidence(v)); expect(p.tables).toHaveLength(2);
  expect(decodeEvidence(JSON.stringify(p), v).value).toEqual(JSON.parse(JSON.stringify(v)));
  p.tables.reverse();
  expect(() => decodeEvidence(JSON.stringify(p))).toThrow("EVIDENCE_SCHEMA_OR_TABLE_ORDER");
});
it("evidence enforces the exact 2MiB file boundary including newline without truncation", async () => {
  const { boundedEvidence } = await import(driverUrl), v = { padding: "" };
  v.padding = "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(boundedEvidence(v)) - 6);
  for (let i = 0; i < 3; i++) {
    const size = Buffer.byteLength(boundedEvidence(v)); v.padding += "x".repeat(2 * 1024 * 1024 - size);
  }
  expect(Buffer.byteLength(boundedEvidence(v))).toBe(2 * 1024 * 1024);
  v.padding += "x"; expect(() => boundedEvidence(v)).toThrow("REPORT_SIZE_LIMIT");
});
it("statistics distinguish unknown samples, signed timer offsets and initialization", async () => {
  const { timeStats, timingSamples, samplePhase, summarizeRuns } = await import(driverUrl);
  expect(timeStats([4, 1, 3, 2])).toMatchObject({ n: 4, mean: 2.5, median: 2.5, p95: 4, max: 4 });
  expect(timeStats([])).toEqual({ status: "UNKNOWN", n: 0 }); expect(timeStats([-1, 0, 1]).mean).toBe(0);
  expect(() => timeStats([NaN])).toThrow("TIME_SAMPLE");
  expect(samplePhase({ ...evidenceRow(0), stage: "react", c: 0 })).toBe("initialization");
  expect(samplePhase({ ...evidenceRow(128), stage: "react", c: 1 })).toBe("initialization");
  expect(samplePhase(evidenceRow(1))).toBe("steady");
  const t: any = protocolTrial({ workload: "cells128", mode: "on", repetition: 1 });
  t.telemetry.rows = [evidenceRow(0, "frame"), { ...evidenceRow(1, "frame"), a: 1, ms: .1 },
    { ...evidenceRow(1), a: 10, b: 9.9 }];
  const samples = timingSamples([t]);
  expect(samples["steady:inputTimerDelay"][0]).toBeCloseTo(-.1);
  expect(samples["steady:frameHIT"]).toEqual([.1]);
  const off = protocolTrial({ workload: "cells128", mode: "control", repetition: 1 });
  expect(summarizeRuns([off]).cases.cells128.off.times["steady:ingestSync"]).toEqual({ status: "UNKNOWN", n: 0 });
});
it("all timing families, pooled case ratios and initialization/steady GL totals remain distinct", async () => {
  const { summarizeRuns } = await import(driverUrl);
  const t: any = protocolTrial({ workload: "cells128", mode: "on", repetition: 1 });
  t.telemetry.rows = [evidenceRow(), { ...evidenceRow(1, "publish"), a: 10, b: 11 },
    { ...evidenceRow(1, "frame"), a: 0, ms: 2 }, { ...evidenceRow(2, "frame"), a: 1, ms: .1 },
    { ...evidenceRow(1, "react"), layer: "root", ms: 7, c: 1 },
    ...["heatmap", "bubble", "delta"].map((layer, i) => ({ ...evidenceRow(1, "draw"), layer, ms: 3 + i })),
    { ...evidenceRow(1, "raf"), layer: "heatmap", ms: 6 }];
  const c = (n: number) => ({ draws: n, vertices: n * 6, uploads: n, bytes: n * 32 });
  t.gl.frames = [{ revision: 0, layers: { heatmap: c(1), bubble: c(1) } },
    { revision: 1, layers: { heatmap: c(2), bubble: c(2) } }];
  const u = JSON.parse(JSON.stringify(t)); u.workload = "cells512";
  u.telemetry.rows.find((r: any) => r.stage === "draw" && r.layer === "heatmap").ms = 12;
  const summary = summarizeRuns([t, u]), s = summary.cases.cells128.on;
  expect(s.times["steady:ingestSync"].mean).toBe(.25);
  expect(s.times["steady:noticeTimerDelay"].mean).toBe(1);
  expect(s.times["steady:frameMISS"].mean).toBe(2);
  expect(s.times["steady:frameHIT"].mean).toBe(.1);
  expect(s.times["initialization:react:root"].mean).toBe(7);
  for (const [name, value] of [["heatmap", 3], ["bubble", 4], ["delta", 5]])
    expect(s.times[`steady:drawCPU:${name}`].mean).toBe(value);
  expect(s.times["steady:rAFWait:heatmap"].mean).toBe(6);
  expect(s.gl[0].phases.initialization.heatmap.draws).toBe(1);
  expect(s.gl[0].phases.steady.heatmap.draws).toBe(2);
  expect(summary.meanRatios512over128["steady:drawCPU:heatmap"]).toBe(4);
});

it.each(["heatmap", "bubble"])("OFF %s safety counters never clock or log native calls", async layer => {
  const { installSafetyGLObserver } = await import(driverUrl);
  let error = 0;
  const native = { createBuffer: vi.fn(() => ({})), deleteBuffer: vi.fn(), bufferData: vi.fn(),
    drawArrays: vi.fn((..._args: unknown[]) => "native-return"), getError: vi.fn(() => error) };
  class GL {
    createBuffer() { return native.createBuffer(); } deleteBuffer(x: unknown) { native.deleteBuffer(x); }
    bufferData(...args: unknown[]) { native.bufferData(...args); }
    drawArrays(...args: unknown[]) { return native.drawArrays(...args); }
    getError() { return native.getError(); }
  }
  const gl = new GL(), listeners = new Map<string, () => void>();
  class Canvas {
    classList = { contains: (s: string) => s === (layer === "heatmap" ? "hm-canvas" : "bb-canvas") };
    dataset = { revision: "128" }; getContext(..._args: unknown[]) { return gl; }
    addEventListener(n: string, fn: () => void) { listeners.set(n, fn); }
    removeEventListener(n: string) { listeners.delete(n); }
  }
  const win: any = {};
  runInNewContext(`(${installSafetyGLObserver.toString()})()`, { window: win,
    HTMLCanvasElement: Canvas, WebGL2RenderingContext: GL,
    performance: { now: () => { throw Error("OFF_CLOCK_FORBIDDEN"); } } });
  new Canvas().getContext("webgl2"); const b = gl.createBuffer();
  gl.bufferData(1, new Float32Array(8), 2);
  expect(gl.drawArrays(4, 0, 6)).toBe("native-return");
  expect(gl.getError()).toBe(0); error = 1282; expect(gl.getError()).toBe(1282);
  listeners.get("webglcontextlost")!(); listeners.get("webglcontextrestored")!(); gl.deleteBuffer(b);
  const snapshot = win.__b2gl.snapshot();
  expect(snapshot).toMatchObject({ version: 0, observation: "OFF_SAFETY_ONLY", limited: false });
  expect(snapshot.totals[layer]).toMatchObject({ contexts: 1, draws: 1, vertices: 6, uploads: 1,
    bytes: 32, errors: 1, errorChecks: 2, loss: 1, restore: 1, buffers: 1, deletes: 1, cpuMs: "UNKNOWN" });
  expect(snapshot.frames).toBeUndefined(); expect(snapshot.draws).toBeUndefined();
  expect(native.getError).toHaveBeenCalledTimes(2);
  win.__b2gl.dispose(); expect(listeners.size).toBe(0); expect(win.__b2gl).toBeUndefined();
  gl.drawArrays(4, 0, 6); expect(native.drawArrays).toHaveBeenCalledTimes(2);
});
it("OFF context observation is bounded, flags overflow and never blocks native creation", async () => {
  const { installSafetyGLObserver } = await import(driverUrl);
  let nativeCalls = 0;
  class GL {
    createBuffer() { return {}; } deleteBuffer() {} bufferData() {} drawArrays() {} getError() { return 0; }
  }
  class Canvas {
    classList = { contains: (s: string) => s === "hm-canvas" }; dataset = { revision: "0" };
    getContext(..._args: unknown[]) { nativeCalls++; return new GL(); }
    addEventListener() {} removeEventListener() {}
  }
  const win: any = {};
  runInNewContext(`(${installSafetyGLObserver.toString()})()`, {
    window: win, HTMLCanvasElement: Canvas, WebGL2RenderingContext: GL });
  for (let i = 0; i < 17; i++) expect(new Canvas().getContext("webgl2")).toBeInstanceOf(GL);
  const s = win.__b2gl.snapshot();
  expect(nativeCalls).toBe(17); expect(s.totals.heatmap.contexts).toBe(16);
  expect(s.limited).toBe(true); expect(s.unrecordedApiCalls).toBe(1);
  win.__b2gl.dispose();
});
