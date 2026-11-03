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
/** Never imports the receiver or application entrypoint. REST jobs receive one work item.
 * Labels jobs receive only immutable, request-owned local snapshots; no REST key.
 */
process.on("message", async (job: {
  id: number; key: string; symbol: MarketSymbol; kind: Kind; start: number; end: number; testOrigin?: string;
  type?: string; job?: import("../labels/export.ts").LabelExport;
}) => {
  if (job.type?.startsWith("labels_") && job.type !== "labels_export") return;
  if (job.type === "labels_export") {
    const lease: import("../labels/reader.ts").Lease = async (hour, visit) => {
      const request = (type: string, expected: string) => new Promise<import("../labels/input.ts").LabelHourInput>((resolve, reject) => {
        const receive = (value: unknown) => {
          const m = value as { id: number; hour: number; type: string; input: import("../labels/input.ts").LabelHourInput };
          if (m.id !== job.id || m.hour !== hour) return;
          if (m.type === expected || m.type === "labels_input_failed") {
            process.off("message", receive);
            if (m.type === "labels_input_failed") reject(Error("labels_input_unavailable")); else resolve(m.input);
          }
        };
        process.on("message", receive); send({ id: job.id, type, hour });
      });
      const input = await request("labels_input", "labels_input_ready");
      try { return await visit(input); }
      finally { await request("labels_release", "labels_released"); }
    };
    try {
      const { exportLabels } = await import("../labels/export.ts");
      const response = await exportLabels(job.job!, lease);
      send({ id: job.id, type: "labels_done", response: { zip: response.zip, summary: { counts: response.summary.counts } },
        cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
    } catch (e) {
      const reason = e instanceof Error && /^labels_|^invalid_|^quantity_/.test(e.message) ? e.message : "labels_export_failed";
      send({ id: job.id, type: "labels_failed", reason, cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
    }
    return;
  }
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
