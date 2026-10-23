import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
const modulePath = "./canvas-lifecycle-smoke.mjs";
const smoke = await import(modulePath);
const baselinePath = "./baseline13-driver.mjs";
const policy = await import(baselinePath);

it("import has no main/browser side effects and formal source is pinned", async () => {
  expect(smoke.resourceObserverSource(await readFile(resolve("src/diagnostics/baseline13-driver.mjs"), "utf8")))
    .toContain("function installResourceObserver");
  expect(() => smoke.resourceObserverSource("tampered")).toThrow("FORMAL_DRIVER_CHANGED");
});
for (const status of ["PASS", "FAIL", "UNKNOWN", "NOT_SUPPORTED"]) {
  it(`retains ${status} rather than upgrading observations`, async () => {
    const rows: { status: string }[] = [];
    await smoke.runCases([{ name: "case", gate: "extended", run: async () => ({ status }) }],
      async (row: { status: string }) => rows.push(row));
    expect(rows[0].status).toBe(status);
  });
}
it("stops after an actual extended FAIL", async () => {
  const next = vi.fn();
  expect(await smoke.runCases([
    { name: "first", gate: "extended", run: async () => ({ status: "FAIL" }) },
    { name: "next", run: next },
  ], async () => {})).toBe(false);
  expect(next).not.toHaveBeenCalled();
});
it("UNKNOWN core cannot authorize the next case", async () => {
  const next = vi.fn();
  expect(await smoke.runCases([{ name: "core", gate: "core", run: async () => ({ status: "UNKNOWN" }) },
    { run: next }], async () => {})).toBe(false);
  expect(next).not.toHaveBeenCalled();
});
it("exceptions are FAIL, not UNKNOWN, and evidence is recorded", async () => {
  const record = vi.fn();
  expect(await smoke.runCases([{ name: "throws", run: async () => { throw Error("actual fault"); } }], record)).toBe(false);
  expect(record.mock.calls[0][0]).toMatchObject({ status: "FAIL", reason: "Error: actual fault" });
});
it("accounts reservations, executions, cancellations and live IDs separately", () => {
  expect(smoke.rafAccounting({ reserved: 5, executed: 2, cancelled: 1, live: 2 })).toBe(true);
  expect(smoke.rafAccounting({ reserved: 5, executed: 3, cancelled: 3, live: 0 })).toBe(false);
});
it("observer counts actual callback/cancel paths and restores using the pre-loss extension", async () => {
  const callbacks = new Map<number, (t: number) => void>();
  const listeners = new Map<string, () => void>();
  let id = 0, lost = false;
  const ext = {
    loseContext() { lost = true; listeners.get("webglcontextlost")?.(); },
    restoreContext() { lost = false; listeners.get("webglcontextrestored")?.(); },
  };
  class GL {
    createBuffer() { return {}; }
    deleteBuffer() {}
    bufferData() {}
    drawArrays() {}
    isContextLost() { return lost; }
    getExtension() { return lost ? null : ext; }
  }
  const gl = new GL();
  class Canvas {
    classList = { contains: (name: string) => name === "hm-canvas" };
    dataset = { revision: "1" };
    isConnected = true;
    getContext() { return gl; }
    addEventListener(name: string, cb: () => void) { listeners.set(name, cb); }
    removeEventListener(name: string) { listeners.delete(name); }
  }
  const fakeWindow = {
    requestAnimationFrame: (cb: (t: number) => void) => { callbacks.set(++id, cb); return id; },
    cancelAnimationFrame: (n: number) => callbacks.delete(n),
  };
  class StackError extends Error { stack = "at /components/HeatmapCanvas.tsx:1:1"; }
  runInNewContext(`(${smoke.installPhaseObserver.toString()})()`, {
    window: fakeWindow, WebGL2RenderingContext: GL, HTMLCanvasElement: Canvas,
    performance, crypto: webcrypto, Error: StackError, structuredClone,
  });
  const observer = (fakeWindow as typeof fakeWindow & { __canvasPhaseA: {
    snapshot: () => Promise<{ totals: { heatmap: { reserved: number; executed: number; cancelled: number; live: number } };
      contexts: { loss: number; restore: number }[] }>;
    intervene: (layer: string, action: string) => string;
  } }).__canvasPhaseA;
  new Canvas().getContext();
  const first = fakeWindow.requestAnimationFrame(() => {});
  callbacks.get(first)!(10);
  fakeWindow.cancelAnimationFrame(fakeWindow.requestAnimationFrame(() => {}));
  expect((await observer.snapshot()).totals.heatmap).toEqual({ reserved: 2, executed: 1, cancelled: 1, live: 0 });
  expect(observer.intervene("heatmap", "lose")).toBe("REQUESTED");
  expect(observer.intervene("heatmap", "restore")).toBe("REQUESTED");
  expect((await observer.snapshot()).contexts[0]).toMatchObject({ loss: 1, restore: 1 });
});
it("rejects a missing draw", () => {
  expect(() => smoke.verifyDrawCoverage([{ kind: "draw", layer: "heatmap", revision: 1, tokenRevision: 1 }], 1))
    .toThrow("MISSING_DRAW");
});
it("rejects mismatching source and committed revisions", () => {
  expect(() => smoke.verifyDrawCoverage([{ kind: "draw", layer: "heatmap", revision: 1, tokenRevision: 2 }], 1))
    .toThrow("MIXED_REVISION");
});
const valid = { restored: true, timedOut: false, lostDraws: 0, expectedHash: "abc",
  rows: [{ revision: 4, tokenRevision: 4, sha256: "abc" }] };
it("accepts an independently matched restored payload", () => {
  expect(smoke.assessRestore(valid).status).toBe("PASS");
});
it("unknown restore reference is not PASS", () => {
  expect(smoke.assessRestore({ ...valid, expectedHash: undefined }).status).toBe("UNKNOWN");
});
it("restore timeout is FAIL", () => {
  expect(smoke.assessRestore({ ...valid, timedOut: true }).reason).toBe("CONTEXT_RESTORE_TIMEOUT");
});
it("draw while lost is FAIL", () => {
  expect(smoke.assessRestore({ ...valid, lostDraws: 1 }).reason).toBe("DRAW_WHILE_LOST");
});
it("missing restore draw is FAIL", () => {
  expect(smoke.assessRestore({ ...valid, rows: [] }).reason).toBe("RESTORE_DRAW_MISSING");
});
it("wrong restored payload is FAIL", () => {
  expect(smoke.assessRestore({ ...valid, expectedHash: "other" }).reason).toBe("RESTORE_GPU_PAYLOAD_MISMATCH");
});
it("duplicate identical restore uploads are not silently accepted", () => {
  expect(smoke.assessRestore({ ...valid, rows: [valid.rows[0], { ...valid.rows[0], tokenRevision: null }] }).reason)
    .toBe("DUPLICATE_RESTORE_DRAW");
});
it("evidence is persisted, bounded, hashed and never overwritten", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "canvas-phase-offline-"));
  try {
    const path = resolve(dir, "evidence.json"), record = await smoke.saveEvidence(path, { status: "FAIL" });
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ status: "FAIL" });
    await expect(smoke.saveEvidence(path, {})).rejects.toThrow();
    await expect(smoke.saveEvidence(resolve(dir, "big"), "x".repeat(2097152))).rejects.toThrow("EVIDENCE_LIMIT");
  } finally { await rm(dir, { recursive: true }); }
});
const leader = { pid: 991, ppid: 900, pgid: 991, sid: 991, uid: 1000, startTicks: "900", state: "S" };
function cleanupFixture(reused = false, graceful = true) {
  let exited = false;
  const signal = vi.fn();
  const current = { ...leader, startTicks: reused ? "901" : "900" };
  const io = { close: async () => { if (graceful) exited = true; }, exited: () => exited,
    waitExit: async () => {}, holdsLeader: () => !exited, signal, recover: async () => {},
    inspect: async () => ({ processes: exited ? [] : [current], live: exited ? [] : [991], zombies: [] }) };
  return { signal, policy: policy.createBrowserTermination(io, { trialId: "offline", started: leader }) };
}
it("normal close and cleanup issue no signal", async () => {
  const f = cleanupFixture();
  expect((await f.policy.finish()).status).toBe("PASS");
  expect(f.signal).not.toHaveBeenCalled();
});
it("stale PID identity can never authorize a signal", async () => {
  const f = cleanupFixture(true, false);
  const r = await f.policy.finish();
  expect(r.status).toBe("FAIL"); expect(r.ownership.reason).toBe("PID_OR_PGID_REUSED");
  expect(f.signal).not.toHaveBeenCalled();
});
it("forced cleanup never changes FAIL to PASS and blocks subsequent trials", async () => {
  const f = cleanupFixture(false, false), r = await f.policy.finish();
  expect(r.status).toBe("FAIL"); expect(r.subsequentTrial).toBe("BLOCKED");
  expect(f.signal).toHaveBeenCalledWith(-991, "SIGKILL");
});
it("wall timeout is permanently FAIL even with graceful cleanup", async () => {
  const f = cleanupFixture(), r = await f.policy.wallTimeout();
  expect(r.status).toBe("FAIL"); expect(r.reason).toBe("BROWSER_WALL_TIMEOUT");
  expect((await f.policy.finish()).status).toBe("FAIL");
});
