/**
 * Read-only with respect to existing data/cloud. All PUTs target a unique
 * temporary LocalSettings / disk-backed ダミー Objects instance.
 * Run against an archived, coherent v3 checkout, not concurrent UI edits.
 */
import express from "express";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import assert from "node:assert/strict";
import { browser, delay } from "./perf/cdp.ts";

const baseline = path.resolve(process.argv[2] ?? "/tmp/settings-investigation-baseline");
const out = path.resolve(process.argv[3] ?? `data/settings-investigation-${Date.now()}`);
try {
  assert.equal((await fs.readdir(out)).length, 0, "調査先は空の隔離ディレクトリが必要です");
} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
await fs.mkdir(out, { recursive: true });
const load = (p: string) => import(pathToFileURL(path.join(baseline, p)).href);
const { AppSettings } = await load("server/src/settings/app.ts");
const { LocalSettings } = await load("server/src/settings/local.ts");
const { settingsRouter } = await load("server/src/settings/routes.ts");
const { defaults } = await load("server/src/settings/schema.ts");
assert.equal(Object.keys(defaults).length, 14, "この計測はversion 3の固定コード専用です");
const values = { ...defaults, heatTopPct: 5, heatLowerMode: "size", heatLowerSize: 50,
  heatGamma: 1, bubbleMin: 20, bubbleScale: 3, bookBarPct: 10,
  bookBarOpacity: .5, bigTopPct: 2, bigMinSec: 5, timeZone: "Asia/Tokyo" };
const events: any[] = [];
const result: any = { startedAt: new Date().toISOString(),
  note: "ダミー接続・実保存固定再生。クラウドPUTなし。上流WSなし。",
  baseline, values, stages: [] };
const mark = (event: string, data: object = {}) => events.push({
  at: new Date().toISOString(), ms: performance.now(), event, ...data });
const log = (event: string, data?: object) => mark(event, data);

// Every object remains on disk in this run's unique output directory.
class DummyObjects {
  files = new Map<string, Buffer>();
  verifyDelay = 0;
  failUpload = false;
  uploaded = false;
  async timed<T>(operation: string, action: () => Promise<T>) {
    const t = performance.now(); mark("io_begin", { operation });
    try { return await action(); }
    finally { mark("io_end", { operation, elapsedMs: performance.now() - t }); }
  }
  async exists(name: string) { return this.timed("exists", async () => this.files.has(name)); }
  async list(prefix: string) { return this.timed("list", async () =>
    [...this.files.keys()].filter(k => k.startsWith(prefix))); }
  async download(name: string, file: string) {
    return this.timed(file.endsWith(".cloud") ? "download_initial" : "download_verify", async () => {
      if (!file.endsWith(".cloud")) await delay(this.verifyDelay);
      await fs.writeFile(file, this.files.get(name)!);
    });
  }
  async upload(name: string, file: string) {
    return this.timed("upload", async () => {
      if (this.failUpload) throw Error("ダミー upload failure");
      this.files.set(name, await fs.readFile(file)); this.uploaded = true;
      await fs.writeFile(path.join(out, "dummy-cloud.json"), this.files.get(name)!);
    });
  }
}
const cloud = new DummyObjects();
cloud.files.set("dummy/settings.json", Buffer.from(JSON.stringify({
  version: 3, values: defaults, updatedAt: 1 })));
const appStore = new AppSettings(path.join(out, "staging/settings.json"), cloud, "dummy/", log);
const local = new LocalSettings(path.join(out, "ui/settings.json"), log);
const app = express();
let seq = 0, active = 0, maxActive = 0;
const gc: any[] = [];
const observer = new PerformanceObserver(list => {
  for (const e of list.getEntries()) gc.push({ atMs: e.startTime, durationMs: e.duration });
});
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const cpuStart = process.cpuUsage(), wallStart = performance.now();
app.use((req, res, next) => {
  const id = ++seq, start = performance.now();
  active++; maxActive = Math.max(active, maxActive);
  mark("request_arrived", { id, method: req.method, route: req.path });
  res.on("finish", () => mark("response_finish", { id, elapsedMs: performance.now() - start }));
  res.on("close", () => { active--; mark("response_close", {
    id, elapsedMs: performance.now() - start, finished: res.writableFinished }); });
  next();
});
app.use("/probe", settingsRouter(appStore));
app.use("/api/settings", settingsRouter(local));
app.get("/@fs/home/runner/workspace/data/perf-memory/render-fixture/:name", async (req, res) => {
  if (!["columns.bin", "trades.json", "metadata.json"].includes(req.params.name)) {
    res.sendStatus(404); return;
  }
  res.sendFile(path.resolve("data/perf-memory/render-fixture", req.params.name));
});
app.use(express.static(path.join(baseline, "artifacts/heatmap/dist/public")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;
result.port = address.port;
const request = async (route: string, input?: object, timeout = 20000) => {
  const start = performance.now(); mark("request_sent", { route, method: input ? "PUT" : "GET" });
  try {
    const res = await fetch(base + route, { method: input ? "PUT" : "GET",
      signal: AbortSignal.timeout(timeout),
      ...(input ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: input }) } : {}) });
    const headersMs = performance.now() - start;
    const document = await res.json();
    return { status: res.status, headersMs, elapsedMs: performance.now() - start, document };
  } catch (e) {
    return { error: (e as Error).name, elapsedMs: performance.now() - start };
  }
};
let chrome: Awaited<ReturnType<typeof browser>> | undefined;
try {
  result.normalGet = await request("/probe");
  result.normalPut = await request("/probe", values);
  assert.equal(result.normalPut.status, 200);
  cloud.verifyDelay = 12000;
  const first = request("/probe", { ...values, bubbleMin: 21 }, 10000);
  await delay(250);
  // These requests arrive while verification is pending. They must serialize.
  const queuedGet = request("/probe");
  const queuedPut = request("/probe", { ...values, bubbleMin: 22 });
  result.abort = await first;
  result.atAbort = { cloudBubbleMin: JSON.parse(cloud.files.get("dummy/settings.json")!.toString()).values.bubbleMin,
    localBubbleMin: JSON.parse(await fs.readFile(path.join(out, "staging/settings.json"), "utf8")).values.bubbleMin };
  cloud.verifyDelay = 0; // First verify is already asleep; subsequent PUT is normal.
  result.queuedGet = await queuedGet; result.queuedPut = await queuedPut;
  result.finalGet = await request("/probe");
  assert.equal(result.abort.error, "TimeoutError");
  assert.equal(result.atAbort.cloudBubbleMin, 21);
  assert.equal(result.queuedGet.document.values.bubbleMin, 21);
  assert.equal(result.finalGet.document.values.bubbleMin, 22);
  cloud.failUpload = true;
  result.failedPut = await request("/probe", { ...values, bubbleMin: 23 });
  result.failedReadback = await request("/probe");
  assert.equal(result.failedPut.status, 500);
  assert.equal(result.failedReadback.document.values.bubbleMin, 22);
  await local.put(defaults);
  chrome = await browser(9237);
  const page = await chrome.page("about:blank");
  const script = await fs.readFile("server/tools/perf/frozen-feed.js", "utf8");
  await page.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: script + `
    window.__investigationLongTasks=[];
    new PerformanceObserver(list=>{for(const e of list.getEntries())
      window.__investigationLongTasks.push({at:e.startTime,ms:e.duration})}).observe({type:'longtask',buffered:true});
    window.__investigationRequests=[];
    const nf=fetch.bind(window);window.fetch=async(...args)=>{
      const t=performance.now();const r=await nf(...args);
      if(String(args[0]).includes('api/settings')){
        const headers=performance.now();await r.clone().text();
        window.__investigationRequests.push({method:args[1]?.method||'GET',start:t,headersMs:headers-t,bodyMs:performance.now()-headers});
      }return r;};
    addEventListener('DOMContentLoaded',()=>{const b=document.createElement('div');
      b.textContent='ダミー接続・実保存固定再生・隔離設定';
      b.style='position:fixed;top:0;right:0;z-index:99999;color:white;background:#603000';document.body.append(b);});
  ` });
  await page.cdp.call("Page.navigate", { url: base + "/?mode=replay&from=1793022000&speed=1&debug=1" });
  const wait = async (expr: string) => {
    for (let i = 0; i < 240; i++) {
      if (await page.cdp.evaluate(expr)) return;
      await delay(100);
    }
    throw Error("wait_timeout:" + expr);
  };
  await wait("window.__frozenFeedReady && window.__heatmapDebug?.cachedColumns>0 && !window.__heatmapDebug.loadingRanges");
  const click = (selector: string) => page.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const stage = async (name: string, action: () => Promise<unknown>) => {
    const start = await page.cdp.evaluate("performance.now()");
    await action(); await delay(1150);
    result.stages.push({ name, start, ...await page.cdp.evaluate(`({
      end:performance.now(), frames:window.__heatmapFrameStats.filter(f=>f.at>=${start}),
      longTasks:window.__investigationLongTasks.filter(f=>f.at>=${start}),
      requests:window.__investigationRequests.filter(f=>f.start>=${start}),
      debug:window.__heatmapDebug })`) });
  };
  await stage("open-default", async () => {
    await click('[data-testid="button-settings"]');
    await wait("!document.getElementById('su-heatTopPct').disabled");
  });
  await stage("save-user-values", async () => {
    for (const [key, value] of Object.entries(values)) await page.cdp.evaluate(`(()=>{
      const e=document.getElementById(${JSON.stringify("su-" + key)});
      e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('[data-testid="button-settings-save"]');
    await wait("!document.querySelector('dialog').open");
  });
  await stage("open-user-values", async () => {
    await click('[data-testid="button-settings"]');
    await wait("!document.getElementById('su-heatTopPct').disabled");
    assert.equal(await page.cdp.evaluate("document.getElementById('su-heatLowerSize').value"), "50");
    await click('[data-testid="button-settings-close"]');
  });
  // Change only bigMinSec: existing implementation rebuilds even though top% is unchanged.
  await stage("big-min-only", async () => {
    await click('[data-testid="button-settings"]');
    await wait("!document.getElementById('su-bigMinSec').disabled");
    await page.cdp.evaluate(`(()=>{const e=document.getElementById('su-bigMinSec');e.value='6';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('[data-testid="button-settings-save"]'); await wait("!document.querySelector('dialog').open");
  });
  for (const [name, key, value] of [["bubble-only", "bubbleScale", "1"], ["heat-only", "heatTopPct", "4"]] as const) {
    await stage(name, async () => {
      await click('[data-testid="button-settings"]'); await wait(`!document.getElementById('su-${key}').disabled`);
      await page.cdp.evaluate(`(()=>{const e=document.getElementById('su-${key}');e.value='${value}';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('[data-testid="button-settings-save"]'); await wait("!document.querySelector('dialog').open");
    });
  }
  // Return to the provided values through the isolated UI before normal operations.
  await stage("restore-user-values", async () => {
    await click('[data-testid="button-settings"]'); await wait("!document.getElementById('su-heatTopPct').disabled");
    for (const [key, value] of Object.entries(values)) await page.cdp.evaluate(`(()=>{
      const e=document.getElementById(${JSON.stringify("su-" + key)});e.value=${JSON.stringify(String(value))};
      e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('[data-testid="button-settings-save"]'); await wait("!document.querySelector('dialog').open");
  });
  await stage("normal-time-zoom", async () => {
    for (let i = 0; i < 20; i++) {
      await page.cdp.evaluate(`(()=>{const e=document.getElementById('heatmap'),r=e.getBoundingClientRect();
        e.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+r.width*.5,clientY:r.y+r.height*.5,deltaY:25,bubbles:true,cancelable:true}));})()`);
      await delay(35);
    }
  });
  await stage("normal-pan", async () => {
    const r = await page.cdp.evaluate(`(()=>{const r=document.getElementById('heatmap').getBoundingClientRect();
      return{x:r.x+r.width*.25,y:r.y+r.height*.5}})()`);
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...r, button: "left", clickCount: 1 });
    for (let i = 1; i <= 20; i++) {
      await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + i * 5, y: r.y, button: "left", buttons: 1 });
      await delay(35);
    }
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 100, y: r.y, button: "left" });
  });
  const screenshot = await page.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, "isolated.png"), Buffer.from(screenshot.data, "base64"));
  result.resourceEntries = await page.cdp.evaluate(`performance.getEntriesByType('resource')
    .map(e=>({name:new URL(e.name).pathname,ms:e.duration}))`);
  result.passed = true;
} finally {
  if (chrome) result.browserClosed = await chrome.close();
  loop.disable(); observer.disconnect();
  const cpu = process.cpuUsage(cpuStart);
  result.serverMetrics = { wallMs: performance.now() - wallStart, cpuMs: (cpu.user + cpu.system) / 1000,
    eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6, gc,
    maxActive, rss: process.memoryUsage().rss };
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  result.serverClosed = !server.listening;
  await fs.writeFile(path.join(out, "events.json"), JSON.stringify(events, null, 2));
  await fs.writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, passed: result.passed, browserClosed: result.browserClosed,
    serverClosed: result.serverClosed, metrics: result.serverMetrics }));
}
