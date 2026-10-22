import { _planGuardEvent, _planRebaseSequenceGuard, type _GuardDecision,
  guardEvent, rebaseSequenceGuard, type GuardResult, type SequenceGuard } from "./sequenceGuard";
import { _createQualityReducer, currentMbpBook, currentQuality, markChannelCondition,
  type MarketQualityState, type MarketResult, type QualityChannel } from "./qualityTimeline";

declare const brand: unique symbol;
export interface SealedMarketState { readonly [brand]: true }
export type MarketDecision = Pick<MarketResult, "applied" | "outcome" | "reason">;
export interface SeenObservation {
  readonly phase: "base-import" | "owner-copy" | "guard" | "materialize" | "replay";
  readonly copies: number; readonly copiedEntries: number; readonly elapsedMs: number;
}
/** Deep detach, preserving Native Map insertion order and complete values. */
function copy<T>(value: T): T {
  if (value instanceof Map) return new Map([...value].map(([k,v]) => [copy(k), copy(v)])) as T;
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([k,v]) => [k, copy(v)])) as T;
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sealed = new WeakMap<object, MarketQualityState>();
const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();
function get(handle: SealedMarketState) {
  const state = sealed.get(handle);
  if (!state) throw new TypeError("Invalid sealed market state");
  return state;
}
function capsule(state: MarketQualityState): SealedMarketState {
  const handle = Object.freeze({}) as SealedMarketState;
  sealed.set(handle, state); return handle;
}
export function importMarketState(state: MarketQualityState): SealedMarketState { return capsule(copy(state)); }
export function materializeMarketState(state: SealedMarketState): MarketQualityState { return copy(get(state)); }
export function readSealedScope(handle: SealedMarketState) {
  const s = get(handle);
  return freeze(copy({ config: s.config, qualities: {
    L1: currentQuality(s.timeline,"L1"), L2_MBP: currentQuality(s.timeline,"L2_MBP"),
    TRADES: currentQuality(s.timeline,"TRADES"),
  }, lastBookReceiveNs: s.lastGoodBook.lastHeader?.receiveTimeNs ?? null }));
}
export function copySealedCurrentBook(handle: SealedMarketState) { return copy(currentMbpBook(get(handle))); }
export interface OwnedMarketSession {
  readonly phase: "ACTIVE" | "SEALED" | "DISCARDED";
  readonly config: MarketQualityState["config"];
  ingestEvent(input: unknown): MarketDecision;
  ingestBatch(inputs: readonly unknown[]): MarketDecision;
  condition(channel: QualityChannel, status: "GAP"|"STALE"|"RESYNCING"|"CLOSED"|"OUTSIDE_DEPTH",
    atNs: string, reason: string): void;
  inspectForVerification(): MarketQualityState;
  seal(): SealedMarketState;
  discard(): void;
}
export function beginOwnedSequenceSession(base: SealedMarketState,
  observe?: (m: SeenObservation) => void): OwnedMarketSession {
  return beginOwnedSequenceSessionFromNative(get(base), observe);
}
export function beginOwnedSequenceSessionFromNative(base: MarketQualityState,
  observe?: (m: SeenObservation) => void): OwnedMarketSession {
  return makeSession(base,true,observe);
}
/** @internal Reference session uses the same ownership/publication protocol, immutable guards. */
export function _beginImmutableSequenceSession(base:SealedMarketState|MarketQualityState,
  observe?:(m:SeenObservation)=>void):OwnedMarketSession {
  return makeSession(sealed.has(base)?get(base as SealedMarketState):base as MarketQualityState,false,observe);
}
function makeSession(base:MarketQualityState,owned:boolean,observe?: (m:SeenObservation)=>void):OwnedMarketSession {
  const start = now();
  // Single seen copy; all other mutable components are detached independently.
  const seen = owned ? new Map(base.guard.seen) : base.guard.seen;
  let state: MarketQualityState = { config: freeze(copy(base.config)), timeline: copy(base.timeline),
    lastGoodBook: copy(base.lastGoodBook), guard: {heads: copy(base.guard.heads), seen} };
  let phase: OwnedMarketSession["phase"] = "ACTIVE", busy = false;
  const undo: string[] = [];
  const versions = new WeakMap<SequenceGuard, number>();
  versions.set(state.guard, 0);
  const active = () => { if (phase !== "ACTIVE") throw new TypeError("Owner no longer active"); };
  observe?.({phase:"owner-copy",copies:owned?1:0,copiedEntries:owned?seen.size:0,elapsedMs:now()-start});
  function apply(guard: SequenceGuard, plan: _GuardDecision): GuardResult {
    active();
    let next = guard;
    if (plan.change === "NEXT") {
      const heads = new Map(guard.heads); heads.set(plan.partition, plan.head);
      if (plan.insert) {
        if (seen.has(plan.insert.key)) throw new TypeError("Owner insert would overwrite fingerprint");
        (seen as Map<string,string>).set(plan.insert.key, plan.insert.fingerprint); undo.push(plan.insert.key);
      }
      next = {heads, seen}; versions.set(next, undo.length);
    }
    return { state: next, outcome:plan.outcome, apply:plan.apply, reason:plan.reason, verification:plan.verification };
  }
  const immutableEvent:typeof guardEvent=(s,i,r)=>{
    const t=now(),result=guardEvent(s,i,r);
    observe?.({phase:"guard",copies:result.state.seen===s.seen?0:1,
      copiedEntries:result.state.seen===s.seen?0:s.seen.size,elapsedMs:now()-t});
    return result;
  };
  const immutableRebase:typeof rebaseSequenceGuard=(s,i,r,e)=>{
    const t=now(),result=rebaseSequenceGuard(s,i,r,e);
    observe?.({phase:"guard",copies:result.state.seen===s.seen?0:1,
      copiedEntries:result.state.seen===s.seen?0:s.seen.size,elapsedMs:now()-t});
    return result;
  };
  function ownedObserved(guard:SequenceGuard, plan:()=>_GuardDecision) {
    const t=now(),result=apply(guard,plan());
    observe?.({phase:"guard",copies:0,copiedEntries:0,elapsedMs:now()-t});
    return result;
  }
  const reducer = _createQualityReducer(owned?{
    event: (guard, input, rule) => ownedObserved(guard,()=>_planGuardEvent(guard,input,rule)),
    rebase: (guard,input,rule,evidence) => ownedObserved(guard,()=>_planRebaseSequenceGuard(guard,input,rule,evidence)),
  }:{event:immutableEvent,rebase:immutableRebase});
  function rollback(end: number) { while (undo.length > end) (seen as Map<string,string>).delete(undo.pop()!); }
  function run(input: unknown, batch: boolean): MarketDecision {
    active(); if (busy) throw new TypeError("Reentrant owner use");
    busy = true; const checkpoint = undo.length;
    try {
      const ownedInput = copy(input);
      const result = batch ? reducer.ingestBatch(state,ownedInput as readonly unknown[]) : reducer.ingestEvent(state,ownedInput);
      if(owned) {
        const end = versions.get(result.state.guard);
        if (end === undefined) throw new TypeError("Foreign guard token");
        rollback(end);
      }
      state = result.state;
      return { applied: result.applied, outcome: result.outcome, reason: result.reason };
    } catch (e) { rollback(checkpoint); throw e; }
    finally { busy = false; }
  }
  return Object.freeze({
    get phase() { return phase; },
    get config() { return state.config; },
    ingestEvent: (input:unknown) => run(input,false),
    ingestBatch: (inputs:readonly unknown[]) => run(inputs,true),
    condition(channel:QualityChannel,status:"GAP"|"STALE"|"RESYNCING"|"CLOSED"|"OUTSIDE_DEPTH",atNs:string,reason:string) {
      active(); if(busy)throw new TypeError("Reentrant owner use");
      state = markChannelCondition(state,channel,status,atNs,reason);
    },
    inspectForVerification() { active(); return copy(state); },
    seal() { active(); if(busy)throw new TypeError("Reentrant owner use"); phase="SEALED"; return capsule(state); },
    discard() { active(); phase="DISCARDED"; if(owned)(seen as Map<string,string>).clear(); },
  });
}
