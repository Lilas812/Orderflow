import * as fs from "node:fs/promises";
import path from "node:path";
import { browser, delay } from "./cdp.ts";

const phase = process.argv[2] ?? "before";
const output = path.resolve("data/perf-memory", phase, "render-static");
const staticRoot = path.resolve(process.argv[3] ?? "artifacts/heatmap/dist/public");
await fs.mkdir(output, { recursive: true });
const script = await fs.readFile(new URL("./frozen-feed.js", import.meta.url), "utf8");
const chromium = await browser(9223);
const results: unknown[] = [];
try {
  // Page injection must run before the module creates its WebSocket.
  const page = await chromium.page("about:blank", staticRoot);
  await page.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: script + `
    addEventListener("DOMContentLoaded", () => {
      const badge = document.createElement("div");
      badge.textContent = "ダミー接続 · 実保存データの固定再生";
      badge.style.cssText = "position:fixed;top:0;right:8px;color:#e8e3c9;background:#20242b;font:10px monospace;z-index:9999;pointer-events:none";
      document.body.append(badge);
      console.info("ダミー接続 · 実保存データの固定再生");
    });
  ` });
  await page.cdp.call("Page.navigate", { url: "http://127.0.0.1/?mode=replay&from=1793022000&speed=1&debug=1" });
  for (let i = 0; i < 240; i++) {
    const state = await page.cdp.evaluate("({ready:window.__frozenFeedReady, debug:window.__heatmapDebug,error:window.__frozenFeedError})");
    if (state.error) throw Error(state.error);
    if (state.ready && state.debug?.loadingRanges === 0) break;
    if (i === 239) throw Error("fixture_load_timeout");
    await delay(250);
  }
  await delay(1500);
  const boxes = await page.cdp.evaluate(`Object.fromEntries(["heatmap","price-axis"].map(id=>{
    const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,height:r.height}]}))`);
  const heat = boxes.heatmap, axis = boxes["price-axis"];
  async function capture(name: string, perform: () => Promise<void>) {
    const start = await page.cdp.evaluate("performance.now()");
    const before = await page.cdp.evaluate("window.__heatmapDebug.viewport");
    await perform(); await delay(300);
    const frames = await page.cdp.evaluate(`window.__heatmapFrameStats.filter(f=>f.at>=${start})`);
    const debug = await page.cdp.evaluate("window.__heatmapDebug");
    const shot = await page.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
    results.push({ name, before, after: debug.viewport, p99: debug.p99,
      orders: debug.bigOrders.orders, frameCount: frames.length, frames });
    await fs.writeFile(path.join(output, "frames.json"), JSON.stringify(results));
  }
  async function drag(x: number, y: number, dx: number, dy: number, steps: number) {
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    for (let step = 1; step <= steps; step++) {
      await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx * step / steps,
        y: y + dy * step / steps, button: "left", buttons: 1 });
      await delay(35);
    }
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", clickCount: 1 });
  }
  // Optional comparison setup only: match a prior run's left edge despite a changed follow anchor.
  // This is an actual pan (browsing), not a production debug setter or a data modification.
  const matchStartUs = process.argv[4] === undefined ? null : Number(process.argv[4]);
  if (matchStartUs !== null) {
    if (!Number.isSafeInteger(matchStartUs)) throw Error("invalid_match_start_us");
    const v = await page.cdp.evaluate("window.__heatmapDebug.viewport");
    const dx = (v.startUs - matchStartUs) / (v.durationSec * 1e6) * heat.width;
    await drag(heat.x + heat.width * 0.3, heat.y + heat.height * 0.45, dx, 0, 20);
    for (let i = 0; i < 120; i++) {
      if ((await page.cdp.evaluate("window.__heatmapDebug.loadingRanges")) === 0) break;
      await delay(100);
    }
    await delay(500);
    const actual = await page.cdp.evaluate("window.__heatmapDebug.viewport");
    const differencePixels = (actual.startUs - matchStartUs) / (actual.durationSec * 1e6) * heat.width;
    await fs.writeFile(path.join(output, "viewport-match.json"), JSON.stringify({ matchStartUs, actual, differencePixels }));
    if (Math.abs(differencePixels) > 1) throw Error("comparison_viewport_mismatch");
  }
  await capture("steady", () => delay(2200));
  await capture("price-zoom", () => drag(axis.x + axis.width / 2, axis.y + axis.height * 0.60, 0, -160, 60));
  await capture("price-reset", () => drag(axis.x + axis.width / 2, axis.y + axis.height * 0.60, 0, 160, 60));
  await capture("pan", () => drag(heat.x + heat.width * 0.15, heat.y + heat.height * 0.45, heat.width * 0.55, 0, 60));
  await capture("time-zoom", async () => {
    for (let step = 0; step < 40; step++) {
      await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: heat.x + heat.width / 2,
        y: heat.y + heat.height / 2, deltaX: 0, deltaY: 30 });
      await delay(35);
    }
  });
  process.stdout.write(JSON.stringify({ event: "render_benchmark_complete", phase, output,
    counts: results.map((x: any) => ({ name: x.name, frames: x.frameCount })) }) + "\n");
} finally {
  const closed = await chromium.close();
  await fs.writeFile(path.join(output, "browser-closed.json"), JSON.stringify(closed, null, 2));
}
