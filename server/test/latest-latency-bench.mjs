/** Fixed-input real WS + Canvas benchmark. No upstream or production requests. */
import fs from "node:fs/promises";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const port = Number(process.argv[2]), name = process.argv[3];
const root = `http://127.0.0.1:${port}`, out = "data/latest-indicators";
await fs.mkdir(out, { recursive: true });
const b = await browser({ headed: true }), result = { name, root, viewport: [1280, 800], dpr: 1 };
async function browserCpu(rootPid) {
  const all = [];
  for (const name of await fs.readdir("/proc")) if (/^\d+$/.test(name)) {
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, "utf8"), a = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      all.push({ pid: Number(name), parent: Number(a[1]), ticks: Number(a[11]) + Number(a[12]) });
    } catch { /* exited process */ }
  }
  const ids = new Set([rootPid]);
  for (let i = 0; i < 10; i++) for (const p of all) if (ids.has(p.parent)) ids.add(p.pid);
  const processes = all.filter(p => ids.has(p.pid));
  return { processes, ticks: processes.reduce((sum, p) => sum + p.ticks, 0), ticksPerSecond: 100 };
}
try {
  const p = await b.page(); await p.call("Performance.enable");
  await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__bench={rows:[],bytes:0};
    const Original=WebSocket;
    window.WebSocket=class extends Original { constructor(...args){ super(...args); this.addEventListener('message',e=>{
      if(typeof e.data!=='string')return;
      window.__bench.bytes+=new TextEncoder().encode(e.data).length;
      const m=JSON.parse(e.data); if(m.type!=='trades')return;
      const receivedAt=performance.now(), receivedWall=Date.now(), prior=window.__heatmapDebug?.overlayDrawCount??0;
      const t=m.trades.at(-1); if(!t)return;
      const sample={seq:t.seq,tsUs:t.tsUs,recvUs:t.recvUs,receivedAt,receivedWall,sentAtUs:m.sentAtUs??null,price:t.price};
      window.__bench.rows.push(sample);
      const paint=()=>{const d=window.__heatmapDebug;
        if(d&&d.overlayDrawCount>prior&&d.currentPrice===t.price){Object.assign(sample,{paintAt:performance.now(),frameMs:d.drawBreakdown.drawMs,initialLoading:d.loadingRanges>0,depth:d.depthDrawCount});}
        else requestAnimationFrame(paint);
      }; requestAnimationFrame(paint);
    }); }};
  ` });
  await fetch(`${root}/__dummy/delay?ms=500`);
  await p.call("Page.navigate", { url: `${root}/?debug=1` });
  await p.front();
  await waitFor(() => p.evaluate("!!window.__heatmapDebug && window.__heatmapDebug.connection==='connected'"));
  result.foregroundAtStart = await p.evaluate("({hidden:document.hidden,state:document.visibilityState})");
  if (result.foregroundAtStart.hidden) throw Error("benchmark_not_foreground");
  const initialTick = await (await fetch(`${root}/__dummy/tick?price=21000.25&size=2`)).json();
  await waitFor(() => p.evaluate("window.__bench.rows.some(r=>r.paintAt)"), 10000);
  result.initial = { input: initialTick, samples: await p.evaluate("window.__bench.rows") };
  await waitFor(() => p.evaluate("window.__heatmapDebug.loadingRanges===0"), 15000);
  await fetch(`${root}/__dummy/delay?ms=0`);
  const before = await (await fetch(`${root}/__dummy/status`)).json();
  const perfBefore = await p.call("Performance.getMetrics");
  result.browserCpuBefore = await browserCpu(b.proc.pid);
  const wall = Date.now();
  for (let i = 0; i < 32; i++) {
    await fetch(`${root}/__dummy/tick?price=${21000 + (i % 5) * .25}&size=${i % 3 + 1}&side=${i % 2 ? "sell" : "buy"}`);
    await delay(285);
  }
  await delay(300);
  result.elapsedMs = Date.now() - wall;
  result.before = before; result.after = await (await fetch(`${root}/__dummy/status`)).json();
  result.performanceBefore = perfBefore; result.performanceAfter = await p.call("Performance.getMetrics");
  result.browserCpuAfter = await browserCpu(b.proc.pid);
  result.foregroundAtEnd = await p.evaluate("({hidden:document.hidden,state:document.visibilityState})");
  result.browser = await p.evaluate("({bench:window.__bench,debug:window.__heatmapDebug,memory:performance.memory?.usedJSHeapSize,latency:window.__heatmapLatency??null,daily:window.__heatmapDaily??null})");
  await p.screenshot(`${out}/${name}.png`);
} catch (e) { result.error = String(e.stack ?? e); }
finally {
  result.cleanup = await b.close();
  try { process.kill(result.cleanup.pid, 0); result.cleanup.pidAbsent = false; } catch { result.cleanup.pidAbsent = true; }
  await fs.writeFile(`${out}/${name}.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ name, error: result.error, cleanup: result.cleanup }));
