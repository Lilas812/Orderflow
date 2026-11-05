// One owned Chromium, two independent contexts. No upstream/production browser.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const out = path.resolve('data/research-range-bars/evidence');
await fs.mkdir(out, { recursive: true });
// Do not race the separately scheduled low-priority generator with a duplicate API generation.
await new Promise((resolve, reject) => {
  const directory = path.resolve('data/research-range-bars/cache');
  const timer = setTimeout(() => { watcher.close(); reject(Error('80-tick pre-generation not ready')); }, 900000);
  const check = async () => {
    const names = await fs.readdir(directory);
    if (names.some(n => n.startsWith('NQ-80-40-') && n.endsWith('.json'))) {
      clearTimeout(timer); watcher.close(); resolve();
    }
  };
  const watcher = watch(directory, () => { void check(); });
  void check();
});
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'range-browser-'));
const browser = spawn(process.argv.slice(2).find(x => !x.startsWith('--')) ?? '/repl/tools/bin/chromium', ['--headless', '--no-sandbox',
  '--disable-dev-shm-usage', '--remote-debugging-port=19488', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: 'ignore', detached: true });
const timeout = setTimeout(() => { try { process.kill(-browser.pid, 'SIGKILL'); } catch {} }, 240000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = once(this.ws, 'open');
    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(Error('Owned browser connection closed'));
      this.pending.clear();
    };
    this.ws.onmessage = event => {
      const m = JSON.parse(event.data), p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      if (m.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  }
}
const resume = process.argv.includes('--resume');
const imagesOnly = process.argv.includes('--images-only');
const previous = resume ? JSON.parse(await fs.readFile(path.join(out, 'browser-results.json'), 'utf8')) : null;
if (resume) await fs.copyFile(path.join(out, 'browser-results.json'), path.join(out, 'browser-results-first-pass.json'));
const checks = previous?.checks ?? [], performanceResults = previous?.performanceResults ?? [];
let root, a, b, initial, createdId;
const url = 'http://127.0.0.1:80/gc-n-research/range-bars';
const selector = id => `[data-testid="${id}"]`;
const hasMark = note => `[...document.querySelectorAll('[data-testid="range-mark-row"]')].some(e=>e.textContent.includes(${JSON.stringify(note)}))`;
async function wait(c, expression, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await c.evaluate(expression)) return; await sleep(200); }
  throw Error(`wait failed: ${expression}`);
}
const click = (c, id) => c.evaluate(`document.querySelector(${JSON.stringify(selector(id))}).click()`);
async function setInput(c, id, value) {
  return c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector(id))});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement: e.tagName==='SELECT'?HTMLSelectElement:HTMLInputElement;Object.getOwnPropertyDescriptor(p.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
}
async function textButton(c, text, within = 'document') {
  await c.evaluate(`(()=>{const e=[...${within}.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)});if(!e)throw Error('missing button');e.click();})()`);
}
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, captureBeyondViewport: false });
  await fs.writeFile(path.join(out, `${name}.jpg`), Buffer.from(r.data, 'base64'));
}
async function api(c, command) {
  return c.evaluate(`(async()=>{const u='/gc-n-research/range-api/marks';${command ? `const s=await(await fetch(u)).json();const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:s.revision,...${JSON.stringify(command)}})});if(!r.ok)throw Error(await r.text());return r.json();` : 'return(await fetch(u)).json();'}})()`);
}
try {
  let version;
  for (let i = 0; i < 100; i++) { try { version = await (await fetch('http://127.0.0.1:19488/json/version')).json(); break; } catch { await sleep(100); } }
  assert(version, 'Chromium failed to start'); root = new CDP(version.webSocketDebuggerUrl); await root.ready;
  async function page() {
    const { browserContextId } = await root.send('Target.createBrowserContext');
    const { targetId } = await root.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const c = new CDP(`ws://127.0.0.1:19488/devtools/page/${targetId}`); c.context = browserContextId;
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url });
    await wait(c, 'window.__rangeChart?.barCount>0');
    return c;
  }
  a = await page(); initial = await api(a);
  if (imagesOnly) {
    await a.send('Emulation.setDeviceMetricsOverride', { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });
    for (const symbol of ['NQ', 'GC']) {
      if (symbol === 'GC') {
        await setInput(a, 'range-symbol', 'GC');
        await wait(a, 'window.__rangeChart?.width===20 && document.querySelector(".range-summary")?.textContent.includes("GCZ26")');
      }
      await a.evaluate('document.querySelector(\'[data-testid="range-chart"]\').scrollIntoView({block:"center"})');
      await sleep(200); await shot(a, `${symbol.toLowerCase()}-mobile-chart`);
    }
    checks.push('static images only: scrolled mobile charts, no repeated user-journey test');
  } else {
  if (!resume) {
  await shot(a, 'nq-month-desktop');
  performanceResults.push({ symbol: 'NQ', mode: 'month', ...(await a.evaluate('window.__rangeChart.measureFrames(120)')) });
  await setInput(a, 'range-tz', 'JST'); await wait(a, 'document.querySelector(\'[data-testid="range-details"]\').textContent.includes("JST")');
  await setInput(a, 'range-tz', 'CT');
  assert.equal(await a.evaluate('document.querySelector(\'[data-testid="range-guides"]\').checked'), false);
  await click(a, 'range-guides'); await click(a, 'range-guides'); await click(a, 'range-volume'); await click(a, 'range-volume');
  await textButton(a, '次セッション'); await textButton(a, '前セッション'); await textButton(a, '全期間フィット');
  await textButton(a, '2点定規 OFF');
  const rect = await a.evaluate(`(()=>{const r=document.querySelector('[data-testid="range-chart"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  for (const [xx, yy] of [[.3, .4], [.6, .6]]) {
    const x = rect.x + rect.width * xx, y = rect.y + rect.height * yy;
    await a.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await a.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  await wait(a, 'document.querySelector(\'[data-testid="range-ruler"]\')?.textContent.includes("ticks")');
  await textButton(a, '2点定規 ON');
  checks.push('CT/JST, default-off raw guides, volume toggle, session navigation and 2 point ruler');
  }
  const note = `[検証・削除予定] range ${Date.now()}`;
  // Select an approved real bar; the supplied index may target a non-extreme after width change.
  await a.evaluate(`window.__rangeChart.select(${Number(process.env.RANGE_CHECK_INDEX ?? 0)})`);
  await click(a, 'range-add-top'); await setInput(a, 'range-mark-note', note); await click(a, 'range-mark-save');
  await wait(a, `document.querySelector('[data-testid="range-save-status"]').textContent.startsWith('保存済み')`);
  let state = await api(a); const mark = state.marks.find(m => m.note === note); assert(mark); createdId = mark.id;
  b = await page(); await wait(b, hasMark(note));
  await a.send('Page.bringToFront');
  checks.push('create/reload/independent browser context sees identical raw mark');
  const criteria = `[検証]基準 ${Date.now()}`;
  await setInput(a, 'range-criteria', criteria); await click(a, 'range-criteria-save');
  await wait(b, `document.querySelector('[data-testid="range-criteria"]').value===${JSON.stringify(criteria)}`);
  checks.push('criteria is shared by finite polling');
  // Freeze edit revision in A; B writes while the form is open, so A must show a conflict.
  const article = `([...document.querySelectorAll('[data-testid="range-mark-row"]')].find(e=>e.textContent.includes(${JSON.stringify(note)})))`;
  if (!resume) {
  await textButton(a, '編集', article);
  await api(b, { action: 'criteria', text: criteria + ' 別端末' });
  await textButton(a, '編集を保存');
  await wait(a, `document.body.textContent.includes('競合中は保存できません')`);
  checks.push('stale edit revision produces visible conflict without silent overwrite');
  await textButton(a, '保存を再読込'); await wait(a, '!document.querySelector(".range-alert")'); await textButton(a, '閉じる');
  }
  await textButton(a, '編集', article);
  await a.evaluate(`(()=>{const e=document.querySelector('.range-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(note + ' edited')});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await textButton(a, '編集を保存');
  await wait(b, hasMark(note + ' edited'));
  await textButton(a, '削除', article);
  await wait(a, `!(${hasMark(note + ' edited')})`);
  await click(a, 'range-undo'); await wait(a, hasMark(note + ' edited'));
  await b.send('Page.reload'); await wait(b, `window.__rangeChart?.barCount>0 && (${hasMark(note + ' edited')})`);
  checks.push('edit/delete/undo/server reload retain record, history, and stable raw key');
  const exported = await a.evaluate(`(async()=>({json:await(await fetch('/gc-n-research/range-api/export?format=json')).json(),csv:await(await fetch('/gc-n-research/range-api/export?format=csv')).text()}))()`);
  assert(exported.csv.includes(String(mark.ref.tsUs))); assert(exported.json.history.some(h => h.action === 'undo'));
  assert.deepEqual(exported.json.marks.find(m => m.id === createdId).ref, mark.ref);
  checks.push('CSV us precision and complete JSON history/identity');
  await setInput(a, 'range-width', '80'); await textButton(a, '幅を適用');
  await wait(a, 'window.__rangeChart?.width===80', 90000);
  assert.deepEqual((await a.evaluate('window.__rangeChart.markPositions')).find(m => m.id === createdId).ref, mark.ref);
  checks.push('width change preserves original trade identity and chart marker position');
  await a.evaluate('window.__rangeChart.zoom(.02)'); await sleep(250); await shot(a, 'nq-zoom-desktop');
  // Restore 40 tick default for comparable monthly mobile measurement.
  await setInput(a, 'range-width', '40'); await textButton(a, '幅を適用'); await wait(a, 'window.__rangeChart?.width===40', 60000);
  await a.send('Emulation.setDeviceMetricsOverride', { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });
  await a.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await a.evaluate('window.scrollTo(0,0)'); await sleep(250); await shot(a, 'nq-month-mobile');
  performanceResults.push({ symbol: 'NQ', mode: 'mobile-month', ...(await a.evaluate('window.__rangeChart.measureFrames(120)')) });
  await a.evaluate('document.querySelector(\'[data-testid="range-chart"]\').scrollIntoView({block:"center"})');
  const touch = await a.evaluate(`(()=>{const r=document.querySelector('[data-testid="range-chart"]').getBoundingClientRect();return{x:r.x+r.width*.5,y:r.y+r.height*.5}})()`);
  const before = await a.evaluate('window.__rangeChart.view');
  await a.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touch.x - 25, y: touch.y, id: 1 }, { x: touch.x + 25, y: touch.y, id: 2 }] });
  await a.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x - 70, y: touch.y, id: 1 }, { x: touch.x + 70, y: touch.y, id: 2 }] });
  await a.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(150);
  const after = await a.evaluate('window.__rangeChart.view');
  assert(after[1] - after[0] < before[1] - before[0], 'synthetic pinch should zoom');
  checks.push('real CDP synthetic two-finger touch input changes viewport; not physical Safari');
  await textButton(a, '全期間フィット'); await a.evaluate('window.scrollTo(0,0)');
  await setInput(a, 'range-symbol', 'GC'); await wait(a, 'window.__rangeChart?.width===20 && document.querySelector(".range-summary")?.textContent.includes("GCZ26")', 60000);
  await sleep(250); await shot(a, 'gc-month-mobile');
  performanceResults.push({ symbol: 'GC', mode: 'mobile-month', ...(await a.evaluate('window.__rangeChart.measureFrames(120)')) });
  await a.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await a.evaluate('window.scrollTo(0,0)'); await sleep(250); await shot(a, 'gc-month-desktop');
  performanceResults.push({ symbol: 'GC', mode: 'month', ...(await a.evaluate('window.__rangeChart.measureFrames(120)')) });
  checks.push('NQ/GC month and zoom desktop/mobile canvases and separate frame/drawing samples');
  }
} finally {
  if (a && initial) {
    try {
      const s = await api(a);
      if (createdId && s.marks.some(m => m.id === createdId)) await api(a, { action: 'delete', id: createdId });
      const current = await api(a);
      if (current.criteria.startsWith('[検証]基準 ')) await api(a, { action: 'criteria', text: initial.criteria });
    } catch (e) { checks.push(`cleanup error: ${e.message}`); }
  }
  for (const c of [a, b]) if (c) { c.ws.close(); try { await root.send('Target.disposeBrowserContext', { browserContextId: c.context }); } catch {} }
  if (root) { try { await root.send('Browser.close'); } catch {} root.ws.close(); }
  if (browser.exitCode === null) await Promise.race([once(browser, 'exit'), sleep(5000)]);
  if (browser.exitCode === null) { try { process.kill(-browser.pid, 'SIGTERM'); } catch {} await Promise.race([once(browser, 'exit'), sleep(3000)]); }
  clearTimeout(timeout);
  const remaining = execFileSync('ps', ['-eo', 'pid=,pgid=,args='], { encoding: 'utf8' }).split('\n')
    .filter(line => Number(line.trim().split(/\s+/)[1]) === browser.pid);
  let debugPortClosed = false; try { await fetch('http://127.0.0.1:19488/json/version'); } catch { debugPortClosed = true; }
  await fs.writeFile(path.join(out, imagesOnly ? 'chart-image-results.json' : 'browser-results.json'), JSON.stringify({ checks, performanceResults,
    browserPid: browser.pid, exitCode: browser.exitCode, remainingOwnedProcesses: remaining, debugPortClosed }, null, 2));
  assert.equal(remaining.length, 0, 'owned browser descendants remain'); assert(debugPortClosed);
  console.log(JSON.stringify({ checks, performanceResults, browserPid: browser.pid, exitCode: browser.exitCode, remainingOwnedProcesses: remaining.length, debugPortClosed }, null, 2));
}
