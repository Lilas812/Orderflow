import { HistoryClient, WindowSplitRequired, WindowUnavailableError } from "./client.ts";
import { historyColumns, historyTrades, inWindow } from "./decode.ts";
import { Metrics } from "../ingest/metrics.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import type { Kind } from "../store/local.ts";

const send = (value: unknown) => { if (process.connected) process.send?.(value); };
// Lifetime CPU includes startup and GC between jobs. Do not reset per request.
const resources = setInterval(() => send({ type: "resource",
  cpu: process.cpuUsage(), rss: process.memoryUsage().rss }), 5000);
resources.unref();
/** Deliberately imports no store, repository, receiver or application entrypoint.
 * The only capability received over IPC is a single REST work item.
 */
process.on("message", async (job: {
  id: number; key: string; symbol: MarketSymbol; kind: Kind; start: number; end: number; testOrigin?: string;
}) => {
  let client: HistoryClient;
  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (job.testOrigin) {
      const origin = new URL(job.testOrigin);
      if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw Error("invalid_test_origin");
      url.protocol = origin.protocol; url.host = origin.host;
    }
    return fetch(url, init);
  };
  client = new HistoryClient(job.key, (event, details) =>
    send({ id: job.id, type: "progress", event, details, stats: { ...client.stats } }), request, undefined, job.symbol);
  try {
    const response = await client.get(job.kind, job.start, job.end, new AbortController().signal);
    const metrics = new Metrics(() => {});
    let seq = 0;
    const prepared = {
      columns: !response.truncated && job.kind === "book"
        ? historyColumns(response.rows, job.start, job.end, metrics, job.symbol) : [],
      trades: !response.truncated && job.kind === "tick"
        ? historyTrades(response.rows, job.start, job.end, metrics, () => ++seq, job.symbol) : [],
      inputRows: response.rows.filter(r => inWindow(r, job.start, job.end)).length,
      counts: metrics.counts, examples: metrics.examples,
    };
    send({ id: job.id, type: "done", response: { rows: [], truncated: response.truncated, prepared },
      stats: client.stats, cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
  } catch (error) {
    send({ id: job.id, type: "failed", fatal: !(error instanceof WindowUnavailableError),
      reason: error instanceof WindowSplitRequired ? "split"
      : error instanceof WindowUnavailableError ? error.reason : "history_child_request_failed",
    stats: client.stats, cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
  }
});
process.on("disconnect", () => process.exit(0));
