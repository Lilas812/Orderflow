import * as fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { browser, delay } from "./cdp.ts";
import { staticProxy } from "./static-proxy.ts";

const out = path.resolve("data/phase5-revise");
await fs.mkdir(out, { recursive: true });
const evidence: any = { checks: [], browsers: [], statuses: [] };
const status = async () => (await fetch("http://127.0.0.1:8080/api/status")).json();
async function wait(check: () => Promise<boolean>, label: string, attempts = 240) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await delay(250); }
  throw Error(`timeout:${label}`);
}
await wait(async () => { try { return Boolean((await status()).memory?.pid); } catch { return false; } }, "api");
const first = await status(), pid = first.memory.pid;
evidence.pid = pid; evidence.preexistingConnections = first.phase2b.connections;
const proxy = await staticProxy(path.resolve("artifacts/heatmap/dist/public"));
let active: Awaited<ReturnType<typeof browser>> | null = null;
try {
  active = await browser(9222);
  const page = await active.page("http://127.0.0.1:19090/?mode=replay&from=1793022000&speed=1&debug=1");
  const debug = () => page.cdp.evaluate("window.__heatmapDebug");
  await wait(async () => {
    const d = await debug(); return d?.traffic.initialComplete && d.loadingRanges === 0 && d.currentBook.paintedRows > 0;
  }, "replay_loaded");
  const box = await page.cdp.evaluate(`Object.fromEntries(["heatmap","price-axis","current-book","trade-overlay"].map(id=>{
    const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,height:r.height}]}))`);
  const h = box.heatmap, axis = box["price-axis"];
  async function anchor() {
    const d = await debug();
    assert.equal(d.follow, true);
    const ratio = (d.latestTimeUs + 1e6 - d.viewport.startUs) / (d.viewport.durationSec * 1e6);
    assert.ok(Math.abs(ratio - 0.8) < 2 / h.width, `follow_ratio:${ratio}`);
    evidence.checks.push({ name: "follow-anchor", ratio, duration: d.viewport.durationSec });
  }
  async function mouse(type: string, x: number, y: number, clickCount = 1) {
    await page.cdp.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseMoved" ? 1 : 0, clickCount });
  }
  async function reset() {
    await mouse("mousePressed", h.x + h.width * 0.95, h.y + h.height * 0.6, 2);
    await mouse("mouseReleased", h.x + h.width * 0.95, h.y + h.height * 0.6, 2);
    await delay(500); await anchor();
    assert.equal((await debug()).viewport.durationSec, 600);
  }
  async function drag(x: number, y: number, dx: number, dy: number, steps = 20) {
    await mouse("mousePressed", x, y);
    for (let i = 1; i <= steps; i++) {
      await mouse("mouseMoved", x + dx * i / steps, y + dy * i / steps); await delay(35);
    }
    await mouse("mouseReleased", x + dx, y + dy);
  }
  async function capture(name: string) {
    await wait(async () => (await debug()).loadingRanges === 0, name);
    await delay(500);
    const d = await debug();
    const screenshot = await page.cdp.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(screenshot.data, "base64"));
    const s = await status();
    evidence.statuses.push({ name, at: new Date().toISOString(), memory: s.memory, connections: s.phase2b.connections });
    evidence.checks.push({ name, debug: d });
  }
  await anchor();
  const hit = await page.cdp.evaluate(`document.elementFromPoint(${h.x + h.width * 0.95},${h.y + h.height * 0.6})?.id`);
  assert.equal(hit, "heatmap");
  evidence.checks.push({ name: "overlay-hit-test", target: hit, boxes: box });
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: h.x + h.width * 0.95,
    y: h.y + h.height / 2, deltaX: 0, deltaY: -80 });
  await delay(500); await anchor(); await reset();
  // Symmetric two-touch zoom over the bars: preserve follow, then double-tap reset.
  await page.cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const touchY = h.y + h.height * 0.65, touchX = h.x + h.width * 0.9;
  const points = (spread: number) => [{ x: touchX - spread, y: touchY, id: 1 }, { x: touchX + spread, y: touchY, id: 2 }];
  await page.cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(15) });
  await page.cdp.call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(30) });
  await page.cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(500); await anchor();
  const pinched = await debug(); assert.ok(pinched.viewport.durationSec < 600);
  const tap = async () => {
    await page.cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY, id: 3 }] });
    await page.cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await tap(); await delay(100); await tap(); await delay(500);
  await anchor(); assert.equal((await debug()).viewport.durationSec, 600);
  evidence.checks.push({ name: "pinch-and-double-tap", pinchedDuration: pinched.viewport.durationSec });
  await page.cdp.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await capture("replay-follow");
  const beforePan = await debug();
  await drag(h.x + h.width * 0.9, h.y + h.height * 0.6, h.width * 0.3, 0);
  await capture("replay-browse");
  const afterPan = await debug();
  assert.equal(afterPan.follow, false);
  assert.ok(afterPan.viewport.startUs < beforePan.viewport.startUs);
  assert.equal(afterPan.bigOrders.rebuildCount, beforePan.bigOrders.rebuildCount);
  const colors = await page.cdp.evaluate(`(()=>{
    const c=document.getElementById("current-book"),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;
    let minX=c.width,gray=0,purple=0,maxAlpha=0;
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4,a=p[i+3];
      if(a){minX=Math.min(minX,x);maxAlpha=Math.max(maxAlpha,a);
        if(a>=176&&p[i]>=214&&p[i+1]>=214&&p[i+2]>=214)gray++;
        if(a>=176&&p[i]>=135&&p[i]<=142&&p[i+1]>=57&&p[i+1]<=65&&p[i+2]>=250)purple++;}}
    return{width:c.width,minX,gray,purple,maxAlpha};})()`);
  assert.ok(colors.minX >= Math.floor(colors.width * 0.8) - 1);
  assert.ok(colors.gray > 0 && colors.purple > 0);
  assert.ok(Math.abs(colors.maxAlpha - 0.7 * 255) <= 1);
  evidence.checks.push({ name: "actual-canvas-colors-alpha-width", ...colors });
  await drag(axis.x + axis.width / 2, axis.y + axis.height * 0.6, 0, -160, 60);
  await capture("replay-zoom-in");
  await drag(axis.x + axis.width / 2, axis.y + axis.height * 0.6, 0, 160, 60);
  await capture("replay-zoom-out");
  // Observe genuinely book-only updates (no depth/overlay increment).
  let previous = await debug(), bookOnly = 0;
  for (let i = 0; i < 50; i++) {
    await delay(80); const d = await debug();
    if (d.currentBook.drawCount > previous.currentBook.drawCount && d.depthDrawCount === previous.depthDrawCount
      && d.overlayDrawCount === previous.overlayDrawCount) bookOnly++;
    previous = d;
  }
  evidence.checks.push({ name: "book-only-updates", count: bookOnly });
  evidence.browsers.push({ mode: "replay", ...await active.close() }); active = null;
  active = await browser(9222);
  const live = await active.page("http://127.0.0.1:19090/?debug=1");
  await wait(async () => {
    const d = await live.cdp.evaluate("window.__heatmapDebug");
    return d?.loadingRanges === 0 && d.traffic.initialComplete && d.currentBook.paintedRows > 0;
  }, "live_loaded");
  await delay(4000);
  const liveDebug = await live.cdp.evaluate("window.__heatmapDebug");
  const shot = await live.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, "live-follow.png"), Buffer.from(shot.data, "base64"));
  evidence.checks.push({ name: "live", debug: liveDebug });
  evidence.browsers.push({ mode: "live", ...await active.close() }); active = null;
  await delay(500);
  const s = await status(); evidence.statuses.push({ name: "after-browser-close", status: s });
  const own = s.phase2b.connections.filter((c: any) => c.userAgent?.endsWith(`NQPerf/${process.pid}`));
  assert.equal(own.length, 0);
  evidence.ownConnectionsRemaining = 0;
  evidence.success = true;
} catch (error) {
  evidence.failure = String(error); console.error(error); process.exitCode = 1;
} finally {
  if (active) evidence.browsers.push({ mode: "error-cleanup", ...await active.close() });
  evidence.proxy = await proxy.close();
  await fs.writeFile(path.join(out, "browser-checks.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: "phase5_visual_checkpoint", success: evidence.success, pid, directory: out }));
  for (let i = 0; i < 240; i++) {
    if (await fs.stat(path.join(out, "finish-visual-check")).then(() => true, () => false)) break;
    await delay(500);
  }
  evidence.finalStatus = await status();
  const termAt = Date.now(); process.kill(pid, "SIGTERM");
  evidence.sigtermAt = new Date(termAt).toISOString();
  for (let i = 0; i < 600; i++) {
    try { process.kill(pid, 0); } catch { evidence.serverExited = true; break; }
    await delay(100);
  }
  await fs.writeFile(path.join(out, "browser-checks.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: "phase5_complete", success: evidence.success, serverExited: evidence.serverExited }));
}
