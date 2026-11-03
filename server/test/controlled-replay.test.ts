import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlledReplay, reserveReplay, releaseReplay } from "../src/hub/controlled-replay.ts";
import { WindowedReplay } from "../src/hub/windowed-replay.ts";
import { decodeFrame, replayParams } from "../src/hub/frame.ts";
import type { Source } from "../src/hub/hub.ts";
import type { Trade } from "../src/types.ts";
import type { ReplayClock } from "../src/hub/replay.ts";
class Clock implements ReplayClock {
  time = 0; id = 0; timers = new Map<number, { at: number; f(): void }>();
  now() { return this.time; }
  later(f: () => void, ms: number) { const id = ++this.id; this.timers.set(id, { at: this.time + ms, f }); return id; }
  cancel(id: unknown) { this.timers.delete(id as number); }
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      await new Promise<void>(r => setImmediate(r));
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].f();
    }
    this.time = end; await new Promise<void>(r => setImmediate(r));
  }
}
const t = (seq: number, tsUs: number) => ({ seq, tsUs, recvUs: tsUs, price: 100, size: seq, side: "buy", source: "history" }) as Trade;
function fixture() {
  const clock = new Clock(), events: (string | Buffer)[] = [];
  const trades = [t(1,100900000),t(2,100100000),t(3,100100000),t(4,101150000), t(5,400000000)];
  const source: Source = { savedRange: () => ({ fromSec:100,toSec:702 }), status: () => ({}),
    read: async (a,b) => ({ columns: Array.from({ length: Math.max(0,b-a) },(_,i) => ({tsSec:a+i,source:"history",bids:[],asks:[]})),
      trades: trades.filter(x => x.tsUs >= a*1e6 && x.tsUs < b*1e6) }) };
  const session = new ControlledReplay(source,"NQ",clock,v => { events.push(v); return true; },()=>true,{fromSec:100,toSec:702},false);
  return { clock, events, source, session, trades };
}
const json = (events: (string|Buffer)[]) => events.filter((v):v is string => typeof v === "string").map(v => JSON.parse(v));
test("controlled replay pause silence, exact fractional steps, continuous speed/resume and end", async () => {
  const {clock,events,session,trades} = fixture();
  await session.initialize(100,1,true);
  const n=events.length; await clock.advance(2000); assert.equal(events.length,n);
  await session.control({op:"replay",action:"resume"}); await clock.advance(125);
  await session.control({op:"replay",action:"pause"});
  const state=()=>json(events).filter(x=>x.type==="replayState").at(-1);
  assert.equal(state().positionUs,100125000);
  const sent=json(events).filter(x=>x.type==="trades").flatMap(x=>x.trades);
  assert.deepEqual(sent.map((x:Trade)=>x.seq),[2,3]); // distinct identical-looking trades retained
  const before=events.length; await clock.advance(1000); assert.equal(events.length,before);
  await session.control({op:"replay",action:"step",seconds:1}); assert.equal(state().positionUs,101125000);
  for (const seconds of [10,60]) {
    const pos=state().positionUs; await session.control({op:"replay",action:"step",seconds});
    assert.equal(state().positionUs,pos+seconds*1e6);
  }
  await session.control({op:"replay",action:"speed",speed:60});
  await session.control({op:"replay",action:"resume"}); await clock.advance(10000);
  assert.equal(state().state,"ended"); assert.equal(state().positionUs,702e6);
  const delivered=json(events).filter(x=>x.type==="trades").flatMap(x=>x.trades) as Trade[];
  assert.deepEqual(delivered.slice().sort((a,b)=>a.seq-b.seq),trades);
  for(const e of json(events).filter(x=>x.type==="trades")) assert(e.trades.every((v:Trade)=>v.tsUs<e.replayHeadUs));
  for(const e of events.filter((v):v is Buffer=>Buffer.isBuffer(v))) {
    assert.equal(e[0],4); assert.equal(e.readUInt32LE(1),1);
    const f=decodeFrame(e.subarray(13)); assert(f.columns.every(c=>c.tsSec*1e6<=e.readDoubleLE(5)));
  }
  session.stop();
});
test("seek generations discard pending old ranges, in both directions", async () => {
  const {session,source,events}=fixture();
  await session.initialize(100,1,true);
  await session.control({op:"replay",action:"step",seconds:60});
  let unblock!:()=>void; const gate=new Promise<void>(r=>unblock=r), read=source.read;
  source.read=async(a,b)=>{ if(a===150) await gate; return read(a,b); };
  const old=session.range({reqId:9,fromSec:150,toSec:160});
  await session.control({op:"replay",action:"seek",fromSec:500});
  const boundary=events.length; unblock(); await old; assert.equal(events.length,boundary);
  await session.control({op:"replay",action:"seek",fromSec:101});
  const hellos=json(events).filter(v=>v.type==="hello");
  assert.deepEqual(hellos.map(v=>v.replayGeneration),[1,2,3]); assert.equal(hellos.at(-1).replayFromSec,101);
  await assert.rejects(session.control({op:"replay",action:"seek",fromSec:702}),/outside_saved/);
  session.stop();
});

test("FOOTPRINT replay uses the saved-trade reader only, clips at the fractional cursor, and sends no books or VP", async () => {
  const clock = new Clock(), events: (string | Buffer)[] = [];
  const trades = [t(1, 100_100_000), t(2, 100_900_000), t(3, 101_150_000), t(4, 102_000_000)];
  let tradeReads = 0, fullReads = 0;
  const source: Source = {
    savedRange: () => ({ fromSec: 100, toSec: 702 }), status: () => ({}),
    read: async () => { fullReads++; throw Error("footprint replay must use readTrades"); },
    readTrades: async (a, b, visit, signal) => {
      tradeReads++;
      for (const trade of trades) {
        signal.throwIfAborted();
        if (trade.tsUs >= a * 1e6 && trade.tsUs < b * 1e6) visit(trade);
      }
      return { coverage: [[a, b]], gaps: [], noData: [], quality: "recorded_not_guaranteed" };
    },
  };
  const session = new ControlledReplay(source, "NQ", clock, v => { events.push(v); return true; }, () => true,
    { fromSec: 100, toSec: 702 }, true, () => 0, "footprint", "fixture-generation");
  await session.initializeAt(100, 1, true, 100_125_000);
  const hello = json(events).find(v => v.type === "hello");
  assert.equal(hello.mode, "replay"); assert.equal(hello.generation, "fixture-generation");
  assert.equal(hello.replayHeadUs, 100_125_000);
  assert.equal(tradeReads, 2); assert.equal(fullReads, 0); // current and one bounded read-ahead window
  assert.equal(events.some(v => Buffer.isBuffer(v)), false);
  assert.equal(json(events).some(v => v.type === "vp" || v.type === "sessionIndicators"), false);

  await session.control({ op: "replay", action: "step", seconds: 1 });
  const playback = json(events).filter(v => v.type === "trades").flatMap(v => v.trades) as Trade[];
  assert.deepEqual(playback.map(v => v.seq), [2]);
  assert(playback.every(v => v.tsUs < 101_125_000));

  await session.range({ reqId: 8, fromSec: 100, toSec: 102 });
  const rangeRows = json(events).filter(v => v.type === "rangeTrades").flatMap(v => v.trades) as Trade[];
  assert.deepEqual(rangeRows.map(v => v.seq), [1, 2]);
  const done = json(events).findLast(v => v.type === "rangeDone");
  assert.equal(done.trades, 2);
  assert.deepEqual(done.footprint, {
    coverage: [[100, 102]], gaps: [], noData: [], quality: "recorded_not_guaranteed",
  });
  assert.equal(events.some(v => Buffer.isBuffer(v)), false);
  assert.equal(json(events).some(v => v.type === "vp" || v.type === "sessionIndicators"), false);
  session.stop();
});
test("global two replay slots and URL speeds 30/60; releases permit replacement", () => {
  const a={},b={},c={};
  try { assert(reserveReplay(a));assert(reserveReplay(b));assert(!reserveReplay(c));releaseReplay(a);assert(reserveReplay(c)); }
  finally {for(const owner of [a,b,c]) releaseReplay(owner);}
  for(const speed of [30,60]) assert.equal(replayParams(new URL(`http://local/?mode=replay&from=100&speed=${speed}`),{fromSec:100,toSec:702})?.speed,speed);
});

test("CT17 rollover sends a full empty VP and clears the preceding daily session even with no new trades", async () => {
  const clock=new Clock(), events:(string|Buffer)[]=[], from=Date.parse("2026-11-01T22:59:59Z")/1000;
  const source:Source={savedRange:()=>({fromSec:from,toSec:from+3}),status:()=>({}),
    read:async(a,b)=>({columns:[{tsSec:from,source:"history" as const,bids:[],asks:[]}].filter(c=>c.tsSec>=a&&c.tsSec<b),
      trades:[t(1,(from+.5)*1e6)].filter(t=>t.tsUs>=a*1e6&&t.tsUs<b*1e6)})};
  const session=new ControlledReplay(source,"GC",clock,v=>{events.push(v);return true},()=>true,{fromSec:from,toSec:from+3},true);
  await session.initialize(from,1,true);
  await session.control({op:"replay",action:"step",seconds:1});
  const profiles=json(events).filter(v=>v.type==="vp");
  assert.equal(profiles.at(-1).sessionStartSec,from+1);assert.deepEqual(profiles.at(-1).levels,[]);
  assert.equal(json(events).filter(v=>v.type==="sessionIndicators").at(-1).sessionStartSec,from+1);
  session.stop();
});
