import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventJournal, applyJournalInput, applyOwnedJournalInput, eventsIn, selectJournalSeenForFiniteMock,
  type JournalInput, type JournalAttemptEvidence, type JournalCommitReceipt } from "@workspace/storage/journal";
import { SqliteCatalog, checksum, canonical } from "@workspace/storage/catalog";
import { migrateToV2 } from "@workspace/storage/migration";
import { currentQuality, type MarketQualityConfig, type MarketQualityState, type QualityChannel } from "@workspace/core/quality-timeline";
import { createTradeStore, ingestTrade, type TradeStore } from "@workspace/core/trade-store";
import type { MarketEvent } from "@workspace/core/events";
import { maxNs } from "./metrics";
import { requireOwnedDirectory } from "./r16Fixtures";
import type { Trace } from "./r161Diagnostics";
import { beginOwnedSequenceSession, _beginImmutableSequenceSession, importMarketState, materializeMarketState, readSealedScope,
  copySealedCurrentBook, type SealedMarketState, type SeenObservation } from "@workspace/core/owned-sequence-session";
import { currentMbpBook } from "@workspace/core/quality-timeline";

export interface FiniteSeenRun {
  readonly mode:"immutable"|"owned";readonly eventLimit:100|400|1000|2000;
  readonly traceHash:string;readonly c1Mode:"reference";readonly boundary:"fixed";
}
export interface StorageAdapterOptions { readonly finiteSeen?:FiniteSeenRun }
export type CommitPhase="STAGED"|"PRIVATE_CANDIDATE"|"SEALED_CANDIDATE"|"COMMIT_IN_PROGRESS"|
  "COMMITTED_NOT_PUBLISHED"|"PUBLISHED"|"FAILED_OR_UNKNOWN";
type Outcome={applied:boolean;duplicate:boolean;outcome:string;input:JournalInput};
export interface PublishedStorageCommit extends JournalCommitReceipt {readonly outcomes:readonly Outcome[]}
export interface StorageCommitAttempt {
  readonly id:string;readonly phase:CommitPhase;readonly receipt:JournalCommitReceipt|null;
  readonly evidence:JournalAttemptEvidence|null;
  execute():PublishedStorageCommit;resumePublish():PublishedStorageCommit;
  reconcile():"COMMITTED"|"NOT_COMMITTED"|"UNKNOWN";discardUncommitted():void;
}
interface Root {
  states:Map<string,MarketQualityState|SealedMarketState>;trades:Map<string,TradeStore>;generation:number;
  lastLogicalAppliedPosition:string;lastLogicalAppliedTime:string|null;latestPersistedTime:string|null;
}
function freezeInputs<T>(value:T):T {
  if(value && typeof value==="object"){for(const x of Object.values(value))freezeInputs(x);Object.freeze(value);}
  return value;
}

export class StorageAdapter {
  trace: Trace | undefined;
  private _catalog!:SqliteCatalog;
  private _journal!:EventJournal;
  get catalog(){return this._catalog;}
  get journal(){return this._journal;}
  private root:Root={states:new Map(),trades:new Map(),generation:0,lastLogicalAppliedPosition:"0",
    lastLogicalAppliedTime:null,latestPersistedTime:null};
  private active:StorageCommitAttempt|null=null;
  private convenience:{attempt:StorageCommitAttempt;scopeId:string;inputHash:string}|null=null;
  private attemptId=0;
  private deselect:(()=>void)|undefined;
  private readonly owned:boolean;
  readonly seenObservations:{owner:"adapter"|"journal";observation:SeenObservation}[]=[];
  readonly commitObservations:{events:number;inputs:number;transactionMs:number;commitMs:number;candidateMs:number}[]=[];
  beforePublish:(()=>void)|undefined;
  /** Diagnostic fault after actual COMMIT but before receipt delivery. */
  afterCommitBeforeReceipt:(()=>void)|undefined;
  get pendingAttempt(){return this.active;}
  get states():ReadonlyMap<string,MarketQualityState> {
    return new Map([...this.root.states.keys()].map(id=>[id,this.stateSnapshot(id)!]));
  }
  get trades():ReadonlyMap<string,TradeStore>{return structuredClone(this.root.trades);}
  get lastLogicalAppliedPosition(){return this.root.lastLogicalAppliedPosition;}
  get lastLogicalAppliedTime(){return this.root.lastLogicalAppliedTime;}
  get latestPersistedTime(){return this.root.latestPersistedTime;}
  beforeCommit: (() => void) | undefined;
  readonly options:StorageAdapterOptions;
  constructor(readonly directory: string,options:StorageAdapterOptions={}) {
    requireOwnedDirectory(directory);
    this.options=freezeInputs(structuredClone(options));
    const run=this.options.finiteSeen;
    if(run && (!["immutable","owned"].includes(run.mode)||![100,400,1000,2000].includes(run.eventLimit)||
      !/^[a-f0-9]{64}$/.test(run.traceHash)||run.c1Mode!=="reference"||run.boundary!=="fixed"))
      throw Error("Invalid finite seen run");
    this.owned=run?.mode==="owned";
    const file = join(directory, "events.r16.sqlite"), fresh = !existsSync(file);
    this._catalog = new SqliteCatalog(file);
    this._journal = new EventJournal(this.catalog);
    if (fresh) migrateToV2(this.journal);
    else if (this.catalog.database.pragma("user_version", { simple: true }) !== 2) {
      this.catalog.close(); throw new Error("R16 refuses implicit migration of an existing database");
    }
    for (const { id } of this.catalog.database.prepare("SELECT id FROM scopes").all() as { id: string }[]) {
      const state=this.journal.replay(id);
      this.root.states.set(id,importMarketState(state));
      for (const r of this.journal.records(id)) for (const e of eventsIn(r.input)) {
        this.root.latestPersistedTime=maxNs(this.latestPersistedTime,e.header.exchangeTimeNs);
        let logical=r.applied;
        if (e.header.channel === "TRADES" && (r.applied || r.outcome === "DUPLICATE"))
          logical=this.applyTrade(id,e,this.root.trades)==="ACCEPTED" && r.applied;
        if(logical) {
          this.root.lastLogicalAppliedTime=maxNs(this.lastLogicalAppliedTime,e.header.exchangeTimeNs);
          if(BigInt(r.position)>BigInt(this.lastLogicalAppliedPosition)) this.root.lastLogicalAppliedPosition=r.position;
        }
      }
    }
  }
  register(config: MarketQualityConfig, startNs: string): string {
    if(this.active)throw Error("Pending attempt fences registration");
    if (!this.root.states.has(checksum(config.identity)) && this.root.states.size >= 32) throw new Error("R16 scope limit: 32");
    const scope = this.journal.register(config, startNs);
    if (!this.root.states.has(scope.id)) {
      const state=this.journal.replay(scope.id);
      this.root={...this.root,states:new Map(this.root.states).set(scope.id,importMarketState(state)),
        generation:this.root.generation+1};
    }
    if(this.options.finiteSeen) {
      this.deselect?.();
      this.deselect=selectJournalSeenForFiniteMock(this.journal,{...this.options.finiteSeen,
        scopeIds:[...this.root.states.keys()],expectedAuditInputs:this.options.finiteSeen.eventLimit,
        observe:m=>this.observeSeen("journal",m)});
    }
    return scope.id;
  }
  private applyTrade(id: string, event: MarketEvent, stores: Map<string, TradeStore>): string {
    const current = stores.get(id) ?? createTradeStore(event.header);
    const result = this.trace ? this.trace.measure("candidate.trade_dedup",()=>ingestTrade(current,event)) : ingestTrade(current,event);
    stores.set(id,result.store); return result.disposition;
  }
  private observeSeen(owner:"adapter"|"journal",observation:SeenObservation) {
    const index=this.seenObservations.findIndex(x=>x.owner===owner && x.observation.phase===observation.phase);
    if(index<0)this.seenObservations.push({owner,observation});
    else {
      const old=this.seenObservations[index].observation;
      this.seenObservations[index]={owner,observation:{...observation,copies:old.copies+observation.copies,
        copiedEntries:old.copiedEntries+observation.copiedEntries,elapsedMs:old.elapsedMs+observation.elapsedMs}};
    }
  }
  readScope(id:string) {
    const state=this.root.states.get(id); if(!state)return undefined;
    const view=readSealedScope(state as SealedMarketState);
    return structuredClone({identity:view.config.identity,qualities:view.qualities,
      lastBookReceiveNs:view.lastBookReceiveNs,tradeIssueCount:this.root.trades.get(id)?.issues.length??0});
  }
  stateSnapshot(id:string) {
    const state=this.root.states.get(id);
    return state?materializeMarketState(state as SealedMarketState):undefined;
  }
  tradeSnapshot(id:string){return structuredClone(this.root.trades.get(id));}
  bookSnapshot(id:string) {
    const state=this.root.states.get(id);
    return state?copySealedCurrentBook(state as SealedMarketState):null;
  }
  beginCommit(scopeId:string, inputs:readonly JournalInput[]):StorageCommitAttempt {
    if(this.active)throw Error("Pending attempt must be resolved before another write");
    if(!this.root.states.has(scopeId))throw Error("Unregistered scope");
    const pending=freezeInputs(JSON.parse(canonical(inputs)) as JournalInput[]);
    const base=this.root, before=this.catalog.manifest();
    let phase:CommitPhase="STAGED",receipt:JournalCommitReceipt|null=null;
    let stage:ReturnType<EventJournal["stage"]>|undefined, candidate:Root|undefined;
    let outcomes:Outcome[]=[],result:PublishedStorageCommit|undefined;
    let transactionMs=0,candidateMs=0,commitStart=0;
    const self=this;
    const publish=():PublishedStorageCommit=>{
      if(phase==="PUBLISHED")return result!;
      if(phase!=="COMMITTED_NOT_PUBLISHED" || !receipt || !candidate)throw Error("No durable candidate");
      if(self.root!==base)throw Error("Stale candidate generation");
      self.beforePublish?.(); // Last fallible hook: failure retains candidate and receipt.
      self.root=candidate; phase="PUBLISHED";self.active=null;self.convenience=null;
      return result!;
    };
    const attempt:StorageCommitAttempt={
      id:String(++this.attemptId),get phase(){return phase;},get receipt(){return receipt;},
      get evidence(){return stage?.attemptEvidence??null;},
      resumePublish:publish,
      reconcile() {
        if(phase==="PUBLISHED" || phase==="COMMITTED_NOT_PUBLISHED")return "COMMITTED";
        let independent:SqliteCatalog|undefined;
        try {
          if(self.catalog.database.inTransaction)return "UNKNOWN";
          // Existing catalog uses locking_mode=EXCLUSIVE: release it before independent verification.
          const filename=self.catalog.filename;
          self.catalog.close();
          independent=new SqliteCatalog(filename);
          const journal=new EventJournal(independent),manifest=independent.manifest();
          const evidence=stage?.attemptEvidence;
          self._catalog=independent;self._journal=journal;independent=undefined;
          self.deselect?.();self.deselect=undefined;
          if(self.options.finiteSeen)self.deselect=selectJournalSeenForFiniteMock(journal,{
            ...self.options.finiteSeen,scopeIds:[...self.root.states.keys()],
            expectedAuditInputs:self.options.finiteSeen.eventLimit,observe:m=>self.observeSeen("journal",m)});
          if(manifest.recordCount===before.recordCount && manifest.head===before.head)return "NOT_COMMITTED";
          if(evidence?.expected && manifest.recordCount===evidence.expected.lastPosition &&
            manifest.head===evidence.expected.checksum) {
            const records=journal.records().filter(r=>BigInt(r.position)>BigInt(before.recordCount));
            if(records.length===pending.length && records.every(r=>r.scopeId===scopeId) &&
              checksum(records.map(r=>r.input))===checksum(pending)) {
              receipt=Object.freeze({committed:true,...evidence.expected}); result=freezeInputs({...receipt,outcomes});
              phase="COMMITTED_NOT_PUBLISHED";return "COMMITTED";
            }
          }
          return "UNKNOWN";
        } catch {return "UNKNOWN";} finally {independent?.close();}
      },
      discardUncommitted() {
        if(self.active && self.active!==attempt)throw Error("Another writer is active");
        if(attempt.reconcile()!=="NOT_COMMITTED")throw Error("Cannot discard uncertain/durable attempt");
        self.active=null;phase="FAILED_OR_UNKNOWN";
      },
      execute() {
        if(self.active && self.active!==attempt)throw Error("Another writer is active");
        if(phase==="PUBLISHED")return result!;
        if(phase==="COMMITTED_NOT_PUBLISHED")return publish();
        if(phase==="FAILED_OR_UNKNOWN") {
          const status=attempt.reconcile();
          if(status==="COMMITTED")return publish();
          if(status!=="NOT_COMMITTED")throw Error("UNKNOWN COMMIT: independent reconciliation required");
        }
        if(self.root!==base)throw Error("Stale candidate generation");
        self.active=attempt;phase="PRIVATE_CANDIDATE";
        const prepareStart=performance.now();
        try {
          const observe=self.options.finiteSeen?(m:SeenObservation)=>self.observeSeen("adapter",m):undefined;
          const owner=self.owned?beginOwnedSequenceSession(base.states.get(scopeId) as SealedMarketState,observe):
            _beginImmutableSequenceSession(base.states.get(scopeId) as SealedMarketState,observe);
          const trades=new Map(base.trades);
          outcomes=pending.map(input=>{
      const stage=input.type==="EVENT" && input.event.kind==="L2_SNAPSHOT"?"candidate.snapshot_sequence_quality":"candidate.sequence_quality";
      const apply=()=>applyOwnedJournalInput(owner,input);
      const decision=self.trace?self.trace.measure(stage,apply):apply();
      let applied = decision.applied, duplicate = decision.outcome === "DUPLICATE";
      for (const event of eventsIn(input)) if (event.header.channel === "TRADES" && (applied || duplicate)) {
        const disposition = self.applyTrade(scopeId,event,trades);
        duplicate ||= disposition === "DUPLICATE";
        applied &&= disposition === "ACCEPTED";
      }
      return { applied, duplicate, outcome: decision.outcome, input };
          });
          candidate={...base,states:new Map(base.states).set(scopeId,owner.seal()),
            trades,generation:base.generation+1};
    const firstPosition=BigInt(before.recordCount)+1n;
    for(let i=0;i<outcomes.length;i++) for(const e of eventsIn(inputs[i])) {
      candidate.latestPersistedTime=maxNs(candidate.latestPersistedTime,e.header.exchangeTimeNs);
      if(outcomes[i].applied) {
        candidate.lastLogicalAppliedPosition=(firstPosition+BigInt(i)).toString();
        candidate.lastLogicalAppliedTime=maxNs(candidate.lastLogicalAppliedTime,e.header.exchangeTimeNs);
      }
    }
          phase="SEALED_CANDIDATE";stage=self.journal.stage(scopeId,pending);
          candidateMs=performance.now()-prepareStart;
          commitStart=performance.now();phase="COMMIT_IN_PROGRESS";
          const actual=stage.commit(self.beforeCommit);transactionMs=performance.now()-commitStart;
          self.afterCommitBeforeReceipt?.(); // Simulates lost return; evidence is NOT success proof.
          receipt=Object.freeze(actual);result=freezeInputs({...actual,outcomes});phase="COMMITTED_NOT_PUBLISHED";
          // All fallible diagnostics before pointer publish; bounded finite-only arrays.
          if(self.options.finiteSeen) {
            if(self.commitObservations.length>=2048)throw Error("Commit observer capacity");
            self.commitObservations.push({events:pending.reduce((n,i)=>n+eventsIn(i).length,0),
              inputs:pending.length,transactionMs,commitMs:performance.now()-prepareStart,candidateMs});
          }
          self.trace?.add("canonical.publish",0);self.trace?.count("committed.input_entries",pending.length);
        } catch(error) {
          if(phase!=="COMMITTED_NOT_PUBLISHED")phase="FAILED_OR_UNKNOWN";
          throw error;
        }
        return publish();
      },
    };
    return attempt;
  }
  commit(scopeId:string, inputs:readonly JournalInput[]):PublishedStorageCommit {
    // Legacy convenience retry is allowed ONLY after independently proving zero commit.
    // A matching payload alone never identifies a durable retry or authorizes a second INSERT.
    if(this.active) {
      const previous=this.convenience;
      if(previous?.attempt===this.active && previous.scopeId===scopeId &&
        previous.inputHash===checksum(inputs) && this.active.phase==="FAILED_OR_UNKNOWN" &&
        this.active.reconcile()==="NOT_COMMITTED")return this.active.execute();
      throw Error("Pending attempt requires explicit resolution");
    }
    const attempt=this.beginCommit(scopeId,inputs);
    this.convenience={attempt,scopeId,inputHash:checksum(inputs)};
    return attempt.execute();
  }
  condition(scopeId: string, channel: QualityChannel, atNs: string, status: "GAP" | "RESYNCING", reason: string) {
    const state = this.stateSnapshot(scopeId);
    if (!state) throw new Error("Unknown fault scope");
    const lastReceipt = this.journal.records(scopeId).filter(r => r.channel === channel).at(-1)?.receiveNs ?? atNs;
    const detectionNs = maxNs(maxNs(atNs,lastReceipt), currentQuality(state.timeline,channel).startNs)!;
    return this.commit(scopeId,[{ type: "CONDITION", channel, atNs: detectionNs, status, reason }]);
  }
  close(): void { this.catalog.close(); }
}
