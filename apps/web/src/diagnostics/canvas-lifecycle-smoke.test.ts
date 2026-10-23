import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
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
    getContext(_contextId?: string) { return gl; }
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
  new Canvas().getContext("webgl2");
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

function gpuFixture(timer: object | null | undefined = null, fault?: string) {
  const lose = vi.fn(), context = {
    RENDERER: 4,
    getParameter: vi.fn(() => {
      if (fault === "renderer") throw Error("RENDERER_QUERY_FAILED");
      return "synthetic renderer";
    }),
    getExtension: vi.fn((name: string): object | null | undefined => {
      if (name === "WEBGL_debug_renderer_info") return { UNMASKED_RENDERER_WEBGL: 7 };
      if (name === "EXT_disjoint_timer_query_webgl2") {
        if (fault === "extension") throw Error("EXTENSION_QUERY_FAILED");
        return timer;
      }
      return { loseContext: lose };
    }),
  };
  const getContext = vi.fn(() => {
    if (fault === "context-throw") throw Error("CONTEXT_QUERY_FAILED");
    return fault === "no-context" ? null : context;
  });
  return { context, getContext, lose, run: () => runInNewContext(`(${smoke.observeGpu.toString()})()`, {
    document: { createElement: () => ({ getContext }) },
  }) };
}
for (const supported of [false, true]) {
  it(`observes real query return for timerExtension ${supported}`, () => {
    const f = gpuFixture(supported ? {} : null);
    expect(f.run()).toEqual({ webgl2: true, renderer: "synthetic renderer", timerExtension: supported });
    expect(f.getContext).toHaveBeenCalledWith("webgl2");
    expect(f.context.getParameter).toHaveBeenCalledWith(7);
    expect(f.context.getExtension).toHaveBeenCalledWith("EXT_disjoint_timer_query_webgl2");
    expect(f.lose).toHaveBeenCalledOnce();
  });
}
for (const fault of ["renderer", "extension", "no-context", "context-throw"]) {
  it(`GPU ${fault} failure is an explicit error, not false`, () => {
    expect(() => gpuFixture(null, fault).run()).toThrow("GPU_OBSERVATION_FAILED");
  });
}
it("undefined extension result is not unsupported false", () => {
  const f = gpuFixture();
  f.context.getExtension.mockImplementation((name: string) => name === "EXT_disjoint_timer_query_webgl2"
    ? undefined : { loseContext: f.lose });
  expect(f.run).toThrow("GPU_TIMER_EXTENSION_UNOBSERVED");
});
const startupBaseline = policy.loadE2Baseline((p: string) => readFile(new URL(`../../../../${p}`, import.meta.url)));
it("all three GPU fields must match the verified immutable E2 baseline before input", async () => {
  const b = await startupBaseline, e = JSON.parse(b.environment), input = vi.fn(() => "started");
  expect(await smoke.afterStartupVerification(e.chromium, e.gpu, e.dpr, b, input)).toBe("started");
  expect(input).toHaveBeenCalledOnce();
});
for (const field of ["webgl2", "renderer", "timerExtension"]) {
  it(`rejects missing ${field} without starting input`, async () => {
    const b = await startupBaseline, e = JSON.parse(b.environment), gpu = { ...e.gpu }, input = vi.fn();
    delete gpu[field];
    await expect(smoke.afterStartupVerification(e.chromium, gpu, e.dpr, b, input))
      .rejects.toThrow("GPU_SCHEMA_INCOMPLETE");
    expect(input).not.toHaveBeenCalled();
  });
}
it("real timerExtension mismatch rejects input rather than normalizing it to E2", async () => {
  const b = await startupBaseline, e = JSON.parse(b.environment), input = vi.fn();
  await expect(smoke.afterStartupVerification(e.chromium,
    { ...e.gpu, timerExtension: !e.gpu.timerExtension }, e.dpr, b, input)).rejects.toThrow("E2_GPU_MISMATCH");
  expect(input).not.toHaveBeenCalled();
});
function pageCleanupSnapshot(baselineRecorded = true) {
  return { resources: { intervals: 0, raf: 0 },
    ownership: { records: [], initial: [], baselineRecorded, limited: false, unrecorded: 0, unknownCreations: 0 },
    phase: { contexts: [] as { created: number; deleted: number; invalidated: number; liveBuffers: number }[],
      limited: false, unrecorded: 0 },
    layers: [] as object[], gl: { totals: { heatmap: { contexts: 0 }, bubble: { contexts: 0 } } } };
}
function cleanupRunFixture(status = "FAIL", failure: string | undefined = status === "FAIL" ? "ORIGINAL_GPU_FAILURE" : undefined) {
  const order: string[] = [];
  const io = {
    pageAvailable: () => true,
    exitPage: vi.fn(async () => { order.push("page"); }),
    snapshot: vi.fn(async () => pageCleanupSnapshot()),
    finishBrowser: vi.fn(async () => {
      order.push("browser");
      return { status: "PASS", reason: null as string | null, signal: { attempted: false } };
    }),
    inspectGroup: vi.fn(async () => {
      order.push("group"); return { live: [] as number[], zombies: [] as number[] };
    }),
    removeProfile: vi.fn(async () => { order.push("profile"); }),
    persistEvidence: vi.fn(async () => { order.push("evidence"); }),
    evidenceFailure: vi.fn(),
  };
  return { report: { status, failure }, io, order };
}
for (const stage of ["before GPU comparison", "after GPU comparison"]) {
  it(`early failure ${stage} remains FAIL after successful cleanup`, async () => {
    const f = cleanupRunFixture("FAIL", stage), r = await smoke.cleanupPhase(f.report, f.io);
    expect(r.status).toBe("FAIL"); expect(r.failure).toBe(stage);
    expect(r.cleanup.page.status).toBe("PASS"); expect(r.cleanup.browser.status).toBe("PASS");
    expect(r.phaseBEligible).toBe(false);
    expect(f.order).toEqual(["page", "browser", "group", "profile", "evidence"]);
  });
}
it("baseline absence remains UNKNOWN even with zero observed intervals", async () => {
  const f = cleanupRunFixture();
  f.io.snapshot.mockResolvedValue(pageCleanupSnapshot(false));
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.cleanup.page.status).toBe("UNKNOWN");
  expect(r.failure).toBe("ORIGINAL_GPU_FAILURE"); expect(r.termination.status).toBe("PASS");
  expect(r.chromiumCleanup.profileRemoved).toBe(true);
});
it("an unobserved page cannot become a PASS or an assumed empty resource set", async () => {
  const f = cleanupRunFixture();
  f.io.pageAvailable = () => false;
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.cleanup.page.status).toBe("NOT_OBSERVED"); expect(r.cleanupPage).toBeUndefined();
  expect(f.io.snapshot).not.toHaveBeenCalled(); expect(f.io.finishBrowser).toHaveBeenCalledOnce();
});
it("independent absence of Canvas and both context observers permits NOT_APPLICABLE buffers", () => {
  expect(smoke.assessPageCleanup(pageCleanupSnapshot())).toMatchObject({
    status: "PASS", buffers: { status: "NOT_APPLICABLE" },
  });
  const unproven = pageCleanupSnapshot(); unproven.layers.push({});
  expect(smoke.assessPageCleanup(unproven).status).toBe("UNKNOWN");
});
it("normal exit with verified deleted buffers can remain PASS", async () => {
  const f = cleanupRunFixture("PASS", undefined), snapshot = pageCleanupSnapshot();
  snapshot.phase.contexts.push({ created: 3, deleted: 2, invalidated: 1, liveBuffers: 0 });
  f.io.snapshot.mockResolvedValue(snapshot);
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.status).toBe("PASS"); expect(r.phaseBEligible).toBe(true);
  expect(r.cleanup.profile.status).toBe("PASS");
});
it("page cleanup error preserves original failure and still closes browser and persists both errors", async () => {
  const f = cleanupRunFixture(); f.io.exitPage.mockRejectedValue(Error("PAGE_EXIT_FAULT"));
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.failure).toBe("ORIGINAL_GPU_FAILURE");
  expect(r.cleanupFailure).toContain("PAGE_EXIT_FAULT"); expect(r.cleanup.page.status).toBe("FAIL");
  expect(f.io.finishBrowser).toHaveBeenCalledOnce(); expect(f.io.persistEvidence).toHaveBeenCalledOnce();
});
it("Browser.close failure and unknown ownership retain FAIL without signaling a foreign PID", async () => {
  const signal = vi.fn();
  const termination = policy.createBrowserTermination({
    close: async () => { throw Error("CLOSE_FAULT"); }, exited: () => false, holdsLeader: () => false,
    inspect: async () => ({ processes: [{ ...leader, startTicks: "901" }], live: [991], zombies: [] }),
    waitExit: async () => {}, signal, recover: async () => {},
  }, { trialId: "offline-close-fault", started: leader });
  const f = cleanupRunFixture();
  f.io.finishBrowser.mockImplementation(() => termination.finish());
  f.io.inspectGroup.mockResolvedValue({ live: [991], zombies: [] });
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.termination.status).toBe("FAIL"); expect(r.failure).toBe("ORIGINAL_GPU_FAILURE");
  expect(signal).not.toHaveBeenCalled(); expect(r.phaseBEligible).toBe(false);
});
it("profile deletion failure is retained separately from the original failure", async () => {
  const f = cleanupRunFixture(); f.io.removeProfile.mockRejectedValue(Error("PROFILE_DELETE_FAULT"));
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.failure).toBe("ORIGINAL_GPU_FAILURE"); expect(r.cleanup.profile.status).toBe("FAIL");
  expect(r.chromiumCleanup.profileRemoved).toBe(false); expect(r.phaseBEligible).toBe(false);
});
it("unobserved process groups are not invented as empty and profiles are preserved", async () => {
  const f = cleanupRunFixture(); f.io.inspectGroup.mockRejectedValue(Error("GROUP_UNOBSERVED"));
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.chromiumCleanup).toBeUndefined(); expect(f.io.removeProfile).not.toHaveBeenCalled();
  expect(r.status).toBe("FAIL");
});
it("residual processes prohibit profile deletion and formal continuation", async () => {
  const f = cleanupRunFixture("PASS", undefined);
  f.io.inspectGroup.mockResolvedValue({ live: [991], zombies: [] });
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.status).toBe("FAIL"); expect(f.io.removeProfile).not.toHaveBeenCalled();
  expect(r.phaseBEligible).toBe(false);
});
it("SIGKILL cannot become PASS even if group inspection is empty afterwards", async () => {
  const f = cleanupRunFixture("PASS", undefined);
  f.io.finishBrowser.mockResolvedValue({ status: "FAIL", reason: "FORCED", signal: { attempted: true } });
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(r.status).toBe("FAIL"); expect(r.phaseBEligible).toBe(false);
});
it("evidence write failure occurs after safe shutdown and remains FAIL", async () => {
  const f = cleanupRunFixture("PASS", undefined);
  f.io.persistEvidence.mockRejectedValue(Error("EVIDENCE_DISK_FAULT"));
  const r = await smoke.cleanupPhase(f.report, f.io);
  expect(f.io.finishBrowser).toHaveBeenCalledOnce(); expect(f.io.removeProfile).toHaveBeenCalledOnce();
  expect(r.cleanup.evidence.status).toBe("FAIL"); expect(r.phaseBEligible).toBe(false);
  expect(f.io.evidenceFailure).toHaveBeenCalledOnce(); expect(r.status).toBe("FAIL");
});
it("evidence case failure stops subsequent cases before cleanup orchestration", async () => {
  const next = vi.fn();
  await expect(smoke.runCases([{ name: "first", run: async () => ({ status: "PASS" }) },
    { name: "next", run: next }], async () => { throw Error("CASE_WRITE_FAILED"); })).rejects.toThrow("CASE_WRITE_FAILED");
  expect(next).not.toHaveBeenCalled();
});

function continuationFixture(layer = "heatmap", scenario = "B") {
  const hash = (revision: number) => revision.toString().padStart(64, "0");
  const bytes = 6 * (layer === "heatmap" ? 32 : 52);
  const references = Array.from({ length: 7 }, (_, i) => ({ layer, revision: i + 2,
    bytes, vertices: 6, sha256: hash(i + 2) }));
  const restoredRevision = scenario === "A" ? 2 : 4;
  const snapshot = (revision: number, lost: boolean, restore: number) => ({
    canvas: { id: 11, connected: true, revision, lost, loss: lost || restore ? 1 : 0, restore },
    source: { revision, counts: { inputs: revision, accepted: revision, duplicate: 0, rejected: 0 } },
    size: { width: 403, height: 324, status: lost ? "CONTEXT LOST" : "READY" },
    raf: { reserved: 2, executed: 2, cancelled: 0, live: 0 },
    gl: { errors: 0 }, inputGate: { fault: null }, limited: false, release: { status: "PASS" },
    emptyPixels: { canvasId: 11, revision, defaultFramebuffer: true, rgba: Array(20).fill(0),
      colorMask: [true, true, true, true], error: 0 },
    rows: [] as Record<string, unknown>[],
  });
  const draw = (revision: number, native = false) => ({ kind: "draw", layer, canvasId: 11, revision,
    tokenRevision: native ? null : revision, uploadSerial: revision + 1,
    bytes, vertices: 6, sha256: hash(revision), lost: false });
  const transfer = (revision: number) => [
    { kind: "clearColor", layer, canvasId: 11, revision,
      rgba: layer === "bubble" ? [0, 0, 0, 0] : [8 / 255, 9 / 255, 13 / 255, 1] },
    { kind: "clear", layer, canvasId: 11, revision, lost: false, mask: 16384, scissor: false },
    { kind: "upload", layer, canvasId: 11, revision, lost: false, uploadSerial: revision + 1,
      bytes, sha256: hash(revision) },
  ];
  const before = snapshot(2, false, 0), lost = snapshot(restoredRevision, true, 0);
  lost.rows.push({ kind: "contextlost", layer, canvasId: 11 });
  const restored = snapshot(restoredRevision, false, 1);
  restored.rows.push({ kind: "contextrestored", layer, canvasId: 11 }, ...transfer(restoredRevision), draw(restoredRevision, true));
  const followups = Array.from({ length: 8 - restoredRevision }, (_, i) => {
    const revision = restoredRevision + i + 1, s = snapshot(revision, false, 1);
    s.raf.reserved += i + 1; s.raf.executed += i + 1;
    s.rows.push({ kind: "reserve", layer, canvasId: 11, revision, rafId: revision },
      { kind: "execute", layer, canvasId: 11, revision, rafId: revision }, ...transfer(revision), draw(revision));
    return s;
  });
  const stopped = { ...snapshot(8, false, 1), source: null };
  return { c: { layer, scenario, before, lost, restored, followups, stopped }, references };
}
for (const layer of ["heatmap", "bubble"]) for (const scenario of ["A", "B"]) {
  it(`E5 ${layer} ${scenario} validates same-Canvas native replay then every continuous GPU draw`, () => {
    const { c, references } = continuationFixture(layer, scenario), result = smoke.assessContinuation(c, references);
    expect(result.status).toBe("PASS"); expect(result.canvasId).toBe(11);
    expect(result.continuedRevisions).toEqual(scenario === "A" ? [3, 4, 5, 6, 7, 8] : [5, 6, 7, 8]);
    expect(c.restored.rows.at(-1)!.tokenRevision).toBeNull();
    expect(c.followups.every(s => s.rows.at(-1)!.tokenRevision === s.source.revision)).toBe(true);
  });
}
const mutations: [string, (c: ReturnType<typeof continuationFixture>["c"]) => void, string][] = [
  ["missing revision", c => { c.followups.splice(1, 1); }, "CONTINUATION_SEQUENCE_MISSING"],
  ["missing draw", c => { c.followups[0].rows.pop(); }, "CONTINUATION_DRAW_MISSING"],
  ["duplicate draw", c => { c.followups[0].rows.push({ ...c.followups[0].rows.at(-1)! }); }, "CONTINUATION_DUPLICATE_DRAW"],
  ["changed Canvas", c => { c.followups[0].canvas.id = 99; }, "CANVAS_IDENTITY_CHANGED"],
  ["wrong GPU hash", c => { c.followups[0].rows.at(-1)!.sha256 = "tampered"; }, "CONTINUATION_GPU_MISMATCH"],
  ["wrong GPU bytes", c => { c.followups[0].rows.at(-1)!.bytes = 48; }, "CONTINUATION_GPU_MISMATCH"],
  ["wrong vertices", c => { c.followups[0].rows.at(-1)!.vertices = 12; }, "CONTINUATION_GPU_MISMATCH"],
  ["stale callback", c => { c.followups[0].rows.at(-1)!.tokenRevision = 4; }, "NATIVE_VS_RAF_REVISION"],
  ["second context loss", c => { c.followups[0].canvas.loss = 2; }, "CONTEXT_RELOST_OR_REPLACED"],
  ["lost GPU draw", c => { c.lost.rows.push({ kind: "draw" }); }, "CONTINUATION_DRAW_WHILE_LOST"],
  ["unobserved restore event", c => { c.restored.rows.shift(); }, "RESTORE_EVENT_UNOBSERVED"],
  ["native replay via rAF", c => { c.restored.rows.push({ kind: "execute" }); }, "NATIVE_REPLAY_VIA_RAF"],
  ["cancelled normal callback", c => { c.followups[0].rows.push({ kind: "cancel" }); }, "CONTINUATION_RAF_CORRESPONDENCE"],
  ["GL error", c => { c.followups[0].gl.errors = 1282; }, "CONTINUATION_GL_ERRORS"],
  ["late stop draw", c => { c.stopped.rows.push({ kind: "draw" }); }, "DRAW_AFTER_STOP"],
];
for (const [name, mutate, reason] of mutations) {
  it(`E5 rejects ${name} without upgrading the result`, () => {
    const { c, references } = continuationFixture(); mutate(c);
    expect(smoke.assessContinuation(c, references)).toMatchObject({ status: "FAIL", reason: expect.stringContaining(reason) });
  });
}
it("E5 missing independent GPU reference is UNKNOWN, never PASS", () => {
  const { c } = continuationFixture();
  expect(smoke.assessContinuation(c, [])).toEqual({ status: "UNKNOWN", reason: "CONTINUATION_REFERENCE_MISSING" });
});
it("E5 R3 reference requires a single nonempty hashed payload for every layer/revision", () => {
  const rows = ["heatmap", "bubble"].flatMap(layer => continuationFixture(layer).references
    .map(r => ({ kind: "draw", canvasId: layer === "heatmap" ? 1 : 2, tokenRevision: r.revision, lost: false, ...r })));
  const report = { status: "PASS", control: { phase: { rows } } };
  expect(smoke.continuationReferences(report, createHash("sha256").update(JSON.stringify(report)).digest("hex"))).toHaveLength(14);
  expect(() => smoke.continuationReferences({ ...report, status: "FAIL" })).toThrow("NOT_PASS");
  expect(() => smoke.continuationReferences({ status: "PASS", control: { phase: { rows: rows.slice(1) } } }))
    .toThrow("AMBIGUOUS");
  expect(() => smoke.continuationReferences({ status: "PASS", control: { phase: { rows: [...rows, rows[0]] } } }))
    .toThrow("AMBIGUOUS");
});
it("E5 source gate defers timer ticks, preserves original inputs and leaves 250ms notices untouched", () => {
  let revision = 0;
  const timers: { fn: () => void; ms: number }[] = [], input = vi.fn(() => revision++), notice = vi.fn();
  const original = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  const fakeWindow = { setInterval: original,
    __orderflowMockDiagnostics: { progress: () => ({ status: { revision } }) } };
  function SourceError(message?: string) {
    const error = Error(message);
    error.stack = "at start (http://localhost/src/lib/mockAnalysisSession.ts:119:7)";
    return error;
  }
  // Callable and constructible, like native Error; returned errors retain their
  // host Error prototype across the VM boundary and the source-identifying stack.
  SourceError.prototype = Error.prototype;
  const errors = runInNewContext('[Error("called"), new Error("constructed")]', { Error: SourceError }) as Error[];
  expect(errors.map(error => error.message)).toEqual(["called", "constructed"]);
  for (const error of errors) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SourceError);
    expect(error.name).toBe("Error");
    expect(error.stack).toContain("/src/lib/mockAnalysisSession.ts:119:7");
  }
  expect(() => runInNewContext('throw Error("realm rejection")', { Error: SourceError })).toThrow(Error);
  runInNewContext(`(${smoke.installContinuationInputGate.toString()})()`, { window: fakeWindow, Error: SourceError, performance });
  const gate = (fakeWindow as typeof fakeWindow & { __canvasContinuationInput: {
    setCeiling: (n: number) => void; snapshot: () => { delivered: number; deferredTicks: number; fault: string | null };
    dispose: () => void;
  } }).__canvasContinuationInput;
  fakeWindow.setInterval(input, 300); fakeWindow.setInterval(notice, 250);
  for (let i = 0; i < 4; i++) { timers[0].fn(); timers[1].fn(); }
  expect(input).toHaveBeenCalledTimes(2); expect(notice).toHaveBeenCalledTimes(4);
  expect(gate.snapshot()).toMatchObject({ delivered: 2, deferredTicks: 2, fault: null });
  gate.setCeiling(4); timers[0].fn(); timers[0].fn();
  expect(revision).toBe(4); expect(timers.map(t => t.ms)).toEqual([300, 250]);
  expect(() => gate.setCeiling(9)).toThrow("CEILING");
  gate.dispose(); expect(fakeWindow.setInterval).toBe(original);
  expect(() => timers[0].fn()).toThrow("AFTER_DISPOSE");
});
it("E5 four-case plan is Heatmap A/B then Bubble A/B and never starts formal trials", () => {
  const cases = smoke.continuationCases({});
  expect(cases.map((c: { name: string }) => c.name)).toEqual([
    "E5 heatmap Scenario A", "E5 heatmap Scenario B", "E5 bubble Scenario A", "E5 bubble Scenario B"]);
  expect(cases.every((c: { gate: string }) => c.gate === "core")).toBe(true);
});
it("E5 actual continuation FAIL is preserved in evidence and prevents the next case", async () => {
  const { c, references } = continuationFixture(); c.followups[0].rows.pop();
  const record = vi.fn(), next = vi.fn();
  expect(await smoke.runCases([{ name: "E5", gate: "core", run: async () => smoke.assessContinuation(c, references) },
    { name: "not run", run: next }], record)).toBe(false);
  expect(record.mock.calls[0][0].status).toBe("FAIL"); expect(next).not.toHaveBeenCalled();
});

const emptyPayloadSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const jsonSha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function referenceFixture() {
  const rows = ["heatmap", "bubble"].flatMap(layer => continuationFixture(layer).references.map(r => ({
    kind: "draw", canvasId: layer === "heatmap" ? 1 : 2, tokenRevision: r.revision, lost: false, ...r,
    sha256: createHash("sha256").update(new Uint8Array(r.bytes).fill(r.revision)).digest("hex"),
  })));
  Object.assign(rows.find(r => r.layer === "bubble" && r.revision === 2)!,
    { vertices: 0, bytes: 0, sha256: emptyPayloadSha });
  const report = { status: "PASS", control: { phase: { rows } } };
  return { report, rows, pin: jsonSha(report) };
}
it("R2 accepts the unique semantically permitted empty reference and fixed nonempty geometry", () => {
  const { report, pin } = referenceFixture(), refs = smoke.continuationReferences(report, pin);
  expect(refs).toHaveLength(14);
  expect(refs.filter((r: { bytes: number }) => r.bytes === 0))
    .toEqual([{ layer: "bubble", revision: 2, bytes: 0, vertices: 0, sha256: emptyPayloadSha }]);
  expect(createHash("sha256").update(new Uint8Array()).digest("hex")).toBe(emptyPayloadSha);
  expect(refs.filter((r: { bytes: number }) => r.bytes > 0)).toHaveLength(13);
});
const invalidReference: [string, Record<string, unknown>, boolean][] = [
  ["negative vertices", { vertices: -6 }, false],
  ["negative bytes", { bytes: -312 }, false],
  ["NaN vertices", { vertices: NaN }, false],
  ["NaN bytes", { bytes: NaN }, false],
  ["missing vertices", { vertices: undefined }, false],
  ["missing bytes", { bytes: undefined }, false],
  ["fractional vertices", { vertices: 6.5 }, false],
  ["fractional bytes", { bytes: 312.5 }, false],
  ["zero vertices with nonzero bytes", { vertices: 0 }, false],
  ["zero bytes with nonzero vertices", { bytes: 0 }, false],
  ["wrong stride", { bytes: 192 }, false],
  ["wrong empty SHA", { sha256: "a".repeat(64) }, true],
  ["missing SHA", { sha256: undefined }, true],
  ["noninteger zero", { vertices: "0" }, true],
  ["wrong nonempty SHA", { sha256: "a".repeat(64) }, false],
  ["empty hash with nonempty geometry", { sha256: emptyPayloadSha }, false],
  ["empty required-nonempty revision", { vertices: 0, bytes: 0, sha256: emptyPayloadSha }, false],
  ["wrong revision", { revision: 9 }, false],
  ["wrong layer", { layer: "delta" }, false],
  ["invalid Canvas identifier", { canvasId: 0 }, false],
  ["wrong token revision", { tokenRevision: 77 }, false],
  ["lost source", { lost: true }, false],
];
for (const [name, patch, empty] of invalidReference) {
  it(`R2 rejects ${name} without weakening the reference pin`, () => {
    const { report, rows, pin } = referenceFixture();
    Object.assign(rows.find(r => r.layer === "bubble" && r.revision === (empty ? 2 : 5))!, patch);
    expect(() => smoke.continuationReferences(report, pin)).toThrow();
  });
}
it("R2 rejects reference duplication and missing references even when content is self-consistent", () => {
  const { report, rows } = referenceFixture(); rows.push({ ...rows[0] });
  expect(() => smoke.continuationReferences(report, jsonSha(report))).toThrow("AMBIGUOUS");
  rows.pop(); rows.shift();
  expect(() => smoke.continuationReferences(report, jsonSha(report))).toThrow("AMBIGUOUS");
});
it("R2 production reference pin cannot be replaced by an artificial matching payload", () => {
  expect(() => smoke.continuationReferences(referenceFixture().report)).toThrow("CONTENT_HASH");
});
function emptyContinuationFixture() {
  const { c, references } = continuationFixture("bubble", "A");
  Object.assign(references[0], { bytes: 0, vertices: 0, sha256: emptyPayloadSha });
  for (const row of c.restored.rows) if (row.kind === "draw" || row.kind === "upload")
    Object.assign(row, { bytes: 0, sha256: emptyPayloadSha, ...(row.kind === "draw" ? { vertices: 0 } : {}) });
  return { c, references };
}
it("R2 empty native replay still requires observed clear, actual zero upload and zero-vertex draw", () => {
  const { c, references } = emptyContinuationFixture();
  expect(smoke.assessContinuation(c, references).status).toBe("PASS");
  expect(c.restored.rows.filter(r => r.kind === "draw")).toHaveLength(1);
  expect(c.restored.rows.find(r => r.kind === "draw")!.vertices).toBe(0);
  expect(c.followups.map(s => s.source.revision)).toEqual([3, 4, 5, 6, 7, 8]);
});
for (const kind of ["upload", "clear", "clearColor", "draw"]) {
  it(`R2 does not mistake absent ${kind} for an empty native frame`, () => {
    const { c, references } = emptyContinuationFixture();
    c.restored.rows = c.restored.rows.filter(r => r.kind !== kind);
    expect(smoke.assessContinuation(c, references).status).toBe("FAIL");
  });
}
it("R2 empty payload does not hide retained visible pixels", () => {
  const { c, references } = emptyContinuationFixture(); c.restored.emptyPixels.rgba[3] = 255;
  expect(smoke.assessContinuation(c, references)).toMatchObject({ status: "FAIL",
    reason: expect.stringContaining("EMPTY_NOT_TRANSPARENT") });
});
it("R2 rejects an upload silently reused from a previous draw", () => {
  const { c, references } = emptyContinuationFixture();
  c.restored.rows.find(r => r.kind === "draw")!.uploadSerial = 99;
  expect(smoke.assessContinuation(c, references).status).toBe("FAIL");
});
for (const revision of [5, 6, 7, 8]) {
  it(`R2 missing real draw at continued revision ${revision} remains FAIL`, () => {
    const { c, references } = emptyContinuationFixture();
    const frame = c.followups.find(s => s.source.revision === revision)!;
    frame.rows = frame.rows.filter(r => r.kind !== "draw");
    expect(smoke.assessContinuation(c, references)).toMatchObject({ status: "FAIL",
      reason: expect.stringContaining("DRAW_MISSING") });
  });
}
it("R2 observer independently records clear, empty transfer, zero draw and transparent framebuffer samples", async () => {
  const reads = vi.fn();
  class GL {
    ARRAY_BUFFER = 34962; COLOR_BUFFER_BIT = 16384; SCISSOR_TEST = 3089;
    READ_FRAMEBUFFER_BINDING = 1; DRAW_FRAMEBUFFER_BINDING = 2; COLOR_WRITEMASK = 3;
    RGBA = 6408; UNSIGNED_BYTE = 5121;
    createBuffer() { return {}; } deleteBuffer() {} bufferData(_target: number, _data: Float32Array) {}
    drawArrays(_mode: number, _offset: number, _count: number) {} clearColor(..._color: number[]) {} clear(_mask: number) {}
    isContextLost() { return false; } isEnabled(_parameter: number) { return false; }
    getParameter(parameter: number) { return parameter === this.COLOR_WRITEMASK ? [true, true, true, true] : null; }
    readPixels(...args: unknown[]) { reads(...args); } getError() { return 0; }
  }
  const gl = new GL();
  class Canvas {
    dataset = { revision: "2" }; classList = { contains: (name: string) => name === "bb-canvas" };
    width = 403; height = 324; isConnected = true;
    getContext(_kind: string) { return gl; } addEventListener() {} removeEventListener() {}
  }
  const win = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
  runInNewContext(`(${smoke.installPhaseObserver.toString()})()`, {
    window: win, HTMLCanvasElement: Canvas, WebGL2RenderingContext: GL, performance, crypto: webcrypto, structuredClone,
  });
  const observer = (win as typeof win & { __canvasPhaseA: {
    snapshot(): Promise<{ rows: Record<string, unknown>[] }>;
    emptyPixels(layer: string): { rgba: number[]; sampleCount: number }; dispose(): void;
  } }).__canvasPhaseA;
  try {
    new Canvas().getContext("webgl2"); gl.clearColor(0, 0, 0, 0); gl.clear(16384);
    gl.bufferData(34962, new Float32Array()); gl.drawArrays(4, 0, 0);
    const s = await observer.snapshot();
    expect(s.rows.map(r => r.kind)).toEqual(["clearColor", "clear", "upload", "draw"]);
    expect(s.rows[2]).toMatchObject({ bytes: 0, sha256: emptyPayloadSha, uploadSerial: 1 });
    expect(s.rows[3]).toMatchObject({ vertices: 0, bytes: 0, sha256: emptyPayloadSha, uploadSerial: 1 });
    expect(observer.emptyPixels("bubble")).toMatchObject({ sampleCount: 5, rgba: Array(20).fill(0) });
    expect(reads).toHaveBeenCalledTimes(5);
  } finally { observer.dispose(); }
});
