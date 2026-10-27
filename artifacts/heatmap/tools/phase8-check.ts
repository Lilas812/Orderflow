import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { staticProxy } from "../../../server/tools/perf/static-proxy.ts";

// Development evidence only. No upstream connection or writes to market files.
const out = path.resolve("data/phase8");
await fs.mkdir(out, { recursive: true });
const evidence: any = { started: new Date().toISOString(), browsers: [], stages: [], statuses: [] };
const dump = () => fs.writeFile(path.join(out, "browser-checks.json"), JSON.stringify(evidence, null, 2));
const status = async () => (await fetch("http://127.0.0.1:8080/api/status")).json();

/** Independent raw gzip JSONL scan: no production aggregate/geometry imports. */
async function savedRows(fromUs: number, toUs: number) {
  const rows: any[] = [];
  for (let h = Math.floor(fromUs / 3_600_000_000) * 3600; h * 1e6 < toUs; h += 3600) {
    const date = new Date(h * 1000).toISOString();
    const file = path.resolve("data/trades/NQ", date.slice(0, 10), date.slice(11, 13) + ".jsonl.gz");
    const raw = createReadStream(file), input = raw.pipe(createGunzip());
    raw.on("error", e => input.destroy(e));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) if (line) {
        const t = JSON.parse(line); if (t.tsUs >= fromUs && t.tsUs < toUs) rows.push(t);
      }
    } finally { lines.close(); input.destroy(); raw.destroy(); }
  }
  return rows;
}

// Run after SIGTERM/flush, so receive-cutoff comparison cannot race file writes.
if (process.argv.includes("--recount-live")) {
  const snapshots = JSON.parse(await fs.readFile(path.join(out, "browser-checks.json"), "utf8"));
  const results: any[] = [];
  for (const stage of snapshots.stages.filter((s: any) => s.name.startsWith("live-"))) {
    const s = stage.snapshot, recent = s.recent;
    const cutoff = recent.trades.reduce((a: any, b: any) =>
      !a || b.recvUs > a.recvUs || b.recvUs === a.recvUs && b.seq > a.seq ? b : a, null);
    assert.ok(cutoff, "live received trades");
    const rows = (await savedRows(recent.fromUs, recent.toUs + 1e6)).filter(t =>
      t.recvUs < cutoff.recvUs || t.recvUs === cutoff.recvUs && t.seq <= cutoff.seq);
    const identity = (t: any) => `${t.recvUs}:${t.seq}`;
    assert.deepEqual(rows.map(identity).sort(), recent.trades.map(identity).sort(), "all recent received trades match saved rows");
    const cells = new Map<string, any>();
    const last = new Map<number, any>();
    const seconds = new Map<number, { buy: number; sell: number; count: number }>();
    for (const t of rows.sort((a, b) => a.seq - b.seq)) {
      const secondUs = Math.floor(t.tsUs / 1e6) * 1e6, key = `${secondUs}:${t.price}`;
      const cell = cells.get(key) ?? { secondUs, price: t.price, buy: 0, sell: 0 };
      cell[t.side] += t.size; cells.set(key, cell); last.set(secondUs, t);
      const total = seconds.get(secondUs) ?? { buy: 0, sell: 0, count: 0 };
      total[t.side as "buy" | "sell"] += t.size; total.count++; seconds.set(secondUs, total);
    }
    const sortCells = (v: any[]) => v.sort((a, b) => a.secondUs - b.secondUs || a.price - b.price);
    assert.deepEqual(sortCells([...cells.values()]), sortCells(recent.cells), "shared cells match saved sizes by side");
    const v = s.debug.viewport, heat = s.boxes.heatmap;
    const checked: any[] = [];
    // Use only the completed seconds and latest received second that are in this snapshot.
    for (const [sec, total] of seconds) {
      const bar = s.deltaBars.find((b: any) => b.startUs === sec);
      assert.ok(bar, "1-second live delta bar exists even ahead of the latest confirmed depth column");
      assert.equal(bar.delta, total.buy - total.sell);
      const x = (sec + 500_000 - v.startUs) / (v.durationSec * 1e6) * heat.width;
      const expectedBubbles = [...cells.values()].filter(c => c.secondUs === sec && c.buy + c.sell >= s.debug.bubbleMin)
        .filter(c => {
          const y = (v.centerPriceTicks + v.priceSpanTicks / 2 - c.price) / v.priceSpanTicks * heat.height;
          return x >= 0 && x < heat.width && y >= -14 && y <= heat.height + 14;
        });
      const actualBubbles = s.overlay.bubbles.filter((b: any) => Math.abs(b.x - x) < 0.01);
      assert.equal(actualBubbles.length, expectedBubbles.length);
      for (const b of actualBubbles) {
        const c = expectedBubbles.find(c => c.price === b.price)!;
        assert.ok(c); assert.equal(b.buy, c.buy); assert.equal(b.sell, c.sell);
      }
      const point = recent.lastPrices.find((p: any) => p.secondUs === sec);
      assert.equal(point?.price, last.get(sec).price);
      // The latest price point is clamped to the received head, not its future
      // half-second centre (the Phase 4 line convention).
      const lineX = (Math.min(sec + 500_000, recent.toUs) - v.startUs) / (v.durationSec * 1e6) * heat.width;
      const bin = s.overlay.priceBins.find((p: any) => Math.abs(p.x - lineX) < 0.01);
      assert.ok(bin); assert.equal(bin.last, last.get(sec).price);
      checked.push({ second: sec / 1e6, ...total, delta: bar.delta, bubbleCells: actualBubbles.length,
        pricePoints: 1, lastPrice: bin.last, unconfirmed: sec > s.debug.latestTimeUs,
        x, lineX, anchorX: heat.width * 0.8, insideBookArea: x > heat.width * 0.8 });
    }
    assert.ok(checked.length >= 3);
    results.push({ name: stage.name, cutoff: { recvUs: cutoff.recvUs, seq: cutoff.seq },
      rawTradeCount: rows.length, cellCount: cells.size, seconds: checked });
  }
  await fs.writeFile(path.join(out, "live-saved-comparison.json"), JSON.stringify(results, null, 2));
  console.log("LIVE_SAVED_MATCH", JSON.stringify(results.map(x => ({ name: x.name, rawTradeCount: x.rawTradeCount, seconds: x.seconds.length }))));
} else {
  const proxy = await staticProxy(path.resolve("artifacts/heatmap/dist/public"));
  let active: Awaited<ReturnType<typeof browser>> | null = null;
  async function wait(check: () => Promise<boolean>, label: string, limit = 180000) {
    const end = Date.now() + limit;
    while (Date.now() < end) { if (await check()) return; await delay(150); }
    throw Error(`timeout:${label}`);
  }
  async function closeBrowser() {
    if (!active) return;
    evidence.browsers.push(await active.close()); active = null;
    await delay(250);
    const s = await status();
    evidence.statuses.push({ at: new Date().toISOString(), memory: s.memory, connections: s.phase2b.connections });
    assert.equal(s.phase2b.connections.filter((p: any) => p.userAgent?.includes(`NQPerf/${process.pid}`)).length, 0);
    await dump();
  }
  async function open(query: string) {
    active = await browser(9222);
    const p = await active.page("http://127.0.0.1:19090/?" + query + "&debug=1");
    const errors: unknown[] = [];
    await p.cdp.call("Runtime.enable");
    p.cdp.on("Runtime.exceptionThrown", e => errors.push(e));
    const debug = () => p.cdp.evaluate("window.__heatmapDebug");
    await wait(async () => { const d = await debug(); return d?.traffic.initialComplete && !d.loadingRanges && d.cachedTrades > 0; }, "initial_range");
    return { ...p, debug, errors };
  }
  async function zoom(p: any, duration: number) {
    for (let i = 0; i < 15; i++) {
      const d = await p.debug();
      if (Math.abs(d.viewport.durationSec - duration) < 0.01) break;
      const deltaY = Math.max(-700, Math.min(700, Math.log(duration / d.viewport.durationSec) / .0015));
      const b = await p.cdp.evaluate(`(()=>{const r=document.getElementById("heatmap").getBoundingClientRect();
        return {x:r.x+r.width*.5,y:r.y+r.height*.5}})()`);
      await p.cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...b, deltaX: 0, deltaY });
      await delay(180);
    }
    await wait(async () => !(await p.debug()).loadingRanges, "zoom_range");
    await delay(1000);
  }
  async function capture(p: any, name: string) {
    let snapshot: any;
    await wait(async () => {
      snapshot = await p.cdp.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r({
        debug:window.__heatmapDebug,deltaBars:window.__heatmapDeltaBars,overlay:window.__heatmapTradeOverlay,
        recent:window.__heatmapRecentTrades,
        boxes:Object.fromEntries(["heatmap","delta"].map(id=>{const b=document.getElementById(id).getBoundingClientRect();
          return [id,{x:b.x,y:b.y,width:b.width,height:b.height}]}))
      }))))`);
      return snapshot.debug.overlay.aggregationRevision === snapshot.recent.revision
        && snapshot.debug.delta.aggregationRevision === snapshot.recent.revision;
    }, "paint_revision");
    assert.equal(snapshot.boxes.delta.x, snapshot.boxes.heatmap.x);
    assert.equal(snapshot.boxes.delta.width, snapshot.boxes.heatmap.width);
    const { data } = await p.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
    evidence.stages.push({ name, at: new Date().toISOString(), snapshot, errors: p.errors });
    assert.equal(p.errors.length, 0);
    await dump(); return snapshot;
  }
  try {
    evidence.initialStatus = await status(); await dump();
    const replay = await open("mode=replay&from=1793022000&speed=1");
    for (const [name, duration, seconds] of [["replay-1s", 200, 1], ["replay-15s", 1600, 15], ["replay-60s", 7200, 60]] as const) {
      await zoom(replay, duration);
      const s = await capture(replay, name);
      assert.equal(s.debug.delta.seconds, seconds);
      const selected = s.deltaBars.filter((b: any) => b.startUs + seconds * 1e6 < s.debug.replayHeadUs
        && b.x >= 0 && b.x + b.width < s.boxes.heatmap.width && b.delta !== 0).slice(-3);
      assert.equal(selected.length, 3);
      const results: any[] = [];
      for (const b of selected) {
        const rows = await savedRows(b.startUs, b.startUs + seconds * 1e6);
        const buy = rows.filter(t => t.side === "buy").reduce((n, t) => n + t.size, 0);
        const sell = rows.filter(t => t.side === "sell").reduce((n, t) => n + t.size, 0);
        assert.equal(b.buy, buy); assert.equal(b.sell, sell); assert.equal(b.delta, buy - sell);
        const heatX = (b.startUs - s.debug.viewport.startUs) / (s.debug.viewport.durationSec * 1e6) * s.boxes.heatmap.width;
        assert.ok(Math.abs(b.x - heatX) < 1e-9);
        results.push({ fromSec: b.startUs / 1e6, seconds, rawTrades: rows.length, buy, sell, delta: b.delta,
          deltaX: b.x, heatX, differenceCssPx: Math.abs(b.x - heatX) });
      }
      evidence.stages.at(-1).savedComparison = results; await dump();
    }
    await closeBrowser();
    const live = await open("");
    await zoom(live, 100);
    // Collect enough fresh seconds for a receive-cutoff comparison without waiting for backfill.
    await delay(12000);
    const a = await capture(live, "live-follow");
    assert.equal(a.debug.delta.seconds, 1);
    const b = a.boxes.heatmap;
    // A modest pan exits follow but keeps the latest seconds visible for verification.
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await live.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await live.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 20, y, button: "left", buttons: 1 });
    await live.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 20, y, button: "left", clickCount: 1 });
    await delay(6500);
    const browsed = await capture(live, "live-browse");
    assert.equal(browsed.debug.follow, false);
    assert.ok(browsed.recent.trades.some((t: any) => t.tsUs > a.recent.toUs), "live arrivals retained while browsing");
    await closeBrowser();
    console.log("PHASE8_BROWSER_CHECK_PASSED", JSON.stringify(evidence.stages.map((s: any) =>
      ({ name: s.name, seconds: s.snapshot.debug.delta.seconds, count: s.snapshot.debug.delta.visibleCount }))));
  } finally {
    await closeBrowser();
    evidence.proxy = await proxy.close();
    evidence.finished = new Date().toISOString(); await dump();
  }
}
