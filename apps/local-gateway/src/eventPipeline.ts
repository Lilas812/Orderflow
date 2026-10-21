import { validateMarketEvent, type MarketEvent } from "@workspace/core/events";
import { currentMbpBook, currentQuality, type QualityChannel } from "@workspace/core/quality-timeline";
import { inputMetadata } from "@workspace/storage/journal";
import { canonical } from "@workspace/storage/catalog";
import type { StorageAdapter } from "./storageAdapter";
import { Metrics, maxNs, type ModelStamp } from "./metrics";
import { ReconnectController } from "./reconnectController";
import type { MarketQualityState } from "@workspace/core/quality-timeline";
import type { TradeStore } from "@workspace/core/trade-store";

export interface QueueLimits { events: number; bytes: number; high: number; low: number; batch: number }
export const LIMITS: Readonly<QueueLimits> = Object.freeze({ events: 2048, bytes: 8*1024*1024, high: .75, low: .5, batch: 128 });
interface Entry { ordinal: number; scopeId: string; event: MarketEvent; bytes: number; mono: number }
interface Fault {
  scopeId: string; channel: QualityChannel; atNs: string; barrier: number;
  status: "GAP" | "RESYNCING"; reason: string; recorded: boolean;
}
export class EventPipeline {
  readonly metrics: Metrics;
  private queue: Entry[] = [];
  private bytes = 0; private ordinal = 0;
  private readonly faults = new Map<string,Fault>();
  private offered: ModelStamp | null = null;
  private renderClock = -Infinity;
  private rendererReady = true;
  paused = false;
  viewMode: "LIVE" | "HISTORY" = "LIVE";
  constructor(readonly storage: StorageAdapter, readonly clock = () => performance.now(),
    readonly limits: Readonly<QueueLimits> = LIMITS, readonly onPause: (pause: boolean) => void = () => {}) {
    this.metrics=new Metrics(clock);
    if (!Number.isSafeInteger(limits.events) || limits.events <= 0 || !Number.isSafeInteger(limits.bytes) || limits.bytes <= 0 ||
      !Number.isFinite(limits.high) || !Number.isFinite(limits.low) ||
      limits.high <= limits.low || limits.high > 1 || limits.low < 0 || !Number.isSafeInteger(limits.batch) || limits.batch < 1)
      throw new TypeError("Invalid queue watermarks/limits");
    this.metrics.lastPersistedPosition = storage.catalog.manifest().recordCount;
    this.metrics.lastAppliedPosition=storage.lastLogicalAppliedPosition;
    this.metrics.latestPersistedEventTime=storage.latestPersistedTime;
    if(storage.lastLogicalAppliedPosition!=="0") this.metrics.latestModel={
      position:storage.lastLogicalAppliedPosition,eventNs:storage.lastLogicalAppliedTime,publishedMonoMs:this.clock(),
    };
  }
  private key(scope: string, channel: QualityChannel) { return `${scope}:${channel}`; }
  reconnectController(scope: string, channels: readonly QualityChannel[], detectionNs: () => string) {
    return new ReconnectController(this.clock,()=>{
      for(const channel of channels) this.invalidate(scope,channel,detectionNs(),"MOCK TRANSPORT DISCONNECTED","RESYNCING");
    },()=>{this.metrics.reconnectCount++;});
  }
  quality(scope: string, channel: QualityChannel): string {
    if (this.metrics.storageStatus !== "OK") return "STORAGE ERROR";
    if(channel==="TRADES" && this.storage.trades.get(scope)?.issues.length) return "INCOMPLETE";
    return this.faults.get(this.key(scope,channel))?.status ??
      (this.storage.states.has(scope) ? currentQuality(this.storage.states.get(scope)!.timeline,channel).status : "NOT_INITIALIZED");
  }
  book(scope: string) {
    const state = this.storage.states.get(scope);
    return state && this.quality(scope,"L2_MBP") === "VALID" ? currentMbpBook(state) : null;
  }
  invalidate(scopeId: string, channel: QualityChannel, atNs: string, reason: string, status: "GAP" | "RESYNCING" = "GAP"): void {
    if (!this.storage.states.has(scopeId)) return;
    const key = this.key(scopeId,channel), existing = this.faults.get(key);
    if (existing) {
      existing.atNs = maxNs(existing.atNs,atNs)!;
      existing.barrier = Math.max(existing.barrier,this.ordinal);
      existing.recorded = false;
      existing.status = status;
    } else {
      this.faults.set(key,{ scopeId,channel,atNs,reason,status,barrier:this.ordinal,recorded:false });
      if (status==="GAP") this.metrics.sequenceGapCount++;
    }
  }
  receive(scopeId: string, input: unknown): boolean {
    const m = this.metrics; m.receivedEvents++;
    let event: MarketEvent;
    try {
      event = validateMarketEvent(input);
      inputMetadata({ type: "EVENT", event });
      if(event.header.channel==="TRADES" && event.header.exchangeTimeNs===null)
        throw new TypeError("R08 canonical Trade requires known exchange time; never substitute receipt time");
      const identity = this.storage.states.get(scopeId)?.config.identity;
      if (!identity || !Object.entries(identity).every(([k,v]) => event.header[k as keyof typeof event.header] === v))
        throw new TypeError("Scope mismatch");
    } catch {
      m.rejectedEvents++;
      // No arbitrary malformed payload is written as a normalized market event.
      const state = this.storage.states.get(scopeId);
      if (state) for (const ch of ["L1","L2_MBP","TRADES"] as const)
        this.invalidate(scopeId,ch,state.lastGoodBook.lastHeader?.receiveTimeNs ?? this.storage.journal.scope(scopeId).startNs,"INVALID INPUT");
      return false;
    }
    m.latestExchangeEventTime = maxNs(m.latestExchangeEventTime,event.header.exchangeTimeNs);
    const bytes = Buffer.byteLength(canonical(event),"utf8");
    if (this.queue.length+1 > this.limits.events || this.bytes+bytes > this.limits.bytes) {
      m.overflowEvents++; m.explicitlyLostEvents++;
      this.invalidate(scopeId,event.header.channel as QualityChannel,event.header.receiveTimeNs,"QUEUE OVERFLOW: delivery not admitted");
      return false;
    }
    // Strictly bounded ownership copy: caller mutation cannot change a queued input.
    const copy = JSON.parse(canonical(event)) as MarketEvent;
    this.queue.push({ scopeId,event:copy,bytes,ordinal:++this.ordinal,mono:this.clock() });
    this.bytes += bytes; m.depth(this.queue.length,this.bytes,this.queue[0]?.mono??null); this.watermark();
    return true;
  }
  private watermark(): void {
    const utilization = Math.max(this.queue.length/this.limits.events,this.bytes/this.limits.bytes);
    if (!this.paused && utilization >= this.limits.high) {
      this.paused = true; this.metrics.pauseRequests++; this.onPause(true);
    } else if (this.paused && utilization <= this.limits.low) { this.paused=false; this.onPause(false); }
  }
  private controls(): boolean {
    for (const fault of this.faults.values()) if (!fault.recorded && (!this.queue.length || this.queue[0].ordinal > fault.barrier)) {
      try {
        const commit = this.storage.condition(fault.scopeId,fault.channel,fault.atNs,fault.status,fault.reason);
        this.metrics.auditRecords++;
        this.metrics.lastPersistedPosition = commit.lastPosition;
        this.metrics.storageStatus="OK";
        fault.recorded=true;
      } catch {
        this.metrics.storageErrorCount++; this.metrics.storageStatus="STORAGE ERROR"; return false;
      }
    }
    return true;
  }
  flush(): boolean {
    if (!this.controls()) return false;
    if (!this.queue.length) return true;
    const first = this.queue[0], group: Entry[] = [];
    const barrier = Math.min(...[...this.faults.values()].filter(f => !f.recorded).map(f => f.barrier));
    for (const e of this.queue) {
      if (e.scopeId !== first.scopeId || group.length >= this.limits.batch || (group.length && e.ordinal > barrier)) break;
      group.push(e);
    }
    const begin = this.clock();
    let commit: ReturnType<StorageAdapter["commit"]>;
    try { commit = this.storage.commit(first.scopeId, group.map(e => ({ type: "EVENT", event: e.event }))); }
    catch {
      this.metrics.storageStatus="STORAGE ERROR"; this.metrics.storageErrorCount++;
      return false; // Keep ownership; candidates were not published.
    }
    {
      const end = this.clock(), startPosition = BigInt(commit.lastPosition)-BigInt(group.length)+1n;
      const m = this.metrics;
      m.storageStatus="OK"; m.commitDuration.add(end-begin); m.storageFlush.add(Math.max(0,end-group[0].mono)); m.auditRecords+=group.length;
      for (let i=0;i<group.length;i++) {
        const e=group[i], result=commit.outcomes[i], position=(startPosition+BigInt(i)).toString();
        m.queueWait.add(Math.max(0,begin-e.mono)); m.processing.add(Math.max(0,end-e.mono));
        m.latestPersistedEventTime=maxNs(m.latestPersistedEventTime,e.event.header.exchangeTimeNs);
        if (result.duplicate) m.duplicateEvents++;
        else if (result.applied) {
          m.acceptedEvents++; m.appliedEvents++; m.persistedEvents++;
          m.lastAppliedPosition=position;
          m.latestModel={ position,eventNs:maxNs(m.latestModel?.eventNs ?? null,e.event.header.exchangeTimeNs),publishedMonoMs:end };
        } else {
          m.rejectedEvents++;
          if (result.outcome==="GAP") m.sequenceGapCount++;
        }
        const key=this.key(e.scopeId,e.event.header.channel as QualityChannel), fault=this.faults.get(key);
        if (fault?.recorded && e.ordinal>fault.barrier && e.event.kind==="L2_SNAPSHOT" && result.applied &&
          BigInt(e.event.header.receiveTimeNs)>=BigInt(fault.atNs)) this.faults.delete(key);
      }
      m.lastPersistedPosition=commit.lastPosition;
      this.queue.splice(0,group.length); this.bytes-=group.reduce((n,e)=>n+e.bytes,0);
      m.depth(this.queue.length,this.bytes,this.queue[0]?.mono??null); this.watermark();
      return this.controls();
    }
  }
  drain(): boolean {
    while (this.queue.length) if (!this.flush()) return false;
    return this.controls();
  }
  setRendererReady(ready: boolean): void { this.rendererReady=ready; if (!ready) this.offered=null; }
  /** Invoke existing derivation functions on committed state only; no arithmetic or coverage inference here. */
  derived<T>(scope: string, derive: (state: MarketQualityState, trades: TradeStore | undefined) => T): T | null {
    const state=this.storage.states.get(scope);
    if(!state || this.metrics.storageStatus!=="OK") return null;
    const start=this.clock();
    try { return derive(state,this.storage.trades.get(scope)); }
    finally { this.metrics.derivedProcessing.add(Math.max(0,this.clock()-start)); }
  }
  renderTick(): ModelStamp | null {
    const now=this.clock(), model=this.metrics.latestModel;
    if (!this.rendererReady || !model || now-this.renderClock<250 || model===this.offered) return null;
    this.renderClock=now; this.offered=model; return { ...model };
  }
  acknowledgeRender(stamp: ModelStamp): boolean {
    if (!this.rendererReady || !this.offered || stamp.position!==this.offered.position ||
      stamp.eventNs!==this.offered.eventNs || stamp.publishedMonoMs!==this.offered.publishedMonoMs) return false;
    this.metrics.renderedModel={ ...stamp }; this.metrics.latestRenderedEventTime=stamp.eventNs;
    this.metrics.renderAcknowledgement.add(Math.max(0,this.clock()-stamp.publishedMonoMs)); return true;
  }
}
