import { readConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { Receiver } from "./ingest/receiver.ts";
import { Upstream } from "./upstream/connection.ts";
import { createStatusApp, statusSnapshot } from "./status/app.ts";
import { Pipeline } from "./pipeline.ts";
import { Hub, attachHub } from "./hub/hub.ts";
import { MemoryMonitor } from "./diagnostics/memory.ts";

async function main() {
  const config = readConfig(process.env);
  const log = createLogger(config.apiKey);
  let activity: () => unknown = () => ({ phase: "initializing" });
  const memory = new MemoryMonitor(log, () => activity());
  memory.start();
  const pipeline = new Pipeline(config.apiKey, () => receiver.nextSequence(), log, column => hub.column(column));
  const receiver = new Receiver(log, {
    book: (book) => { pipeline.book(book); hub.book(book); },
    trade: (trade) => { pipeline.trade(trade); hub.trade(trade); },
  });
  await pipeline.initialize();
  const upstream = new Upstream({ apiKey: config.apiKey, receiver, log });
  const hub: Hub = new Hub({
    savedRange: () => pipeline.store.savedRange,
    read: (from, to) => pipeline.readRange(from, to),
    status: () => statusSnapshot(upstream, receiver, config.apiKey, () => pipeline.status(), () => hub.snapshot()),
  }, log);
  activity = () => ({ delivery: hub.snapshot(), backfill: pipeline.backfill.snapshot().state });
  const app = createStatusApp(upstream, receiver, config.apiKey, () => pipeline.status(),
    () => ({ ...hub.snapshot(), connections: hub.connections() }),
    () => memory.snapshot());
  const http = app.listen(config.port, "0.0.0.0");
  const wss = attachHub(http, hub);
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown_requested", { signal });
    hub.stop(); wss.close();
    const httpClosed = new Promise<void>((resolve) => http.close(() => resolve()));
    await Promise.all([upstream.stop(), pipeline.stop()]);
    await httpClosed;
    await memory.stop();
    log("server_stopped", { upstream: upstream.status.state, httpClosed: true });
  }
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGUSR2", () => { upstream.reconnect("SIGUSR2"); });
  http.once("error", (error) => {
    log("http_error", { error });
    process.exitCode = 1;
    void shutdown("http_error");
  });
  http.once("listening", () => {
    log("server_listening", { port: config.port, host: "0.0.0.0" });
    upstream.start();
  });
}

void main().catch(() => {
  // No raw startup exception: it might include values from configuration.
  process.stdout.write(JSON.stringify({ event: "startup_failed", reason: "invalid_configuration" }) + "\n");
  process.exitCode = 1;
});
