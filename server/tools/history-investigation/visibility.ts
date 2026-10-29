// ダミー transport / isolated LocalStore. Execute actual main.ts handlers, not a rewritten status rule.
import "./offline.ts";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import ts from "typescript";
import { LocalStore } from "../../src/store/local.ts";
import { Backfill } from "../../src/history/backfill.ts";
import { Metrics } from "../../src/ingest/metrics.ts";
import { Hub } from "../../src/hub/hub.ts";
import { decodeFrame } from "../../src/hub/frame.ts";
import { ColumnCache } from "../../../artifacts/heatmap/src/data/cache.ts";
import { RealtimeClient } from "../../../artifacts/heatmap/src/data/socket.ts";
import { deltaBounds, deltaSeconds } from "../../../artifacts/heatmap/src/chart/delta-geometry.ts";
import { followStartUs } from "../../../artifacts/heatmap/src/chart/coordinates.ts";
import { resetViewport } from "../../../artifacts/heatmap/src/chart/view-reset.ts";
import { resetTimeViewport } from "../../../artifacts/heatmap/src/chart/axis-view.ts";
import { clampViewport, bestMidpoint } from "../../../artifacts/heatmap/src/domain.ts";

const out = process.argv[2];
assert.match(out ?? "", /^data\/history-investigation-[a-zA-Z0-9_-]+$/);
const variant = process.argv[3] ?? "fixed";
assert.ok(["fixed", "baseline"].includes(variant));
const baselineRef = process.argv[4];
if (variant === "baseline") assert.match(baselineRef ?? "", /^[a-f0-9]{40}$/);
const source = async (file: string) => variant === "baseline"
  ? execFileSync("git", ["show", `${baselineRef}:${file}`], { encoding:"utf8" })
  : fs.readFile(file, "utf8");
let Client = RealtimeClient;
if (variant === "baseline") {
  const file = "artifacts/heatmap/src/data/socket.ts";
  const compiled = ts.transpileModule(await source(file), { compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,
  }}).outputText.replace(/from "(\.[^"]+)"/g, (_, p) =>
    `from "${pathToFileURL(path.resolve(path.dirname(file),p)).href}"`);
  Client = (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)).RealtimeClient;
}
await fs.mkdir(out, { recursive: true });
const main = await source("artifacts/heatmap/src/main.ts");
const ast = ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest, true);
const functions = new Map<string, string>(), props = new Map<string, string>();
function visit(n: ts.Node) {
  if (ts.isFunctionDeclaration(n) && n.name) functions.set(n.name.text, n.getText(ast));
  if (ts.isPropertyAssignment(n) && ts.isArrowFunction(n.initializer)
    && ["onStatus", "onColumns", "onRangeComplete", "onHello", "depth"].includes(n.name.getText(ast))) {
    assert.ok(!props.has(n.name.getText(ast)), "ambiguous handler");
    props.set(n.name.getText(ast), n.initializer.getText(ast));
  }
  ts.forEachChild(n, visit);
}
visit(ast);
const names = ["syncRetentionAndRequests", "refreshVisibleRange", "backfillState", "setViewport",
  "alignFollowToPhysicalPixel", "resetView", "resetTimeView", "positionPriceFromData"].filter(n=>functions.has(n));
const code = names.map(n => { assert.ok(functions.has(n)); return functions.get(n); }).join("\n")
  + `\nthis.actual = { ${names.join(",")}, ${[...props].map(([k,v])=>`${k}:${v}`).join(",")} };`;
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
await fs.writeFile(path.join(out, "extracted-handlers.js"), js);
const BASE = 1793275200, NOW = BASE + 1800, U = 1e6;
const column = (sec: number, size: number) => ({ tsSec: sec, source: "history" as const,
  bids: [{ price: 80000, size }], asks: [{ price: 80001, size }] });
// Both initial IDs are in the same final 300s chunk: isolate stale negative
// coverage from the independent initial-loading retention/coverage evolution.
const initial = [column(NOW - 290, 101), column(NOW - 10, 102)];
const late = [column(NOW - 280, 201), column(NOW - 20, 202)];
const rows = (sec: number, id: number) => Array.from({ length: 800 }, (_, i) => ({
  ts: sec * U + 750000, side: i < 400 ? "bid" : "ask", level: i % 400 + 1,
  price: (i < 400 ? 80000 - i : 80001 + i - 400) / 4, size: id, flag: 0,
}));
const noop = () => {};
class Clock {
  now = () => NOW * 1000;
  tasks = new Map<number, () => void>(); next = 0;
  later = (fn: () => void) => { this.tasks.set(++this.next, fn); return this.next; };
  cancel = (id: unknown) => { this.tasks.delete(Number(id)); };
  flush() { const tasks = [...this.tasks]; this.tasks.clear(); for (const [, fn] of tasks) fn(); }
}
const results: any[] = [];
for (let trial = 1; trial <= 3; trial++)
for (const scenario of ["follow-transition", "browse-transition", "first-status-complete", "offscreen-gap", "initial-empty", "browse-empty"])
for (const recovery of ["follow-reset"]) {
  const root = await fs.mkdtemp(path.join(out, scenario + "-" + recovery + "-")); // each attempt has a fresh state
  const store = new LocalStore(root, () => NOW * 1000);
  await store.initialize();
  // Hold through reads so no real cloud, existing files or maintenance can participate.
  store.hold(BASE, NOW);
  const isEmpty = scenario.endsWith("empty");
  await store.addColumns(isEmpty ? [] : initial);
  let state = "running"; // case 3 transport withholds running; first delivered status is complete
  const reads: any[] = [], deliveries: any[] = [], jsonDeliveries: any[] = [], draws: any[] = [], requests: any[] = [], errors: string[] = [];
  let phase = "initial", serverSocket: any, browserSocket: any, connection: Promise<void> = Promise.resolve();
  let phaseStart = performance.now(), phaseCpu = process.cpuUsage(), maxTimerDelayMs = 0;
  const beginPhase = (name: string) => { phase = name; phaseStart = performance.now();phaseCpu = process.cpuUsage();maxTimerDelayMs = 0; };
  const cache = new ColumnCache(), clock = new Clock();
  const hub = new Hub({
    savedRange: () => store.savedRange,
    read: async (a,b) => {
      const before = performance.now(), cpuBefore = process.cpuUsage();
      const view = await store.readView(a,b), cpu = process.cpuUsage(cpuBefore);
      reads.push({ phase, fromSec:a, toSec:b, columns:view.columns.length,
        wallMs:performance.now()-before, sharedProcessCpuMs:(cpu.user+cpu.system)/1000 }); return view;
    },
    status: () => ({ phase2a: { backfill: { state, startSec:NOW-10800,endSec:NOW,
      startedAtUs:(NOW-100)*U,finishedAtUs:state==="complete"?NOW*U:null } } }),
  }, noop, clock);
  const ctx: any = {
    cache, US_PER_SECOND:U, deltaBounds, deltaSeconds, clampViewport, followStartUs,
    resetViewport, resetTimeViewport, follow: !["browse-transition","browse-empty"].includes(scenario), hello: { mode:"live", serverTimeUs:NOW*U },
    latestStatus:null, viewport: { startUs:(NOW-80)*U, durationSec:100, centerPriceTicks:80000, priceSpanTicks:160 },
    canvas:{ clientWidth:1000, getBoundingClientRect:()=>({width:1000}) },
    window:{devicePixelRatio:1}, updateStatus:noop, renderTimeAxis:noop, scheduleDraw:noop,
    autoPrice:{enabled:false}, disableAutoPrice:noop,
    bestMidpoint, centeredOnData:scenario!=="browse-empty", replayHeadUs:null, displayZone:"Asia/Tokyo",
    receivedColumnRevision:0, depthDrawCount:0,
    renderer:{setTrades:noop, draw:(columns: any[], viewport:any) => {
      draws.push({phase, inputSeconds:columns.map(c=>c.timeUs/U),
        visibleSeconds:columns.filter(c=>c.timeUs>=viewport.startUs && c.timeUs<viewport.startUs+viewport.durationSec*U).map(c=>c.timeUs/U)});
    } },
    settingsRecovery:{connected:async()=>{}}, vpState:{reset:noop},vpLoading:{hidden:false},
    bigFeed:{beginInitial:noop,accept:noop,completeInitial:noop},
    initialQuote:{trade:null,reset:noop},currentTrade:{trade:null,reset:noop},
    hasHello:false,initialCutoffUs:0,lastDataError:"",replayFromSec:()=>null,BOOK_OVERLAY_FRACTION:.2,
    positionPriceFromData:noop,drawScheduler:{request:noop},updateDebugPanel:noop,
  };
  if(scenario==="browse-empty")ctx.viewport.centerPriceTicks=81000; // deliberate paused off-market price position
  vm.createContext(ctx); vm.runInContext(js, ctx);
  const client = new Client(cache, {
    onConnection:noop, onHello:m=>ctx.actual.onHello(m), onStatus:m=>ctx.actual.onStatus(m),
    onColumns:(...args)=>{ctx.actual.onColumns(...args);ctx.actual.depth(false);},
    onRangeComplete:id=>{ctx.actual.onRangeComplete(id);ctx.actual.depth(false);},
    onLatestBook:noop, onTrades:noop, onError:m=>errors.push(m),
    onReplayEnded:noop, onBytesPerMinute:noop, onRangeRequest:r=>requests.push({phase,...r}),
  }, { protocol:"http:",host:"dummy.invalid",search:"" }, {
    now:clock.now, setTimeout:(fn)=>clock.later(fn),clearTimeout:id=>clock.cancel(id),
    createSocket:()=>{
      const b: any = {readyState:1, binaryType:"arraybuffer", onopen:null,onmessage:null,onerror:null,onclose:null,
        send:(value:string)=>s.emit("message",Buffer.from(value),false),
        close:()=>{ b.readyState=3;s.readyState=3;s.emit("close",1000);b.onclose?.({code:1000});} };
      const s: any = new EventEmitter();s.readyState=1;s.bufferedAmount=0;
      s.send=(data:string|Buffer,cb:any)=>{
        if(Buffer.isBuffer(data)) {
          const frame=decodeFrame(data);
          const t = performance.now(), cpu = process.cpuUsage();
          const compressed = deflateRawSync(data);
          const compressionCpu = process.cpuUsage(cpu);
          const delivery = {phase, kind:frame.kind, reqId:frame.reqId, seconds:frame.columns.map(c=>c.tsSec),
            bytes:data.length, independentDeflateBytes:compressed.length,
            compressionWallMs:performance.now()-t,compressionProcessCpuMs:(compressionCpu.user+compressionCpu.system)/1000,
            receiveWallMs:0,receiveProcessCpuMs:0};
          deliveries.push(delivery);
          const rt=performance.now(),rc=process.cpuUsage();
          b.onmessage?.({data:Uint8Array.from(data).buffer});
          const receivedCpu=process.cpuUsage(rc);
          delivery.receiveWallMs=performance.now()-rt;delivery.receiveProcessCpuMs=(receivedCpu.user+receivedCpu.system)/1000;
        } else {
          // Observe no running status in case 3. First delivered status is
          // complete AFTER save, rather than inventing hidden post-complete writes.
          if(scenario==="first-status-complete" && phase==="initial" && JSON.parse(data).type==="status") {cb?.();return;}
          jsonDeliveries.push({phase,type:JSON.parse(data).type,bytes:Buffer.byteLength(data)});
          b.onmessage?.({data});
        }
        cb?.();
      };
      s.close=()=>b.close();s.terminate=s.close;
      browserSocket=b;serverSocket=s;
      connection=new Promise<void>((resolve,reject)=>setImmediate(()=>{
        b.onopen?.({});
        hub.connect(s,new URL("http://dummy.invalid/api/ws")).then(resolve,reject);
      }));
      return b;
    },
  });
  ctx.client=client;
  const settle=async()=>{
    await connection;
    for(let i=0;i<80;i++){ const t=performance.now();await new Promise(r=>setTimeout(r,2));maxTimerDelayMs=Math.max(maxTimerDelayMs,performance.now()-t-2);if(!client.loadingRangeCount) return; }
    throw Error("dummy range did not settle");
  };
  const snapshot=()=>({ wallMs:performance.now()-phaseStart, sharedProcessCpuMs:(process.cpuUsage(phaseCpu).user+process.cpuUsage(phaseCpu).system)/1000,
    maxTimerDelayMs,viewport:{...ctx.viewport},follow:ctx.follow,
    requests:requests.filter(r=>r.phase===phase), reads:reads.filter(r=>r.phase===phase),
    received:deliveries.filter(r=>r.phase===phase), draw:draws.at(-1) ?? null,
    jsonReceived:jsonDeliveries.filter(r=>r.phase===phase),
    cacheSeconds:cache.columns.map(c=>c.timeUs/U), coverage:cache.getCoverage() });
  const stages:any[]=[];
  try {
    client.start();await settle();ctx.actual.depth(false);
    stages.push({phase,...snapshot()});
    // Test actual Backfill.run→take→historyColumns→store.addColumns. Fake history has exactly 2 late seconds.
    const backfill = new Backfill({get:async(kind,a,b)=>({
      rows:kind==="book" ? late.filter(c=>c.tsSec>=a&&c.tsSec<b).flatMap(c=>rows(c.tsSec,c.bids[0].size)):[], truncated:false,
    })},store,new Metrics(noop),()=>1,noop,{now:()=> (NOW+1000)*1000,wait:async()=>{}});
    beginPhase("late-save");backfill.start(NOW);await backfill.settled();
    assert.equal(backfill.status.state,"complete");
    const saved = await store.readView(BASE,NOW);
    assert.equal(saved.columns.length,isEmpty?2:4);
    assert.equal(saved.columns.find(c=>c.tsSec===late[0].tsSec)?.bids[0].size,201);
    assert.equal(deliveries.filter(d=>d.phase===phase).length,0,"saving history must not broadcast");
    if(scenario==="offscreen-gap") {
      // Initial [BASE,NOW) coverage still includes the historical gap, but only recent viewport invalidated.
      ctx.viewport={...ctx.viewport,startUs:(NOW-80)*U,durationSec:100};
    }
    const beforeComplete={viewport:{...ctx.viewport},follow:ctx.follow};
    beginPhase("complete");state="complete";clock.flush();await settle();ctx.actual.depth(false);
    stages.push({phase,...snapshot()});
    const recentRecovered=cache.columns.some(c=>c.timeUs===late[1].tsSec*U);
    assert.equal(recentRecovered,variant==="fixed" || ["follow-transition","offscreen-gap","initial-empty"].includes(scenario),
      JSON.stringify({scenario,phase,requests,errors,coverage:cache.getCoverage(),columns:cache.columns.map(c=>c.timeUs/U)}));
    if(!beforeComplete.follow) assert.deepEqual({viewport:{...ctx.viewport},follow:ctx.follow},beforeComplete,"browse position/zoom/follow unchanged");
    beginPhase("pan");ctx.actual.setViewport({...ctx.viewport,startUs:(NOW-300)*U,durationSec:100},true);
    await settle();ctx.actual.depth(false);stages.push({phase,...snapshot()});
    assert.equal(cache.columns.some(c=>c.timeUs===late[0].tsSec*U),variant==="fixed","offscreen revalidation on demand");
    if(variant==="fixed") assert.ok(draws.at(-1).visibleSeconds.includes(late[0].tsSec));
    beginPhase("zoom");ctx.actual.setViewport({...ctx.viewport,durationSec:50},false);
    await settle();ctx.actual.depth(false);stages.push({phase,...snapshot()});
    assert.equal(requests.filter(r=>r.phase===phase).length,0);
    beginPhase("repeat-complete");
    for(let i=0;i<10;i++){hub.flush();ctx.actual.syncRetentionAndRequests();}
    await settle();ctx.actual.depth(false);stages.push({phase,...snapshot()});
    assert.equal(requests.filter(r=>r.phase===phase).length,0,"identical status/view must not revalidate again");
    const target={...ctx.viewport};
    beginPhase("pan-away");ctx.actual.setViewport({...target,startUs:(NOW-50)*U,durationSec:50},true);
    await settle();ctx.actual.depth(false);stages.push({phase,...snapshot()});
    beginPhase("pan-back");ctx.actual.setViewport(target,true);
    await settle();ctx.actual.depth(false);stages.push({phase,...snapshot()});
    assert.equal(requests.filter(r=>r.phase===phase).length,0,"return to already revalidated interval");
    assert.deepEqual({...ctx.viewport},target);
    beginPhase(recovery);ctx.actual.resetTimeView();
    await settle();ctx.actual.depth(false);
    stages.push({phase,...snapshot()});
    assert.ok(cache.columns.some(c=>c.timeUs===late[0].tsSec*U));
    assert.ok(draws.at(-1).visibleSeconds.includes(late[0].tsSec));
    assert.deepEqual(errors,[]);
    results.push({scenario,recovery,trial,variant,dummy:true,initialColumns:isEmpty?[]:initial,
      addedColumns:late,stages,reads,deliveries,jsonDeliveries,requests});
  } finally {
    client.stop();serverSocket?.close();hub.stop();
    assert.equal(hub.snapshot().connected,0);
    assert.equal(browserSocket.readyState,3);
    clock.tasks.clear();
  }
}
await fs.writeFile(path.join(out,"visibility.json"),JSON.stringify({
  dummy:true,variant,baselineRef,mainSha256:createHash("sha256").update(main).digest("hex"), handlerNames:names,
  evidence:"Actual extracted depth callback → renderer.draw argument capture; no Canvas/pixel/browser verification.",
  results,cleanup:{fakeConnections:0,realSockets:0,browserUsed:false},
},null,2));
console.log(`ダミー: ${results.length} fresh-state scenarios passed, actual Hub/Backfill/client/cache/main handlers, draw-input captured; fake WS remaining 0.`);
