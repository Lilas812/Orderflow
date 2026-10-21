import { describe, expect, it, vi } from "vitest";
import { R10_SCENARIOS, R10_CONTINUITY, R10_DENSITY_EXPECTED, R09_SCENARIOS, R10_OVERLAY_DEPTH } from "@workspace/fixtures";
import { createBubbleFinality, ingestBubbleTrade, advanceBubbleWatermark, type BubbleState } from "@workspace/core/bubble-finality";
import { validateMarketEvent, type DataQualityInterval } from "@workspace/core/events";
import { createViewport, panTime, resizeViewport, zoomTime, type Viewport } from "@workspace/core/viewport";
import { bubbleDiameter, DEFAULT_BUBBLE_SIZING } from "@workspace/core/bubble-sizing";
import { DEFAULT_BUBBLE_FILTERS } from "@workspace/core/bubble-aggregate";
import { clusterBubbles, type ClusteringOptions, type ClusteringContinuity, type BubbleDensity } from "./bubbleClustering";
import { projectBubbles, hitTestProjectedBubble, BubbleRenderer, type ProjectedBubble } from "./bubbleRenderer";

const T0 = 1767261600000000000n, SEC = 1_000_000_000n;
const continuity = R10_CONTINUITY.DENSITY;
const options = (mode: BubbleDensity = "STANDARD"): ClusteringOptions => ({ mode, continuity: [continuity] });
const json = (v: unknown) => JSON.stringify(v, (_, n) => typeof n === "bigint" ? `${n}n` : n);
function finality(id = "DENSITY", steps = 1) {
  const fixture = R10_SCENARIOS.find(s => s.id === id)!;
  let s = createBubbleFinality(fixture.events[0].header, fixture.quality), count = 0;
  for (const step of fixture.steps.slice(0, steps)) {
    while (count < step.tradeCount) s = ingestBubbleTrade(s, fixture.events[count++]);
    if (step.progressNs) s = advanceBubbleWatermark(s, { trusted: true, evidence: "Explicit aligned MOCK progress",
      scope: s.store.scope, exchangeTimeNs: step.progressNs });
  }
  return s;
}
function viewport(span = 600, width = 1158, dpr = 1): Viewport {
  const end = T0 + 30n * SEC;
  const v = createViewport({ bounds: { left: 0, top: 0, width, height: 400 }, dpr,
    latestNs: end.toString(), price: { minTick: 79900, maxTick: 80100 } });
  return { ...v, timeMode: "HISTORY", priceMode: "MANUAL",
    time: { minNs: (end - BigInt(span) * SEC).toString(), maxNs: end.toString() } };
}
const states = finality().bubbles;
const originalProjection = () => projectBubbles(states, viewport()).sourceBubbles;
function points(xs: readonly number[]): ProjectedBubble[] {
  return xs.map((x, i) => ({ ...originalProjection()[i % 3], x, y: 100, diameter: 16,
    source: { ...states[i % 3], id: `point-${String(i).padStart(3, "0")}` } }));
}
const optWith = (evidence: Partial<ClusteringContinuity>): ClusteringOptions =>
  ({ mode: "STANDARD", continuity: [{ ...continuity, ...evidence }] });
const qualityWith = (intervals: readonly DataQualityInterval[]) => optWith({ intervals });
const q = (start: bigint, end: bigint, status: DataQualityInterval["status"] = "VALID"): DataQualityInterval =>
  ({ channel: "TRADES", startNs: (T0 + start).toString(), endNs: (T0 + end).toString(), status, reason: "Explicit test event-time evidence" });

describe("R10 fixed MOCK and display-only exact totals", () => {
  it("has twelve validated raw Trades and four distinct time AND price bin identities", () => {
    const s = finality();
    expect(s.store.rawEvents).toHaveLength(R10_DENSITY_EXPECTED.rawTradeCount);
    for (const t of s.store.rawEvents) expect(validateMarketEvent(t)).toEqual(t);
    expect(states).toHaveLength(4);
    expect(new Set(states.map(b => b.bucket.timeBinId)).size).toBe(4);
    expect(new Set(states.map(b => b.bucket.priceBinId)).size).toBe(4);
    expect(states.every(b => b.status === "FINAL" && b.bucket.status === "COMPLETE")).toBe(true);
    expect(states.every(b => b.bucket.scope.environment === "MOCK")).toBe(true);
    for (const s of Object.values(R10_OVERLAY_DEPTH)) expect(validateMarketEvent(s)).toEqual(s);
  });
  it.each([["ALL", 4], ["STANDARD", 2], ["HIGH_COMPRESSION", 2]] as const)("%s has %i outputs at designated base zoom", (mode, count) => {
    const frame = projectBubbles(states, viewport(), undefined, undefined, options(mode));
    expect(frame.clusters).toHaveLength(count);
    expect(frame.sourceBubbles).toHaveLength(4);
    expect(frame.vertexCount).toBe(count * 6);
    expect(frame.bubbles.map(p => p.cluster)).toEqual(frame.clusters);
  });
  it("produces B69 S12 V81 Delta57, weighted bias and SQRT diameter22.4 without adding source diameters", () => {
    const c = projectBubbles(states, viewport(), undefined, undefined, options()).clusters.find(c => c.children.length === 3)!;
    expect([c.B, c.S, c.V, c.delta]).toEqual([69n, 12n, 81n, 57n]);
    expect(c.imbalancePercent).toBeCloseTo(R10_DENSITY_EXPECTED.buyCluster.imbalancePercent, 12);
    expect(c.diameter).toBe(22.4);
    expect(c.diameter).not.toBe(c.children.reduce((s, p) => s + p.diameter, 0));
    expect(c.children.every(p => states.includes(p.source))).toBe(true);
    expect(c.startNs).toBe(T0.toString());
    expect(c.endNs).toBe((T0 + 6n * SEC).toString());
    expect([c.minTick, c.maxTick]).toEqual([80000, 80005]);
  });
  it.each(["ALL", "STANDARD", "HIGH_COMPRESSION"] as const)("%s conserves IDs, membership and all exact quantities", mode => {
    const clusters = projectBubbles(states, viewport(), undefined, undefined, options(mode)).clusters;
    const ids = clusters.flatMap(c => c.childrenIds);
    expect(ids.slice().sort()).toEqual(states.map(b => b.id).sort());
    expect(new Set(ids).size).toBe(4);
    expect(clusters.reduce((s, c) => s + c.B, 0n)).toBe(73n);
    expect(clusters.reduce((s, c) => s + c.S, 0n)).toBe(35n);
    expect(clusters.reduce((s, c) => s + c.V, 0n)).toBe(108n);
    expect(clusters.reduce((s, c) => s + c.delta, 0n)).toBe(38n);
  });
  it("restores ALL exactly after repeated density toggles without mutating raw inputs or sealed buckets", () => {
    const source = finality(), before = json(source);
    const first = projectBubbles(source.bubbles, viewport(), undefined, undefined, options("ALL"));
    for (const mode of ["STANDARD", "HIGH_COMPRESSION", "ALL", "STANDARD", "ALL"] as const) {
      projectBubbles(source.bubbles, viewport(), undefined, undefined, options(mode));
    }
    expect(json(source)).toBe(before);
    expect(projectBubbles(source.bubbles, viewport(), undefined, undefined, options("ALL"))).toEqual(first);
    expect(DEFAULT_BUBBLE_FILTERS.volume.minimum).toBe(15);
  });
  it("preserves SHA-256 of full raw Trades and full original BubbleStates through modes and viewport operations", async () => {
    const state = finality();
    const digest = async () => {
      const input = new TextEncoder().encode(json({ raw: state.store.rawEvents, bubbles: state.bubbles }));
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
        .map(n => n.toString(16).padStart(2, "0")).join("");
    };
    const before = await digest(), v = viewport();
    for (const mode of ["ALL", "STANDARD", "HIGH_COMPRESSION", "ALL"] as const) {
      for (const view of [v, zoomTime(v, 1100, .3), panTime(v, 80),
        resizeViewport(v, { ...v.bounds, width: 1798 }, 2)]) {
        projectBubbles(state.bubbles, view, undefined, undefined, options(mode));
      }
      expect(await digest()).toBe(before);
    }
  });
  it("leaves the fifth PROVISIONAL source separate from FINAL", () => {
    const mixed = finality("DENSITY_MIXED", 2);
    const frame = projectBubbles(mixed.bubbles, viewport(), undefined, undefined,
      { mode: "STANDARD", continuity: [R10_CONTINUITY.DENSITY_MIXED] });
    expect(mixed.bubbles).toHaveLength(5);
    expect(frame.clusters).toHaveLength(3);
    expect(frame.clusters.filter(c => c.status === "PROVISIONAL")).toHaveLength(1);
    expect(frame.clusters.find(c => c.status === "PROVISIONAL")!.children).toHaveLength(1);
  });
});
describe("R10 original graph distances and deterministic components", () => {
  it.each([["STANDARD", 12], ["HIGH_COMPRESSION", 24]] as const)("uses arithmetic mean CSS diameter and inclusive %s threshold", (mode, distance) => {
    const p = points([100, 100 + distance]); p[0] = { ...p[0], diameter: 8 }; p[1] = { ...p[1], diameter: 24 };
    expect(clusterBubbles(p, options(mode))).toHaveLength(1);
    expect(clusterBubbles([p[0], { ...p[1], x: p[1].x + .000001 }], options(mode))).toHaveLength(2);
  });
  it("merges chain A-B-C even when A-C is not adjacent", () => {
    const p = points([0, 10, 20]), c = clusterBubbles(p, options());
    expect(c).toHaveLength(1); expect(c[0].childrenIds).toHaveLength(3);
    expect(c[0].spread.maxCenterDistance).toBe(20);
  });
  it("records a 20-source long chain with no unapproved maximum span cap", () => {
    const c = clusterBubbles(points(Array.from({ length: 20 }, (_, i) => i * 10)), options());
    expect(c).toHaveLength(1);
    expect(c[0].spread).toMatchObject({ width: 190, height: 0, maxCenterDistance: 190, footprintWidth: 206, footprintHeight: 16 });
    expect(c[0].diameter).toBe(24);
  });
  it("does not create a new edge from an enlarged merged diameter", () => {
    const c = clusterBubbles(points([0, 2, 14.3]), options());
    expect(c).toHaveLength(2);
    expect(c.map(c => c.children.length)).toEqual([2, 1]);
  });
  it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])("is invariant to permutation %j", (...order) => {
    const p = points([0, 10, 20]);
    expect(clusterBubbles(order.map(i => p[i]), options())).toEqual(clusterBubbles(p, options()));
  });
  it("has stable ALL identities and draw order regardless of source order", () => {
    const p = points([0, 1, 2]);
    expect(clusterBubbles([...p].reverse(), options("ALL"))).toEqual(clusterBubbles(p, options("ALL")));
  });
  it("uses volume-weighted coordinates and ratio of summed Delta/volume, not average biases", () => {
    const p = points([100, 110]);
    p[1] = { ...p[1], y: 110, source: { ...p[1].source, bucket: {
      ...p[1].source.bucket, B: 50n, S: 10n, V: 60n, V_raw: 60n, delta: 40n, imbalancePercent: 100 * 40 / 60,
    } } };
    const c = clusterBubbles(p, options("HIGH_COMPRESSION"))[0];
    expect(c.x).toBeCloseTo((100 * 27 + 110 * 60) / 87, 12);
    expect(c.y).toBeCloseTo((100 * 27 + 110 * 60) / 87, 12);
    expect(c.imbalancePercent).toBeCloseTo(59 / 87 * 100, 12);
    expect(c.imbalancePercent).not.toBe((70.37037037037037 + 66.66666666666667) / 2);
  });
  it("never mutates the projected array, geometry or nested source", () => {
    const p = points([0, 10, 20]), before = json(p);
    p.forEach(Object.freeze); Object.freeze(p);
    clusterBubbles(p, options()); expect(json(p)).toBe(before);
  });
  it("rejects duplicate membership, invalid geometry, invalid mode and re-clustering of prior aggregates", () => {
    const p = points([0, 1]);
    expect(() => clusterBubbles([p[0], p[0]], options())).toThrow(/Duplicate/);
    expect(() => clusterBubbles([{ ...p[0], x: NaN }], options())).toThrow(/CSS/);
    expect(() => clusterBubbles(p, { mode: "other" as BubbleDensity })).toThrow(/density/);
    const c = clusterBubbles(p, options())[0];
    expect(() => clusterBubbles([{ ...p[0], cluster: c }], options())).toThrow(/original/);
  });
});
describe("R10 scope, finality and exchange-time quality boundaries", () => {
  it("never merges opposing Delta signs even at identical positions", () => {
    const p = originalProjection().map(p => ({ ...p, x: 100, y: 100 }));
    expect(clusterBubbles(p, options()).map(c => c.children.length).sort()).toEqual([1, 3]);
  });
  it.each(["environment", "source", "sourceId", "canonicalInstrumentId", "sessionId"] as const)("never merges across %s", key => {
    const p = points([100, 101]);
    p[1] = { ...p[1], source: { ...p[1].source, bucket: { ...p[1].source.bucket,
      scope: { ...p[1].source.bucket.scope, [key]: key === "environment" ? "LIVE" : key === "source" ? "VERIFIED_VENDOR" : "DIFFERENT" },
    } } };
    expect(clusterBubbles(p, options())).toHaveLength(2);
  });
  it.each(["PROVISIONAL", "REVISED"] as const)("never mixes FINAL and %s", status => {
    const p = points([100, 101]); p[1] = { ...p[1], source: { ...p[1].source, status } };
    expect(clusterBubbles(p, options())).toHaveLength(2);
  });
  it("merges REVISED only with the same revision number", () => {
    const p = points([100, 101]).map(p => ({ ...p, source: { ...p.source, status: "REVISED" as const, revision: 1 } }));
    expect(clusterBubbles(p, options())).toHaveLength(1);
    p[1] = { ...p[1], source: { ...p[1].source, revision: 2 } };
    expect(clusterBubbles(p, options())).toHaveLength(2);
  });
  it.each(["UNKNOWN", "GAP", "INCOMPLETE", "FILTERED"] as const)("does not resurrect %s input", problem => {
    const p = points([100, 101]);
    const b = p[1].source.bucket;
    p[1] = { ...p[1], source: { ...p[1].source,
      status: problem === "INCOMPLETE" ? "INCOMPLETE" : "FINAL",
      bucket: problem === "UNKNOWN" ? { ...b, U: 5n, V: null, delta: null, status: "INCOMPLETE" }
        : problem === "GAP" ? { ...b, status: "INCOMPLETE", quality: ["TRADE_GAP"] }
        : problem === "FILTERED" ? { ...b, B: 12n, S: 14n, V: 26n, V_raw: 26n, delta: -2n, imbalancePercent: 2 / 26 * 100 } : b,
    } };
    expect(clusterBubbles(p, options())).toHaveLength(1);
    expect(clusterBubbles(p, options())[0].childrenIds).toEqual([p[0].source.id]);
  });
  it("keeps individual nodes without aligned evidence, even with matching timestamps", () => {
    expect(clusterBubbles(points([100, 101]), { mode: "STANDARD" })).toHaveLength(2);
    expect(clusterBubbles(points([100, 101]), optWith({ timeAxis: "RECEIVE_TIME" as "EXCHANGE_TIME_NS" }))).toHaveLength(2);
    expect(clusterBubbles(points([100, 101]), optWith({ alignmentEvidence: "" }))).toHaveLength(2);
  });
  it("rejects an unrelated evidence scope and competing evidence", () => {
    const p = points([100, 101]);
    expect(clusterBubbles(p, optWith({ scope: { ...continuity.scope, sessionId: "other" } }))).toHaveLength(2);
    expect(clusterBubbles(p, { mode: "STANDARD", continuity: [continuity, continuity] })).toHaveLength(2);
  });
  it.each(["GAP", "STALE", "NOT_INITIALIZED", "CLOSED", "OUTSIDE_DEPTH"] as const)("cannot bridge a %s interval", status => {
    const intervals = [q(0n, SEC), q(SEC, 2n * SEC, status), q(2n * SEC, 20n * SEC)];
    expect(clusterBubbles(points([100, 101]), qualityWith(intervals))).toHaveLength(2);
  });
  it("cannot bridge an unobserved interval or a one-nanosecond hole", () => {
    const p = points([100, 101]);
    expect(clusterBubbles(p, qualityWith([q(0n, SEC), q(2n * SEC, 20n * SEC)]))).toHaveLength(2);
    expect(clusterBubbles(p, qualityWith([q(0n, SEC), q(SEC + 1n, 20n * SEC)]))).toHaveLength(2);
  });
  it("can cross adjacent explicitly VALID intervals on the same aligned axis", () => {
    expect(clusterBubbles(points([100, 101]), qualityWith([q(0n, SEC), q(SEC, 20n * SEC)]))).toHaveLength(1);
  });
  it("cannot bridge an invalid zero-duration marker", () => {
    expect(clusterBubbles(points([100, 101]), qualityWith([q(0n, SEC), q(SEC, SEC, "GAP"), q(SEC, 20n * SEC)]))).toHaveLength(2);
  });
  it("treats overlapping, reversed, malformed or non-TRADES evidence as unverified", () => {
    const variants = [
      [q(0n, 3n * SEC), q(2n * SEC, 20n * SEC)], [q(2n * SEC, 20n * SEC), q(0n, SEC)],
      [{ ...q(0n, 20n * SEC), startNs: "1.2" }], [{ ...q(0n, 20n * SEC), channel: "L2_MBP" as const }],
    ];
    for (const intervals of variants) expect(clusterBubbles(points([100, 101]), qualityWith(intervals))).toHaveLength(2);
  });
});
describe("R10 shared viewport, draw/hover correspondence and lifecycle", () => {
  it.each([1158, 1798])("shows STANDARD4 and HIGH2 at 180s with CSS width %i", width => {
    const v = viewport(180, width);
    expect(projectBubbles(states, v, undefined, undefined, options()).clusters).toHaveLength(4);
    expect(projectBubbles(states, v, undefined, undefined, options("HIGH_COMPRESSION")).clusters).toHaveLength(2);
  });
  it("reclusters on zoom and HISTORY pan without resetting source states", () => {
    const v = viewport(), before = json(states);
    const zoom = zoomTime(v, 1100, .3);
    expect(projectBubbles(states, zoom, undefined, undefined, options()).clusters).toHaveLength(4);
    const away = panTime(v, v.bounds.width);
    expect(projectBubbles(states, away, undefined, undefined, options()).clusters).toHaveLength(0);
    expect(json(states)).toBe(before);
  });
  it("reclusters on resize using CSS dimensions, independently of DPR1/2", () => {
    const v = viewport(180), f = projectBubbles(states, v, undefined, undefined, options());
    expect(f.clusters).toHaveLength(4);
    const small = resizeViewport(v, { ...v.bounds, width: 400 }, 1);
    expect(projectBubbles(states, small, undefined, undefined, options()).clusters).toHaveLength(2);
    const dpr2 = projectBubbles(states, { ...v, dpr: 2 }, undefined, undefined, options());
    expect(dpr2.clusters).toEqual(f.clusters);
    expect(dpr2.vertexData).toEqual(f.vertexData);
  });
  it.each(["FIXED", "LINEAR", "SQRT", "LOG"] as const)("passes aggregate V into the unchanged %s size function", mode => {
    const sizing = { ...DEFAULT_BUBBLE_SIZING, mode };
    const c = projectBubbles(states, viewport(), sizing, undefined, options("HIGH_COMPRESSION")).clusters.find(c => c.children.length === 3)!;
    expect(c.diameter).toBe(bubbleDiameter(81n, sizing));
  });
  it("hits the actual drawn cluster and exposes each original source for expansion", () => {
    const f = projectBubbles(states, viewport(), undefined, undefined, options());
    const buy = f.bubbles.find(p => p.cluster!.children.length === 3)!;
    const hit = hitTestProjectedBubble(f, buy.x, buy.y)!;
    expect(hit).toBe(buy);
    expect(hit.cluster!.children.map(p => p.source)).toEqual(states.slice(0, 3));
    for (const child of hit.cluster!.children) expect(child.source.bucket.tradeIds).toHaveLength(3);
    expect(hitTestProjectedBubble(f, -1, -1)).toBeNull();
  });
  it("uploads cluster totals, positions, color and diameter to the GPU buffer, never representative-only totals", () => {
    const f = projectBubbles(states, viewport(), undefined, undefined, options());
    f.clusters.forEach((c, i) => {
      const data = f.vertexData.slice(i * 78, (i + 1) * 78);
      expect([...data.slice(9, 13)]).toEqual([Number(c.B), Number(c.S), Number(c.V), Number(c.delta)]);
      expect(data[8]).toBeCloseTo(c.diameter / 2, 5);
      expect(data[0]).toBeCloseTo(c.x - c.diameter / 2, 3);
      expect(data[1]).toBeCloseTo(c.y - c.diameter / 2, 3);
      expect(data[7]).toBeCloseTo(.92, 6);
    });
  });
  it("retains the latest density/options across actual renderer context callbacks without mutating input", () => {
    const fn = () => vi.fn();
    const gl = {
      createShader: vi.fn(() => ({})), createProgram: vi.fn(() => ({})), createBuffer: vi.fn(() => ({})),
      createVertexArray: vi.fn(() => ({})), getUniformLocation: vi.fn(() => ({})),
      getShaderParameter: vi.fn(() => true), getProgramParameter: vi.fn(() => true),
      shaderSource: fn(), compileShader: fn(), attachShader: fn(), linkProgram: fn(), deleteShader: fn(),
      enableVertexAttribArray: fn(), vertexAttribPointer: fn(), bindVertexArray: fn(), bindBuffer: fn(),
      deleteBuffer: fn(), deleteVertexArray: fn(), deleteProgram: fn(), viewport: fn(), disable: fn(),
      clearColor: fn(), clear: fn(), enable: fn(), scissor: fn(), blendFuncSeparate: fn(), useProgram: fn(),
      bufferData: fn(), uniform2f: fn(), drawArrays: fn(), getError: vi.fn(() => 0), isContextLost: vi.fn(() => false), NO_ERROR: 0, TRIANGLES: 4,
    };
    class Canvas extends EventTarget { width = 0; height = 0; getContext = vi.fn(() => gl); }
    const c = new Canvas(), renderer = new BubbleRenderer(c as unknown as HTMLCanvasElement);
    const source = finality(), before = json(source);
    renderer.draw(source.bubbles, viewport(180), undefined, undefined, options("STANDARD"));
    expect(renderer.lastFrame.clusters).toHaveLength(4);
    c.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    renderer.draw(source.bubbles, viewport(180), undefined, undefined, options("HIGH_COMPRESSION"));
    c.dispatchEvent(new Event("webglcontextrestored"));
    expect(renderer.status).toBe("READY");
    expect(renderer.lastFrame.clusters).toHaveLength(2);
    expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, 12);
    expect(json(source)).toBe(before);
    renderer.dispose();
  });
  it("leaves R09 without assumed quality alignment and preserves unchanged F04 reference values", () => {
    const s = R09_SCENARIOS.find(s => s.id === "F04")!;
    let state = createBubbleFinality(s.events[0].header, s.quality);
    for (const e of s.events) state = ingestBubbleTrade(state, e);
    const p = projectBubbles(state.bubbles, viewport(), undefined, undefined, { mode: "STANDARD" }).bubbles[0];
    expect([p.source.bucket.B, p.source.bucket.S, p.source.bucket.V, p.source.bucket.delta]).toEqual([23n, 4n, 27n, 19n]);
    expect(p.diameter).toBeCloseTo(16.313843876330612, 12);
    expect(p.rgba[3]).toBe(.45);
  });
});
