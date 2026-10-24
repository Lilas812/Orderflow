import { it, expect, vi } from "vitest";
import fs from "node:fs";
import { createPublicationPump, publicationCleanupGate } from "../../web/src/diagnostics/load29-browser/publicationPump";
import { createMockAnalysisSession } from "../../web/src/lib/mockAnalysisSession";
import { deltaLayoutGate } from "../diagnostics/verify";
import { deltaDrawingGate } from "../../web/src/diagnostics/load29-browser/contracts";
import { projectDeltaTimeline } from "@workspace/core/delta-timeline";

const reflected = (r: number) => ({ react: r, heatmap: r, bubble: r, delta: r, volumeProfile: r });
function harness(wallMs = 2000) {
  let status = { state: "RUNNING", revision: 127 }, ui = reflected(0);
  const publishes: { at: number; revision: number }[] = [], failures: unknown[] = [];
  let completed = 0;
  const pump = createPublicationPump({ period: 250, wallMs,
    status: () => status, observe: () => ui,
    publish: at => { publishes.push({ at, revision: status.revision }); return status.revision; },
    complete: () => completed++, failure: e => failures.push(String(e)), now: () => Date.now() });
  return { pump, publishes, failures, setStatus: (s: typeof status) => { status = s; },
    reflect: (r: number) => { ui = reflected(r); },
    missDelta: () => { ui.delta--; }, completed: () => completed };
}
it("keeps COMPLETED hub128/published127 pending until a normal 250ms opportunity and all four actual observations", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness();
  try {
    h.pump.start(); vi.advanceTimersByTime(250); h.reflect(127);
    h.setStatus({ state: "COMPLETED", revision: 128 });
    vi.advanceTimersByTime(249);
    expect(h.pump.snapshot()).toMatchObject({ done: false, published: 127, timers: 1 });
    expect(() => h.pump.stop()).toThrow("UNDELIVERED");
    vi.advanceTimersByTime(1);
    expect(h.pump.snapshot()).toMatchObject({ inputComplete: true, hub: 128, published: 128, done: false });
    h.reflect(128); h.missDelta(); vi.advanceTimersByTime(250);
    expect(h.completed()).toBe(0);
    h.reflect(128); vi.advanceTimersByTime(250);
    expect(h.completed()).toBe(1);
    expect(h.pump.snapshot()).toMatchObject({ done: true, timers: 0, reflected: reflected(128) });
    vi.advanceTimersByTime(500);
    expect(h.publishes).toEqual([{ at: 250, revision: 127 }, { at: 500, revision: 128 }]);
    expect(h.failures).toEqual([]); h.pump.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally { h.pump.dispose(); vi.useRealTimers(); }
});
it("fails finitely if UI never reflects a final publication, without making duplicate publications", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = harness(1000);
  try {
    h.setStatus({ state: "COMPLETED", revision: 128 });
    h.pump.start(); vi.advanceTimersByTime(1000);
    expect(h.publishes).toHaveLength(1);
    expect(h.failures).toEqual(["Error: FINAL_PUBLICATION_TIMEOUT"]);
    expect(h.pump.snapshot()).toMatchObject({ done: false, timers: 0, ended: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally { h.pump.dispose(); vi.useRealTimers(); }
});
it("rejects wrong/duplicate publication revision and does not call completion", () => {
  vi.useFakeTimers();
  const errors: string[] = [];
  const p = createPublicationPump({ period: 250, wallMs: 1000,
    status: () => ({ state: "COMPLETED", revision: 128 }),
    publish: () => 127, observe: () => reflected(128),
    complete: () => { throw Error("FALSE_COMPLETION"); }, failure: e => errors.push(String(e)) });
  try { p.start(); vi.advanceTimersByTime(250); expect(errors).toEqual(["Error: PUBLICATION_REVISION"]); }
  finally { p.dispose(); vi.useRealTimers(); }
});
it("runs the real saved session at 300ms and publication pump at 250ms through final reflection and cleanup", () => {
  vi.useFakeTimers();
  const d = JSON.parse(fs.readFileSync("../../.local/diagnostics/task29-a/stage0-input.json", "utf8"));
  const session = createMockAnalysisSession({ ...d, inputEveryMs: 300 });
  session.setNotificationsEnabled(false);
  let ui = reflected(0), complete = false;
  const revisions: number[] = [], times: number[] = [], errors: unknown[] = [];
  const p = createPublicationPump({ period: 250, wallMs: 70000, status: session.getStatus,
    publish(at) {
      const frame = session.readFrame(d.query); revisions.push(frame.revision); times.push(at);
      // Model real asynchronous paint observation, not the publish call.
      setTimeout(() => { ui = reflected(frame.revision); }, 16);
      return frame.revision;
    }, observe: () => ui, complete: () => { complete = true; }, failure: e => errors.push(e) });
  try {
    session.start(); p.start();
    vi.advanceTimersByTime(38400);
    expect(session.getStatus()).toMatchObject({ state: "COMPLETED", revision: 128 });
    expect(p.snapshot().done).toBe(false);
    vi.advanceTimersByTime(600);
    expect(complete).toBe(true); expect(errors).toEqual([]);
    expect(revisions.at(-1)).toBe(128); expect(new Set(revisions).size).toBe(revisions.length);
    expect(times.slice(1).every((t, i) => t - times[i] >= 250)).toBe(true);
    expect(p.snapshot().reflected).toEqual(reflected(128));
    p.stop(); session.dispose();
    expect(publicationCleanupGate({ timers: p.snapshot().timers + session.getStatus().timers,
      subscribers: session.getStatus().subscribers, pending: vi.getTimerCount() })).toBe(true);
  } finally { p.dispose(); session.dispose(); vi.useRealTimers(); }
});
for (const field of ["timers", "subscribers", "pending"]) it(`refuses leftover ${field} after cleanup`, () => {
  expect(() => publicationCleanupGate({ timers: 0, subscribers: 0, pending: 0, [field]: 1 })).toThrow("REMAINDER");
});

const interval = { start: { at: 20, generation: 3, snapshot: { geometry: { dpr: 1 } } }, end: 100 };
function draw(width: number, phase: string, generation: number, at: number) {
  return { kind: "delta-draw", revision: 0, width, height: 126, canvasId: 1, contextId: 2,
    started: at, ended: at + 1, viewport: { dpr: 1, bounds: { width } },
    layout: { phase, generation, at, dpr: 1, cssWidth: width, cssHeight: 126 } };
}
it("validates initial887 and settled647 independently even at the same data revision0", () => {
  expect(deltaLayoutGate(draw(887, "initial", 0, 1), interval, 647)).toMatchObject({ phase: "initial", width: 887 });
  expect(deltaLayoutGate(draw(647, "initial", 3, 10), interval, 647)).toMatchObject({ phase: "initial", width: 647 });
  expect(deltaLayoutGate(draw(647, "formal", 3, 21), interval, 647)).toMatchObject({ phase: "formal", width: 647 });
});
it("rejects post-start geometry/generation/DPR changes and mislabelled periods rather than filtering them", () => {
  for (const d of [draw(887, "formal", 3, 21), draw(647, "formal", 4, 21),
    draw(647, "initial", 3, 21), draw(647, "formal", 3, 10), draw(647, "ended", 3, 99)]) {
    expect(() => deltaLayoutGate(d, interval, 647)).toThrow();
  }
  const d = draw(647, "formal", 3, 21); d.layout.dpr = 2;
  expect(() => deltaLayoutGate(d, interval, 647)).toThrow();
});
it("keeps empty revision0 NO DATA distinct from real bins at either initial width", () => {
  const empty = projectDeltaTimeline([], { dpr: 1, bounds: { left: 0, top: 0, width: 647, height: 324 },
    time: { minNs: "0", maxNs: "1000" }, price: null, latestNs: null, timeMode: "LIVE",
    priceMode: "AUTO", priceData: "NO TRADE PRICE" }, 126);
  const d = { ...draw(647, "initial", 3, 10), binRows: [],
    placeholders: [{ text: "NO DATA: no Delta bin", hasBinFields: false }],
    operations: [{ api: "fillRect", style: "#08090d", args: [0, 0, 647, 126] }] };
  expect(deltaDrawingGate(d, empty, 0, 647)).toMatchObject({ empty: true, validBins: 0 });
  expect(() => deltaDrawingGate({ ...d, binRows: [{ id: "extra" }] }, empty, 0, 647)).toThrow("BIN_COUNT");
  expect(() => deltaDrawingGate({ ...d, placeholders: [{ text: "NO DATA: no Delta bin", hasBinFields: true }] },
    empty, 0, 647)).toThrow("PLACEHOLDER_INVALID");
});
