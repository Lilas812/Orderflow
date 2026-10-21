/** Bounded, exact samples up to the declared cap; never label sampled tails exact. */
export class Latencies {
  private values: number[] = [];
  count = 0;
  sum = 0;
  constructor(readonly capacity = 65_536) {}
  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new TypeError("Nonnegative monotonic duration required");
    this.count++; this.sum += ms;
    if (this.values.length < this.capacity) this.values.push(ms);
  }
  report() {
    const sorted = [...this.values].sort((a,b) => a-b);
    const exact = this.count <= this.capacity;
    const percentile = (p: number) => !exact || !sorted.length ? null : sorted[Math.ceil(sorted.length*p)-1];
    return { count: this.count, meanMs: this.count ? this.sum/this.count : null,
      p95Ms: percentile(.95), p99Ms: percentile(.99), exactPercentiles: exact };
  }
}
export const maxNs = (a: string | null, b: string | null): string | null =>
  b !== null && (a === null || BigInt(b) > BigInt(a)) ? b : a;
export interface ModelStamp { position: string; eventNs: string | null; publishedMonoMs: number }
export class Metrics {
  constructor(readonly clock:()=>number=()=>performance.now()) {}
  receivedEvents = 0; acceptedEvents = 0; appliedEvents = 0; persistedEvents = 0;
  duplicateEvents = 0; rejectedEvents = 0; auditRecords = 0;
  explicitlyLostEvents = 0; queueDepth = 0; queueBytes = 0;
  peakQueueDepth = 0; peakQueueBytes = 0; overflowEvents = 0; pauseRequests = 0;
  sequenceGapCount = 0; reconnectCount = 0; storageErrorCount = 0;
  latestExchangeEventTime: string | null = null;
  latestPersistedEventTime: string | null = null;
  latestRenderedEventTime: string | null = null;
  lastPersistedPosition = "0"; lastAppliedPosition = "0";
  storageStatus: "OK" | "STORAGE ERROR" = "OK";
  readonly processing = new Latencies();
  readonly storageFlush = new Latencies();
  readonly commitDuration = new Latencies();
  readonly queueWait = new Latencies();
  readonly derivedProcessing = new Latencies();
  readonly renderAcknowledgement = new Latencies();
  latestModel: ModelStamp | null = null;
  renderedModel: ModelStamp | null = null;
  oldestQueuedMonoMs: number | null = null;
  depth(count: number, bytes: number, oldestMonoMs: number | null = null): void {
    this.queueDepth = count; this.queueBytes = bytes;
    this.oldestQueuedMonoMs=oldestMonoMs;
    this.peakQueueDepth = Math.max(this.peakQueueDepth, count);
    this.peakQueueBytes = Math.max(this.peakQueueBytes, bytes);
  }
  snapshot() {
    return {
      counterWindow: "THIS_PROCESS_SESSION", receivedEvents: this.receivedEvents,
      // accepted/applied/persisted count logical accepted events; audit includes duplicates/controls.
      acceptedEvents: this.acceptedEvents, appliedEvents: this.appliedEvents, persistedEvents: this.persistedEvents,
      duplicateEvents: this.duplicateEvents, rejectedEvents: this.rejectedEvents, auditRecords: this.auditRecords,
      explicitlyLostEvents: this.explicitlyLostEvents, overflowEvents: this.overflowEvents,
      queueDepth: this.queueDepth, queueBytes: this.queueBytes,
      oldestQueueAgeMs:this.oldestQueuedMonoMs===null?null:Math.max(0,this.clock()-this.oldestQueuedMonoMs),
      peakQueueDepth: this.peakQueueDepth, peakQueueBytes: this.peakQueueBytes, pauseRequests: this.pauseRequests,
      eventProcessingLatencyMs: this.processing.report(), storageFlushLagMs: this.storageFlush.report(),
      commitDurationMs:this.commitDuration.report(),
      queueWaitMs: this.queueWait.report(), storageStatus: this.storageStatus,
      derivedProcessingLatencyMs: this.derivedProcessing.report(),
      latestExchangeEventTime: this.latestExchangeEventTime, latestPersistedEventTime: this.latestPersistedEventTime,
      latestRenderedEventTime: this.latestRenderedEventTime, latestModelEventTime: this.latestModel?.eventNs ?? null,
      lastPersistedPosition: this.lastPersistedPosition, lastAppliedPosition: this.lastAppliedPosition,
      sequenceGapCount: this.sequenceGapCount, reconnectCount: this.reconnectCount, storageErrorCount: this.storageErrorCount,
      renderLagMs: this.renderedModel && this.latestModel ?
        Math.max(0, this.latestModel.publishedMonoMs-this.renderedModel.publishedMonoMs) : null,
      renderAcknowledgementMs: this.renderAcknowledgement.report(),
      renderMeasurement: this.renderedModel ? "MOCK_ACK_ONLY" : "NOT MEASURED",
    };
  }
}
