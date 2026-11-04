import type { Log } from "../logger.ts";
import type { Receiver } from "../ingest/receiver.ts";
import type { Pipeline } from "../pipeline.ts";
import type { Upstream } from "../upstream/connection.ts";

/** No per-message logging/timestamps/arrays. Two bounded snapshots per minute.
 * Disconnect/watchdog/reconnect are shared-connection counters, attributed to
 * both affected symbols, not two independent upstream sockets. */
export class BoardStageLogger {
  private previous: Record<string, number> = {};
  private last: number;
  private timer?: ReturnType<typeof setInterval>;
  private receiver: Receiver;
  private pipeline: Pipeline;
  private upstream: () => Upstream;
  private log: Log;
  private clock: () => number;
  constructor(receiver: Receiver, pipeline: Pipeline,
    upstream: () => Upstream, log: Log, clock = Date.now) {
    this.receiver = receiver; this.pipeline = pipeline; this.upstream = upstream;
    this.log = log; this.clock = clock;
    this.last = clock();
  }
  start() { this.timer ??= setInterval(() => this.emit(), 60000).unref(); }
  emit(final = false) {
    const now = this.clock();
    if (!final && now - this.last < 60000) return;
    const upstream = this.upstream(), counts = upstream.sharedCounts();
    const total: Record<string, number> = {
      receivedBooks: this.receiver.metrics.byType.book ?? 0,
      acceptedBooks: this.receiver.metrics.counts.acceptedBook,
      rejectedBooks: this.receiver.metrics.counts.rejectedBook,
      ...this.pipeline.boardStages, savedLocalColumns: this.pipeline.store.boardWrites.columns,
      watchdog: counts.watchdog, disconnects: counts.disconnects, reconnects: upstream.status.reconnectCount,
    };
    for (const [reason, n] of Object.entries(this.receiver.metrics.bookRejections)) total["reject_" + reason] = n;
    const delta = Object.fromEntries(Object.entries(total).map(([key, n]) => [key, n - (this.previous[key] ?? 0)]));
    this.log("board_save_stages", { symbol: this.receiver.symbol, intervalMs: now - this.last, final,
      connectionScope: "shared_upstream", persistenceScope: "local_completed_writes", delta, total });
    this.previous = total; this.last = now;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.emit(true); }
}
