import { describe, expect, it, vi } from "vitest";
import { R09_SCENARIOS, R09_BUBBLE_EXPECTED, R09_OVERLAY_DEPTH, F04_TRADES } from "@workspace/fixtures";
import { createBubbleFinality, ingestBubbleTrade, advanceBubbleWatermark, type BubbleState } from "@workspace/core/bubble-finality";
import { DEFAULT_BUBBLE_SIZING } from "@workspace/core/bubble-sizing";
import { DEFAULT_BUBBLE_FILTERS } from "@workspace/core/bubble-aggregate";
import { createViewport, resizeViewport, zoomTime, panTime, tickToY, timeToX, type Viewport } from "@workspace/core/viewport";
import { createMarketQualityState, ingestMarketEvent } from "@workspace/core/quality-timeline";
import { calculateTimeWeightedDepth } from "@workspace/core/time-weighted-depth";
import {
  BubbleRenderer, projectBubbles, hitTestBubble, bubbleColor,
  BUBBLE_FLOATS_PER_VERTEX, BUBBLE_LAYER_ORDER,
} from "./bubbleRenderer";

const first = R09_SCENARIOS[0], origin = 1767261600000000000n;
function states(id = "F04", finalize = false): readonly BubbleState[] {
  const s = R09_SCENARIOS.find(s => s.id === id)!;
  let state = createBubbleFinality(s.events[0].header, s.quality);
  for (const t of s.events) state = ingestBubbleTrade(state, t);
  if (finalize) state = advanceBubbleWatermark(state, { exchangeTimeNs: (origin + 5_000_000_000n).toString(),
    trusted: true, evidence: "MOCK trusted event progress", scope: state.store.scope });
  return state.bubbles;
}
function viewport(dpr = 1): Viewport {
  const v = createViewport({ bounds: { left: 20, top: 10, width: 1000, height: 400 },
    dpr, latestNs: (origin + 6_000_000_000n).toString(), price: { minTick: 79980, maxTick: 80020 } });
  return { ...v, time: { minNs: (origin - 54_000_000_000n).toString(), maxNs: v.latestNs! } };
}
describe("R13 bubble palette presentation only", () => {
  const colors = { buy: [255, 0, 0] as const, sell: [0, 0, 255] as const, neutral: [0, 255, 255] as const };
  it("updates GPU vertex RGB, preserving alpha, exact quantities, diameter and positions", () => {
    const bubbles = states(), vp = viewport(), before = JSON.stringify(bubbles, (_, x) => typeof x === "bigint" ? x.toString() : x);
    const standard = projectBubbles(bubbles, vp), colored = projectBubbles(bubbles, vp, undefined, undefined, undefined, colors);
    expect(colored.bubbles.length).toBe(standard.bubbles.length);
    for (const [index, next] of colored.bubbles.entries()) {
      const old = standard.bubbles[index];
      expect([next.x, next.y, next.diameter, next.rgba[3]]).toEqual([old.x, old.y, old.diameter, old.rgba[3]]);
      expect(next.source).toBe(old.source);
      expect(next.rgba.slice(0, 3)).toEqual([1, 0, 0]);
      expect(Array.from(colored.vertexData.slice(index * 6 * BUBBLE_FLOATS_PER_VERTEX + 4, index * 6 * BUBBLE_FLOATS_PER_VERTEX + 7))).toEqual([1, 0, 0]);
    }
    expect(JSON.stringify(bubbles, (_, x) => typeof x === "bigint" ? x.toString() : x)).toBe(before);
  });
  it("uses sell and neutral colors without changing the original alpha formula", () => {
    const base = states()[0];
    for (const [delta, expected] of [[-1n, [0, 0, 1]], [0n, [0, 1, 1]], [null, [0, 1, 1]]] as const) {
      const source = { ...base, bucket: { ...base.bucket, delta } };
      expect(bubbleColor(source, colors).slice(0, 3)).toEqual(expected);
      expect(bubbleColor(source, colors)[3]).toBe(bubbleColor(source)[3]);
    }
  });
  it("applies filters and palette only to projection, without changing Delta or raw inputs", () => {
    const bubbles = states(), before = bubbles.map(b => b.bucket);
    const filters = { ...DEFAULT_BUBBLE_FILTERS, volume: { enabled: true, minimum: 1000 } };
    expect(projectBubbles(bubbles, viewport(), undefined, filters, undefined, colors).bubbles).toHaveLength(0);
    expect(projectBubbles(bubbles, viewport(), undefined, DEFAULT_BUBBLE_FILTERS, undefined, colors).bubbles).toHaveLength(1);
    expect(bubbles.map(b => b.bucket)).toEqual(before); expect(bubbles[0].bucket.delta).toBe(19n);
  });
  it("validates RGB boundaries, rather than sending NaN/out-of-range values to WebGL", () => {
    for (const rgb of [[-1, 0, 0], [256, 0, 0], [NaN, 0, 0], [1.5, 0, 0], [1, 2]]) {
      expect(() => projectBubbles(states(), viewport(), undefined, undefined, undefined,
        { ...colors, buy: rgb as unknown as readonly [number, number, number] })).toThrow();
    }
  });
});
function fakeGpu() {
  const gl = {
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962, FLOAT: 5126, DYNAMIC_DRAW: 35048, TRIANGLES: 4,
    SCISSOR_TEST: 3089, DEPTH_TEST: 2929, CULL_FACE: 2884, BLEND: 3042,
    ONE: 1, ONE_MINUS_SRC_ALPHA: 771, COLOR_BUFFER_BIT: 16384, NO_ERROR: 0,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => "bubble compile diagnostic"),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => "bubble link diagnostic"),
    createBuffer: vi.fn(() => ({})), createVertexArray: vi.fn(() => ({})),
    getUniformLocation: vi.fn(() => ({})), bindVertexArray: vi.fn(), bindBuffer: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), deleteShader: vi.fn(),
    deleteBuffer: vi.fn(), deleteVertexArray: vi.fn(), deleteProgram: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), scissor: vi.fn(),
    clearColor: vi.fn(), clear: vi.fn(), blendFuncSeparate: vi.fn(), useProgram: vi.fn(),
    bufferData: vi.fn(), uniform2f: vi.fn(), drawArrays: vi.fn(),
    getError: vi.fn(() => 0), isContextLost: vi.fn(() => false),
  };
  class Canvas extends EventTarget {
    width = 0; height = 0;
    getContext = vi.fn(() => gl);
  }
  const canvas = new Canvas();
  return { gl, canvas, element: canvas as unknown as HTMLCanvasElement };
}
describe("R09 quantity-preserving shared viewport projection and CPU hover", () => {
  it("projects F04 at the exact time and fractional Tick midpoint", () => {
    const source = states(), v = viewport(), frame = projectBubbles(source, v), p = frame.bubbles[0];
    expect(frame.bubbles).toHaveLength(1);
    expect(p.source).toBe(source[0]);
    expect(p.x).toBe(timeToX(v, R09_BUBBLE_EXPECTED.f04.centerNs));
    expect(p.y).toBe(tickToY(v, 80000.5));
    expect(R09_BUBBLE_EXPECTED.f04.centerPoints).toBe(20000.125);
    expect(p.diameter).toBeCloseTo(16.313843876330612, 12);
    expect(p.rgba).toEqual([67 / 255, 250 / 255, 85 / 255, .45]);
    expect(frame.vertexCount).toBe(6);
    expect(frame.vertexData.length).toBe(6 * BUBBLE_FLOATS_PER_VERTEX);
  });
  it("keeps source B/S/V/Delta in diagnostic buffers and exact original CPU source", () => {
    const frame = projectBubbles(states(), viewport());
    for (let i = 0; i < 6; i++) {
      expect(Array.from(frame.vertexData.slice(i * 13 + 9, i * 13 + 13))).toEqual([23, 4, 27, 19]);
    }
    const b = frame.bubbles[0], hit = hitTestBubble(frame, b.x, b.y);
    expect(hit).toBe(b.source);
    expect([hit!.bucket.B, hit!.bucket.S, hit!.bucket.V, hit!.bucket.delta]).toEqual([23n, 4n, 27n, 19n]);
    expect(hit!.bucket.imbalancePercent).toBeCloseTo(70.37037037037037);
  });
  it("uses circular hover rather than square GPU quad bounds", () => {
    const f = projectBubbles(states(), viewport()), p = f.bubbles[0], r = p.diameter / 2;
    expect(hitTestBubble(f, p.x + r * .9, p.y + r * .9)).toBeNull();
    expect(hitTestBubble(f, p.x + r * .9, p.y)).toBe(p.source);
    expect(hitTestBubble(f, -1, p.y)).toBeNull();
    expect(hitTestBubble(f, NaN, p.y)).toBeNull();
  });
  it("uses reverse visual order for overlapping bubbles without clustering", () => {
    const source = states()[0], other = { ...source, id: "other" };
    const f = projectBubbles([source, other], viewport()), p = f.bubbles[0];
    expect(f.bubbles).toHaveLength(2); expect(hitTestBubble(f, p.x, p.y)).toBe(other);
  });
  it("defines background→gap→heatmap→price→bubble→tooltip ordering", () => {
    expect(BUBBLE_LAYER_ORDER).toEqual(["background", "gap", "heatmap", "price", "bubbles", "tooltip"]);
  });
  it.each(["F05", "F09", "GAP", "CORRECTION", "CANCEL"])("%s is not drawn as a complete filtered bubble", id => {
    expect(projectBubbles(states(id, true), viewport()).bubbles).toHaveLength(0);
  });
  it("explicit INCOMPLETE gate never ignores a complete bucket's renderer state", () => {
    const b = { ...states()[0], status: "INCOMPLETE" as const };
    expect(projectBubbles([b], viewport()).bubbles).toHaveLength(0);
  });
  it.each(["BUY", "SELL", "NEUTRAL"] as const)("supports %s color without altering data", direction => {
    const original = states()[0], delta = direction === "BUY" ? 19n : direction === "SELL" ? -19n : 0n;
    const source = { ...original, bucket: { ...original.bucket, delta } };
    const rgba = bubbleColor(source);
    expect(rgba.slice(0, 3)).toEqual((direction === "BUY" ? [67, 250, 85]
      : direction === "SELL" ? [178, 53, 250] : [156, 163, 180]).map(n => n / 255));
    const filters = { ...DEFAULT_BUBBLE_FILTERS,
      absoluteDelta: { enabled: false, minimum: 10 }, imbalancePercent: { enabled: false, minimum: 40 } };
    expect(projectBubbles([source], viewport(), DEFAULT_BUBBLE_SIZING, filters).bubbles).toHaveLength(1);
  });
  it("changes only alpha at finality, not midpoint or source volume", () => {
    const a = projectBubbles(states(), viewport()).bubbles[0];
    const b = projectBubbles(states("F04", true), viewport()).bubbles[0];
    expect([b.x, b.y, b.diameter]).toEqual([a.x, a.y, a.diameter]);
    expect(a.rgba[3]).toBe(.45); expect(b.rgba[3]).toBe(.92);
    expect(b.source.bucket.V).toBe(27n);
  });
  it("recolors and resizes provisional sign flips while maintaining identity", () => {
    let s = createBubbleFinality(R09_SCENARIOS[3].events[0].header, first.quality);
    const colors: number[][] = [], ids: string[] = [], diameters: number[] = [];
    for (const t of R09_SCENARIOS[3].events) {
      s = ingestBubbleTrade(s, t);
      const p = projectBubbles(s.bubbles, viewport()).bubbles[0];
      colors.push(Array.from(p.rgba)); ids.push(p.source.id); diameters.push(p.diameter);
    }
    expect(new Set(ids).size).toBe(1);
    expect(colors.map(c => c[0])).toEqual([67 / 255, 178 / 255, 67 / 255]);
    expect(diameters[1]).toBeGreaterThan(diameters[0]); expect(diameters[2]).toBe(24);
  });
  it("creates identical CSS geometry at DPR1/DPR2", () => {
    expect(projectBubbles(states(), viewport(1)).vertexData).toEqual(projectBubbles(states(), viewport(2)).vertexData);
  });
  it("follows shared pan/zoom transforms and retains fixed CSS diameter", () => {
    const v = viewport(), p = projectBubbles(states(), v).bubbles[0];
    const next = zoomTime(panTime(v, 20), p.x, 2);
    const q = projectBubbles(states(), next).bubbles[0];
    expect(q.x).toBe(timeToX(next, R09_BUBBLE_EXPECTED.f04.centerNs));
    expect(q.y).toBe(tickToY(next, 80000.5)); expect(q.diameter).toBe(p.diameter);
    expect(next.timeMode).toBe("HISTORY");
  });
  it("reprojects after resize with no DPR multiplier in CSS center", () => {
    const v = resizeViewport(viewport(), { left: 0, top: 0, width: 1750, height: 600 }, 2);
    const p = projectBubbles(states(), v).bubbles[0];
    expect(p.x).toBe(timeToX(v, R09_BUBBLE_EXPECTED.f04.centerNs));
    expect(p.y).toBeCloseTo(292.5);
  });
  it("does not draw offscreen bubbles or a fake bubble without a measured price viewport", () => {
    expect(projectBubbles(states(), { ...viewport(), price: null }).bubbles).toEqual([]);
    expect(projectBubbles(states(), { ...viewport(), bounds: { left: 0, top: 0, width: 0, height: 0 } }).bubbles).toEqual([]);
    expect(projectBubbles(states(), panTime(viewport(), 2000)).bubbles).toEqual([]);
  });
  it("never mutates original Trade timestamps, prices, fixtures or CPU results", () => {
    const s = states(), before = JSON.stringify(F04_TRADES);
    const raw = s[0].bucket;
    projectBubbles(s, viewport());
    expect(JSON.stringify(F04_TRADES)).toBe(before); expect(s[0].bucket).toBe(raw);
    expect(F04_TRADES.events.map(e => e.priceTicks)).toEqual([80000, 80000, 80000]);
  });
  it("rejects duplicate display identities rather than double drawing one bin", () => {
    const s = states(); expect(() => projectBubbles([s[0], s[0]], viewport())).toThrow("Duplicate");
  });
  it.each(["BID", "ASK"] as const)("derives NEW R09 %s backdrop TWA from R03/R04, not retimed F01", side => {
    const snap = R09_OVERLAY_DEPTH.F04, h = snap.header;
    const rule = { scope: h.sequenceScope, continuity: { contiguous: true, evidence: "MOCK +1" } } as const;
    const s = createMarketQualityState({
      identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
        canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
      depthScope: snap.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
      snapshotAlignmentEvidence: "MOCK snapshot covered sequence matches",
    }, h.exchangeTimeNs!);
    const result = ingestMarketEvent(s, snap); expect(result.applied).toBe(true);
    const twa = calculateTimeWeightedDepth({
      events: [snap], qualityState: result.state, qualityTimeAlignmentEvidence: "R09 MOCK clocks explicitly aligned",
    }, { side, width: 1, priceTicks: side === "BID" ? 80000 : 80001,
      startNs: F04_TRADES.expected.startNs, endNs: F04_TRADES.expected.endNs });
    expect(twa.twa).toBe(side === "BID" ? 100 : 75);
    expect(twa.coverageRatio).toBe(1); expect(twa.status).toBe("VALID");
  });
});
describe("R09 WebGL2 lifecycle (stubbed calls; real context/pixels checked in browser)", () => {
  it("requests real transparent WebGL2, no fallback when unavailable", () => {
    const { canvas, element } = fakeGpu(); canvas.getContext.mockReturnValue(null as never);
    const r = new BubbleRenderer(element);
    expect(canvas.getContext).toHaveBeenCalledWith("webgl2", expect.objectContaining({ alpha: true }));
    expect(r.status).toBe("RENDER ERROR"); expect(r.error).toContain("WebGL2");
    r.dispose();
  });
  it("uploads exact CPU vertices and draws transparent circular triangles", () => {
    const { element, gl } = fakeGpu(), r = new BubbleRenderer(element);
    const f = r.draw(states(), viewport());
    expect(gl.bufferData).toHaveBeenCalledWith(gl.ARRAY_BUFFER, f.vertexData, gl.DYNAMIC_DRAW);
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 6);
    expect(gl.clearColor).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(1, 771, 1, 771);
    expect(gl.shaderSource.mock.calls.some(args => args[1].includes("length(v_local)"))).toBe(true);
    expect(r.status).toBe("READY"); r.dispose();
  });
  it.each([1, 2])("uses DPR%s only for backing size and scissor", dpr => {
    const { element, gl, canvas } = fakeGpu(), r = new BubbleRenderer(element);
    r.draw(states(), viewport(dpr));
    expect([canvas.width, canvas.height]).toEqual([1020 * dpr, 410 * dpr]);
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.anything(), 1020, 410);
    expect(gl.scissor).toHaveBeenCalledWith(20 * dpr, 0, 1000 * dpr, 400 * dpr);
    r.dispose();
  });
  it("resizes backing store after DPR and bounds changes", () => {
    const { canvas, element } = fakeGpu(), r = new BubbleRenderer(element);
    r.draw(states(), viewport());
    r.draw(states(), resizeViewport(viewport(), { left: 0, top: 0, width: 1400, height: 600 }, 2));
    expect([canvas.width, canvas.height]).toEqual([2800, 1200]); r.dispose();
  });
  it("clears old bubbles when the next frame becomes filtered or INCOMPLETE", () => {
    const { element, gl } = fakeGpu(), r = new BubbleRenderer(element);
    r.draw(states(), viewport()); const next = r.draw(states("F09"), viewport());
    expect(next.vertexCount).toBe(0); expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, 0);
    expect(gl.clear).toHaveBeenCalledTimes(2); r.dispose();
  });
  it("prevents context loss, retains latest source, and restores exact frame and hover", () => {
    const { element, canvas, gl } = fakeGpu(), r = new BubbleRenderer(element), source = states();
    const before = r.draw(source, viewport());
    const lost = new Event("webglcontextlost", { cancelable: true }); canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true); expect(r.status).toBe("CONTEXT LOST");
    r.draw(source, viewport()); expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.status).toBe("READY"); expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(r.lastFrame.vertexData).toEqual(before.vertexData);
    const p = r.lastFrame.bubbles[0]; expect(hitTestBubble(r.lastFrame, p.x, p.y)).toBe(source[0]);
    r.dispose();
  });
  it("restores latest queued CPU results even when updated during context loss", () => {
    const { element, canvas } = fakeGpu(), r = new BubbleRenderer(element);
    r.draw(states(), viewport()); canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    r.draw(states("F04", true), viewport(2)); canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.lastFrame.bubbles[0].rgba[3]).toBe(.92); expect(canvas.width).toBe(2040); r.dispose();
  });
  it.each(["compile", "link", "allocation", "uniform"] as const)("reports %s initialization failure explicitly", mode => {
    const { element, gl } = fakeGpu();
    if (mode === "compile") gl.getShaderParameter.mockReturnValue(false);
    if (mode === "link") gl.getProgramParameter.mockReturnValue(false);
    if (mode === "allocation") gl.createBuffer.mockReturnValue(null as never);
    if (mode === "uniform") gl.getUniformLocation.mockReturnValue(null as never);
    const r = new BubbleRenderer(element); expect(r.status).toBe("RENDER ERROR"); expect(r.error).toBeTruthy();
    r.dispose();
  });
  it("reports failed restoration instead of successful recovery", () => {
    const { element, canvas, gl } = fakeGpu(), r = new BubbleRenderer(element);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    gl.getShaderParameter.mockReturnValue(false); canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.status).toBe("RENDER ERROR"); r.dispose();
  });
  it("reports actual GL draw error", () => {
    const { element, gl } = fakeGpu(), r = new BubbleRenderer(element);
    gl.getError.mockReturnValue(1282); r.draw(states(), viewport());
    expect(r.status).toBe("RENDER ERROR"); expect(r.error).toBe("Bubble WebGL error 1282"); r.dispose();
  });
  it("disposes resources and listeners idempotently; later draw is rejected", () => {
    const { element, canvas, gl } = fakeGpu(), r = new BubbleRenderer(element);
    r.dispose(); r.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(new Event("webglcontextrestored")); expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(() => r.draw(states(), viewport())).toThrow("disposed");
  });
});
