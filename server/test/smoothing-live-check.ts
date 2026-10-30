/** Explicit synthetic input, real Receiver/Hub/WS/product Canvas; no upstream or persistent I/O. */
import fs from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { browser, delay } from "../tools/perf/cdp.ts";
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6) ?? "data/heatmap-smoothing/live";
await fs.mkdir(out, { recursive: true });
const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
async function chromeUsage(profile: string) {
  const rows = [];
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (!/chromium|chrome/.test(args[0] ?? "")) continue;
      const s = await fs.readFile(`/proc/${pid}/stat`, "utf8"), v = s.slice(s.lastIndexOf(")") + 2).split(" ");
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      rows.push({ pid: +pid, parent: +v[1]!, cpu: (+v[11]! + +v[12]!) / hz,
        rss: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024, root: args.includes(profile) });
    } catch {}
  }
  const ids = new Set(rows.filter(r => r.root).map(r => r.pid));
  for (let i = 0; i < 8; i++) for (const r of rows) if (ids.has(r.parent)) ids.add(r.pid);
  const own = rows.filter(r => ids.has(r.pid));
  return { cpu: own.reduce((n, r) => n + r.cpu, 0), rss: own.reduce((n, r) => n + r.rss, 0), pids: [...ids] };
}
const summary = (a: number[]) => {
  a.sort((a, b) => a - b);
  return { n: a.length, p50: a[Math.floor(a.length * .5)] ?? null,
    p95: a[Math.floor(a.length * .95)] ?? null, max: a.at(-1) ?? null };
};
const records = [];
const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const seconds = Number(arg("seconds") ?? 15);
const renderer = arg("renderer");
const replayInput = arg("replay-input");
const only = arg("symbol");
const dprFilter = arg("dpr");
const front = arg("front");
const seedSeconds = arg("seed-seconds");
const fixedBatches = arg("batches") ? Number(arg("batches")) : null;
const cases: readonly (readonly ["NQ" | "GC", number])[] = process.argv.includes("--matrix")
  ? [["NQ", 1], ["NQ", 2], ["NQ", 3], ["GC", 1], ["GC", 2], ["GC", 3]] : [["NQ", 1], ["GC", 2]];
for (const [symbol, dpr] of cases) {
  if (only && only !== symbol || dprFilter && +dprFilter !== dpr) continue;
  const child = spawn(process.execPath, ["server/test/latest-indicators-fixture.ts", "--port=18815", "--smoothing=1",
    ...(replayInput ? [`--replay-input=${replayInput}`] : []), ...(front ? [`--front=${front}`] : []),
    ...(seedSeconds ? [`--seed-seconds=${seedSeconds}`] : [])], { stdio: "ignore" });
  let chrome: Awaited<ReturnType<typeof browser>> | undefined;
  const result: Record<string, any> = { symbol, dpr, synthetic: true, initialColumns: 1796, levelsPerColumn: 80,
    viewportCSS: [1280, 800], intervalMs: 250, durationTargetSec: seconds, style: "glow", requestedRenderer: renderer,
    replayInput: replayInput ?? null };
  try {
    for (let i = 0; ; i++) {
      try { await fetch("http://127.0.0.1:18815/__dummy/status"); break; }
      catch { if (i > 50) throw Error("fixture_start_timeout"); await delay(100); }
    }
    chrome = await browser(9233);
    const p = await chrome.page("http://127.0.0.1:18815/__dummy/away");
    await p.cdp.evaluate(`sessionStorage.clear();sessionStorage.setItem("heatmap.instrument","${symbol}")`);
    await p.cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
    await p.cdp.call("Page.navigate", { url: `http://127.0.0.1:18815/?debug=1${renderer ? "&renderer=" + renderer : ""}` });
    for (let i = 0; i < 100; i++) {
      if (await p.cdp.evaluate("!!window.__heatmapDebug && window.__heatmapDebug.cachedColumns>0")) break;
      await delay(100);
      if (i === 99) throw Error("initial_columns_timeout");
    }
    await delay(1000);
    await p.cdp.call("Page.bringToFront");
    const profile = `--user-data-dir=/tmp/heatmap-perf-browser-${process.pid}-9233`;
    const before = await (await fetch("http://127.0.0.1:18815/__dummy/status")).json();
    result.synthetic = !replayInput;
    if (replayInput) { result.initialColumns = before.replay.seedColumns[symbol]; result.levelsPerColumn = "saved variable depth"; }
    const usage = await chromeUsage(profile);
    result.before = await p.cdp.evaluate("({hidden:document.hidden,debug:window.__heatmapDebug,frames:window.__heatmapFrameStats,heap:performance.memory?.usedJSHeapSize,perfNow:performance.now()})");
    const base = symbol === "NQ" ? 21000 : 2700, step = symbol === "NQ" ? .25 : .1;
    const started = performance.now();
    let injected = 0, maxRss = usage.rss, maxHeap = result.before.heap ?? 0;
    while (fixedBatches === null ? performance.now() - started < seconds * 1000 : injected < fixedBatches) {
      const target = started + injected * 250;
      if (target > performance.now()) await delay(target - performance.now());
      if (replayInput) {
        await fetch(`http://127.0.0.1:18815/__dummy/replay-step?symbol=${symbol}&quarter=${injected}`);
      } else {
        await fetch(`http://127.0.0.1:18815/__dummy/tick?symbol=${symbol}&price=${(base + injected % 7 * step).toFixed(2)}&size=3`);
        if (injected % 4 === 0)
          await fetch(`http://127.0.0.1:18815/__dummy/column?symbol=${symbol}&size=${73 + injected}`);
      }
      if (injected % 4 === 0) {
        maxRss = Math.max(maxRss, (await chromeUsage(profile)).rss);
        maxHeap = Math.max(maxHeap, await p.cdp.evaluate("performance.memory?.usedJSHeapSize??0"));
      }
      injected++;
    }
    await delay(500);
    const after = await (await fetch("http://127.0.0.1:18815/__dummy/status")).json();
    const u1 = await chromeUsage(profile);
    const samples = await p.cdp.evaluate("window.__heatmapLatency??[]");
    result.after = await p.cdp.evaluate("({hidden:document.hidden,debug:window.__heatmapDebug,frames:window.__heatmapFrameStats,heap:performance.memory?.usedJSHeapSize,gpu:window.__heatmapGpu?.metrics()})");
    const frames = result.after.frames.filter((f:any)=>f.at>=result.before.perfNow);
    Object.assign(result, { injected: replayInput ? after.replay.counts[symbol].count : injected,
      injectedBatches: injected, injectedQuantity: replayInput ? after.replay.counts[symbol].quantity : injected * 3,
      replayCounts: after.replay?.counts?.[symbol], replay: after.replay ?? null,
      canvasUpdate: summary(frames.map((f:any)=>f.totalMs)), depthUpdate:summary(frames.filter((f:any)=>f.depth).map((f:any)=>f.totalMs)),
      heatmapUpdate:summary(frames.filter((f:any)=>f.depth).map((f:any)=>f.heatmapMs)),
      wallSec: (performance.now() - started) / 1000, receiveToPaint: summary(samples.map((s: any) => s.receiveToPaintMs)),
      normalizeMs: summary(after.stages.map((s: any) => s.normalizationMs)),
      serverSendToPaint: summary(samples.map((s: any) => s.serverSendToPaintMs).filter((n: any) => n !== null)),
      upstreamAgeMs: summary(samples.map((s: any) => s.upstreamAgeMs)),
      browserCPUSeconds: u1.cpu - usage.cpu, browserRSSBefore: usage.rss, browserRSSAfter: u1.rss,
      browserSampledPeakRSS: maxRss, sampledPeakHeap: maxHeap,
      serverCPUMicroseconds: after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system,
      serverRSSBefore: before.rss, serverRSSAfter: after.rss,
      wsWireBytes: after.wsWireSent - before.wsWireSent, serverHubs: after.hubs,
      profile: after.profiles.find((p: any[]) => p[0] === symbol) });
    if (result.before.hidden || result.after.hidden || samples.length === 0
      || after.hubs.reduce((n: number, h: any) => n + h.connected, 0) !== 1) throw Error("invalid_measurement_conditions");
    result.targetMet = result.receiveToPaint.p95 <= 100;
    result.canvasSizes = await p.cdp.evaluate("Array.from(document.querySelectorAll('canvas')).map(c=>({id:c.id,width:c.width,height:c.height,cssWidth:c.getBoundingClientRect().width,cssHeight:c.getBoundingClientRect().height}))");
    // Outside the measured interval; captures actual product Canvas, not a mock.
    const screenshot = await p.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(`${out}/${symbol}-dpr${dpr}.png`, Buffer.from(screenshot.data, "base64"));
  } catch (e) { result.error = String(e); }
  finally {
    if (chrome) result.browserClosed = await chrome.close();
    try { result.finalHubStatus = await (await fetch("http://127.0.0.1:18815/__dummy/status")).json(); }
    catch (e) { result.finalHubError = String(e); }
    result.serverPID = child.pid;
    child.kill("SIGTERM");
    await Promise.race([new Promise(r => child.once("exit", r)), delay(3000)]);
    try { process.kill(child.pid!, 0); result.serverClosed = false; } catch (e: any) { result.serverClosed = e.code === "ESRCH"; }
    records.push(result);
    await fs.writeFile(`${out}/real-ws.json`, JSON.stringify(records, null, 2));
  }
}
console.log(JSON.stringify(records.map(({ symbol, dpr, receiveToPaint, targetMet, error }) => ({ symbol, dpr, receiveToPaint, targetMet, error }))));
if (records.some(r => r.error || !r.targetMet)) process.exitCode = 1;
