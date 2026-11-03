import { readConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { Receiver } from "./ingest/receiver.ts";
import { Upstream } from "./upstream/connection.ts";
import { createStatusApp, statusSnapshot } from "./status/app.ts";
import { Pipeline } from "./pipeline.ts";
import { Hub, attachHub } from "./hub/hub.ts";
import { MemoryMonitor } from "./diagnostics/memory.ts";
import { HistoryProcess } from "./history/process.ts";
import { LabelsStore } from "./labels/store.ts";
import { workCpu } from "./diagnostics/work-cpu.ts";
import { measurementLogWriter } from "./diagnostics/measurement-log.ts";
import { MeasurementIsolation, isolationMarker } from "./diagnostics/isolation.ts";
import { LocalSettings } from "./settings/local.ts";
import { AppSettings } from "./settings/app.ts";
import { LongVpSettings } from "./settings/longvp.ts";
import { AppStore } from "./store/app.ts";
import { ReplitObjects, storageMode } from "./store/objects.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { productionAccumulation, accumulationEnabled, AppLongVp } from "./long-vp/app-service.ts";
import { LongRest } from "./long-vp/rest.ts";
import { LongObjects } from "./long-vp/objects.ts";
import type { Server } from "node:http";
import { SettingsTrace } from "./settings/trace.ts";
import { createGcRuntime } from "./gc-runtime.ts";
import { MarketReceiver } from "./ingest/markets.ts";
import { historyGate } from "./history/gate.ts";
import { namedWork } from "./diagnostics/main-thread.ts";

async function main() {
  const config = readConfig(process.env);
  const historyRequest = historyGate();
  const log = createLogger(config.apiKey, measurementLogWriter());
  const nqLog: typeof log = (event, fields) => log(event, {
    ...(fields && typeof fields === "object" ? fields : { detail: fields }), symbol: "NQ" });
  const mode = storageMode(process.env);
  let longVp: AppLongVp | null = null;
  const longStatus = () => longVp?.snapshot() ?? {
    enabled: false, reason: "production_only",
  };
  const useObjects = mode.app || accumulationEnabled(process.env);
  const root = useObjects ? path.resolve(process.env.HEATMAP_STORAGE_DIR
    ?? fileURLToPath(new URL("../../data/app-storage-working/", import.meta.url))) : null;
  const objects = useObjects ? new ReplitObjects() : null;
  const settings = objects ? new AppSettings(path.join(root!, "settings.json"), objects, mode.prefix, log)
    : new LocalSettings(fileURLToPath(new URL("../../data/settings.json", import.meta.url)), log);
  const longVpSettings = new LongVpSettings(objects ? path.join(root!, "settings-longvp.json")
    : fileURLToPath(new URL("../../data/settings-longvp.json", import.meta.url)), log,
    objects ? { objects, prefix: mode.prefix } : undefined);
  const isolation = new MeasurementIsolation(isolationMarker, log);
  isolation.snapshot();
  let activity: () => unknown = () => ({ phase: "initializing" });
  const memory = new MemoryMonitor(log, () => activity(), { objects, prefix: mode.prefix,
    directory: path.resolve(root ?? "data/dev", "diagnostics/cpuprofile"),
    secrets: Object.entries(process.env).filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key))
      .flatMap(([, value]) => value ? [value] : []) });
  memory.start();
  const historyProcess = new HistoryProcess(config.apiKey, log, () => ({
    loopP99Ms: memory.eventLoop.window(10000).p99Ms,
    throttledRatio: memory.pressure.snapshot().throttledRatio,
  }), undefined, undefined, us => workCpu.child(us));
  const pipeline = new Pipeline(config.apiKey, () => receiver.nextSequence(), nqLog, column => hub.column(column),
    objects ? new AppStore(root!, objects, mode.prefix, nqLog) : undefined, "NQ", historyRequest, historyProcess);
  const receiver = new Receiver(nqLog, {
    book: (book) => { pipeline.book(book); hub.book(book); },
    trade: (trade) => { pipeline.trade(trade); hub.trade(trade); longVp?.trade(trade); },
  });
  const gc = createGcRuntime({ key: config.apiKey, log, request: historyRequest, objects, root,
    prefix: mode.prefix, env: process.env, upstream: () => upstream, historyProcess });
  if (accumulationEnabled(process.env) && objects && root) {
    longVp = new AppLongVp({ repository: new LongObjects(objects, mode.prefix, path.join(root, "longvp-working")),
      store: pipeline.store, history: pipeline.client, metrics: pipeline.historyMetrics,
      metadata: new LongRest(config.apiKey, historyRequest), nextSeq: () => receiver.nextSequence(), log: nqLog,
      readyStatus: () => ({ seamReady: pipeline.backfill.status.endSec !== null,
        backfillState: pipeline.backfill.status.state, vpHistoryState: pipeline.vpHistory.state.state }),
    });
  } else log("long_vp_disabled", longStatus());
  pipeline.onHistoryRepair = (start, end) => namedWork("longvp-repair", () => longVp?.historyRepaired(start, end));
  gc.pipeline.onHistoryRepair = (start, end) => gc.longVp?.historyRepaired(start, end);
  const upstream = new Upstream({ apiKey: config.apiKey, receiver: new MarketReceiver(receiver, gc.receiver), log, symbols: ["NQ", "GC"],
    eventLoopSnapshot: () => memory.eventLoop.snapshot(),
    loopPauseMs: () => memory.eventLoop.window(30000).maxMs });
  const hub: Hub = new Hub({
    savedRange: () => pipeline.store.savedRange,
    read: (from, to) => pipeline.readRange(from, to),
    readTrades: (from, to, visit, signal) => pipeline.readFootprintRange(from, to, visit, signal),
    ownsLiveTrade: trade => pipeline.ownsFootprintLive(trade),
    vp: () => pipeline.vp,
    replayVp: (from, alive) => pipeline.replayVp(from, alive),
    // Keep the existing WS status shape; VP progress is an HTTP diagnostic.
    status: () => statusSnapshot(upstream, receiver, config.apiKey, () => {
      const { vp: _vp, ...existing } = pipeline.status(); return existing;
    }, () => hub.snapshot()),
  }, nqLog);
  const settingsTrace = process.env.HEATMAP_SETTINGS_TRACE === "1" ? new SettingsTrace(log, () => ({
    backfill: pipeline.backfill.status.state, vpHistory: pipeline.vpHistory.snapshot().state,
    requests: pipeline.client.stats.requests, errors: pipeline.client.stats.errors, retries: pipeline.client.stats.retries,
    waiting: pipeline.client.stats.waitUntilUs !== null && pipeline.client.stats.waitUntilUs > Date.now() * 1000,
  }), productionAccumulation(process.env) ? "published" : "development", objects ? "app-storage" : "local") : undefined;
  const app = createStatusApp(upstream, receiver, config.apiKey, () => ({ ...pipeline.status(), longVp: longStatus() }),
    () => ({ ...hub.snapshot(), connected: hub.snapshot().connected + gc.hub.snapshot().connected,
      connections: [...hub.connections().map(c => ({ ...c, symbol: "NQ" })), ...gc.hub.connections().map(c => ({ ...c, symbol: "GC" }))],
      bySymbol: { NQ: hub.snapshot(), GC: gc.hub.snapshot() } }),
    () => ({ ...memory.snapshot(), historyProcess: historyProcess.snapshot() }), () => isolation.snapshot(), settings,
    process.env.HEATMAP_SERVE_FRONTEND === "1"
      ? fileURLToPath(new URL("../../artifacts/heatmap/dist/public/", import.meta.url)) : undefined, longVp, longVpSettings, settingsTrace,
    symbol => symbol === "GC" ? gc : null, { labels: new LabelsStore(objects ?? new ReplitObjects(), mode.prefix),
      history: historyProcess, store: symbol => symbol === "GC" ? gc.pipeline.store : pipeline.store });
  let http: Server | null = null;
  let wss: ReturnType<typeof attachHub> | null = null;
  const startup = new AbortController();
  let initialization: Promise<void> | null = null;
  let initialized = false;
  let shuttingDown = false;

  async function shutdown(signal: string, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown_requested", { signal });
    startup.abort();
    // The whole process, not each individual upload, has one budget. Leave
    // 0.5s before the user's 10s ceiling and 0.5s to finish logging/HTTP.
    const started = performance.now();
    const budget = new AbortController();
    const abortTimer = setTimeout(() => budget.abort(), 9000);
    if (pipeline.store instanceof AppStore) pipeline.store.beginShutdown(budget.signal);
    if (gc.pipeline.store instanceof AppStore) gc.pipeline.store.beginShutdown(budget.signal);
    const hardTimer = setTimeout(() => {
      budget.abort();
      log("shutdown_deadline", { elapsedMs: performance.now() - started,
        storage: pipeline.store instanceof AppStore ? pipeline.store.shutdownSummary() : null });
      process.exit(1);
    }, 9500);
    hub.stop(); gc.hub.stop(); wss?.close();
    const httpClosed = http
      ? new Promise<void>((resolve) => http!.close(() => resolve())) : Promise.resolve();
    // Close the upstream first; its existing close timeout is inside the same
    // process-wide budget. Never open another upstream during shutdown.
    await upstream.stop();
    await Promise.all([longVp?.stop(), gc.longVp?.stop()]);
    // A cancelled/failed recovery must not flush a partial coverage index or
    // compress/replace existing data. Wait for its readers to close instead.
    await initialization?.catch(() => {});
    if (initialized) await Promise.all([pipeline.stop(), gc.pipeline.stop()]);
    await historyProcess.stop();
    await httpClosed;
    settingsTrace?.stop();
    await memory.stop();
    log("server_stopped", { upstream: upstream.status.state, httpClosed: true,
      storageInitialized: initialized, elapsedMs: performance.now() - started, uploadDeadlineReached: budget.signal.aborted });
    clearTimeout(abortTimer);
    // The SDK has no public cancellation option. Do not let its outstanding
    // sockets or internal retries keep the process alive past the deadline.
    process.stdout.write("", () => { clearTimeout(hardTimer); process.exit(exitCode); });
  }
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGUSR2", () => {
    if (initialized && !shuttingDown && productionAccumulation(process.env)) upstream.reconnect("SIGUSR2");
    else log("upstream_disabled", { reason: "production_only_rest_development" });
  });
  const started = performance.now();
  log("storage_initializing");
  initialization = (async () => {
    await settings.get();
    startup.signal.throwIfAborted();
    await pipeline.initialize(startup.signal);
    await gc.pipeline.initialize(startup.signal);
    initialized = true;
  })();
  try { await initialization; }
  catch {
    if (!shuttingDown) {
      log("startup_failed", { reason: "storage_initialization_failed" });
      await shutdown("startup_failed", 1);
    }
    return;
  }
  if (shuttingDown) return;
  log("storage_initialized", { elapsedMs: performance.now() - started });
  activity = () => ({ delivery: hub.snapshot(), backfill: pipeline.backfill.snapshot().state,
    upstreamReceive: upstream.receiveDiagnostics(), historyProcess: historyProcess.snapshot() });
  settingsTrace?.start();
  // Neither HTTP readiness nor WS rangeDone can be exposed before full recovery.
  http = app.listen(config.port, "0.0.0.0");
  wss = attachHub(http, new Map([["NQ", hub], ["GC", gc.hub]]), origin => isolation.allows(origin));
  http.once("error", (error) => {
    log("http_error", { error });
    process.exitCode = 1;
    void shutdown("http_error");
  });
  http.once("listening", () => {
    log("server_listening", { port: config.port, host: "0.0.0.0" });
    if (productionAccumulation(process.env)) upstream.start();
    else log("upstream_disabled", { reason: "production_only_rest_development" });
    longVp?.start();
    gc.longVp?.start();
  });
}

void main().catch(() => {
  // No raw startup exception: it might include values from configuration.
  process.stdout.write(JSON.stringify({ event: "startup_failed", reason: "invalid_configuration" }) + "\n");
  process.exitCode = 1;
});
