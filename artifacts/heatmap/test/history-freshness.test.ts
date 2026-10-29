import assert from "node:assert/strict";
import test from "node:test";
import { ColumnCache } from "../src/data/cache.ts";
import { HistoryFreshness } from "../src/data/history-freshness.ts";
import { RealtimeClient } from "../src/data/socket.ts";
import { makeFrame } from "./helpers.ts";

class Socket {
  readyState = 1;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  sent: { reqId: number; fromSec: number; toSec: number }[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.({ code:1000 } as CloseEvent); }
  json(value: unknown) { this.onmessage?.({data:JSON.stringify(value)} as MessageEvent); }
  bytes(value: Uint8Array) { this.onmessage?.({data:value} as MessageEvent); }
}
const book = {tsSec:4450,source:1 as const,bids:[[80000,201] as [number,number]]};
const trade = {tsUs:4450e6,recvUs:4450e6,seq:1,price:80000,size:2,side:"buy"};
function fixture(mode: "live" | "replay" = "live") {
  const socket = new Socket(), cache = new ColumnCache(), errors: string[] = [];
  const client = new RealtimeClient(cache,{
    onConnection:()=>{},onHello:()=>{cache.setRetentionAnchor(4400e6,4600e6,false,null);client.requestVisible(4400,4600);},
    onStatus:()=>{},onColumns:()=>{},onLatestBook:()=>{},onTrades:()=>{},onError:e=>errors.push(e),
    onReplayEnded:()=>{},onBytesPerMinute:()=>{},onRangeRequest:()=>{},
  },{protocol:"http:",host:"dummy.invalid",search:mode==="replay"?"?mode=replay&from=5000":""},{
    createSocket:()=>socket,setTimeout:()=>1,clearTimeout:()=>{},now:()=>5000e3,
  });
  client.start();
  socket.json({type:"hello",symbol:"NQ",tickSize:.25,columnSeconds:1,serverTimeUs:5000e6,mode,
    savedRange:{fromSec:3200,toSec:5000}});
  const done = (reqId: number, columns: typeof book[] = [], trades: typeof trade[] = []) => {
    const range = reqId===0 ? {fromSec:3200,toSec:5000} : socket.sent.find(r=>r.reqId===reqId)!;
    const chunks = Math.ceil((range.toSec-range.fromSec)/300);
    for(let i=0;i<chunks;i++) {
      socket.bytes(makeFrame(2,reqId,i===0?columns:[]));
      socket.json({type:"rangeTrades",reqId,trades:i===0?trades:[]});
    }
    socket.json({type:"rangeDone",reqId,...range,columns:columns.length,trades:trades.length,chunks});
    assert.deepEqual(errors,[]);
  };
  const status = (state="complete",finishedAtUs=20,fromSec=3200,toSec=5000) =>
    socket.json({type:"status",status:{phase2a:{backfill:{state,startedAtUs:10,finishedAtUs,
      startSec:fromSec,endSec:toSec}}}});
  return {client,socket,cache,done,status};
}

test("ダミー: first complete clips cached revalidation to completed history, once per generation",()=>{
  const f=fixture();
  try {
    f.done(0);f.status("complete",20,4300,4500);
    assert.deepEqual(f.socket.sent,[{op:"range",reqId:1,fromSec:4400,toSec:4500}]);
    f.done(1,[book]);
    for(let i=0;i<20;i++){f.status("complete",20,4300,4500);f.client.requestVisible(4400,4600);}
    assert.equal(f.socket.sent.length,1);
    assert.deepEqual(f.cache.columns.map(c=>c.timeUs),[4450e6],"no preceding-book fill at other seconds");
  } finally {f.client.stop();}
});

test("ダミー: completion during initial read waits for rangeDone and never overlaps it",()=>{
  const f=fixture();
  try {
    f.status("running");f.status();
    for(let i=0;i<10;i++){f.status();f.client.requestVisible(4400,4600);}
    assert.equal(f.socket.sent.length,0);
    f.done(0);
    assert.equal(f.socket.sent.length,1);
    for(let i=0;i<10;i++){f.status();f.client.requestVisible(4400,4600);}
    assert.equal(f.socket.sent.length,1);
    f.done(1,[book]);
    assert.equal(f.client.loadingRangeCount,0);
    assert.equal(f.socket.sent.length,1);
  } finally {f.client.stop();}
});

test("ダミー: a new completion while a range is pending gets one later revalidation",()=>{
  const f=fixture();
  try {
    f.done(0);f.status();
    f.status("complete",30); // same state, different existing finishedAtUs
    assert.equal(f.socket.sent.length,1);
    f.done(1);assert.equal(f.socket.sent.length,2);
    f.done(2,[book]);f.status("complete",30);
    assert.equal(f.socket.sent.length,2);
  } finally {f.client.stop();}
});

test("ダミー: pan cancellation does not consume an unsent interval; returning is bounded",()=>{
  const f=fixture();
  try {
    f.done(0);f.status(); // visible range pending
    f.client.requestVisible(3300,3400);
    f.client.requestVisible(3500,3600); // cancel queued 3300..3400
    assert.equal(f.socket.sent.length,1);
    f.done(1);assert.equal(f.socket.sent.length,2);
    assert.equal(f.socket.sent[1]!.fromSec,3500);
    f.done(2);
    f.client.requestVisible(3300,3400);
    assert.equal(f.socket.sent.length,3);
    f.done(3);f.client.requestVisible(3300,3400);f.status();
    assert.equal(f.socket.sent.length,3);
  } finally {f.client.stop();}
});

test("ダミー: zoom-out revalidates only the two new edges, serially",()=>{
  const f=fixture();
  try {
    f.done(0);f.status();f.done(1);
    f.client.requestVisible(4380,4620);
    assert.deepEqual(f.socket.sent[1],{op:"range",reqId:2,fromSec:4380,toSec:4400});
    assert.equal(f.client.loadingRangeCount,2);
    f.done(2);
    assert.deepEqual(f.socket.sent[2],{op:"range",reqId:3,fromSec:4600,toSec:4620});
    f.done(3);f.client.requestVisible(4380,4620);f.status();
    assert.equal(f.socket.sent.length,3);
  } finally {f.client.stop();}
});

test("ダミー: failure does not turn repeated completion messages into retry loop",()=>{
  const f=fixture();
  try {
    f.done(0);f.status();
    f.socket.json({type:"error",reqId:1,code:"fixture_read_failed"});
    for(let i=0;i<20;i++)f.status();
    assert.equal(f.socket.sent.length,1);
    assert.equal(f.client.loadingRangeCount,0);
    // Explicit existing missing-range recovery still works.
    f.client.requestVisible(4400,4600);assert.equal(f.socket.sent.length,2);
  } finally {f.client.stop();}
});

test("ダミー: revalidating range replaces trades, does not count them twice",()=>{
  const f=fixture();
  try {
    f.done(0,[],[trade]);assert.equal(f.cache.trades.length,1);
    f.status();f.done(1,[book],[trade]);assert.equal(f.cache.trades.length,1);
    assert.equal(f.cache.trades[0]!.size,2);
  } finally {f.client.stop();}
});

test("ダミー: replay does not revalidate on live backfill status",()=>{
  const f=fixture("replay");
  try {f.done(0);f.status("running");f.status();assert.equal(f.socket.sent.length,0);}
  finally {f.client.stop();}
});

test("ダミー: freshness retention discards evicted metadata; legacy repeated complete is finite",()=>{
  const f=new HistoryFreshness(), covered=[{fromSec:100,toSec:200}];
  assert.equal(f.observe({phase2a:{backfill:{state:"complete"}}},covered),true);
  f.dispatched({fromSec:120,toSec:130});
  f.retain([{fromSec:150,toSec:180}]);
  assert.deepEqual(f.visible({fromSec:100,toSec:200},null),[{fromSec:150,toSec:180}]);
  for(let i=0;i<20;i++) assert.equal(f.observe({phase2a:{backfill:{state:"complete"}}},covered),false);
  f.reset();assert.deepEqual(f.visible(covered[0]!,null),[]);
});

test("ダミー: a later completed window preserves older unvisited stale intervals",()=>{
  const f=new HistoryFreshness(), covered=[{fromSec:100,toSec:300}];
  const status=(startSec:number,endSec:number,finishedAtUs:number)=>({
    phase2a:{backfill:{state:"complete",startSec,endSec,finishedAtUs}},
  });
  f.observe(status(100,200,1),covered);
  f.dispatched({fromSec:120,toSec:130});
  f.observe(status(200,300,2),covered);
  assert.deepEqual(f.visible(covered[0]!,null),[{fromSec:100,toSec:120},{fromSec:130,toSec:300}]);
});
