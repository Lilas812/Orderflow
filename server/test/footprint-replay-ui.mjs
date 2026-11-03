/** Isolated end-to-end FOOTPRINT replay check against the hash-verified local copy fixture. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";

const origin = process.env.REPLAY_ORIGIN ?? "http://127.0.0.1:18886";
const evidenceDir = "docs/evidence/footprint-replay";
await fs.mkdir(evidenceDir, { recursive: true });
const initial = await (await fetch(`${origin}/__replay`)).json();
assert(initial.inputs.length > 0, "fixture must read hash-verified saved-copy inputs");
assert(initial.peers.every(([, n]) => n === 0), "another replay client is connected");
const q95 = values => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
const getMetrics = async (page, reset = false) => {
  const rows = await page.call("Performance.getMetrics");
  const values = Object.fromEntries(rows.metrics.map(m => [m.name, m.value]));
  if (reset) return values;
  return values;
};
const stateExpr = "window.__footprintReplayEvidence?.states.at(-1)";
const instrument = symbol => `(() => {
  sessionStorage.setItem("heatmap.instrument", ${JSON.stringify(symbol)});
  const Native = window.WebSocket;
  window.__footprintReplayEvidence = { connections: 0, messages: [], states: [], playbackTrades: [],
    rangeTrades: [], rangeDone: [], errors: [], futurePlayback: [], receivedBytes: 0, binaryFrames: 0 };
  window.addEventListener("error", e => window.__footprintReplayEvidence.errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", e => window.__footprintReplayEvidence.errors.push(String(e.reason)));
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args); const d = window.__footprintReplayEvidence; d.connections++;
      if (String(args[0]).includes("/api/ws")) this.addEventListener("message", e => {
        if (typeof e.data !== "string") { d.binaryFrames++; d.receivedBytes += e.data?.byteLength ?? 0; return; }
        d.receivedBytes += new TextEncoder().encode(e.data).length;
        const v = JSON.parse(e.data); d.messages.push(v.type);
        if (v.type === "hello" && v.replayControlled) {
          d.playbackTrades = []; d.rangeTrades = []; d.states = []; d.rangeDone = [];
          d.errors = []; d.futurePlayback = []; d.receivedBytes = 0; d.binaryFrames = 0; d.messages = [];
        }
        if (v.type === "replayState") d.states.push(v);
        if (v.type === "trades" && Number.isSafeInteger(v.replayHeadUs)) {
          d.playbackTrades.push(...v.trades);
          if (v.trades.some(t => t.tsUs >= v.replayHeadUs)) d.futurePlayback.push(v.replayHeadUs);
        }
        if (v.type === "rangeTrades") d.rangeTrades.push(...v.trades);
        if (v.type === "rangeDone") d.rangeDone.push(v);
        if (v.type === "error") d.errors.push(v.code);
      });
    }
  };
})()`;
const dateValue = sec => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 19);
const readPeers = async () => (await (await fetch(`${origin}/__replay`)).json()).peers;
const totalPeers = peers => peers.reduce((sum, [, count]) => sum + count, 0);
const results = { fixture: initial, symbols: [], cleanup: {} };
const b = await browser();

try {
  for (const symbol of ["NQ", "GC"]) {
    const p = await b.page();
    await p.call("Performance.enable");
    await p.call("Page.addScriptToEvaluateOnNewDocument", { source: instrument(symbol) });
    await p.call("Page.navigate", { url: `${origin}/?view=footprint&debug=1&renderer=canvas` });
    await p.front();
    await waitFor(() => p.evaluate(`!!window.__footprintDebug && !!document.querySelector('[aria-label="リプレイ"]')
      && window.__footprintReplayEvidence?.connections === 1`), 30000);
    await waitFor(() => p.evaluate("window.__footprintReplayEvidence.messages.includes('hello')"), 15000);

    const target = initial.end - 600;
    const openAt = async sec => p.evaluate(`(() => {
      document.querySelector('[aria-label="リプレイ"]').click();
      const input = document.querySelector('[aria-label="リプレイ日時"]');
      input.value = ${JSON.stringify(dateValue(sec))};
      document.querySelector('.replay-bar form').requestSubmit();
    })()`);
    await openAt(target);
    await waitFor(() => p.evaluate(`${stateExpr}?.state === 'paused' && ${stateExpr}?.positionUs === ${target * 1e6}`), 30000);
    await waitFor(() => p.evaluate("window.__footprintReplayEvidence.rangeDone.length > 0"), 30000);
    const targetHead = await p.evaluate(stateExpr + ".positionUs");
    const fpd = await p.evaluate("window.__footprintDebug");
    assert(fpd.view.follow && Math.abs(fpd.view.endSec - (Math.floor(target / fpd.timeframe) * fpd.timeframe + fpd.timeframe * 2)) < .01,
      `${symbol}: viewport is not anchored to the replay cursor`);
    assert.equal(await p.evaluate("window.__footprintReplayEvidence.futurePlayback.length"), 0);
    assert.equal(totalPeers(await readPeers()), 1);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-replay-start.png`);

    await p.evaluate("document.querySelector('[data-action=\"play\"]').click()");
    await waitFor(() => p.evaluate(`${stateExpr}?.state === 'playing'`), 10000);
    await delay(350);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-playing.png`);
    await p.evaluate("document.querySelector('[data-action=\"play\"]').click()");
    await waitFor(() => p.evaluate(`${stateExpr}?.state === 'paused'`), 10000);
    const pausedHead = await p.evaluate(stateExpr + ".positionUs");
    assert(pausedHead > targetHead);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-paused.png`);
    const tradeCountBeforePause = await p.evaluate("window.__footprintReplayEvidence.playbackTrades.length");
    await delay(300);
    assert.equal(await p.evaluate("window.__footprintReplayEvidence.playbackTrades.length"), tradeCountBeforePause,
      `${symbol}: paused replay emitted new trades`);
    await p.evaluate("document.querySelector('[aria-label=\"コマ送り幅\"]').value='1';document.querySelector('[data-action=\"step\"]').click()");
    await waitFor(() => p.evaluate(`${stateExpr}?.positionUs === ${pausedHead + 1e6}`), 10000);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-step.png`);
    await p.evaluate("document.querySelector('[aria-label=\"リプレイ速度\"]').value='2';document.querySelector('[aria-label=\"リプレイ速度\"]').dispatchEvent(new Event('change'))");
    await waitFor(() => p.evaluate(`${stateExpr}?.speed === 2 && ${stateExpr}?.state === 'paused'`), 10000);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-speed.png`);
    await p.evaluate(`(() => {
      const input=document.querySelector('[aria-label="リプレイ日時"]');
      input.value=${JSON.stringify(dateValue(initial.end - 580))};
      document.querySelector('.replay-bar form').requestSubmit();
    })()`);
    await waitFor(() => p.evaluate(`${stateExpr}?.positionUs === ${(initial.end - 580) * 1e6} && ${stateExpr}?.state === 'paused'`), 10000);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-forward.png`);
    await p.evaluate(`(() => {
      const input=document.querySelector('[aria-label="リプレイ日時"]');
      input.value=${JSON.stringify(dateValue(target))};
      document.querySelector('.replay-bar form').requestSubmit();
    })()`);
    await waitFor(() => p.evaluate(`${stateExpr}?.positionUs === ${target * 1e6} && ${stateExpr}?.state === 'paused'`), 10000);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-backward.png`);

    const beforeSwitch = await p.evaluate(stateExpr + ".positionUs");
    await p.evaluate("document.querySelector('[data-testid=\"link-view-heatmap\"]').click()");
    await waitFor(() => p.evaluate(`document.querySelector('#heatmap') && ${stateExpr}?.state === 'paused'`), 30000);
    const heatHead = await p.evaluate(stateExpr + ".positionUs");
    assert.equal(heatHead, beforeSwitch, `${symbol}: heatmap did not restore the shared replay position`);
    assert.equal(await p.evaluate(stateExpr + ".speed"), 2);
    assert.equal(totalPeers(await readPeers()), 1, `${symbol}: screen switch opened overlapping replay sockets`);
    await p.screenshot(`${evidenceDir}/${symbol}-heatmap-shared-replay.png`);

    await p.evaluate("document.querySelector('[data-testid=\"link-view-footprint\"]').click()");
    await waitFor(() => p.evaluate(`window.__footprintDebug && ${stateExpr}?.state === 'paused'`), 30000);
    assert.equal(await p.evaluate(stateExpr + ".positionUs"), beforeSwitch,
      `${symbol}: footprint did not restore the shared replay position`);
    assert.equal(totalPeers(await readPeers()), 1);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-restored.png`);

    // Run the requested 60x600 virtual-second interval from a fresh replay generation.
    await openAt(initial.end - 600);
    await waitFor(() => p.evaluate(`${stateExpr}?.state === 'paused' && ${stateExpr}?.positionUs === ${(initial.end - 600) * 1e6}`), 15000);
    await waitFor(() => p.evaluate("window.__footprintReplayEvidence.rangeDone.length > 0"), 30000);
    await p.evaluate("document.querySelector('[aria-label=\"リプレイ速度\"]').value='60';document.querySelector('[aria-label=\"リプレイ速度\"]').dispatchEvent(new Event('change'))");
    await delay(100);
    const tradeStart = await p.evaluate("window.__footprintReplayEvidence.playbackTrades.length");
    const bytesStart = await p.evaluate("window.__footprintReplayEvidence.receivedBytes");
    const drawStart = await p.evaluate("window.__footprintDebug.draw.samplesMs.length");
    const perfBefore = await getMetrics(p);
    await fetch(`${origin}/__replay?reset=1`);
    const playStartedAt = Date.now();
    await p.evaluate("document.querySelector('[data-action=\"play\"]').click()");
    await waitFor(() => p.evaluate(`${stateExpr}?.state === 'ended' && ${stateExpr}?.positionUs === ${initial.end * 1e6}`), 40000);
    const browserTimeMs = Date.now() - playStartedAt;
    const perfAfter = await getMetrics(p);
    const metric = (before, after, key) => (after[key] ?? 0) - (before[key] ?? 0);
    const evidence = await p.evaluate(`(() => {
      const d=window.__footprintDebug,e=window.__footprintReplayEvidence;
      const frames=d.draw.samplesMs.slice(${drawStart});
      const trades=e.playbackTrades.slice(${tradeStart});
      return {draw:{count:frames.length,p50Ms:frames.length?frames.slice().sort((a,b)=>a-b)[Math.floor((frames.length-1)*.5)]:null,
          p95Ms:frames.length?frames.slice().sort((a,b)=>a-b)[Math.ceil(frames.length*.95)-1]:null,maxMs:Math.max(0,...frames)},
        playback:{count:trades.length,quantity:trades.reduce((n,t)=>n+t.size,0),
          hash:trades.map(t=>JSON.stringify(t)).sort().join("\\n")},
        futureFrames:e.futurePlayback.length,binaryFrames:e.binaryFrames,errors:e.errors,
        cache:d.cache,view:d.view,quality:d.state.quality,receivedBytes:e.receivedBytes-${bytesStart},
        generations:e.states.map(s=>s.replayGeneration)};
    })()`);
    evidence.playback.hash = createHash("sha256").update(evidence.playback.hash).digest("hex");
    const expected = initial.symbols.find(v => v.symbol === symbol).last600;
    assert.equal(evidence.playback.count, expected.count, `${symbol}: playback trade count differs from saved input`);
    assert.equal(evidence.playback.quantity, expected.quantity, `${symbol}: playback quantity differs from saved input`);
    assert.equal(evidence.playback.hash, expected.hash, `${symbol}: playback trades differ from saved input`);
    assert.equal(evidence.futureFrames, 0); assert.equal(evidence.binaryFrames, 0); assert.deepEqual(evidence.errors, []);
    const serverAfter = await (await fetch(`${origin}/__replay`)).json();
    assert.equal(totalPeers(serverAfter.peers), 1);
    const serverCpuUs = serverAfter.metrics.cpu.user + serverAfter.metrics.cpu.system;
    results.symbols.push({
      symbol, startSec: initial.end - 600, endSec: initial.end, virtualSeconds: 600, speed: 60,
      wallMs: browserTimeMs, server: { pid: serverAfter.pid, cpuUs: serverCpuUs,
        cpuCores: serverCpuUs / 1e6 / (serverAfter.metrics.elapsedMs / 1000),
        eventLoopMaxMs: serverAfter.metrics.eventLoopMaxMs, txWireBytes: serverAfter.metrics.txWireBytes,
        replayWorkMax: serverAfter.metrics.replayWorkMax, rss: serverAfter.metrics.rss,
        maxReplayPeers: serverAfter.maxReplayPeers ?? null },
      browser: { taskDurationSec: metric(perfBefore, perfAfter, "TaskDuration"),
        scriptDurationSec: metric(perfBefore, perfAfter, "ScriptDuration"),
        heapDeltaBytes: metric(perfBefore, perfAfter, "JSHeapUsedSize"),
        receivedBytes: evidence.receivedBytes },
      footprint: { draw: evidence.draw, playback: { count: evidence.playback.count,
        quantity: evidence.playback.quantity, sha256: evidence.playback.hash },
        cache: evidence.cache, quality: evidence.quality, futureFrames: evidence.futureFrames,
        binaryFrames: evidence.binaryFrames, errors: evidence.errors },
    });
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-60x600-end.png`);

    await p.evaluate("document.querySelector('[data-action=\"live\"]').click()");
    await waitFor(() => p.evaluate("document.querySelector('.replay-bar').hidden && !window.__footprintDebug.state.lastError"), 15000);
    assert.equal(await p.evaluate(`sessionStorage.getItem('replay.shared.v1.${symbol}')`), null);
    await p.screenshot(`${evidenceDir}/${symbol}-footprint-live.png`);
    await p.close();
    await waitFor(async () => totalPeers(await readPeers()) === 0);
  }
} finally {
  results.cleanup.browser = await b.close();
  results.cleanup.browserPidAbsent = !await fs.stat(`/proc/${results.cleanup.browser.pid}`).then(() => true, () => false);
  results.cleanup.peers = await readPeers();
  results.cleanup.zeroPeers = totalPeers(results.cleanup.peers) === 0;
  results.cleanup.fixture = (await (await fetch(`${origin}/__replay`)).json()).pid;
  await fs.writeFile(`${evidenceDir}/results.json`, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify({ symbols: results.symbols, cleanup: results.cleanup }, null, 2));
