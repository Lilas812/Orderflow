import { describe, expect, it, vi } from "vitest";
import { F01_BOOK as F01, F03_GAP_TWA as F03 } from "@workspace/fixtures";
import type { L2Snapshot } from "@workspace/core/events";
import { createMarketQualityState, ingestMarketEvent, markChannelCondition } from "@workspace/core/quality-timeline";
import { calculateTimeWeightedDepth, type DepthHistory } from "@workspace/core/time-weighted-depth";
import { createViewport, resizeViewport, zoomTime, panTime, tickToY } from "@workspace/core/viewport";
import { DEFAULT_SCALE } from "@workspace/core/heatmap-scale";
import {
  BACKGROUND, FLOATS_PER_VERTEX, REFERENCE_QUANTITY, DISPLAY_INTERVAL_MS,
  HeatmapRenderer, cellColor, projectHeatmap, hitTestCell, DEFAULT_PALETTES, type HeatmapCell, type HeatmapStyle,
} from "./heatmapRenderer";

const start = BigInt(F01.expected.startNs);
const at = (seconds: number) => (start + BigInt(seconds) * 1_000_000_000n).toString();
function initial(snapshot: L2Snapshot) {
  const h = snapshot.header;
  const rule = { scope: h.sequenceScope, continuity: { contiguous: true,
    evidence: "Fixed MOCK +1 sequence" } } as const;
  return createMarketQualityState({
    identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
      canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
    depthScope: snapshot.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "MOCK header sequence == snapshot covered sequence",
  }, h.exchangeTimeNs!);
}

describe("R07 display styles preserve R06 inputs and resource behavior", () => {
  const style = (minimumVolume = 50): HeatmapStyle => ({
    settings: { ...DEFAULT_SCALE, minimumVolume },
    references: { BID: 200, ASK: 200 }, palettes: DEFAULT_PALETTES,
  });
  it("leaves the R06 default API reference80 unchanged, R07 explicitly uses200", () => {
    expect(cellColor(cells[0]).intensity).toBe(.75);
    expect(cellColor(cells[0], style()).intensity).toBe(.3);
  });
  it("filter50 uploads only 60,60, filter0 restores all five unchangedcells", () => {
    const v = viewport(), before = JSON.stringify(cells);
    const filtered = projectHeatmap(cells, v, style());
    expect(filtered.rects.map(r => r.source.result.twa)).toEqual([60, 60]);
    expect(filtered.vertexCount).toBe(12);
    expect(projectHeatmap(cells, v, style(0)).rects.map(r => r.source)).toEqual(cells);
    expect(JSON.stringify(cells)).toBe(before);
  });
  it("0->50->100->0 reproduces exact original GPUbuffer", () => {
    const v = viewport(), before = projectHeatmap(cells, v, style(0)).vertexData;
    expect([0, 50, 100, 0].map(t => projectHeatmap(cells, v, style(t)).vertexCount)).toEqual([30, 12, 0, 30]);
    expect(projectHeatmap(cells, v, style(0)).vertexData).toEqual(before);
  });
  it("filteredcells are not drawn or hit-tested, known0 returns whenfilteroff", () => {
    const v = viewport(), hidden = projectHeatmap(cells, v, style()), all = projectHeatmap(cells, v, style(0));
    const zero = all.rects[4], x = (zero.left + zero.right) / 2, y = (zero.top + zero.bottom) / 2;
    expect(hitTestCell(hidden, x, y)).toBe(null);
    expect(hitTestCell(all, x, y)).toBe(cells[4]);
    expect(cellColor(cells[4], style(0))).toMatchObject({ visible: true, missing: false, intensity: 0,
      rgba: [8 / 255, 9 / 255, 13 / 255, 1] });
  });
  it("missingness bypassesfilter100 and preserves hatching/partial35", () => {
    const mapped = cellColor(gapCell, style(100));
    expect(mapped).toMatchObject({ missing: true, visible: true, intensity: null });
    expect(gapCell.result).toMatchObject({ twa: null, partialTWA: 35, coverageRatio: .5 });
  });
  it("palette and contrast changes leave TWA and quantities unchanged", () => {
    const before = JSON.stringify(cells), s = style(0);
    const changed: HeatmapStyle = { ...s, settings: { ...s.settings, liquidityContrast: 2, topContrast: 2 },
      palettes: { ...s.palettes, BID: { low: [1, 10, 2], high: [20, 200, 30] } } };
    expect(cellColor(cells[0], changed).rgba).not.toEqual(cellColor(cells[0], s).rgba);
    expect(JSON.stringify(cells)).toBe(before);
    expect(projectHeatmap(cells, viewport(), changed).vertexData.filter((_, i) => i % 8 === 7))
      .toEqual(projectHeatmap(cells, viewport(), s).vertexData.filter((_, i) => i % 8 === 7));
  });
  it("ASKpalette cannot change BID and viceversa", () => {
    const s = style(0), changed: HeatmapStyle = { ...s,
      palettes: { ...s.palettes, ASK: { low: [12, 13, 14], high: [100, 101, 102] } } };
    expect(cellColor(cells[0], changed)).toEqual(cellColor(cells[0], s));
    const ask: HeatmapCell = { ...cells[0], result: { ...cells[0].result, side: "ASK" } };
    expect(cellColor(ask, changed).rgba).not.toEqual(cellColor(ask, s).rgba);
  });
  it("restoring settings restoresexactRGBA andGPUvertices", () => {
    const s = style(0), v = viewport(), original = projectHeatmap(cells, v, s).vertexData;
    projectHeatmap(cells, v, { ...s, settings: { ...s.settings, topContrast: 4 } });
    expect(projectHeatmap(cells, v, s).vertexData).toEqual(original);
  });
  it("no reference hides positiveVALID cells without coercing them to0 orNO DATA", () => {
    const s: HeatmapStyle = { ...style(0), references: { BID: null, ASK: null } };
    expect(cellColor(cells[0], s)).toMatchObject({ reason: "NO_BASELINE", visible: false, missing: false });
    expect(cells[0].result).toMatchObject({ twa: 60, status: "VALID" });
    expect(cellColor(cells[4], s)).toMatchObject({ visible: true, missing: false });
  });
  it.each([-1, 256, 1.5, NaN])("rejects invalid RGB component%s", component => {
    const s: HeatmapStyle = { ...style(), palettes: { ...DEFAULT_PALETTES,
      BID: { low: [component, 0, 0], high: [0, 255, 0] } } };
    expect(() => cellColor(cells[0], s)).toThrow();
  });
  it("contextrestore reapplies the lateststyle, without regeneratingcells", () => {
    const { canvas, element } = fakeGpu(), renderer = new HeatmapRenderer(element), v = viewport();
    renderer.draw(cells, v, style(0));
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    renderer.draw(cells, v, style(50));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(renderer.lastFrame.rects.map(r => r.source.result.twa)).toEqual([60, 60]);
    expect(renderer.status).toBe("READY"); renderer.dispose();
  });
});
function history(gap = false): DepthHistory {
  const events = gap ? F03.events : F01.events;
  let state = initial(events[0]);
  for (let i = 0; i < events.length; i++) {
    if (gap && i === 1) state = markChannelCondition(state, "L2_MBP", "GAP", F03.gap.startNs, "Fixed exact MOCK GAP");
    const result = ingestMarketEvent(state, events[i]);
    if (!result.applied) throw new Error(result.reason);
    state = result.state;
  }
  return { events, qualityState: state, qualityTimeAlignmentEvidence: "MOCK: exchange == receive, declared event-time GAP" };
}
const f01History = history();
const cells: readonly HeatmapCell[] = [0, 2, 4, 6, 8].map((s, i) => ({
  id: `F01-${i}`, priceTicks: 80000,
  result: calculateTimeWeightedDepth(f01History, { side: "BID", priceTicks: 80000, width: 1,
    startNs: at(s), endNs: at(s + 2) }),
}));
const gapCell: HeatmapCell = {
  id: "F03", priceTicks: 80000, missingReason: "GAP",
  result: calculateTimeWeightedDepth(history(true), { side: "BID", priceTicks: 80000, width: 1,
    startNs: F03.expected.startNs, endNs: F03.expected.endNs }),
};
function viewport(dpr = 1) {
  return {
    ...createViewport({ bounds: { left: 20, top: 10, width: 1000, height: 400 },
      price: { minTick: 79998, maxTick: 80002 }, latestNs: at(12), dpr }),
    time: { minNs: at(0), maxNs: at(10) },
  };
}
function fakeGpu() {
  const gl = {
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962, FLOAT: 5126, DYNAMIC_DRAW: 35048, TRIANGLES: 4,
    SCISSOR_TEST: 3089, DEPTH_TEST: 2929, CULL_FACE: 2884, BLEND: 3042,
    SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, COLOR_BUFFER_BIT: 16384, NO_ERROR: 0,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => "compile diagnostic"),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => "link diagnostic"),
    createBuffer: vi.fn(() => ({})), createVertexArray: vi.fn(() => ({})),
    getUniformLocation: vi.fn(() => ({})), bindVertexArray: vi.fn(), bindBuffer: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), deleteShader: vi.fn(),
    deleteBuffer: vi.fn(), deleteVertexArray: vi.fn(), deleteProgram: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), scissor: vi.fn(),
    clearColor: vi.fn(), clear: vi.fn(), blendFunc: vi.fn(), useProgram: vi.fn(),
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

describe("R06 actual R04 quantities and separated colors", () => {
  it("uses the five unchanged F01 events and exact 2-second TWA results", () => {
    expect(F01.events).toHaveLength(5);
    expect(cells.map((c) => c.result.twa)).toEqual([60, 40, 30, 60, 0]);
    expect(cells.map((c) => c.result.coverageRatio)).toEqual([1, 1, 1, 1, 1]);
  });
  it("declares only a provisional fixed linear reference and display cadence", () => {
    expect(REFERENCE_QUANTITY).toBe(80);
    expect(DISPLAY_INTERVAL_MS).toBe(250);
    expect(cells.map((c) => cellColor(c).intensity)).toEqual([0.75, 0.5, 0.375, 0.75, 0]);
  });
  it("maps quantities monotonically to actual RGB luminance", () => {
    const luma = (c: HeatmapCell) => cellColor(c).rgba.slice(0, 3)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    expect(luma(cells[0])).toBeGreaterThan(luma(cells[1]));
    expect(luma(cells[1])).toBeGreaterThan(luma(cells[2]));
    expect(luma(cells[2])).toBeGreaterThan(luma(cells[4]));
  });
  it("makes equal quantities identical colors", () => {
    expect(cellColor(cells[0])).toEqual(cellColor(cells[3]));
  });
  it("maps a known zero to the exact background, not a missingness pattern", () => {
    const color = cellColor(cells[4]);
    expect(color.rgba.slice(0, 3).map((n) => Math.round(n * 255))).toEqual(BACKGROUND);
    expect(color.missing).toBe(false);
    expect(color.intensity).toBe(0);
  });
  it("uses BID green and ASK purple without changing quantity", () => {
    const ask = { ...cells[0], result: { ...cells[0].result, side: "ASK" as const } };
    expect(cellColor(ask).rgba[2]).toBeGreaterThan(cellColor(ask).rgba[1]);
    expect(cellColor(cells[0]).rgba[1]).toBeGreaterThan(cellColor(cells[0]).rgba[2]);
    expect(ask.result.twa).toBe(60);
  });
  it("keeps F03 coverage .5 / partial 35 / confirmed null; never maps 35 as liquidity", () => {
    expect(gapCell.result).toMatchObject({
      status: "NO DATA", twa: null, coverageRatio: 0.5, partialTWA: 35, coveredDuration: "2000000000",
    });
    expect(cellColor(gapCell)).toMatchObject({ intensity: null, missing: true });
    expect(cellColor(gapCell).rgba[3]).toBeLessThan(1);
  });
  it("does not disguise UNKNOWN as zero either", () => {
    const unknown = { ...gapCell, missingReason: "UNKNOWN" as const };
    expect(cellColor(unknown).missing).toBe(true);
    expect(cellColor(unknown)).not.toEqual(cellColor(cells[4]));
  });
  it("rejects incomplete confirmed quantities instead of coloring them", () => {
    expect(() => cellColor({ ...cells[0], result: { ...cells[0].result, coverageRatio: 0.5 } })).toThrow();
  });
  it.each([-1, NaN, Infinity])("rejects invalid confirmed TWA %s", (twa) => {
    expect(() => cellColor({ ...cells[0], result: { ...cells[0].result, status: "VALID", twa } })).toThrow();
  });
});

describe("R06 CPU projection and numeric GPU buffer", () => {
  it("places five cells on shared R05 coordinates with correct tick-centered row", () => {
    const frame = projectHeatmap(cells, viewport());
    expect(frame.rects.map((r) => [r.left, r.right, r.top, r.bottom]))
      .toEqual([[20, 220, 160, 260], [220, 420, 160, 260], [420, 620, 160, 260],
        [620, 820, 160, 260], [820, 1020, 160, 260]]);
    expect((frame.rects[0].top + frame.rects[0].bottom) / 2).toBe(tickToY(viewport(), 80000));
  });
  it("uploads six vertices per source cell with correct quantity, status, RGBA, and CSS geometry", () => {
    const frame = projectHeatmap(cells, viewport());
    expect(frame.vertexCount).toBe(30);
    expect(frame.vertexData).toHaveLength(30 * FLOATS_PER_VERTEX);
    frame.rects.forEach((r, i) => {
      const offset = i * 6 * FLOATS_PER_VERTEX;
      expect(frame.vertexData[offset]).toBe(r.left);
      expect(frame.vertexData[offset + 1]).toBe(r.top);
      for (let v = 0; v < 6; v++) {
        const base = offset + v * FLOATS_PER_VERTEX;
        expect(frame.vertexData[base + 6]).toBe(0);
        expect(frame.vertexData[base + 7]).toBe(r.source.result.twa);
        for (let c = 0; c < 4; c++) expect(frame.vertexData[base + 2 + c]).toBeCloseTo(r.color.rgba[c], 6);
      }
    });
  });
  it("encodes missingness separately and never puts partial35 or zero in GAP quantity slots", () => {
    const v = { ...viewport(), time: { minNs: at(8), maxNs: at(12) } };
    const frame = projectHeatmap([gapCell], v);
    for (let i = 0; i < 6; i++) {
      expect(frame.vertexData[i * 8 + 6]).toBe(1);
      expect(frame.vertexData[i * 8 + 7]).toBe(-1);
    }
  });
  it("returns original computed values for hover, including known zero", () => {
    const frame = projectHeatmap(cells, viewport());
    expect(hitTestCell(frame, 900, 210)).toBe(cells[4]);
    expect(hitTestCell(frame, 21, 210)?.result.twa).toBe(60);
    expect(hitTestCell(frame, 220, 210)).toBe(cells[1]);
    expect(hitTestCell(frame, 1020, 210)).toBeNull();
  });
  it("reprojects zoom through R05 instead of storing stale screen coordinates", () => {
    const original = { ...viewport(), time: { minNs: at(-50), maxNs: at(10) } };
    const zoomed = zoomTime(original, 1020, 2);
    expect(projectHeatmap(cells, original).rects[0].left)
      .not.toBe(projectHeatmap(cells, zoomed).rects[0].left);
    expect(projectHeatmap(cells, zoomed).rects[0].source.result.twa).toBe(60);
  });
  it("reprojects HISTORY pan without recalculating or mutating TWA", () => {
    const original = { ...viewport(), time: { minNs: at(-50), maxNs: at(10) } };
    const panned = panTime(original, -100);
    expect(panned.timeMode).toBe("HISTORY");
    expect(projectHeatmap(cells, panned).rects[0].source).toBe(cells[0]);
  });
  it("culls wholly invisible time/price cells and clips partially visible rectangles", () => {
    expect(projectHeatmap(cells, { ...viewport(), time: { minNs: at(10), maxNs: at(12) } }).rects).toHaveLength(0);
    expect(projectHeatmap(cells, { ...viewport(), price: { minTick: 80001, maxTick: 80004 } }).rects).toHaveLength(0);
    const clipped = projectHeatmap(cells, { ...viewport(), time: { minNs: at(1), maxNs: at(9) } });
    expect(clipped.rects[0].left).toBe(20);
    expect(clipped.rects[4].right).toBe(1020);
  });
  it("has identical CSS vertex buffers at DPR1 and DPR2", () => {
    expect(projectHeatmap(cells, viewport(2)).vertexData).toEqual(projectHeatmap(cells, viewport(1)).vertexData);
  });
  it("follows resize and keeps axis center error below 1 CSSpx", () => {
    const v = resizeViewport(viewport(), { left: 20, top: 10, width: 1798, height: 826 }, 2);
    const r = projectHeatmap(cells, v).rects[0];
    expect(Math.abs((r.top + r.bottom) / 2 - tickToY(v, 80000)!)).toBeLessThanOrEqual(1);
    expect(r.right - r.left).toBeCloseTo(359.6, 8);
  });
  it("handles unmeasured size and absent price scales without fake cells", () => {
    expect(projectHeatmap(cells, resizeViewport(viewport(), { left: 0, top: 0, width: 0, height: 0 }, 1)).rects).toHaveLength(0);
    expect(projectHeatmap(cells, { ...viewport(), price: null }).rects).toHaveLength(0);
  });
  it("does not mutate raw F01/F03, computed results, or Viewport", () => {
    const v = viewport(), before = JSON.stringify([F01, F03, cells, gapCell, v]);
    projectHeatmap(cells, v); cellColor(gapCell);
    expect(JSON.stringify([F01, F03, cells, gapCell, v])).toBe(before);
  });
});

describe("R06 WebGL2 lifecycle (GPU calls stubbed; real pixels verified in browser)", () => {
  it("requires a real WebGL2 context instead of a fake Canvas2D fallback", () => {
    const { element, canvas } = fakeGpu();
    canvas.getContext.mockReturnValue(null as never);
    const status = vi.fn();
    const renderer = new HeatmapRenderer(element, status);
    expect(renderer.status).toBe("RENDER ERROR");
    expect(renderer.error).toContain("WebGL2");
    renderer.dispose();
  });
  it("uses the exact CPU buffer in bufferData and draws triangles, not decorations", () => {
    const { element, gl } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    const frame = renderer.draw(cells, viewport());
    expect(gl.bufferData).toHaveBeenCalledWith(gl.ARRAY_BUFFER, frame.vertexData, gl.DYNAMIC_DRAW);
    expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 30);
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.anything(), 1020, 410);
    expect(renderer.status).toBe("READY");
    renderer.dispose();
  });
  it.each([1, 2])("scales only backing store/GL viewport at DPR %s", (dpr) => {
    const { element, canvas, gl } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    renderer.draw(cells, viewport(dpr));
    expect(canvas.width).toBe(1020 * dpr); expect(canvas.height).toBe(410 * dpr);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 1020 * dpr, 410 * dpr);
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.anything(), 1020, 410);
    renderer.dispose();
  });
  it("resizes GPU backing dimensions when chart bounds change", () => {
    const { element, canvas } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    renderer.draw(cells, viewport());
    renderer.draw(cells, resizeViewport(viewport(), { left: 0, top: 0, width: 1200, height: 600 }, 2));
    expect([canvas.width, canvas.height]).toEqual([2400, 1200]);
    renderer.dispose();
  });
  it("prevents default loss, skips GPU draws while lost, then rebuilds and redraws unchanged cells", () => {
    const { element, canvas, gl } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    const initialFrame = renderer.draw(cells, viewport());
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(renderer.status).toBe("CONTEXT LOST");
    renderer.draw(cells, viewport());
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(renderer.status).toBe("READY");
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(renderer.lastFrame.vertexData).toEqual(initialFrame.vertexData);
    expect(renderer.lastFrame.rects[0].source).toBe(cells[0]);
    renderer.dispose();
  });
  it("reports shader compilation failure explicitly", () => {
    const { element, gl } = fakeGpu();
    gl.getShaderParameter.mockReturnValue(false);
    const renderer = new HeatmapRenderer(element);
    expect(renderer.status).toBe("RENDER ERROR");
    expect(renderer.error).toContain("compile diagnostic");
    renderer.dispose();
  });
  it("reports shader link failure explicitly", () => {
    const { element, gl } = fakeGpu();
    gl.getProgramParameter.mockReturnValue(false);
    const renderer = new HeatmapRenderer(element);
    expect(renderer.error).toContain("link diagnostic");
    renderer.dispose();
  });
  it("reports a restored-context compile failure instead of pretending recovery", () => {
    const { element, canvas, gl } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    gl.getShaderParameter.mockReturnValue(false);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(renderer.status).toBe("RENDER ERROR");
    renderer.dispose();
  });
  it("reports a GL draw error explicitly", () => {
    const { element, gl } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    gl.getError.mockReturnValue(1282);
    renderer.draw(cells, viewport());
    expect(renderer.error).toBe("WebGL error 1282");
    renderer.dispose();
  });
  it("disposes buffers/program/listeners and rejects later draws", () => {
    const { element, canvas, gl } = fakeGpu();
    const renderer = new HeatmapRenderer(element);
    renderer.dispose(); renderer.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(() => renderer.draw(cells, viewport())).toThrow("disposed");
  });
});
