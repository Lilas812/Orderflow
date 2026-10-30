import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const dir = "data/footprint-completion", base = "http://127.0.0.1:18779";
await fs.mkdir(dir, { recursive: true });
const ctl = async p => (await fetch(`${base}/__fixture/${p}`)).json();
const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
async function processSample(root) {
  const tree = execFileSync("ps", ["-eo", "pid,ppid"], { encoding: "utf8" }).trim().split("\n").slice(1).map(l => l.trim().split(/\s+/).map(Number));
  const selected = new Set([root]);
  for (let i = 0; i < 8; i++) for (const [p, parent] of tree) if (selected.has(parent)) selected.add(p);
  let rss = 0, hwm = 0; const ticks = {};
  for (const pid of selected) try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"), rest = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    ticks[pid] = Number(rest[11]) + Number(rest[12]);
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    rss += Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
    hwm += Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0) * 1024;
  } catch { /* exited children remain visible in raw PID differences */ }
  return { ticks, rss, hwm };
}
const instrumentation = `(()=>{
window.__paintProof={frames:[],http:0};let active=null;
for(const name of ['fillRect','stroke','fillText','drawImage','putImageData','strokeRect']){
 const fn=CanvasRenderingContext2D.prototype[name];CanvasRenderingContext2D.prototype[name]=function(...args){if(active)active.targets.add(this.canvas.id);return fn.apply(this,args)}
}
const raf=window.requestAnimationFrame.bind(window);
window.requestAnimationFrame=cb=>raf(t=>{const old=active,f={start:performance.now(),targets:new Set()};active=f;try{return cb(t)}finally{active=old;if(f.targets.size)window.__paintProof.frames.push({at:f.start,ms:performance.now()-f.start,targets:[...f.targets]})}});
})()`;
const results = [];
for (const mode of ["before", "after", "fp5", "fp60"]) {
  const status = await ctl("reset"), end = status.started, fp = mode.startsWith("fp"), tf = mode === "fp60" ? 60 : 5;
  const b = await browser({ headed: true });
  const r = { dummy: true, mode, epoch: end, historyRows: 120, liveRows: 4, inputPerStep: 1, seconds: 120, width: 600, height: 800, dpr: 1,
    browser: b.info.Browser, executable: b.info["User-Agent"], phases: [] };
  try {
    const p = await b.page(); await p.call("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
    await p.call("Performance.enable"); await p.call("Network.enable");
    await p.call("Page.addScriptToEvaluateOnNewDocument", { source: instrumentation });
    let httpBytes = 0, wsBody = 0;
    const listener = m => {
      if (m.sessionId !== p.sessionId) return;
      if (m.method === "Network.loadingFinished") httpBytes += m.params.encodedDataLength;
      if (m.method === "Network.webSocketFrameReceived") {
        const x = m.params.response; wsBody += x.opcode === 2 ? Buffer.from(x.payloadData, "base64").length : Buffer.byteLength(x.payloadData);
      }
    };
    b.listeners.add(listener);
    const viewport = { startUs: (end - 120) * 1e6, durationSec: 120, centerPriceTicks: 84000, priceSpanTicks: 160 };
    const params = new URLSearchParams({ debug: "1", ...(fp ? { view: "footprint" } : { benchViewport: JSON.stringify(viewport) }),
      ...(mode === "before" ? { fixtureFront: "before" } : {}) });
    const address = `${base}/?${params}`;
    const navigate = async () => { await p.call("Page.navigate", { url: address }); };
    const complete = () => waitFor(async () => {
      const x = await p.evaluate(fp ? "window.__footprintDebug" : "window.__heatmapDebug").catch(() => null);
      return fp ? x?.requests.some(v => v.state === "done") && x?.bars.some(v => v.bar)
        : x?.connection === "connected" && x.cachedTrades >= 120 && x.loadingRanges === 0 && x.depthDrawCount > 0;
    });
    // One warmup per case; empty app cache on final navigation, warmed engine.
    await navigate(); await delay(500);
    let plotW = 0;
    if (fp) plotW = await waitFor(async () => (await p.evaluate("window.__footprintDebug?.layout.plotW").catch(() => null)) || false);
    await p.call("Page.navigate", { url: `${base}/__fixture/blank` });
    await waitFor(() => p.evaluate("location.pathname==='/__fixture/blank'").catch(() => false));
    if (fp) await p.evaluate(`sessionStorage.setItem('heatmap.instrument','NQ');sessionStorage.setItem('footprint.timeframe','${tf}');sessionStorage.setItem('view.footprint.NQ',JSON.stringify({endSec:${end},barW:${plotW * tf / 120},rowH:16,centerPrice:84000,follow:false}))`);
    await delay(200);
    const snap = async () => ({
      os: await processSample(b.proc.pid), server: await ctl("status"),
      perf: Object.fromEntries((await p.call("Performance.getMetrics")).metrics.map(m => [m.name, m.value])),
      http: httpBytes, wsBody, wall: performance.now(),
    });
    const primary = fp ? "fp-canvas" : "heatmap";
    async function finish(name, before) {
      const after = await snap();
      const frames = await p.evaluate(`(window.__paintProof?.frames??[]).filter(x=>x.targets.includes('${primary}'))`);
      const times = frames.map(x => x.ms);
      const cpuTicks = Object.entries(after.os.ticks).reduce((n, [pid, ticks]) => n + Math.max(0, ticks - (before.os.ticks[pid] ?? 0)), 0);
      const elapsed = after.wall - before.wall;
      r.phases.push({ name, elapsedMs: elapsed, canvasContainingFrames: times.length,
        meanCanvasFrameMs: times.length ? times.reduce((a, c) => a + c, 0) / times.length : null,
        maxCanvasFrameMs: times.length ? Math.max(...times) : null, frameSamples: frames,
        browserCpuMs: cpuTicks * 1000 / hz, browserCpuPercent: cpuTicks * 1000 / hz / elapsed * 100,
        rendererTaskMs: (after.perf.TaskDuration - before.perf.TaskDuration) * 1000,
        jsHeap: after.perf.JSHeapUsedSize, browserRss: after.os.rss, browserCumulativeHwmSum: after.os.hwm,
        httpBytes: after.http - before.http, wsPayloadBytes: after.wsBody - before.wsBody,
        tcpWsTx: after.server.tcp.tx - before.server.tcp.tx, tcpWsRx: after.server.tcp.rx - before.server.tcp.rx,
        activeConnections: after.server.connections.reduce((n, c) => n + c.connected, 0), before, after });
    }
    let before = await snap(); await navigate(); await complete(); await delay(1200); await finish("initial", before);
    r.display = await p.evaluate(fp
      ? "({view:__footprintDebug.view,layout:__footprintDebug.layout,tf:__footprintDebug.timeframe,bars:__footprintDebug.bars.length,detail:__footprintDebug.detail,trades:__footprintCounters.trades,dpr:devicePixelRatio})"
      : "({view:__heatmapDebug.viewport,bars:__heatmapDebug.cachedColumns,trades:__heatmapDebug.cachedTrades,dpr:devicePixelRatio})");
    const span = fp ? r.display.layout.plotW / r.display.view.barW * tf : r.display.view.durationSec;
    assert.ok(Math.abs(span - 120) < 0.001); assert.equal(r.display.dpr, 1); assert.equal(r.display.trades, 120);
    if (fp) assert.equal(r.display.view.endSec, end);
    else assert.equal(r.display.view.startUs, (end - 120) * 1e6);
    r.visibleBars = fp ? Math.ceil(end / tf) - Math.floor((end - 120) / tf) : 120;
    await p.evaluate("window.__paintProof.frames=[]"); before = await snap();
    for (let k = 0; k < 4; k++) { await ctl("step"); await delay(1100); }
    await finish("updates", before);
    await p.evaluate("window.__paintProof.frames=[]"); before = await snap();
    for (let k = 0; k < 4; k++) {
      await p.evaluate(`(()=>{const c=document.querySelector('#${primary}'),b=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{clientX:b.left+b.width/2,clientY:b.top+30,deltaY:${k % 2 ? 70 : -70},bubbles:true,cancelable:true}))})()`);
      await delay(220);
    }
    await finish("operations", before);
    await p.screenshot(`${dir}/canvas-${mode}.png`);
    r.finalTrades = await p.evaluate(fp ? "__footprintCounters.trades" : "__heatmapDebug.cachedTrades");
    assert.equal(r.finalTrades, 124);
    await p.close();
  } catch (e) { r.failure = e.stack; throw e; }
  finally {
    r.cleanup = await b.close(); results.push(r);
    await fs.writeFile(`${dir}/canvas-measure.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ mode, failure: r.failure, phases: r.phases.map(x => ({ name: x.name, frames: x.canvasContainingFrames,
      meanMs: x.meanCanvasFrameMs, maxMs: x.maxCanvasFrameMs, cpuMs: x.browserCpuMs, heap: x.jsHeap, rss: x.browserRss, tcpTx: x.tcpWsTx })) }));
  }
}
