import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventJournal, applyJournalInput, eventsIn, type JournalInput } from "@workspace/storage/journal";
import { SqliteCatalog, checksum } from "@workspace/storage/catalog";
import { migrateToV2 } from "@workspace/storage/migration";
import { currentQuality, type MarketQualityConfig, type MarketQualityState, type QualityChannel } from "@workspace/core/quality-timeline";
import { createTradeStore, ingestTrade, type TradeStore } from "@workspace/core/trade-store";
import type { MarketEvent } from "@workspace/core/events";
import { maxNs } from "./metrics";
import { requireOwnedDirectory } from "./r16Fixtures";
import type { Trace } from "./r161Diagnostics";

export class StorageAdapter {
  trace: Trace | undefined;
  readonly catalog: SqliteCatalog;
  readonly journal: EventJournal;
  readonly states = new Map<string, MarketQualityState>();
  readonly trades = new Map<string, TradeStore>();
  lastLogicalAppliedPosition = "0";
  lastLogicalAppliedTime: string | null = null;
  latestPersistedTime: string | null = null;
  beforeCommit: (() => void) | undefined;
  constructor(readonly directory: string) {
    requireOwnedDirectory(directory);
    const file = join(directory, "events.r16.sqlite"), fresh = !existsSync(file);
    this.catalog = new SqliteCatalog(file);
    this.journal = new EventJournal(this.catalog);
    if (fresh) migrateToV2(this.journal);
    else if (this.catalog.database.pragma("user_version", { simple: true }) !== 2) {
      this.catalog.close(); throw new Error("R16 refuses implicit migration of an existing database");
    }
    for (const { id } of this.catalog.database.prepare("SELECT id FROM scopes").all() as { id: string }[]) {
      this.states.set(id, this.journal.replay(id));
      for (const r of this.journal.records(id)) for (const e of eventsIn(r.input)) {
        this.latestPersistedTime=maxNs(this.latestPersistedTime,e.header.exchangeTimeNs);
        let logical=r.applied;
        if (e.header.channel === "TRADES" && (r.applied || r.outcome === "DUPLICATE"))
          logical=this.applyTrade(id,e,this.trades)==="ACCEPTED" && r.applied;
        if(logical) {
          this.lastLogicalAppliedTime=maxNs(this.lastLogicalAppliedTime,e.header.exchangeTimeNs);
          if(BigInt(r.position)>BigInt(this.lastLogicalAppliedPosition)) this.lastLogicalAppliedPosition=r.position;
        }
      }
    }
  }
  register(config: MarketQualityConfig, startNs: string): string {
    if (!this.states.has(checksum(config.identity)) && this.states.size >= 32) throw new Error("R16 scope limit: 32");
    const scope = this.journal.register(config, startNs);
    if (!this.states.has(scope.id)) this.states.set(scope.id, this.journal.replay(scope.id));
    return scope.id;
  }
  private applyTrade(id: string, event: MarketEvent, stores: Map<string, TradeStore>): string {
    const current = stores.get(id) ?? createTradeStore(event.header);
    const result = this.trace ? this.trace.measure("candidate.trade_dedup",()=>ingestTrade(current,event)) : ingestTrade(current,event);
    stores.set(id,result.store); return result.disposition;
  }
  commit(scopeId: string, inputs: readonly JournalInput[]) {
    let state = this.states.get(scopeId);
    if (!state) throw new Error("Unregistered scope");
    const trades = new Map(this.trades);
    const outcomes = inputs.map(input => {
      const stage=input.type==="EVENT" && input.event.kind==="L2_SNAPSHOT"?"candidate.snapshot_sequence_quality":"candidate.sequence_quality";
      const result = this.trace ? this.trace.measure(stage,()=>applyJournalInput(state!,input)) : applyJournalInput(state!,input);
      state = result.state;
      let applied = result.applied, duplicate = result.outcome === "DUPLICATE";
      for (const event of eventsIn(input)) if (event.header.channel === "TRADES" && (applied || duplicate)) {
        const disposition = this.applyTrade(scopeId,event,trades);
        duplicate ||= disposition === "DUPLICATE";
        applied &&= disposition === "ACCEPTED";
      }
      return { applied, duplicate, outcome: result.outcome, input };
    });
    // Candidate states above are private until FULL transaction commit has returned.
    const committed = this.journal.stage(scopeId,inputs).commit(this.beforeCommit);
    const publishStarted=this.trace?performance.now():0;
    this.states.set(scopeId,state!);
    this.trades.clear(); for (const [key,value] of trades) this.trades.set(key,value);
    const firstPosition=BigInt(committed.lastPosition)-BigInt(inputs.length)+1n;
    for(let i=0;i<outcomes.length;i++) for(const e of eventsIn(inputs[i])) {
      this.latestPersistedTime=maxNs(this.latestPersistedTime,e.header.exchangeTimeNs);
      if(outcomes[i].applied) {
        this.lastLogicalAppliedPosition=(firstPosition+BigInt(i)).toString();
        this.lastLogicalAppliedTime=maxNs(this.lastLogicalAppliedTime,e.header.exchangeTimeNs);
      }
    }
    this.trace?.add("canonical.publish",performance.now()-publishStarted);
    this.trace?.count("committed.input_entries",inputs.length);
    return { ...committed, outcomes };
  }
  condition(scopeId: string, channel: QualityChannel, atNs: string, status: "GAP" | "RESYNCING", reason: string) {
    const state = this.states.get(scopeId);
    if (!state) throw new Error("Unknown fault scope");
    const lastReceipt = this.journal.records(scopeId).filter(r => r.channel === channel).at(-1)?.receiveNs ?? atNs;
    const detectionNs = maxNs(maxNs(atNs,lastReceipt), currentQuality(state.timeline,channel).startNs)!;
    return this.commit(scopeId,[{ type: "CONDITION", channel, atNs: detectionNs, status, reason }]);
  }
  close(): void { this.catalog.close(); }
}
