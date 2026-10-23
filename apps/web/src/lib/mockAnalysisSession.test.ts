import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNIFIED_MOCK_STREAM as source } from "@workspace/fixtures";
import { createAnalysisHub, type AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import { createMockAnalysisSession, type MockSessionOptions } from "./mockAnalysisSession";

const options = (patch: Partial<MockSessionOptions> = {}): MockSessionOptions => ({
  scope: source.scope, inputs: source.inputs, query: source.query, ...patch,
});
const session = (patch: Partial<MockSessionOptions> = {}) => createMockAnalysisSession(options(patch));

describe("finite offline MOCK analysis session lifecycle", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] }));
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it("does not start input, timers or notifications on creation/subscription", () => {
    const s = session(), listener = vi.fn();
    s.subscribe(listener);
    expect(s.getStatus()).toMatchObject({ state: "IDLE", processedInputs: 0, timers: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(() => s.readFrame()).toThrow();
    s.dispose();
  });
  it("publishes a coalesced same-revision stream equal to synchronous all-input processing", () => {
    const s = session(), notifications: AnalysisRenderFrame[] = [], times: number[] = [];
    s.subscribe(frame => { notifications.push(frame); times.push(performance.now()); });
    s.start();
    vi.advanceTimersByTime(1000);
    expect(s.getStatus()).toMatchObject({
      state: "COMPLETED", reason: "INPUT_EXHAUSTED", processedInputs: source.inputs.length, timers: 0,
      processedMarketEvents: 11, acceptedMarketEvents: 11,
    });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.length).toBeLessThan(source.inputs.length);
    times.slice(1).forEach((t, i) => expect(t - times[i]).toBeGreaterThanOrEqual(250));
    expect(notifications.at(-1)!.revision).toBe(source.inputs.length);
    notifications.forEach(f => {
      for (const section of [f.book, f.bubbles, f.delta, f.heatmap, f.volumeProfile, f.quality]) {
        expect(section.revision).toBe(f.revision);
      }
    });
    const hub = createAnalysisHub(source.scope, () => 0);
    source.inputs.forEach(input => hub.ingest(input));
    expect(s.readFrame()).toEqual(hub.readRenderFrame(source.query));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps accepting while notifications are disabled and completes without a timer leak", () => {
    const s = session(), listener = vi.fn();
    s.subscribe(listener); s.setNotificationsEnabled(false); s.start();
    vi.advanceTimersByTime(1000);
    expect(listener).not.toHaveBeenCalled();
    expect(s.getStatus()).toMatchObject({ state: "COMPLETED", processedInputs: 13, timers: 0 });
    expect(s.readFrame().volumeProfile.value!.totals.totalVolume).toBe(43n);
  });
  it("notification pause/resume never replays or loses input", () => {
    const s = session(), frames: AnalysisRenderFrame[] = [];
    s.subscribe(f => frames.push(f));
    s.start(); vi.advanceTimersByTime(250);
    const count = frames.length;
    s.setNotificationsEnabled(false); vi.advanceTimersByTime(200);
    expect(s.getStatus().processedInputs).toBe(9);
    expect(frames).toHaveLength(count);
    s.setNotificationsEnabled(true); vi.advanceTimersByTime(500);
    expect(s.getStatus().processedInputs).toBe(13);
    expect(frames.at(-1)!.volumeProfile.value!.totals.totalVolume).toBe(43n);
    expect(s.getStatus().timers).toBe(0);
  });
  it("rejects double start and resets hub/counters/POC/VA on explicit restart", () => {
    const s = session();
    s.start();
    expect(() => s.start()).toThrow();
    vi.advanceTimersByTime(1000);
    const previous = s.readFrame();
    s.start();
    expect(s.getStatus().processedInputs).toBe(0);
    expect(s.readFrame().volumeProfile.value!.valueArea.valTick).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(s.readFrame()).toEqual(previous);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("manual stop frees timers; further time advancement never consumes inputs", () => {
    const s = session(); s.start(); vi.advanceTimersByTime(150);
    s.stop();
    const n = s.getStatus().processedInputs;
    vi.advanceTimersByTime(5000);
    expect(s.getStatus()).toMatchObject({ state: "STOPPED", reason: "MANUAL_STOP", processedInputs: n, timers: 0 });
    expect(vi.getTimerCount()).toBe(0);
    s.dispose();
  });
  it("unsubscribe/dispose release subscriptions, source execution and retained hub", () => {
    const s = session(), callback = vi.fn(), unsubscribe = s.subscribe(callback);
    s.start(); unsubscribe(); vi.advanceTimersByTime(250);
    expect(callback).not.toHaveBeenCalled();
    s.dispose();
    expect(s.getStatus()).toMatchObject({ state: "DISPOSED", subscribers: 0, timers: 0 });
    expect(() => s.start()).toThrow();
    expect(() => s.subscribe(callback)).toThrow();
    expect(() => s.readFrame()).toThrow();
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("subscriber-triggered stop cannot be restarted reentrantly or leave callbacks running", () => {
    const s = session(), next = vi.fn();
    s.subscribe(() => { expect(() => s.start()).toThrow(); s.stop(); });
    s.subscribe(next); s.start(); vi.advanceTimersByTime(300);
    expect(next).not.toHaveBeenCalled();
    expect(s.getStatus()).toMatchObject({ state: "STOPPED", timers: 0 });
  });
  it("subscriber exceptions stop the session and clear both timers", () => {
    const s = session();
    s.subscribe(() => { throw new Error("Artificial subscriber failure"); });
    s.start(); vi.advanceTimersByTime(300);
    expect(s.getStatus()).toMatchObject({
      state: "STOPPED", reason: "NOTIFICATION_OR_PROJECTION_FAILED", timers: 0,
    });
  });
  it("a bad bounded render query publishes no partial frame and stops notification/input", () => {
    const s = session({ query: { ...source.query,
      endNs: (BigInt(source.query.startNs) + 100_000_000_000n).toString(), cells: [] } });
    const callback = vi.fn(); s.subscribe(callback); s.start(); vi.advanceTimersByTime(300);
    expect(callback).not.toHaveBeenCalled();
    expect(s.getStatus()).toMatchObject({ state: "STOPPED", timers: 0 });
  });
  it("input budget failure retains the last committed analysis and clears resources", () => {
    const s = session({ scope: { ...source.scope, budget: { ...source.scope.budget, trades: 1 } } });
    s.start(); vi.advanceTimersByTime(1000);
    expect(s.getStatus()).toMatchObject({
      state: "STOPPED", reason: "BUDGET_EXCEEDED", processedInputs: 5, timers: 0,
    });
    expect(s.readFrame().volumeProfile.value!.totals.totalVolume).toBe(12n);
  });
  it("empty input is finite, completes immediately and creates no timers", () => {
    const s = session({ inputs: [] }); s.start();
    expect(s.getStatus()).toMatchObject({ state: "COMPLETED", processedInputs: 0, timers: 0 });
  });
  it("owns its bounded source and query instead of observing caller mutations", () => {
    const inputs = [...source.inputs], query = { ...source.query, cells: [...source.query.cells] };
    const s = session({ inputs, query });
    inputs.length = 0; query.cells.length = 0;
    s.start(); vi.advanceTimersByTime(1000);
    expect(s.getStatus().processedInputs).toBe(13);
    expect(s.readFrame().heatmap.cells).toHaveLength(7);
  });
  it("bounds subscriptions without silently dropping listeners", () => {
    const s = session({ maxSubscribers: 1 }), a = vi.fn(), b = vi.fn();
    const off = s.subscribe(a);
    expect(() => s.subscribe(b)).toThrow("Subscriber budget exceeded");
    off(); s.subscribe(b); s.dispose();
  });
  it.each([0, -1, Infinity, NaN])("rejects unsafe input intervals %s", inputEveryMs => {
    expect(() => session({ inputEveryMs })).toThrow();
  });
  it("refuses an oversized source/query before starting any timers", () => {
    expect(() => session({ scope: { ...source.scope,
      budget: { ...source.scope.budget, inputs: 1 } } })).toThrow();
    expect(() => session({ scope: { ...source.scope,
      budget: { ...source.scope.budget, normalizedBytes: 1 } } })).toThrow();
    expect(() => session({ query: { ...source.query,
      cells: Array(513).fill(source.query.cells[0]) } })).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("counts normalized events inside a batch against the finite source cap", () => {
    expect(() => session({ inputs: [{ type: "BATCH",
      events: Array(513).fill(source.inputs[0].event) }] })).toThrow("market-event budget");
  });
});
