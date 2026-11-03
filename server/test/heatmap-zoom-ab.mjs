/** Serial 60s x3 Canvas A/B matrix; immutable saved input, real product handlers. */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";
const root = process.argv.find(a => a.startsWith("--root="))?.slice(7);
if (!root) throw Error("--root required");
const short = process.argv.includes("--short"), seconds = short ? 30 : 60, prefix = short ? "short-" : "";
const config = JSON.parse(await fs.readFile(path.join(root, "builds.json"), "utf8"));
const fixtures = [], results = [], cleanups = [], errors = [];
const quantile = (v, p) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)];
const save = async () => fs.writeFile(path.join(root, prefix + "results.json"), JSON.stringify({ config, seconds, results, cleanups, errors }, null, 2));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  for (const [i, name] of ["before", "after"].entries()) {
    const port = 18885 + i, origin = `http://127.0.0.1:${port}`;
    const log = await fs.open(path.join(root, `${prefix}fixture-${name}.log`), "w");
    const proc = spawn(process.execPath, ["server/test/footprint-zoom-fixture.ts", `--port=${port}`, `--front-root=${config.builds[name].frontRoot}`], { stdio: ["ignore", log.fd, log.fd] });
    fixtures.push({ name, origin, proc, log });
    await waitFor(async () => {
      try { const x = await (await fetch(origin + "/__replay")).json(); assert.equal(x.pid, proc.pid); return x; }
      catch { if (proc.exitCode !== null) throw Error("fixture_failed"); return false; }
    });
  }
  const inputBefore = await (await fetch(fixtures[0].origin + "/__replay")).json();
  const inputAfter = await (await fetch(fixtures[1].origin + "/__replay")).json();
  assert.deepEqual(inputBefore.inputs, inputAfter.inputs);
  assert.deepEqual(inputBefore.symbols, inputAfter.symbols);
  const centers = { NQ: 117878, GC: 40212 }; // Same observed saved trade centres as preceding measurement.
  await fs.writeFile(path.join(root, prefix + "input.json"), JSON.stringify({ before: inputBefore, after: inputAfter, centers }, null, 2));
  const conditions = [];
  if (short) for (const span of [8000, 160, 1600]) conditions.push({ symbol: "NQ", dpr: 2, span });
  else for (const symbol of ["NQ", "GC"]) for (const dpr of [1, 2]) for (const span of [160, 1600, 8000]) conditions.push({ symbol, dpr, span });
  for (let round = 1; round <= (short ? 1 : 3); round++) {
    for (const [ci, condition] of conditions.entries()) {
      const names = condition.span === 8000 ? ["after"] : (short || (round + ci) % 2 ? ["before", "after"] : ["after", "before"]);
      for (const name of names) {
        const fixture = fixtures.find(f => f.name === name);
        // Match the exact Chromium/ANGLE flags used in the original 254–332ms run.
        const b = await browser({ headed: true, extraArgs: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
        let p;
        try {
          p = await b.page(); await p.front();
          await p.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: condition.dpr, mobile: false });
          await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `
            Date.now=()=>${inputBefore.end * 1000};
            sessionStorage.setItem("heatmap.instrument","${condition.symbol}");
            sessionStorage.setItem("view.heatmap.${condition.symbol}",JSON.stringify({follow:false,viewport:{
              startUs:${(inputBefore.from + 1200) * 1e6},durationSec:600,
              centerPriceTicks:${centers[condition.symbol]},priceSpanTicks:${condition.span}}}));
          ` });
          await p.call("Page.navigate", { url: fixture.origin + "/?debug=1&renderer=canvas" });
          await waitFor(async () => p.evaluate("!!(window.__heatmapDebug?.cachedColumns && window.__heatmapDebug?.cachedTrades && window.__heatmapDebug?.depthDrawCount && !window.__heatmapDebug?.loadingRanges)"), 30000);
          await delay(4000);
          const startSnapshot = await p.evaluate("window.__heatmapDebug");
          assert.equal(startSnapshot.viewport.priceSpanTicks, condition.span);
          assert.equal(startSnapshot.viewport.centerPriceTicks, centers[condition.symbol]);
          assert.equal(startSnapshot.viewport.startUs, (inputBefore.from + 1200) * 1e6);
          const backend = await p.evaluate("document.querySelector('#debug-panel').textContent.match(/renderer[^\\n]*/)?.[0]");
          assert.match(backend, /renderer canvas/);
          assert.equal(await p.evaluate("document.hidden"), false);
          assert.ok(startSnapshot.p99 > 0, "nonempty_visible_depth");
          const rect = await p.evaluate("(()=>{const r=document.querySelector('#heatmap').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
          const x = rect.x + rect.width * .43, y = rect.y + rect.height * .4;
          await p.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await p.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
          await p.call("Performance.enable");
          const before = await p.call("Performance.getMetrics");
          console.log(JSON.stringify({ event: "case_start", round, name, ...condition, sha: config.builds[name].sha, browserPid: b.proc.pid }));
          await p.evaluate(`(()=>{
            const c=document.querySelector('#heatmap');
            const start=performance.now(),deadline=start+${seconds * 1000};let actions=0;
            window.__ab={start,deadline,actions:0,done:false,hiddenStart:document.hidden};
            const timer=setInterval(()=>{
              if(performance.now()>=deadline){clearInterval(timer);return;}
              c.dispatchEvent(new PointerEvent("pointermove",{pointerId:1,pointerType:"mouse",buttons:1,
                clientX:${x}+((actions++%2)?0:4),clientY:${y},bubbles:true}));
              window.__ab.actions=actions;
            },200);
            setTimeout(()=>{clearInterval(timer);window.__ab.done=true;window.__ab.stopAt=performance.now();window.__ab.hiddenEnd=document.hidden},${seconds * 1000});
          })()`);
          const hostStart = performance.now();
          await delay(seconds * 1000 + 20);
          await waitFor(() => p.evaluate("window.__ab.done"), 30000);
          const data = await p.evaluate(`({run:window.__ab,frames:window.__heatmapFrameStats.filter(f=>f.depth && f.at>=window.__ab.start && f.at<window.__ab.deadline),
            final:window.__heatmapDebug,backend:document.querySelector('#debug-panel').textContent.match(/renderer[^\\n]*/)?.[0]})`);
          const after = await p.call("Performance.getMetrics");
          await p.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
          assert.equal(data.run.hiddenStart, false); assert.equal(data.run.hiddenEnd, false);
          assert.ok(data.frames.length >= 20, "insufficient_real_canvas_frames");
          assert.equal(data.final.viewport.priceSpanTicks, condition.span);
          assert.equal(data.final.viewport.centerPriceTicks, centers[condition.symbol]);
          const samples = data.frames.map(f => f.totalMs);
          const r = { round, name, ...condition, sha: config.builds[name].sha, browser: b.info.Browser,
            cssSize: [1200, 900], canvas: rect, sampleCount: samples.length,
            p50Ms: quantile(samples, .5), p95Ms: quantile(samples, .95), maxMs: Math.max(...samples),
            hostElapsedMs: performance.now() - hostStart, ...data, metrics: { before, after }, startSnapshot };
          results.push(r); await save();
          console.log(JSON.stringify({ event: "case_done", round, name, ...condition, p95Ms: r.p95Ms, sampleCount: r.sampleCount, actions: data.run.actions }));
        } finally {
          if (p) await p.close().catch(() => {});
          const closed = await b.close(); const status = await (await fetch(fixture.origin + "/__replay")).json();
          const ps = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
          const profileProcesses = ps.split("\n").filter(line => line.includes("--user-data-dir=" + closed.profile)).length;
          const cleanup = { round, name, ...condition, ...closed, processExists: alive(closed.pid), profileProcesses, peers: status.peers };
          cleanups.push(cleanup); await save();
          assert.equal(cleanup.processExists, false); assert.equal(profileProcesses, 0);
          assert.ok(status.peers.every(x => x[1] === 0), "fixture_ws_leak");
        }
      }
    }
  }
  const table = [];
  for (const condition of conditions) {
    const row = { ...condition };
    for (const name of ["before", "after"]) {
      const matching = results.filter(r => r.name === name && r.symbol === condition.symbol && r.dpr === condition.dpr && r.span === condition.span);
      row[name] = matching.length ? quantile(matching.map(r => r.p95Ms), .5) : null;
      row[name + "Repeats"] = matching.map(r => r.p95Ms);
    }
    row.changePct = row.before === null ? null : (row.after / row.before - 1) * 100;
    table.push(row);
  }
  await fs.writeFile(path.join(root, prefix + "table.json"), JSON.stringify(table, null, 2));
  console.log("MATRIX_FINISHED " + JSON.stringify(table));
} catch (e) {
  errors.push({ error: String(e), stack: e.stack }); await save(); throw e;
} finally {
  for (const f of fixtures) {
    const peers = await fetch(f.origin + "/__replay").then(r => r.json()).then(r => r.peers).catch(() => null);
    if (f.proc.exitCode === null) f.proc.kill("SIGTERM");
    await Promise.race([new Promise(resolve => f.proc.once("exit", resolve)), delay(5000)]);
    cleanups.push({ fixture: f.name, pid: f.proc.pid, signal: "SIGTERM", processExists: alive(f.proc.pid), peers });
    await f.log.close();
  }
  await save();
}
