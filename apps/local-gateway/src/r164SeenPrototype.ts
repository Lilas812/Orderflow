/** FINITE MOCK EXPERIMENT ONLY. No production reducer/import/Map is patched.
 * Trusted, unchanged repository sources execute in a private VM. Only the two
 * seen-copy constructions are intercepted by identity; heads always use native Map.
 * The native imported quality/guard functions remain the independent oracle.
 */
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import * as events from "@workspace/core/events";
import * as book from "@workspace/core/mbp-book";
import * as oracle from "@workspace/core/quality-timeline";
import type { SequenceGuard, GuardResult,ContinuityRule } from "@workspace/core/sequence-guard";
import { checksum } from "@workspace/storage/catalog";

export type SeenMode = "A" | "B" | "C";
export type Step =
  | { type:"EVENT"; event:events.MarketEvent }
  | { type:"BATCH"; events:readonly events.MarketEvent[] }
  | { type:"CONDITION"; channel:oracle.QualityChannel;
      status:"GAP"|"STALE"|"RESYNCING"; atNs:string; reason:string };
type Head = SequenceGuard["heads"] extends ReadonlyMap<string,infer V> ? V : never;
type Phase = "ACTIVE"|"PREPARED"|"COMMITTED_NOT_PUBLISHED"|"PUBLISHED"|"ROLLED_BACK";
export interface CopyMetrics {
  copies:number; copiedEntries:number; copyMs:number; requests:number;
  writes:number; undoneWrites:number; setMs:number; lookups:number; lookupMs:number;
}
const metrics = ():CopyMetrics => ({
  copies:0,copiedEntries:0,copyMs:0,requests:0,writes:0,undoneWrites:0,
  setMs:0,lookups:0,lookupMs:0,
});

/** Truly read-only facade, not Object.freeze(new Map()). Never exposes its backing Map. */
class SealedMap<K,V> implements ReadonlyMap<K,V> {
  #backing:ReadonlyMap<K,V>;
  constructor(backing:ReadonlyMap<K,V>) { this.#backing=backing;Object.freeze(this); }
  get size(){return this.#backing.size;}
  get(k:K){return this.#backing.get(k);}
  has(k:K){return this.#backing.has(k);}
  entries(){return this.#backing.entries();}
  keys(){return this.#backing.keys();}
  values(){return this.#backing.values();}
  [Symbol.iterator](){return this.entries();}
  forEach(fn:(v:V,k:K,m:ReadonlyMap<K,V>)=>void,thisArg?:unknown) {
    for(const[k,v]of this)fn.call(thisArg,v,k,this);
  }
  get [Symbol.toStringTag](){return "ReadonlyMap";}
}
/** Published C has at most ONE layer. The next transaction flattens it once. */
class LayerMap implements ReadonlyMap<string,string> {
  constructor(private readonly base:ReadonlyMap<string,string>,private readonly delta:ReadonlyMap<string,string>){
    Object.freeze(this);
  }
  get size(){return this.base.size+this.delta.size;}
  get(k:string){return this.delta.get(k)??this.base.get(k);}
  has(k:string){return this.delta.has(k)||this.base.has(k);}
  *entries():MapIterator<[string,string]>{yield* this.base;yield* this.delta;}
  *keys():MapIterator<string>{for(const[k]of this)yield k;}
  *values():MapIterator<string>{for(const[,v]of this)yield v;}
  [Symbol.iterator](){return this.entries();}
  forEach(fn:(v:string,k:string,m:ReadonlyMap<string,string>)=>void,thisArg?:unknown){
    for(const[k,v]of this)fn.call(thisArg,v,k,this);
  }
  get [Symbol.toStringTag](){return "ReadonlyOverlay";}
}
function frozen<T>(value:T):T {
  if(value===null||typeof value!=="object")return value;
  if(Array.isArray(value))return Object.freeze(value.map(frozen)) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,frozen(v)]))) as T;
}
function detached(s:oracle.MarketQualityState):oracle.MarketQualityState {
  // Public diagnostic snapshots are copies. None is a candidate/base ownership handle.
  return structuredClone({...s,guard:{heads:new Map(s.guard.heads),seen:new Map(s.guard.seen)},
    lastGoodBook:{...s.lastGoodBook,bids:new Map(s.lastGoodBook.bids),asks:new Map(s.lastGoodBook.asks)}});
}
function sealState(s:oracle.MarketQualityState,seen:ReadonlyMap<string,string>):oracle.MarketQualityState {
  return Object.freeze({
    config:frozen(s.config),timeline:frozen(s.timeline),
    guard:Object.freeze({heads:new SealedMap(new Map([...s.guard.heads].map(([k,v])=>[k,frozen(v)]))),seen}),
    lastGoodBook:Object.freeze({...frozen({...s.lastGoodBook,bids:undefined,asks:undefined}),
      bids:new SealedMap(new Map(s.lastGoodBook.bids)),asks:new SealedMap(new Map(s.lastGoodBook.asks))}),
  });
}
const published = new WeakMap<PublishedState,oracle.MarketQualityState>();
export class PublishedState {
  private constructor(state:oracle.MarketQualityState,key:symbol){
    if(key!==transferKey)throw Error("PRIVATE_TRANSFER_REQUIRED");
    published.set(this,state);Object.freeze(this);
  }
  static fromOracle(state:oracle.MarketQualityState):PublishedState {
    if(state.config.identity.environment!=="MOCK"||state.config.identity.source!=="MOCK_DETERMINISTIC")
      throw Error("PROTOTYPE_MOCK_ONLY");
    if(state.guard.seen.size>4096)throw Error("PROTOTYPE_SAFETY_STOP: finite base entry budget");
    const copy=detached(state);
    return new PublishedState(sealState(copy,new SealedMap(new Map(copy.guard.seen))),transferKey);
  }
  /** Internal transfer of a sealed owned Map; only this module can supply the capability. */
  static transfer(state:oracle.MarketQualityState,key:symbol):PublishedState {
    if(key!==transferKey)throw Error("PRIVATE_TRANSFER_REQUIRED");
    return new PublishedState(state,transferKey);
  }
  inspect(){const state=published.get(this);if(!state)throw Error("UNKNOWN_BASE");return detached(state);}
  checksum(){return checksum(this.inspect());}
}
const transferKey=Symbol("private publication transfer");
const references=new WeakMap<object,number>();let nextReference=0;
function reference(value:object){let id=references.get(value);if(!id){id=++nextReference;references.set(value,id);}return id;}

class SeenStore {
  readonly m=metrics();
  readonly known=new WeakSet<object>();
  readonly checkpoints=new WeakMap<object,number>();
  private base:ReadonlyMap<string,string>;
  private data:Map<string,string>|null=null;
  private trail:string[]=[];
  private readonly unwrapped=new WeakMap<object,ReadonlyMap<string,string>>();
  readonly view:ReadonlyMap<string,string>;
  constructor(readonly mode:SeenMode,base:ReadonlyMap<string,string>){
    if(base.size>4096)throw Error("PROTOTYPE_SAFETY_STOP: finite base entry budget");
    this.base=base;
    if(mode==="B")this.data=this.copy(base);
    if(mode==="C"){
      if(base instanceof LayerMap)this.base=new SealedMap(this.copy(base));
      this.data=new Map();
    }
    const owner=this;
    // This writable facade is NEVER returned, retained by published state, or exported.
    this.view=mode==="A"?this.instrument(base):{
      get size(){return (mode==="B"?owner.requireData().size:owner.base.size+owner.requireData().size);},
      get(k:string){
        const t=performance.now();try{owner.m.lookups++;
          return owner.requireData().get(k)??(mode==="C"?owner.base.get(k):undefined);
        }finally{owner.m.lookupMs+=performance.now()-t;}
      },
      has(k:string){return this.get(k)!==undefined;},
      set(k:string,v:string){
        const t=performance.now();try{
          if(owner.requireData().has(k)||(mode==="C"&&owner.base.has(k)))throw Error("FINGERPRINT_OVERWRITE_FORBIDDEN");
          if(this.size>=4096)throw Error("PROTOTYPE_SAFETY_STOP: 4096 seen entries; finite MOCK only");
          owner.requireData().set(k,v);owner.trail.push(k);owner.m.writes++;
          return this;
        }finally{owner.m.setMs+=performance.now()-t;}
      },
      *entries(){yield* (mode==="C"?owner.base:[]);yield* owner.requireData();},
      *keys(){for(const[k]of this)yield k;},
      *values(){for(const[,v]of this)yield v;},
      [Symbol.iterator](){return this.entries();},
      forEach(fn:(v:string,k:string,m:ReadonlyMap<string,string>)=>void,thisArg?:unknown){
        for(const[k,v]of this)fn.call(thisArg,v,k,this);
      },
    } as ReadonlyMap<string,string>;
    this.known.add(this.view);
  }
  private requireData(){if(!this.data)throw Error("OWNERSHIP_ENDED");return this.data;}
  private instrument(value:ReadonlyMap<string,string>):ReadonlyMap<string,string>{
    const owner=this;
    const proxy=new Proxy(value,{get(target,key){
      const fn=Reflect.get(target,key,target);
      if(typeof fn!=="function")return fn;
      return (...args:unknown[])=>{
        const start=performance.now();
        try{
          if(key==="set"&&target.size>=4096&&!target.has(args[0] as string))
            throw Error("PROTOTYPE_SAFETY_STOP: 4096 seen entries; finite MOCK only");
          const result=Reflect.apply(fn,target,args);
          if(key==="set")owner.m.writes++;
          return result===target?proxy:result;
        }finally{
          if(key==="get"){owner.m.lookups++;owner.m.lookupMs+=performance.now()-start;}
          if(key==="set")owner.m.setMs+=performance.now()-start;
        }
      };
    }});
    this.unwrapped.set(proxy,value);return proxy;
  }
  private copy(input:ReadonlyMap<string,string>){
    const t=performance.now();try{
      const value=new Map(input);this.m.copies++;this.m.copiedEntries+=input.size;return value;
    }finally{this.m.copyMs+=performance.now()-t;}
  }
  construct(input:ReadonlyMap<string,string>){
    this.m.requests++;
    if(this.mode!=="A")return this.view;
    const result=this.instrument(this.copy(input));this.known.add(result);return result;
  }
  start(guard:SequenceGuard){this.trail=[];this.checkpoints.set(guard,0);}
  guarded(before:SequenceGuard,result:GuardResult){
    this.known.add(before.seen);this.known.add(result.state.seen);
    if(!this.checkpoints.has(result.state))this.checkpoints.set(result.state,this.trail.length);
  }
  finish(guard?:SequenceGuard){
    const end=guard?this.checkpoints.get(guard):0;
    if(end===undefined)throw Error("UNTRACKED_GUARD_BRANCH");
    if(this.mode!=="A")while(this.trail.length>end){
      this.requireData().delete(this.trail.pop()!);this.m.undoneWrites++;
    }
    this.trail=[];
  }
  take(guard:SequenceGuard):ReadonlyMap<string,string>{
    if(this.mode==="A"){
      const raw=this.unwrapped.get(guard.seen)??guard.seen;
      return raw instanceof SealedMap||raw instanceof LayerMap?raw:new SealedMap(raw);
    }
    const owned=this.requireData();this.data=null;
    return this.mode==="B"?new SealedMap(owned):
      owned.size?new LayerMap(this.base,new SealedMap(owned)):this.base;
  }
  discard(){this.data=null;this.trail=[];}
  ownership(){
    return {privateSeenReference:reference(this.view),privateStorageReference:this.data?reference(this.data):null,
      immutableBaseReference:reference(this.base),baseMayBeShared:this.mode==="C"};
  }
}

/** Compile trusted source once; no source text substitutions, imports or files are modified. */
const source=(name:string)=>readFileSync(new URL(`../../../packages/core/src/${name}.ts`,import.meta.url),"utf8");
const guardSource=source("sequenceGuard"),qualitySource=source("qualityTimeline");
if(guardSource.split("new Map(state.seen)").length!==3)throw Error("Guard source changed: review prototype injection");
export const sourceHashes=Object.freeze({guard:checksum(guardSource),quality:checksum(qualitySource)});
function script(text:string,name:string){
  const js=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,
    module:ts.ModuleKind.CommonJS}}).outputText;
  return new Script(`(function(require,module,exports){${js}\n})`,{filename:`r164-isolated-${name}.js`});
}
const guardScript=script(guardSource,"guard"),qualityScript=script(qualitySource,"quality");
let active:SeenStore|null=null;
const privateMap=new Proxy(Map,{construct(target,args){
  const input=args[0] as ReadonlyMap<string,string>|undefined;
  return input&&active?.known.has(input)?active.construct(input):Reflect.construct(target,args,target);
}});
const context=createContext({Map:privateMap,Error,TypeError,RangeError,JSON,BigInt,Object,Array,Number,String});
function load(program:Script,dependencies:Record<string,unknown>):Record<string,unknown>{
  const module={exports:{}};
  program.runInContext(context)((id:string)=>{
    if(!(id in dependencies))throw Error(`Unexpected isolated dependency ${id}`);return dependencies[id];
  },module,module.exports);
  return module.exports;
}
const vmGuard=load(guardScript,{"./events":events}) as typeof import("@workspace/core/sequence-guard");
const wrappedGuard={...vmGuard};
for(const name of["guardEvent","rebaseSequenceGuard"] as const){
  Reflect.set(wrappedGuard,name,(...args:unknown[])=>{
    if(!active)throw Error("PRIVATE_OWNER_REQUIRED");
    const before=args[0] as SequenceGuard;active.known.add(before.seen);
    const result=Reflect.apply(vmGuard[name],undefined,args) as GuardResult;
    active.guarded(before,result);return result;
  });
}
const vmQuality=load(qualityScript,{"./events":events,"./mbpBook":book,"./sequenceGuard":wrappedGuard}) as typeof oracle;
/** Guard-only differential harness, also isolated; never a replacement exported by core. */
export function guardPrototypeOnce(mode:SeenMode,base:SequenceGuard,input:unknown,
  rule:ContinuityRule={contiguous:false},alignment?:string){
  if(active)throw Error("REENTRANT_PROTOTYPE");
  const store=new SeenStore(mode,new SealedMap(new Map(base.seen)));
  const state:SequenceGuard={heads:structuredClone(new Map(base.heads)),seen:store.view};
  store.start(state);active=store;
  try{
    const r=alignment===undefined?wrappedGuard.guardEvent(state,structuredClone(input),rule):
      wrappedGuard.rebaseSequenceGuard(state,structuredClone(input),rule,alignment);
    store.finish(r.state);
    const result:GuardResult={...r,state:structuredClone({
      heads:new Map(r.state.heads),seen:new Map(r.state.seen),
    })};
    return {result,metrics:{...store.m}};
  }catch(error){store.finish();throw error;}
  finally{active=null;store.discard();}
}
export function oracleStep(state:oracle.MarketQualityState,step:Step):oracle.MarketResult{
  if(step.type==="EVENT")return oracle.ingestMarketEvent(state,step.event);
  if(step.type==="BATCH")return oracle.ingestMbpBatch(state,step.events);
  return {state:oracle.markChannelCondition(state,step.channel,step.status,step.atNs,step.reason),
    applied:false,outcome:"CONDITION_RECORDED",reason:step.reason};
}

/** No SQLite here: commit callback is a SIMULATED durability barrier, not a persistence benchmark. */
export class SeenTransaction {
  #draft:oracle.MarketQualityState|null;
  #candidate:PublishedState|null=null;
  #store:SeenStore;
  #phase:Phase="ACTIVE";
  #count=0;
  #bytes=0;
  #ownership:object[]=[];
  get ownership(){return structuredClone(this.#ownership);}
  constructor(readonly mode:SeenMode,readonly base:PublishedState){
    if(!["A","B","C"].includes(mode))throw Error("INVALID_MODE");
    const value=published.get(base);if(!value)throw Error("UNKNOWN_BASE");
    this.#ownership.push({point:"TRANSACTION_START",phase:"ACTIVE",owner:"published sealed base; no scratch",
      publishedSeenReference:reference(value.guard.seen),entries:value.guard.seen.size});
    this.#store=new SeenStore(mode,value.guard.seen);
    this.#draft={...value,guard:{heads:value.guard.heads,seen:this.#store.view}};
    if(this.#store.view===value.guard.seen)throw Error("MUTABLE_BASE_ALIAS");
    this.log("SCRATCH_CREATED");
  }
  get phase(){return this.#phase;}
  get metrics(){return {...this.#store.m};}
  private log(point:string){
    this.#ownership.push({point,phase:this.#phase,...this.#store.ownership(),owner:this.mode==="A"?"private immutable chain":
      this.#phase==="ACTIVE"?(this.mode==="B"?"private owned Map":"sealed base + private delta"):
        "sealed/discarded; no writable alias",entries:this.#draft?.guard.seen.size??0});
  }
  apply(input:Step):Omit<oracle.MarketResult,"state">{
    if(this.#phase!=="ACTIVE"||!this.#draft)throw Error("TRANSACTION_NOT_ACTIVE");
    if(active)throw Error("REENTRANT_PROTOTYPE");
    const count=input.type==="BATCH"?input.events.length:1;
    if(count<1||this.#count+count>128)throw Error("PROTOTYPE_SAFETY_STOP: max 128 logical events/transaction");
    const step=structuredClone(input),raw=JSON.stringify(step);
    const bytes=Buffer.byteLength(raw,"utf8");
    if(this.#bytes+bytes>8*1024*1024)throw Error("PROTOTYPE_SAFETY_STOP: transaction input bytes");
    const before=this.#draft;this.#store.start(before.guard);active=this.#store;
    try{
      const r=step.type==="EVENT"?vmQuality.ingestMarketEvent(before,step.event):
        step.type==="BATCH"?vmQuality.ingestMbpBatch(before,step.events):
          {state:vmQuality.markChannelCondition(before,step.channel,step.status,step.atNs,step.reason),
            applied:false,outcome:"CONDITION_RECORDED",reason:step.reason};
      this.#store.finish(r.state.guard);this.#draft=r.state;this.#count+=count;this.#bytes+=bytes;
      this.log(step.type==="EVENT"&&step.event.kind==="L2_SNAPSHOT"&&r.applied?"SNAPSHOT_RESYNC":r.outcome);
      return {applied:r.applied,outcome:r.outcome,reason:r.reason};
    }catch(error){this.#store.finish();throw error;}
    finally{active=null;}
  }
  inspect(){
    if(!this.#draft)throw Error("NO_PRIVATE_DRAFT");
    return detached(this.#draft);
  }
  prepare(){
    if(this.#phase!=="ACTIVE"||!this.#draft)throw Error("TRANSACTION_NOT_ACTIVE");
    this.#candidate=PublishedState.transfer(sealState(this.#draft,this.#store.take(this.#draft.guard)),transferKey);
    this.#draft=null;this.#phase="PREPARED";this.log("CANDIDATE_SEALED");
  }
  commit(simulatedBarrier:()=>void=()=>{}){
    if(this.#phase==="ACTIVE")this.prepare();
    if(this.#phase!=="PREPARED")throw Error("TRANSACTION_NOT_PREPARED");
    try{simulatedBarrier();this.#phase="COMMITTED_NOT_PUBLISHED";this.log("SIMULATED_COMMIT_OK");}
    catch(error){this.rollback();throw error;}
  }
  publish(beforePublish:()=>void=()=>{}):PublishedState{
    if(this.#phase!=="COMMITTED_NOT_PUBLISHED"||!this.#candidate)throw Error("COMMIT_REQUIRED");
    beforePublish();const result=this.#candidate;this.#candidate=null;
    this.#phase="PUBLISHED";this.log("PUBLISHED");return result;
  }
  rollback(){
    if(!["ACTIVE","PREPARED"].includes(this.#phase))throw Error("CANNOT_ROLLBACK_AFTER_COMMIT");
    this.#store.discard();this.#draft=null;this.#candidate=null;this.#phase="ROLLED_BACK";this.log("ROLLED_BACK");
  }
}
