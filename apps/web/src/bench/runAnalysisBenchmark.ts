import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, cpus, availableParallelism, platform, arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAnalysisHub, analysisInputBytes, type AnalysisDecision, type AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import { validateMarketEvent } from "@workspace/core/events";
import { makeWorkload, WORKLOAD_IDS, type Workload, type WorkloadId } from "./finiteMockWorkload";
import { MetricBuffer, classifyInput, distribution, summarizeInputs, type InputMetric, type FrameMetric } from "./metrics";

type Hub = ReturnType<typeof createAnalysisHub>;
export interface BenchmarkOptions {
  notifications: boolean;
  /** Burst has no offered rate; paced uses explicit per-input deadlines. */
  mode?: "paced" | "burst";
  plannedInputsPerSecond?: number;
  maxWallMs?: number;
  recordCapacity?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const DEFAULT_WALL = 20000;
export function validateWorkload(workload: Workload) {
  if (workload.scope.config.identity.environment !== "MOCK" ||
    workload.scope.config.identity.source !== "MOCK_DETERMINISTIC" || workload.inputs.length > 513) {
    throw new Error("FINITE_MOCK_ONLY");
  }
  let bytes = 0;
  for (const input of workload.inputs) {
    bytes += analysisInputBytes(input);
    if (input.type === "EVENT") {
      const event = validateMarketEvent(input.event), identity = workload.scope.config.identity;
      for (const key of ["environment", "source", "sourceId", "canonicalInstrumentId", "sessionId"] as const) {
        if (event.header[key] !== identity[key]) throw new Error("FOREIGN_SCOPE");
      }
    }
  }
  if (bytes > workload.scope.budget.normalizedBytes || workload.scope.budget.inputs > 512 ||
    workload.scope.budget.trades > 256 || workload.query.cells.length > 512 ||
    workload.scope.volumeProfile!.maxPriceLevels > 64) throw new Error("PREFLIGHT_BUDGET");
  return { bytes, inputs: workload.inputs.length };
}
/** Preserve Map insertion order and decimal bigint precision. Only outside timed sections. */
export function canonical(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (typeof v === "bigint") return { bigint: v.toString() };
    if (v instanceof Map) return { map: [...v].map(([k, x]) => [encode(k), encode(x)]) };
    if (Array.isArray(v)) return v.map(encode);
    if (v !== null && typeof v === "object") return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, encode(x)]));
    return v;
  };
  return JSON.stringify(encode(value));
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function audit(hub: Hub, workload: Workload) {
  const v = hub.read(), frame = hub.readRenderFrame(workload.query), vp = frame.volumeProfile.value!;
  const committed = { qualityState: v.qualityState, tradeStore: v.tradeStore,
    depthRecords: v.depthRecords, tradeQualityEvidence: v.tradeQualityEvidence,
    vp: { totals: vp.totals, levels: vp.levels, poc: vp.pocTick, area: vp.valueArea } };
  return {
    committedHash: digest(committed),
    meaningHash: digest({ committed, counts: v.counts, revision: v.revision,
      stateRevision: frame.stateRevision, observedThroughNs: frame.observedThroughNs,
      stop: v.stop, twa: frame.heatmap.cells, bubbles: frame.bubbles.items, delta: frame.delta.items }),
    summary: {
      revision: v.revision, stateRevision: frame.stateRevision, counts: v.counts,
      stopLimit: v.stop?.limit ?? null, stopReason: v.stop?.reason ?? null,
      acceptedTrades: vp.totals.tradeCount,
      B: vp.totals.buyVolume.toString(), S: vp.totals.sellVolume.toString(),
      U: vp.totals.unknownVolume.toString(), V: vp.totals.totalVolume.toString(),
      poc: vp.pocTick, val: vp.valueArea.valTick, vah: vp.valueArea.vahTick,
      twa: frame.heatmap.cells.map(c => c.twa), coverage: frame.heatmap.cells.map(c => c.coverageRatio),
      delta: frame.delta.items.map(b => b.delta === null ? null : b.delta.toString()),
      book: { bids: [...v.qualityState.lastGoodBook.bids], asks: [...v.qualityState.lastGoodBook.asks] },
      rawDeliveries: v.tradeStore.rawEvents.length, prices: vp.priceLevels,
      heatmapCells: frame.heatmap.cells.length, bubbles: frame.bubbles.items.length,
      derivedRevisionsAgree: [frame.book, frame.heatmap, frame.bubbles, frame.delta,
        frame.volumeProfile, frame.quality].every(part => part.revision === frame.revision),
    },
  };
}
function reference(workload: Workload, count = workload.inputs.length) {
  const hub = createAnalysisHub(workload.scope, () => 0);
  const decisions: AnalysisDecision[] = [];
  for (const input of workload.inputs.slice(0, count)) {
    const d = hub.ingest(input); decisions.push(d);
    if (d.stop) break;
  }
  return { ...audit(hub, workload), decisions };
}
export function checkExpected(
  actual: ReturnType<typeof audit>["summary"], workload: Workload,
  decisions: readonly Pick<AnalysisDecision, "disposition" | "tradeDisposition" | "eventCount">[],
) {
  const e = workload.expected;
  const acceptedMarkets = decisions.reduce((n, d) => n +
    (d.disposition === "ACCEPTED" ? d.eventCount : 0), 0);
  const checks = {
    totals: actual.B === e.B && actual.S === e.S && actual.U === e.U && actual.V === e.V,
    vp: actual.acceptedTrades === e.acceptedTrades && actual.poc === e.poc &&
      actual.val === e.val && actual.vah === e.vah,
    twa: canonical(actual.twa) === canonical(e.twa) && canonical(actual.coverage) === canonical(e.coverage),
    delta: canonical(actual.delta) === canonical(e.delta),
    counts: actual.revision === e.attemptedInputs && actual.counts.inputs === e.attemptedInputs &&
      actual.counts.rejected === e.rejectedInputs && actual.counts.duplicate === e.duplicateTrades &&
      actual.counts.accepted === e.attemptedInputs - e.rejectedInputs - e.duplicateTrades &&
      acceptedMarkets === e.acceptedMarkets,
    duplicate: decisions.filter(d => d.tradeDisposition === "DUPLICATE").length === e.duplicateTrades,
    conflict: decisions.filter(d => d.tradeDisposition === "CONFLICTING_TRADE_ID").length === e.conflictingTrades,
    stop: actual.stopLimit === e.stopLimit, revisions: actual.derivedRevisionsAgree,
  };
  return checks;
}
/** Explicitly callable only. Importing this module starts no timers, workloads or child processes. */
export async function measureWorkload(workload: Workload, options: BenchmarkOptions) {
  const clock = options.clock ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const wall = options.maxWallMs ?? DEFAULT_WALL, rate = options.plannedInputsPerSecond ?? 1000;
  const mode = options.mode ?? "burst", capacity = options.recordCapacity ?? 1024;
  if (!Number.isFinite(wall) || wall < 1 || wall > 30000 || !Number.isFinite(rate) || rate < 1 || rate > 10000) {
    throw new RangeError("Finite wall/rate limits required");
  }
  const trialStart = clock();
  const memory: { phase: string; rss: number; heapUsed: number }[] = [];
  const sampleMemory = (phase: string) => {
    if (memory.length === 8) throw new Error("MEMORY_RECORD_LIMIT");
    const m = process.memoryUsage(); memory.push({ phase, rss: m.rss, heapUsed: m.heapUsed });
  };
  sampleMemory("before-reference");
  // Golden/reference evaluation precedes the measured input window.
  const sourceHashBefore = digest(workload.inputs);
  const preflight = validateWorkload(workload);
  const oracle = reference(workload);
  const golden = checkExpected(oracle.summary, workload, oracle.decisions);
  if (Object.values(golden).some(ok => !ok)) throw new Error(`FIXTURE_GOLDEN_MISMATCH ${canonical(golden)}`);
  if (clock() - trialStart > wall) throw new Error("REFERENCE_WALL_LIMIT");
  const calibration = new MetricBuffer<number>(64), calibrationStart = clock();
  for (let i = 0; i < 64; i++) {
    const start = clock(), end = clock(); calibration.record(end - start);
  }
  const calibrationEnd = clock();
  const inputMetrics = new MetricBuffer<InputMetric>(capacity);
  const frameMetrics = new MetricBuffer<FrameMetric>(capacity);
  const vpMetrics = new MetricBuffer<number>(3);
  const hub = createAnalysisHub(workload.scope, clock);
  let previousFrame: AnalysisRenderFrame | null = null;
  let benchmarkStop: string | null = null, hubStop: string | null = null;
  sampleMemory("before-input");
  const cpuStart = process.cpuUsage();
  const inputStart = clock();
  const timedRead = (reason: FrameMetric["reason"], notifyStart: number | null) => {
    if (frameMetrics.count === frameMetrics.capacity) throw new Error("METRIC_BUFFER_FULL");
    const start = clock(), frame = hub.readRenderFrame(workload.query), end = clock();
    frameMetrics.record({ start, end, notifyStart, reason, revision: frame.revision,
      cache: previousFrame === frame ? "HIT" : "MISS" });
    previousFrame = frame;
  };
  for (let i = 0; i < workload.inputs.length; i++) {
    if (inputMetrics.count === inputMetrics.capacity) { benchmarkStop = "METRIC_BUFFER_FULL"; break; }
    const scheduled = mode === "paced" ? inputStart + i * 1000 / rate : inputStart;
    const wait = scheduled - clock();
    if (mode === "paced" && wait > 0) await sleep(wait);
    if (clock() - trialStart > wall) { benchmarkStop = "WALL_LIMIT"; break; }
    const input = workload.inputs[i], kind = classifyInput(input);
    const start = clock(), decision = hub.ingest(input), end = clock();
    inputMetrics.record({ scheduled, start, end, kind, disposition: decision.disposition,
      tradeDisposition: decision.tradeDisposition, revision: decision.revision, eventCount: decision.eventCount,
      stopReason: decision.stop?.reason ?? null });
    if (decision.stop) { hubStop = decision.stop.reason; break; }
    if (options.notifications) {
      const notifyStart = clock(), notice = hub.pollNotice();
      if (notice) {
        if (frameMetrics.count === frameMetrics.capacity) { benchmarkStop = "METRIC_BUFFER_FULL"; break; }
        timedRead("NOTICE", notifyStart);
      }
    }
    if (clock() - trialStart > wall) { benchmarkStop = "WALL_LIMIT"; break; }
  }
  const inputEnd = clock();
  const inputCpu = process.cpuUsage(cpuStart);
  // Final read is explicit, not falsely counted as a delivered notification.
  if (!benchmarkStop) {
    timedRead("FINAL", null); timedRead("CACHE_PROBE", null);
    for (let i = 0; i < 3; i++) {
      const start = clock(); hub.readVolumeProfile(); const end = clock(); vpMetrics.record(end - start);
    }
  }
  const measuredEnd = clock();
  if (measuredEnd - trialStart > wall) benchmarkStop ??= "WALL_LIMIT";
  sampleMemory("after-input");
  const records = inputMetrics.snapshot(), frames = frameMetrics.snapshot();
  // Verification, hashing, JSON, sorting and memory snapshots are outside input timing.
  const actual = audit(hub, workload);
  const prefix = benchmarkStop ? reference(workload, records.length) : oracle;
  const prior = hubStop ? reference(workload, records.length - 1) : null;
  const checks = {
    ...(!benchmarkStop ? checkExpected(actual.summary, workload, records) : {}),
    referenceHash: actual.meaningHash === prefix.meaningHash,
    noPartialPublish: prior === null || actual.committedHash === prior.committedHash,
    sourceUnchanged: digest(workload.inputs) === sourceHashBefore,
  };
  sampleMemory("after-verification");
  const inputMs = inputEnd - inputStart, completed = records.length;
  const marketAccepted = records.reduce((n, r) => n + (r.disposition === "ACCEPTED" ? r.eventCount : 0), 0);
  const selectFrames = (cache: "HIT" | "MISS") => distribution(frames.filter(r => r.cache === cache).map(r => r.end - r.start));
  const notifiedLatency = options.notifications ? records.flatMap(r => {
    const covering = frames.find(f => f.reason === "NOTICE" && f.revision >= r.revision);
    return covering?.notifyStart === null || covering === undefined ? [] : [covering.notifyStart - r.end];
  }) : [];
  return {
    workload: workload.id, notifications: options.notifications, mode, preflight, sourceHashBefore,
    notificationModel: "Caller polls after ingest; hub >=250ms throttle. NOT React/UI timer measurement.",
    plannedInputsPerSecond: mode === "paced" ? rate : null,
    count: completed, sourceInputs: workload.inputs.length, unattempted: workload.inputs.length - completed,
    acceptedInputs: records.filter(r => r.disposition === "ACCEPTED").length,
    duplicateInputs: records.filter(r => r.disposition === "DUPLICATE").length,
    rejectedInputs: records.filter(r => r.disposition === "REJECTED").length,
    marketAccepted, benchmarkStop, hubStop,
    inputWindowMs: inputMs, totalMeasuredMs: measuredEnd - inputStart, wholeTrialMs: clock() - trialStart,
    completedInputsPerSecond: inputMs > 0 ? completed * 1000 / inputMs : null,
    acceptedMarketsPerSecond: inputMs > 0 ? marketAccepted * 1000 / inputMs : null,
    ingest: distribution(records.map(r => r.end - r.start)), byKind: summarizeInputs(records),
    volumeProfileRead: distribution(vpMetrics.snapshot()),
    inputCpuMicroseconds: inputCpu,
    observerCalibration: { clockPair: distribution(calibration.snapshot()),
      clockPairAndNumericRecordMeanMs: (calibrationEnd - calibrationStart) / 64,
      note: "Lower-bound observer calibration; excludes full input-record object cost. Not subtracted." },
    historyQuarters: Array.from({ length: 4 }, (_, q) => {
      const a = records.slice(Math.floor(completed * q / 4), Math.floor(completed * (q + 1) / 4));
      return { fromInput: Math.floor(completed * q / 4) + 1, count: a.length,
        ingest: distribution(a.map(r => r.end - r.start)) };
    }),
    scheduleLateness: mode === "paced" ? distribution(records.map(r => Math.max(0, r.start - r.scheduled))) : null,
    frames: { count: frames.length, hit: selectFrames("HIT"), miss: selectFrames("MISS"),
      noticeWaiting: options.notifications ? distribution(notifiedLatency) : null,
      withoutNotice: options.notifications ? completed - notifiedLatency.length : completed },
    checks, pass: Object.values(checks).every(Boolean) && benchmarkStop === null,
    meaningHash: actual.meaningHash, referenceHash: prefix.meaningHash,
    committedHash: actual.committedHash, beforeOverflowHash: prior?.committedHash ?? null,
    summary: actual.summary, memory, memoryNote: "At most 8 endpoint snapshots; not peak RSS/heap or GC measurement.",
    inputs: records, reads: frames,
  };
}

/** Parent provides a real external wall limit even while a child is in synchronous core code. */
async function isolated(config: { id: WorkloadId; notifications: boolean; mode: "paced" | "burst"; repetition: number }) {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url),
    "--child", JSON.stringify(config)], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", killed: string | null = null;
  const terminate = (why: string) => { killed ??= why; child.kill("SIGKILL"); };
  const timeout = setTimeout(() => terminate("HARD_WALL_LIMIT"), 30000);
  child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); if (stdout.length > 2_097_152) terminate("OUTPUT_LIMIT"); });
  child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); if (stderr.length > 65536) terminate("STDERR_LIMIT"); });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (killed || outcome.code !== 0) return { ...config, pass: false, failure: killed ?? "CHILD_FAILED",
    outcome, diagnostic: stderr.slice(0, 2048) };
  return { ...config, ...JSON.parse(stdout) as Awaited<ReturnType<typeof measureWorkload>> };
}

async function cli() {
  if (process.argv[2] === "--child") {
    const c = JSON.parse(process.argv[3]) as { id: WorkloadId; notifications: boolean; mode: "paced" | "burst" };
    const result = await measureWorkload(makeWorkload(c.id), { notifications: c.notifications, mode: c.mode });
    process.stdout.write(JSON.stringify(result)); return;
  }
  if (process.argv[2] !== "--run") {
    console.log("Explicit only: pnpm --filter @workspace/storage exec tsx ../../apps/web/src/bench/runAnalysisBenchmark.ts --run [--burst]");
    return;
  }
  const mode = process.argv.includes("--burst") ? "burst" : "paced";
  const selection = process.argv.find(a => a.startsWith("--only="))?.slice("--only=".length).split(",");
  if (selection?.some(id => !(WORKLOAD_IDS as readonly string[]).includes(id))) throw new Error("UNKNOWN_WORKLOAD_SELECTION");
  const selected = selection ? WORKLOAD_IDS.filter(id => selection.includes(id)) : WORKLOAD_IDS;
  if (selected.length === 0) throw new Error("EMPTY_WORKLOAD_SELECTION");
  const directory = await mkdtemp(join(tmpdir(), "orderflow-28b1-"));
  const pilot = await isolated({ id: "baseline13", notifications: true, mode, repetition: 0 });
  await writeFile(join(directory, "pilot.json"), JSON.stringify(pilot, null, 2));
  if (!pilot.pass) throw new Error("PILOT_FAILED");
  console.log(`PILOT PASS; results=${directory}; mode=${mode}; 3 repetitions, 30s hard limit per child`);
  const runs: Awaited<ReturnType<typeof isolated>>[] = [];
  for (let repetition = 1; repetition <= 3; repetition++) for (const id of selected) {
    for (const notifications of repetition % 2 ? [false, true] : [true, false]) {
      const r = await isolated({ id, notifications, repetition, mode });
      runs.push(r);
      console.log(JSON.stringify({ workload: id, repetition, notifications, pass: r.pass,
        ...("ingest" in r ? { count: r.count, perSecond: r.completedInputsPerSecond,
          p95: r.ingest.p95, p99: r.ingest.p99, frameMissP95: r.frames.miss.p95,
          stop: r.hubStop, hash: r.meaningHash } : { failure: r.failure }) }));
      await writeFile(join(directory, "runs.json"), JSON.stringify(runs));
    }
  }
  const environment = { node: process.version, platform: platform(), arch: arch(),
    availableParallelism: availableParallelism(), cpuModel: cpus()[0]?.model,
    unit: "milliseconds; inputs/s distinct from accepted market events/s",
    quantiles: "nearest-rank ceil(p*N)-1; N<100 p99 reference only",
    limits: { repetitions: 3, childWallMs: 30000, cooperativeWallMs: DEFAULT_WALL,
      inputRecords: 1024, frameRecords: 1024, memoryRecords: 8, childOutputChars: 2097152 },
    gc: "UNKNOWN", internalPhaseTimes: "UNMEASURED", uiAndGpu: "NOT IN SCOPE" };
  await writeFile(join(directory, "environment.json"), JSON.stringify(environment, null, 2));
  console.log(`FINISHED ${runs.length} trials; failed=${runs.filter(r => !r.pass).length}; ${directory}`);
  if (runs.some(r => !r.pass)) process.exitCode = 1;
}
// Exact entry-point check; no environment flags or automatic benchmark inside pnpm test/build/dev.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void cli().catch(error => { console.error(error instanceof Error ? error.message : "BENCHMARK_FAILED"); process.exitCode = 1; });
}
