import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createAnalysisHub, analysisInputBytes, type AnalysisDecision, type AnalysisInput, type AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import { validateMarketEvent, type Trade } from "@workspace/core/events";
import { calculateTimeWeightedDepth } from "@workspace/core/time-weighted-depth";
import { canonical, checkExpected } from "../../bench/runAnalysisBenchmark";
import { makeWorkload, at } from "../../bench/finiteMockWorkload";
import { definition, sha256, type Definition } from "./generator";
import { LIMITS, distribution, checkDirectory, save } from "./evidence";

const ROOT = ".local/diagnostics/task29-a";
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function validate(d: Definition) {
  assert.equal(d.label, "MOCK / SIMULATED");
  assert.equal(d.scope.config.identity.environment, "MOCK");
  assert.equal(d.scope.config.identity.source, "MOCK_DETERMINISTIC");
  assert.equal(sha256(JSON.stringify(d.inputs)), d.inputSha256);
  const caps = makeWorkload("cells128").scope;
  for (const key of Object.keys(caps.budget) as (keyof typeof caps.budget)[]) {
    assert(Number.isSafeInteger(d.scope.budget[key]) && d.scope.budget[key] >= 0 &&
      d.scope.budget[key] <= caps.budget[key], `EXISTING_CAP:${key}`);
  }
  assert(d.inputs.length <= d.scope.budget.inputs);
  assert(d.query.cells.length <= caps.derivedViews!.maxHeatmapCells);
  assert(d.scope.derivedViews && d.scope.volumeProfile);
  for (const key of ["maxHeatmapCells", "maxBubbles", "maxDeltaBins"] as const) {
    assert(d.scope.derivedViews[key] <= caps.derivedViews![key], `PROJECTION_CAP:${key}`);
  }
  assert(d.scope.volumeProfile.maxPriceLevels <= caps.volumeProfile!.maxPriceLevels);
  let bytes = 0, last = BigInt(d.scope.startNs);
  for (const input of d.inputs) {
    bytes += analysisInputBytes(input);
    if (input.type === "EVENT") {
      validateMarketEvent(input.event);
      for (const k of ["environment", "source", "sourceId", "canonicalInstrumentId", "sessionId"] as const) {
        assert.equal(input.event.header[k], d.scope.config.identity[k], "SCOPE");
      }
    }
    const t = BigInt(time(input)); assert(t >= last, "INPUT_TIME_ORDER"); last = t;
  }
  assert(bytes <= d.scope.budget.normalizedBytes, "INPUT_BYTES");
  assert(BigInt(d.query.endNs) <= last, "FUTURE_WINDOW");
  return { bytes, inputs: d.inputs.length };
}
function time(x: AnalysisInput): string {
  if (x.type === "EVENT") return x.event.header.receiveTimeNs;
  if (x.type === "CONDITION") return x.atNs;
  if (x.type === "QUALITY_INTERVAL") return x.observedAtNs;
  throw new Error("BATCH_NOT_SUPPORTED_BY_LOAD29_GENERATOR");
}
function finite(value: unknown): void {
  if (typeof value === "number") assert(Number.isFinite(value), "NONFINITE");
  else if (Array.isArray(value)) value.forEach(finite);
  else if (value && typeof value === "object") Object.values(value).forEach(finite);
}
/** Actual core hub; no session timers, network, fake reducers, or browser imports.
 * Notification clock is virtual market elapsed time, NEVER advertised as real-time 4Hz.
 */
export function replay(d: Definition, options: { wallMs?: number; records?: number } = {}) {
  const inputInfo = validate(d), wallMs = options.wallMs ?? LIMITS.wallMs;
  const recordLimit = options.records ?? LIMITS.records;
  assert(wallMs > 0 && wallMs <= LIMITS.wallMs);
  assert(recordLimit >= 0 && recordLimit <= LIMITS.records);
  const cpu0 = process.cpuUsage(), started = performance.now();
  let clock = 0, frameCount = 0;
  let lastFrame: AnalysisRenderFrame | null = null;
  const hub = createAnalysisHub(d.scope, () => clock);
  const decisions: AnalysisDecision[] = [], ingest: number[] = [];
  const reads: { revision: number; missMs: number; hitMs: number; identical: boolean }[] = [];
  const memory: { input: number; rss: number; heapUsed: number; heapTotal: number }[] = [];
  const transitions: { input: number; channel: string; status: string; bookAvailable: boolean }[] = [];
  const notices: { revision: number; virtualMs: number }[] = [];
  let failure: string | null = null;
  const sample = () => {
    const m = process.memoryUsage();
    memory.push({ input: decisions.length, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal });
    if (m.rss > LIMITS.childRss) throw new Error("CHILD_RSS");
  };
  const guard = () => {
    if (performance.now() - started > wallMs) throw new Error("WALL_LIMIT");
    if (decisions.length + reads.length + memory.length + transitions.length + notices.length > recordLimit) {
      throw new Error("RECORD_LIMIT");
    }
  };
  function readPair() {
    const t = performance.now(), frame = hub.readRenderFrame(d.query), mid = performance.now();
    const hit = hub.readRenderFrame(d.query), end = performance.now();
    assert(frame !== lastFrame && (!lastFrame || frame.revision > lastFrame.revision), "MISS_REVISION_IDENTITY");
    lastFrame = frame;
    reads.push({ revision: frame.revision, missMs: mid - t, hitMs: end - mid, identical: hit === frame });
    frameCount += 2;
    assert.equal(hit, frame, "CACHE_HIT_IDENTITY");
    for (const p of [frame.book, frame.heatmap, frame.bubbles, frame.delta, frame.volumeProfile, frame.quality]) {
      assert.equal(p.revision, frame.revision, "ATOMIC_REVISION");
    }
    guard();
    return frame;
  }
  sample();
  try {
    for (const input of d.inputs) {
      guard(); clock = Number(BigInt(time(input)) - BigInt(d.scope.startNs)) / 1e6;
      const t = performance.now(), decision = hub.ingest(input), elapsed = performance.now() - t;
      decisions.push(decision); ingest.push(elapsed); guard();
      if (decision.stop || decision.disposition !== "ACCEPTED") throw new Error(
        `INPUT_${decision.disposition}:${decision.reason}`);
      if (input.type === "CONDITION" || input.type === "EVENT" && input.event.kind === "L2_SNAPSHOT") {
        const v = hub.read();
        for (const channel of ["L2_MBP", "TRADES"] as const) transitions.push({
          input: decisions.length, channel, status: v.qualityState.timeline[channel].at(-1)!.status,
          bookAvailable: v.book !== null,
        });
      }
      const notice = hub.pollNotice();
      if (notice) { notices.push({ revision: notice.revision, virtualMs: clock }); readPair(); }
      if (decisions.length % 16 === 0) sample();
    }
    // Drain only the virtual notification clock, not synthetic observation time.
    clock += 250;
    const last = hub.pollNotice();
    if (last) { notices.push({ revision: last.revision, virtualMs: clock }); readPair(); }
  } catch (e) { failure = String(e); }
  if (failure) return { status: "FAIL" as const, failure, inputInfo,
    completedInputs: decisions.length, decisions, ingest, reads, memory, transitions, notices,
    wallMs: performance.now() - started, ownedTimers: 0, gc: "UNKNOWN" };
  const frame = hub.readRenderFrame(d.query), view = hub.read(), vp = frame.volumeProfile.value!;
  assert.equal(Object.is(frame, lastFrame), true, "FINAL_AUDIT_CACHE_HIT");
  guard(); sample(); guard();
  const trades = d.inputs.flatMap(x => x.type === "EVENT" && x.event.kind === "TRADE" ? [x.event as Trade] : []);
  const sum = (side: Trade["aggressor"]) => trades.filter(t => t.aggressor === side).reduce((s, t) => s + BigInt(t.qty), 0n);
  const B = sum("BUY"), S = sum("SELL"), U = sum("UNKNOWN");
  const byPrice = new Map<number, bigint>();
  trades.forEach(t => byPrice.set(t.priceTicks, (byPrice.get(t.priceTicks) ?? 0n) + BigInt(t.qty)));
  const poc = [...byPrice].sort((a, b) => a[1] === b[1] ? a[0] - b[0] : a[1] > b[1] ? -1 : 1)[0]?.[0] ?? null;
  const bucket = frame.bubbles.items.map(b => b.bucket);
  const checks: Record<string, boolean> = {
    allInputs: decisions.length === d.inputs.length && view.counts.inputs === decisions.length &&
      view.counts.accepted === decisions.length && view.counts.rejected === 0 && view.counts.duplicate === 0,
    revision: view.revision === decisions.at(-1)!.revision && frame.revision === view.revision,
    atomic: [frame.book, frame.heatmap, frame.bubbles, frame.delta, frame.volumeProfile, frame.quality]
      .every(x => x.revision === frame.revision),
    totals: vp.totals.buyVolume === B && vp.totals.sellVolume === S && vp.totals.unknownVolume === U &&
      vp.totals.totalVolume === B + S + U && vp.totals.tradeCount === trades.length,
    prices: vp.levels.length === byPrice.size && vp.levels.every(l => l.totalVolume === byPrice.get(l.priceTicks)),
    poc: vp.pocTick === poc,
    valueArea: vp.valueArea.valTick !== null && vp.valueArea.vahTick !== null &&
      vp.pocTick !== null && vp.valueArea.valTick <= vp.pocTick && vp.pocTick <= vp.valueArea.vahTick &&
      [...byPrice].filter(([p]) => p >= vp.valueArea.valTick! && p <= vp.valueArea.vahTick!)
        .reduce((n, [, v]) => n + v, 0n) === vp.valueArea.includedVolume &&
      vp.valueArea.includedVolume * 10n >= (B + S + U) * 7n,
    bubbleVolume: bucket.reduce((n, b) => n + b.V_raw, 0n) === B + S + U,
    bubbleSides: bucket.reduce((n, b) => n + b.B, 0n) === B &&
      bucket.reduce((n, b) => n + b.S, 0n) === S && bucket.reduce((n, b) => n + b.U, 0n) === U,
    deltaTotals: frame.delta.items.reduce((n, b) => n + b.B, 0n) === B &&
      frame.delta.items.reduce((n, b) => n + b.S, 0n) === S &&
      frame.delta.items.reduce((n, b) => n + b.U, 0n) === U,
    delta: frame.delta.items.every(bin => {
      const ts = trades.filter(t => BigInt(t.header.exchangeTimeNs!) >= BigInt(bin.startNs) &&
        BigInt(t.header.exchangeTimeNs!) < BigInt(bin.endNs));
      const sumSide = (s: Trade["aggressor"]) => ts.filter(t => t.aggressor === s).reduce((n, t) => n + BigInt(t.qty), 0n);
      const b = sumSide("BUY"), s = sumSide("SELL"), u = sumSide("UNKNOWN");
      return bin.B === b && bin.S === s && bin.U === u && bin.delta === (u ? null : b - s);
    }),
    cells: frame.heatmap.cells.length === d.query.cells.length,
    singleCellApi: !!view.depthHistory && [0, Math.floor(d.query.cells.length / 2), d.query.cells.length - 1].every(i =>
      same(calculateTimeWeightedDepth(view.depthHistory!, d.query.cells[i]), frame.heatmap.cells[i])),
    cacheHits: reads.every(r => r.identical),
    notices: notices.every((n, i) => i === 0 || n.virtualMs - notices[i - 1].virtualMs >= 250),
  };
  if (d.config === null) {
    const legacy = makeWorkload("cells128");
    Object.assign(checks, checkExpected({
      revision: view.revision, stateRevision: frame.stateRevision, counts: view.counts,
      stopLimit: view.stop?.limit ?? null, stopReason: view.stop?.reason ?? null,
      acceptedTrades: vp.totals.tradeCount, B: String(B), S: String(S), U: String(U), V: String(B + S + U),
      poc: vp.pocTick, val: vp.valueArea.valTick, vah: vp.valueArea.vahTick,
      twa: frame.heatmap.cells.map(c => c.twa), coverage: frame.heatmap.cells.map(c => c.coverageRatio),
      delta: frame.delta.items.map(b => b.delta === null ? null : String(b.delta)),
      book: { bids: [...view.qualityState.lastGoodBook.bids], asks: [...view.qualityState.lastGoodBook.asks] },
      rawDeliveries: view.tradeStore.rawEvents.length, prices: vp.priceLevels,
      heatmapCells: frame.heatmap.cells.length, bubbles: frame.bubbles.items.length,
      derivedRevisionsAgree: checks.atomic,
    }, legacy, decisions));
  }
  if (d.config?.gap) {
    const gap = d.inputs.find(x => x.type === "CONDITION" && x.status === "GAP")!;
    const recovery = d.inputs.slice(Math.floor(d.inputs.length / 2) + 2)
      .find(x => x.type === "EVENT" && x.event.kind === "L2_SNAPSHOT")!;
    const interval = calculateTimeWeightedDepth(view.depthHistory!, { side: "BID",
      priceTicks: d.config.baseTick, width: 1, startNs: time(gap), endNs: time(recovery) });
    checks.gapUnknown = interval.twa === null && interval.coverageRatio === 0 && interval.status === "NO DATA";
    checks.recovered = frame.quality.channels.L2_MBP.status === "VALID" &&
      transitions.some(t => t.channel === "L2_MBP" && t.status === "GAP" && !t.bookAvailable) &&
      transitions.some(t => t.channel === "L2_MBP" && t.status === "RESYNCING" && !t.bookAvailable);
    checks.tradeIndependent = frame.quality.channels.TRADES.status === "VALID";
  }
  finite(frame);
  const semantic = JSON.parse(canonical({ frame, quality: view.qualityState,
    depth: view.depthRecords, store: view.tradeStore }));
  guard(); sample();
  const totalWall = performance.now() - started, cpu = process.cpuUsage(cpu0);
  return { status: Object.values(checks).every(Boolean) ? "PASS" as const : "FAIL" as const,
    checks, inputInfo, inputSha256: d.inputSha256, meaningSha256: sha256(canonical(semantic)),
    synthetic: { startNs: d.scope.startNs, endNs: d.query.endNs,
      durationMs: Number(BigInt(d.query.endNs) - BigInt(d.scope.startNs)) / 1e6 },
    counts: view.counts, revision: frame.revision, stateRevision: frame.stateRevision,
    layerRevisions: [frame.book, frame.heatmap, frame.bubbles, frame.delta, frame.volumeProfile, frame.quality].map(x => x.revision),
    usage: view.usage, quality: frame.quality.channels,
    timings: { scope: "ingest synchronous CPU work only; frame reads measured separately; total includes diagnostics and assertions",
      ingest: distribution(ingest), frameMiss: distribution(reads.map(r => r.missMs)),
      frameHit: distribution(reads.map(r => r.hitMs)), ingestSumMs: ingest.reduce((a, b) => a + b, 0),
      wallMs: totalWall, completedPerWallSecond: decisions.length / totalWall * 1000,
      synchronousIngestPerSecond: decisions.length / ingest.reduce((a, b) => a + b, 0) * 1000,
      cpuUserUs: cpu.user, cpuSystemUs: cpu.system,
      cpuSingleCorePercent: (cpu.user + cpu.system) / (totalWall * 1000) * 100 },
    frameReadCalls: frameCount + 1, frameGenerationCount: reads.length, frameCacheHitCalls: reads.length + 1,
    cacheClassification: "MISS: new revision/new object; HIT: identical object, including final audit read",
    notices, decisions, ingest, reads, memory, transitions,
    history: { depthRecords: view.depthRecords.length, trades: view.tradeStore.trades.length,
      rawEvents: view.tradeStore.rawEvents.length, usage: view.usage },
    ownedTimers: 0, activeResourceTypes: process.getActiveResourcesInfo(),
    gc: "UNKNOWN", memoryNote: "Endpoint and per-16-input samples, not true peak/retained-after-GC memory.",
    notificationModel: "virtual aligned synthetic time, no wall pacing, no real-time 4Hz claim",
    semantic,
  };
}

function protectedFiles() {
  const p = JSON.parse(fs.readFileSync(ROOT + "/preflight.json", "utf8"));
  for (const f of [...p.sources, ...p.evidence] as { path: string; sha256: string }[]) {
    assert.equal(sha256(fs.readFileSync(f.path)), f.sha256, `PROTECTED:${f.path}`);
  }
}
export function processSample(stat: string, status: string) {
  const values = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = values[0], start = values[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("PROCESS_IDENTITY_UNKNOWN");
  if (state === "Z" || state === "X") return { start, state, rss: null };
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
  if (!match) throw new Error("RUNNING_RSS_UNKNOWN");
  return { start, state, rss: Number(match[1]) * 1024 };
}
function proc(pid: number) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // A child can become Z between stat and status. Confirm again rather than
  // treating an already exited child as an unmeasurable running process.
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  try { return processSample(stat, status); }
  catch (e) {
    const again = processSample(fs.readFileSync(`/proc/${pid}/stat`, "utf8"), status);
    if (again.rss === null) return again;
    throw e;
  }
}
async function isolated(stage: 0 | 1 | 2) {
  const child = spawn(process.execPath, ["--max-old-space-size=384", ...process.execArgv,
    fileURLToPath(import.meta.url), "--child", String(stage)], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  if (!pid) throw new Error("SPAWN_FAILED");
  const owner = proc(pid);
  let stdout = "", stderr = "", reason: string | null = null, peak = 0, totalPeak = 0, forced = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: string) => {
    if (reason) return; reason = why;
    try { if (proc(pid).start === owner.start) child.kill("SIGTERM"); } catch { /* exit event must still arrive */ }
    escalation = setTimeout(() => {
      try { if (proc(pid).start === owner.start) { forced = true; child.kill("SIGKILL"); } } catch { /* already exited */ }
    }, 2000);
  };
  const wall = setTimeout(() => stop("WALL_LIMIT"), LIMITS.wallMs);
  const monitor = setInterval(() => {
    try {
      const p = proc(pid);
      if (p.rss === null) return; // confirmed Z/X, never fabricate zero RSS
      peak = Math.max(peak, p.rss); const total = p.rss + process.memoryUsage().rss;
      totalPeak = Math.max(totalPeak, total);
      if (p.rss > LIMITS.childRss || total > LIMITS.totalRss) stop("RSS_LIMIT");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") stop("RSS_UNKNOWN");
      // ENOENT means the specific child has exited; close event remains required.
    }
  }, 25);
  child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); if (Buffer.byteLength(stdout) > LIMITS.fileBytes) stop("STDOUT_QUOTA"); });
  child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); if (Buffer.byteLength(stderr) > 65536) stop("STDERR_QUOTA"); });
  return await new Promise<Record<string, unknown>>(resolve => {
    child.on("error", e => { reason ??= String(e); });
    child.on("close", (code, signal) => {
      clearInterval(monitor); clearTimeout(wall); if (escalation) clearTimeout(escalation);
      let result: unknown;
      try { result = JSON.parse(stdout); } catch { reason ??= "INVALID_CHILD_RESULT"; result = { stdout }; }
      resolve({ status: !reason && code === 0 && (result as { status?: string }).status === "PASS" ? "PASS" : "FAIL",
        stage, pid, ownerStartTicks: owner.start, code, signal, forced, reason, stderr,
        peakSampledChildRss: peak || "UNKNOWN", peakSampledParentChildRss: totalPeak || "UNKNOWN",
        remainingChildren: 0, cleanup: { closeObserved: true, monitorCleared: true,
          wallTimerCleared: true, escalationCleared: true }, result });
    });
  });
}
async function main() {
  if (process.argv[2] === "--child") {
    try {
      const stage = Number(process.argv[3]); assert([0, 1, 2].includes(stage));
      process.stdout.write(JSON.stringify(replay(definition(stage as 0 | 1 | 2))));
    } catch (e) { process.stdout.write(JSON.stringify({ status: "FAIL", error: String(e) })); process.exitCode = 1; }
    return;
  }
  assert.equal(process.argv[2], "--run", "EXPLICIT_RUN_REQUIRED");
  checkDirectory(ROOT); protectedFiles();
  // Reject directory-as-file/existing file BEFORE launching even one worker.
  for (const stage of [0, 1, 2]) assert(!fs.existsSync(`${ROOT}/stage${stage}.json`), "OUTPUT_EEXIST");
  const manifest = [];
  for (const stage of [0, 1, 2] as const) {
    protectedFiles(); const d = definition(stage);
    manifest.push(save(ROOT, `stage${stage}-input.json`, d));
    const result = await isolated(stage);
    manifest.push(save(ROOT, `stage${stage}.json`, result));
    if (result.status !== "PASS") { save(ROOT, "run-failure.json", { stage, reason: "STAGE_FAIL", manifest }); process.exitCode = 1; return; }
  }
  protectedFiles();
  save(ROOT, "run-complete.json", { status: "PASS", manifest,
    environment: { node: process.version, cpuMax: fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      memoryMax: fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim() },
    toolSources: ["generator.ts", "evidence.ts", "replay-bench.ts"].map(file => ({
      file, sha256: sha256(fs.readFileSync(new URL(file, import.meta.url), "utf8")),
    })), browserStarts: 0, gc: "UNKNOWN", retries: 0 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(String(e)); process.exitCode = 1;
    try { save(ROOT, "run-error.json", { status: "HOLD", error: String(e), automaticRetries: 0 }); }
    catch (writeError) { console.error("EVIDENCE_ERROR", String(writeError)); }
  });
}
