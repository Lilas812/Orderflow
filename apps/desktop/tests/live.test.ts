import { expect, it, vi } from "vitest";
import { createDesktopLiveController } from "../main/liveController";
import { createObservationSession } from "../renderer/observationSession";
import { observationLadder } from "../../web/src/lib/observationDisplay";
import { createViewport } from "@workspace/core/viewport";
import type { LiveFrame } from "@workspace/core/analysis-hub";

const url = "orderflow://app/index.html";
const sender = { owned: true, mainFrame: true, url };
const rawBook = JSON.stringify({ type: "book", symbol: "NQ", ts: 1767225600,
  bids: [[20000, 17], [19999.75, 0]], asks: [[20000.25, 9]], imbalance: 0 });
function harness() {
  const controller = createDesktopLiveController(url, () => Date.now());
  controller.syntheticTestOnly();
  const call = (op: string, generation: number) => Promise.resolve(controller.command(sender, { op, generation }));
  return { controller, transport: { select: () => call("select", 0), read: (g: number) => call("read", g),
    stop: (g: number) => call("stop", g), release: (g: number) => call("release", g) } };
}
it("runs synthetic wire -> parser -> Node hub -> bounded IPC -> 250ms renderer publication -> 4 display revisions", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, transport } = harness();
  const published: LiveFrame[] = [];
  const session = createObservationSession(transport, d => { if (d.frame) published.push(d.frame); });
  try {
    await session.start();
    expect(published[0]).toMatchObject({ state: "HOLD", label: "SIMULATED / LIVE PIPELINE" });
    expect(controller.receive(rawBook, "book", 1, "1767225600000000000", "0")).toBe(true);
    await vi.advanceTimersByTimeAsync(249); expect(published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const frame = published.at(-1)!;
    expect(frame.book.levels).toHaveLength(3);
    expect([frame.book, frame.heatmap, frame.bubbles, frame.delta].map(p => p.revision)).toEqual([1, 1, 1, 1]);
    const vp = createViewport({ bounds: { left: 0, top: 0, width: 600, height: 400 }, dpr: 1,
      latestNs: "1767225600000000000", price: { minTick: 79998, maxTick: 80003 } });
    const view = observationLadder(frame, vp);
    expect(view.identity).toBeNull(); expect(view.topOfBookGuaranteed).toBe(false);
    expect(view.rows.find(r => r.priceTicks === 80000)?.bid).toEqual({ status: "KNOWN", qty: 17 });
    expect(view.rows.find(r => r.priceTicks === 79999)?.bid).toEqual({ status: "KNOWN", qty: 0 });
    expect(view.rows.find(r => r.priceTicks === 79998)?.bid).toEqual({ status: "UNKNOWN", qty: null });
    session.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(published).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
    expect(controller.receive(rawBook, "book", 1, "1767225600000000000", "0")).toBe(false);
  } finally { session.dispose(); controller.dispose(); vi.useRealTimers(); }
});
it("validates the owned window, main frame, exact document, fixed operations and primitive request shape", () => {
  const { controller } = harness();
  for (const invalid of [{ ...sender, owned: false }, { ...sender, mainFrame: false },
    { ...sender, url: url + "#other" }, { ...sender, url: "https://preview.test/" }]) {
    expect(() => controller.command(invalid, { op: "select", generation: 0 })).toThrow("IPC_SENDER");
  }
  for (const request of [null, [], { op: "arbitrary", generation: 0 },
    { op: "select", generation: 0, raw: "secret" }, { op: {}, generation: 0 },
    { op: "read", generation: NaN }, { op: "select", generation: 1 }]) {
    expect(() => controller.command(sender, request)).toThrow();
  }
  controller.dispose();
  expect(() => controller.command(sender, { op: "select", generation: 0 })).toThrow("IPC_SENDER");
});
it("rejects stale-generation reads/receives and clears data on navigation, restart and shutdown", () => {
  const { controller } = harness();
  controller.command(sender, { op: "select", generation: 0 });
  controller.receive(rawBook, "book", 1, "1767225600000000000", "0");
  controller.invalidate();
  expect(() => controller.command(sender, { op: "read", generation: 1 })).toThrow("IPC_GENERATION");
  const next = controller.command(sender, { op: "select", generation: 0 });
  expect(next).toMatchObject({ generation: 2, frame: { accepted: 0, book: { levels: [] } } });
  expect(controller.receive(rawBook, "book", 1, "1767225600000000000", "0")).toBe(false);
  expect(() => controller.command(sender, { op: "release", generation: 1 })).toThrow("IPC_GENERATION");
  controller.dispose();
});
it("leaves actual reception on HOLD even if a Node caller tries to inject an actual response", () => {
  const controller = createDesktopLiveController(url, () => 0);
  expect(controller.command(sender, { op: "select", generation: 0 })).toMatchObject({
    frame: { state: "HOLD", reason: expect.stringContaining("NOT_CONNECTED") },
  });
  expect(controller.receive(rawBook, "book", 1, "1767225600000000000", "0")).toBe(false);
  controller.dispose();
});
it("stops on oversized or unsupported input rather than silently losing coverage", () => {
  for (const raw of ["x".repeat(1024 * 1024 + 1), "{}", JSON.stringify({ type: "warning" })]) {
    const { controller } = harness();
    controller.command(sender, { op: "select", generation: 0 });
    expect(controller.receive(raw, "book", 1, "1767225600000000000", "0")).toBe(false);
    // Stopped hub cannot accept subsequent seemingly valid input.
    expect(controller.receive(rawBook, "book", 1, "1767225600000000000", "0")).toBe(false);
    controller.dispose();
  }
});
it("has only one in-flight read and cannot publish after dispose while select is still pending", async () => {
  vi.useFakeTimers();
  const { controller, transport } = harness();
  const read = vi.fn(() => new Promise<Awaited<ReturnType<typeof transport.read>>>(() => {}));
  const s = createObservationSession({ ...transport, read }, () => {});
  try {
    await s.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledOnce(); s.dispose(); expect(vi.getTimerCount()).toBe(0);
    let resolve!: (value: Awaited<ReturnType<typeof transport.select>>) => void;
    const release = vi.fn(transport.release), publish = vi.fn();
    const pending = createObservationSession({ ...transport,
      select: () => new Promise(r => { resolve = r; }), release }, publish);
    const start = pending.start(); pending.dispose();
    resolve(await transport.select()); await start;
    expect(publish).toHaveBeenCalledOnce(); // initial NO DATA only
    expect(release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  } finally { s.dispose(); controller.dispose(); vi.useRealTimers(); }
});
it("clears all displayed quantities and stops polling on a nonresponding IPC instead of retaining a stale snapshot", async () => {
  vi.useFakeTimers();
  const { controller, transport } = harness();
  const publish = vi.fn();
  const s = createObservationSession({ ...transport, read: () => new Promise(() => {}) }, publish);
  try {
    await s.start(); await vi.advanceTimersByTimeAsync(2250);
    expect(publish).toHaveBeenLastCalledWith({ frame: null, reason: "IPC_FAILED; NO DATA" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { s.dispose(); controller.dispose(); vi.useRealTimers(); }
});
