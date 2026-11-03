import "./footprint.css";
import "../components/settings-ui.css";
import { fetchSettings } from "../data/settings.ts";
import { formatCrosshairTimeUs, type DisplayZone } from "../chart/timezone.ts";
import { ACTIVE_SYMBOL, formatInstrumentPrice } from "../instrument.ts";
import { viewSwitchHtml } from "../long-vp/nav.ts";
import { loadView, saveView } from "../view-memory.ts";
import { FootprintClient } from "./client.ts";
import { mountReplayControls } from "../replay/controls.ts";
import { mountLabelsUi } from "../labels/ui.ts";
import { loadSharedReplay, replayStart } from "../replay/shared.ts";
import { FootprintStore, TIMEFRAMES, contractKey, MAX_TRADES, RETAIN_SEC, type FootprintBar, type SecondState, type Timeframe, type DisplayTimeframe } from "./model.ts";
import { groupPriceRows, type GroupedRows } from "./rows.ts";
import {
  AXIS_W, BAR_GAP, BAR_W_DEFAULT, OHLC_LANE, ROW_H_DEFAULT, STATS_H, STATUS_H, TIME_H,
  barLeft, cellWidth, clampView, compactQty, followEnd, parseTimeframe, priceToY, visibleSpan,
  xToSec, yToPrice, zoomPriceAt, zoomTimeAt, adaptTime, priceGroupTicks, type FpView,
} from "./view.ts";

const C = {
  bg: "#07070a", grid: "#121218", sep: "#24232e", text: "#8e8c9c", textHi: "#d9d9de",
  cell: "#25252b", cellText: "#bfbfc6", buy: "#17694a", buyText: "#e5fff2", sell: "#5b2f9c", sellText: "#f3eaff",
  up: "#3ddc84", down: "#a64dff", flat: "#8e8c9c", poc: "#efe6c6",
  recorded: "#3a3946", empty: "#2b2a33", live: "#6c6a7c", loading: "#5d7fd0", gap: "#ff9a3c", overflow: "#ff6f67", unloaded: "#4a4958",
  cursor: "#9b98aa", label: "#2f2d3b",
};
const STATE_TEXT: Record<SecondState, string> = {
  recorded: "読込済み", empty: "無約定を確認", live: "ライブ受信", loading: "取得中", gap: "既知の未取得あり",
  overflow: "容量上限で破棄", unloaded: "未取得", future: "未来",
};
const SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const TF_KEY = "footprint.timeframe";
const DATA_DRAW_MS = 1_000;

type Layout = { W: number; H: number; plotW: number; plotH: number; statusTop: number; statsTop: number; timeTop: number };

export function mountFootprint(root: HTMLElement): () => void {
  document.title = `${ACTIVE_SYMBOL} | Footprint`;
  root.innerHTML = `
  <div class="app-shell">
    <aside class="tool-rail su-rail fp-rail" aria-label="Tools">
      <button class="su-tool fp-tool" type="button" id="fp-reset" title="表示リセット" aria-label="表示リセット" data-testid="button-footprint-reset"><svg ${SVG}><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><circle cx="12" cy="12" r="1.6"/></svg></button>
      <button class="su-tool fp-tool" type="button" id="fp-follow" title="最新を追従" aria-label="最新を追従" aria-pressed="true" data-testid="button-footprint-follow"><svg ${SVG}><path d="M5 12h12"/><path d="M13 7l5 5-5 5"/><path d="M20 5v14"/></svg></button>
      <button class="su-tool fp-tool" type="button" id="fp-retry" title="履歴を再取得" aria-label="履歴を再取得" data-testid="button-footprint-retry"><svg ${SVG}><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg></button>
    </aside>
    <main class="workspace">
      <header class="masthead">
        <div class="instrument"><strong>${ACTIVE_SYMBOL} / FOOTPRINT</strong><span>SELL | BUY PER TICK</span></div>
        <div class="fp-controls">
          <div class="fp-tf" role="group" aria-label="足の長さ">
            ${TIMEFRAMES.map(tf => `<button type="button" data-tf="${tf}" data-testid="button-timeframe-${tf}">${tf < 60 ? `${tf}s` : "1m"}</button>`).join("")}
          </div>
          <label class="fp-contract">限月 <select id="fp-contract" data-testid="select-contract"><option value="auto">最新</option></select></label>
          <span id="fp-effective" class="fp-effective" data-testid="text-footprint-effective"></span>
        </div>
        ${viewSwitchHtml("footprint")}
        <div class="market-state" id="fp-state" data-state="connecting" data-testid="status-footprint"><i class="state-dot" aria-hidden="true"></i><span id="fp-state-label">CONNECTING</span></div>
      </header>
      <section class="fp-board" aria-label="Footprint">
        <canvas class="fp-canvas" id="fp-canvas" aria-label="Footprint: sell and buy volume per price tick and bar"></canvas>
        <canvas class="fp-cursor" id="fp-cursor" aria-hidden="true"></canvas>
        <div class="fp-legend" data-testid="legend-footprint">
          <span><i class="sw sw-sell"></i>左 売り主導 &gt; 買い</span>
          <span><i class="sw sw-buy"></i>右 買い主導 &gt; 売り</span>
          <span><i class="sw sw-cell"></i>同数・基本</span>
          <span><i class="sw sw-poc"></i>POC</span>
          <span><i class="sw sw-gap"></i>未取得・不完全</span>
          <span><i class="sw sw-load"></i>取得中</span>
        </div>
        <div class="fp-info" id="fp-info" data-testid="text-footprint-cursor" hidden></div>
        <div class="fp-skeleton" id="fp-skeleton" aria-hidden="true"></div>
        <div class="fp-center" id="fp-center" role="status" hidden></div>
        <div class="fp-status" id="fp-status" aria-live="polite"></div>
      </section>
    </main>
  </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const canvas = $<HTMLCanvasElement>("#fp-canvas"), ctx = canvas.getContext("2d")!;
  const cursorCanvas = $<HTMLCanvasElement>("#fp-cursor"), cctx = cursorCanvas.getContext("2d")!;
  const statusEl = $("#fp-status"), centerEl = $("#fp-center"), skeleton = $("#fp-skeleton"), infoEl = $("#fp-info");
  const stateEl = $("#fp-state"), stateLabel = $("#fp-state-label"), contractSel = $<HTMLSelectElement>("#fp-contract");
  const followBtn = $<HTMLButtonElement>("#fp-follow");

  let selectedTf: Timeframe = 5;
  try { selectedTf = parseTimeframe(window.sessionStorage.getItem(TF_KEY) ?? 5); } catch { /* default 5 s */ }
  let tf: DisplayTimeframe = selectedTf, rowTicks = 1;
  const rowCache = new WeakMap<FootprintBar, { ticks: number; value: GroupedRows }>();
  function rowsOf(b: FootprintBar): GroupedRows {
    const old = rowCache.get(b);
    if (old?.ticks === rowTicks) return old.value;
    const value = groupPriceRows(b, rowTicks);
    rowCache.set(b, { ticks: rowTicks, value }); return value;
  }
  const store = new FootprintStore();
  store.setTimeframe(tf);
  let zone: DisplayZone = "jst", zoneWarning = "";
  let contractChoice = "auto";
  const stored = loadView<FpView>("footprint", ACTIVE_SYMBOL);
  let view: FpView = stored && Number.isFinite(stored.endSec) ? { ...stored }
    : { endSec: Date.now() / 1000, barW: BAR_W_DEFAULT, rowH: ROW_H_DEFAULT, centerPrice: 0, follow: true };
  let centered = !!stored && stored.centerPrice !== 0;
  let destroyed = false, frame = 0, cursorFrame = 0;
  let dataDirty = false, lastDraw = 0;
  let W = 1, H = 1, dpr = 1;
  const timings: number[] = [];
  let paintedGroups: ReturnType<FootprintStore["bars"]> = [];
  let drawCount = 0, lastDetail = true;
  let cursorPt: { x: number; y: number } | null = null;

  let replayUi: ReturnType<typeof mountReplayControls> | undefined;
  let labelsUi: ReturnType<typeof mountLabelsUi> | undefined;
  const initialReplay = loadSharedReplay(ACTIVE_SYMBOL);
  const client = new FootprintClient(ACTIVE_SYMBOL, store, {
    onData: () => { dataDirty = true; },
    onState: () => { updateChrome(); },
    onReplayHello: hello => {
      replayUi?.hello(hello);
      if (hello.mode === "replay" && view.follow) setView({ ...view, endSec: followEnd(client.nowSec(), selectedTf) });
    },
    onReplayState: state => { replayUi?.state(state); updateChrome(); request(); },
    onReplayError: code => replayUi?.error(code),
  }, window.location, undefined, initialReplay);
  if (initialReplay) {
    view = { ...view, follow: true, endSec: followEnd(client.nowSec(), selectedTf) };
    centered = false;
  }

  const layout = (): Layout => {
    const plotW = Math.max(1, W - AXIS_W), plotH = Math.max(1, H - TIME_H - STATS_H - STATUS_H);
    return { W, H, plotW, plotH, statusTop: plotH, statsTop: plotH + STATUS_H, timeTop: plotH + STATUS_H + STATS_H };
  };
  const hasDataClock = () => client.clockKnown || client.isReplay;
  const nowSec = () => hasDataClock() ? client.nowSec() : Math.floor(Date.now() / 1000);
  const activeContract = () => {
    if (contractChoice !== "auto") return contractChoice;
    const l = store.latest;
    return l ? contractKey(l) : store.contracts()[0] ?? "UNKNOWN";
  };
  function setView(next: FpView, persist = true) {
    const adaptive = adaptTime(next, selectedTf);
    tf = adaptive.displayTf!; store.setTimeframe(tf);
    view = clampView(adaptive, tf, hasDataClock() ? client.nowSec() : null, layout().plotH);
    if (persist) saveView("footprint", ACTIVE_SYMBOL, view);
    followBtn.setAttribute("aria-pressed", String(view.follow));
    request();
  }
  function request() { if (!frame && !destroyed) frame = requestAnimationFrame(draw); }
  function requestCursor() { if (!cursorFrame && !destroyed) cursorFrame = requestAnimationFrame(drawCursor); }

  /* ---------- main draw ---------- */
  function draw() {
    frame = 0;
    if (document.hidden) return; // resumed by visibilitychange
    const t0 = performance.now();
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, rect.width); H = Math.max(1, rect.height);
    for (const c of [canvas, cursorCanvas]) {
      const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
      if (c.width !== pw) c.width = pw;
      if (c.height !== ph) c.height = ph;
    }
    const L = layout(), now = nowSec();
    view = clampView(view, tf, hasDataClock() ? now : null, L.plotH);
    rowTicks = priceGroupTicks(view.rowH);
    if (view.follow) view = clampView({ ...view, endSec: followEnd(now, tf) }, tf, hasDataClock() ? now : null, L.plotH);
    const [from, to] = visibleSpan(view, tf, L.plotW);
    client.setVisible(Math.max(0, Math.floor(from)), Math.ceil(to));
    const contract = activeContract();
    const groups = store.bars(from, to);
    paintedGroups = groups;
    const latest = store.latest;
    if (latest && contractKey(latest) === contract) {
      const y = priceToY(latest.price, view, L.plotH);
      if (!centered || (view.follow && (y < L.plotH * .12 || y > L.plotH * .88))) {
        view = { ...view, centerPrice: latest.price }; centered = true;
      }
    } else if (!centered) {
      const ext = store.priceExtent(from, to, contract);
      if (ext) { view = { ...view, centerPrice: Math.round((ext[0] + ext[1]) / 2) }; centered = true; }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    lastDetail = true;
    const fontPx = Math.max(9, Math.min(12, Math.floor(view.rowH * rowTicks * .72)));
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, L.plotW, L.plotH); ctx.clip();
    drawStateBands(L, groups.map(g => g.startSec), now);
    drawRowGrid(L);
    let maxVol = 1;
    for (const { group } of groups) { const b = group.get(contract); if (b) maxVol = Math.max(maxVol, b.volume); }
    for (const { startSec, group } of groups) {
      const b = group.get(contract);
      if (!b) continue;
      const x0 = barLeft(startSec, view, tf, L.plotW);
      if (x0 + view.barW < 0 || x0 > L.plotW) continue;
      drawDetailBar(b, x0, L, fontPx);
    }
    ctx.restore();
    drawStatusStrip(L, groups.map(g => g.startSec), now);
    drawStats(L, groups.map(g => ({ startSec: g.startSec, bar: g.group.get(contract) ?? null })), maxVol, now);
    drawPriceAxis(L, latest && contractKey(latest) === contract ? latest.price : null);
    drawTimeAxis(L);
    dataDirty = false; lastDraw = performance.now(); drawCount++;
    timings.push(lastDraw - t0); if (timings.length > 120) timings.shift();
    updateChrome();
    requestCursor();
    labelsUi?.render();
  }

  function drawStateBands(L: Layout, starts: number[], now: number) {
    for (const s of starts) {
      const st = store.stateOf(s, s + tf, now);
      if (st === "recorded" || st === "empty" || st === "live" || st === "future") continue;
      const x0 = barLeft(s, view, tf, L.plotW);
      const color = st === "loading" ? C.loading : st === "overflow" ? C.overflow : st === "gap" ? C.gap : C.unloaded;
      ctx.globalAlpha = st === "loading" ? .07 : .05; ctx.fillStyle = color; ctx.fillRect(x0, 0, view.barW, L.plotH);
      if (st !== "loading") {
        ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, view.barW, L.plotH); ctx.clip();
        ctx.globalAlpha = .16; ctx.strokeStyle = color; ctx.lineWidth = 1;
        for (let x = x0 - L.plotH; x < x0 + view.barW; x += 9) { ctx.beginPath(); ctx.moveTo(x, L.plotH); ctx.lineTo(x + L.plotH, 0); ctx.stroke(); }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }
  function drawRowGrid(L: Layout) {
    ctx.fillStyle = C.grid;
    const top = yToPrice(0, view, L.plotH), bottom = yToPrice(L.plotH, view, L.plotH);
    for (let p = Math.floor(bottom / rowTicks) * rowTicks; p <= top + rowTicks; p += rowTicks) {
      const y = Math.round(priceToY(p - .5, view, L.plotH));
      ctx.fillRect(0, y, L.plotW, 1);
    }
  }
  function ohlcColor(b: FootprintBar) { return b.close > b.open ? C.up : b.close < b.open ? C.down : C.flat; }
  function drawDetailBar(b: FootprintBar, x0: number, L: Layout, fontPx: number) {
    const cw = cellWidth(view.barW), rh = view.rowH * rowTicks, grouped = rowsOf(b);
    const sx = x0 + OHLC_LANE, bx = sx + cw;
    const pad = rh >= 14 ? 1 : 0;
    ctx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "middle";
    for (const { price: p, sell, buy } of grouped.rows) {
      const yc = priceToY(p + (rowTicks - 1) / 2, view, L.plotH), y = yc - rh / 2;
      if (y > L.plotH || y + rh < 0) continue;
      ctx.fillStyle = sell > buy ? C.sell : C.cell; ctx.fillRect(sx, y + pad, cw - 1, rh - pad * 2);
      ctx.fillStyle = buy > sell ? C.buy : C.cell; ctx.fillRect(bx, y + pad, cw - 1, rh - pad * 2);
      ctx.textAlign = "right"; ctx.fillStyle = sell > buy ? C.sellText : C.cellText;
      ctx.fillText(fitQty(sell, cw - 6), bx - 4, yc + .5);
      ctx.textAlign = "left"; ctx.fillStyle = buy > sell ? C.buyText : C.cellText;
      ctx.fillText(fitQty(buy, cw - 6), bx + 3, yc + .5);
    }
    // POC outline around both cells of the row
    const py = priceToY(grouped.poc + (rowTicks - 1) / 2, view, L.plotH) - rh / 2;
    ctx.strokeStyle = C.poc; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(sx) + .5, Math.round(py) + .5, Math.round(cw * 2 - 2), Math.round(rh) - 1);
    // narrow OHLC in the left lane
    const cx = Math.round(x0 + 2) + .5, col = ohlcColor(b);
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(cx, priceToY(b.high, view, L.plotH) - view.rowH / 2); ctx.lineTo(cx, priceToY(b.low, view, L.plotH) + view.rowH / 2); ctx.stroke();
    const yo = priceToY(b.open, view, L.plotH), yc = priceToY(b.close, view, L.plotH);
    ctx.fillRect(cx - 1.5, Math.min(yo, yc) - 1, 3, Math.max(2, Math.abs(yo - yc) + 2));
  }
  function fitQty(n: number, width: number) {
    const s = String(n);
    if (s.length * 6.2 <= width) return s;
    const c = compactQty(n);
    return c.length * 6.2 <= width ? c : "+";
  }
  function drawStatusStrip(L: Layout, starts: number[], now: number) {
    for (const s of starts) {
      const x0 = barLeft(s, view, tf, L.plotW);
      if (x0 + view.barW < 0 || x0 > L.plotW) continue;
      const st = store.stateOf(s, s + tf, now);
      if (st === "future") continue;
      ctx.fillStyle = C[st === "unloaded" ? "unloaded" : st];
      ctx.fillRect(x0 + 1, L.statusTop + 1, Math.max(1, view.barW - BAR_GAP), STATUS_H - 2);
      if (s + tf > now) { // forming
        ctx.fillStyle = C.textHi; ctx.fillRect(x0 + 1, L.statusTop + 1, 3, STATUS_H - 2);
      }
    }
  }
  function drawStats(L: Layout, bars: { startSec: number; bar: FootprintBar | null }[], maxVol: number, now: number) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, L.statsTop, W, STATS_H);
    ctx.strokeStyle = C.sep; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, L.statsTop + .5); ctx.lineTo(W, L.statsTop + .5); ctx.moveTo(0, L.timeTop + .5); ctx.lineTo(W, L.timeTop + .5);
    ctx.moveTo(L.plotW + .5, 0); ctx.lineTo(L.plotW + .5, L.timeTop); ctx.stroke();
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textBaseline = "middle";
    ctx.fillStyle = C.text; ctx.textAlign = "left";
    ctx.fillText("VOL", L.plotW + 6, L.statsTop + 10); ctx.fillText("DELTA", L.plotW + 6, L.statsTop + 25);
    const numbers = view.barW >= 34;
    ctx.save(); ctx.beginPath(); ctx.rect(0, L.statsTop, L.plotW, STATS_H); ctx.clip();
    for (const { startSec, bar } of bars) {
      const x0 = barLeft(startSec, view, tf, L.plotW), w = Math.max(1, view.barW - BAR_GAP);
      if (x0 + w < 0 || x0 > L.plotW) continue;
      if (!bar) {
        if (startSec <= now && numbers && store.stateOf(startSec, startSec + tf, now) === "recorded") {
          ctx.fillStyle = C.unloaded; ctx.textAlign = "center"; ctx.fillText("0", x0 + w / 2, L.statsTop + 10);
        }
        continue;
      }
      if (numbers) {
        ctx.textAlign = "center";
        ctx.fillStyle = C.textHi; ctx.fillText(compactQty(bar.volume), x0 + w / 2, L.statsTop + 10);
        ctx.fillStyle = bar.delta > 0 ? C.up : bar.delta < 0 ? C.down : C.flat;
        ctx.fillText((bar.delta > 0 ? "+" : "") + compactQty(bar.delta), x0 + w / 2, L.statsTop + 25);
      } else {
        const h = Math.max(1, (bar.volume / maxVol) * 13);
        ctx.fillStyle = "#4b4a58"; ctx.fillRect(x0, L.statsTop + 16 - h, w, h);
        const dh = Math.max(1, Math.min(13, Math.abs(bar.delta) / maxVol * 26));
        ctx.fillStyle = bar.delta >= 0 ? C.up : C.down; ctx.fillRect(x0, L.statsTop + 19, w, dh);
      }
    }
    ctx.restore();
  }
  function priceStep(rowH: number) {
    const steps = [1, 2, 4, 5, 10, 20, 40, 50, 100, 200, 400, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000];
    return steps.find(s => s * rowH >= 18) ?? 1000;
  }
  function drawPriceAxis(L: Layout, last: number | null) {
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const step = priceStep(view.rowH), top = yToPrice(0, view, L.plotH), bottom = yToPrice(L.plotH, view, L.plotH);
    ctx.fillStyle = C.text;
    for (let p = Math.ceil(bottom / step) * step; p <= top; p += step) {
      const y = priceToY(p, view, L.plotH);
      if (y < 6 || y > L.plotH - 6) continue;
      ctx.fillText(formatInstrumentPrice(p), L.plotW + 6, y);
    }
    if (last !== null) {
      const y = priceToY(last, view, L.plotH);
      if (y >= 0 && y <= L.plotH) {
        ctx.fillStyle = "#e9e3ff"; ctx.fillRect(L.plotW + 1, y - 7, AXIS_W - 2, 14);
        ctx.fillStyle = C.bg; ctx.fillText(formatInstrumentPrice(last), L.plotW + 6, y);
      }
    }
  }
  function drawTimeAxis(L: Layout) {
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    const every = Math.max(1, Math.ceil(84 / view.barW));
    const stepSec = [1, 2, 3, 4, 6, 12, 24, 60, 120].map(k => k * tf).find(s => s >= every * tf) ?? every * tf;
    const [from, to] = visibleSpan(view, tf, L.plotW);
    ctx.fillStyle = C.text;
    for (let s = Math.ceil(from / stepSec) * stepSec; s <= to; s += stepSec) {
      const x = barLeft(s, view, tf, L.plotW);
      if (x < 34 || x > L.plotW - 34) continue;
      ctx.fillRect(Math.round(x), L.timeTop, 1, 3);
      ctx.fillText(formatCrosshairTimeUs(s * 1e6, zone).slice(6), x, L.timeTop + TIME_H / 2 + 1);
    }
    ctx.textAlign = "right"; ctx.fillStyle = "#555366";
    ctx.fillText(zone === "jst" ? "JST" : "CT", W - 6, L.timeTop + TIME_H / 2 + 1);
  }

  /* ---------- cursor ---------- */
  function cursorInfo() {
    if (!cursorPt) return null;
    const L = layout();
    if (cursorPt.x < 0 || cursorPt.x >= L.plotW || cursorPt.y < 0 || cursorPt.y >= L.plotH) return null;
    const sec = xToSec(cursorPt.x, view, tf, L.plotW), startSec = Math.floor(sec / tf) * tf;
    const price = Math.floor(yToPrice(cursorPt.y, view, L.plotH) / rowTicks) * rowTicks;
    const bar = paintedGroups.find(g => g.startSec === startSec)?.group.get(activeContract()) ?? null;
    const row = bar ? rowsOf(bar).rows.find(r => r.price === price) : null;
    return { x: cursorPt.x, y: cursorPt.y, price, priceEnd: price + rowTicks - 1, startSec, timeUs: Math.floor(sec * 1e6), bar,
      sell: row?.sell ?? 0, buy: row?.buy ?? 0, undirected: row?.undirected ?? 0, state: store.stateOf(startSec, startSec + tf, nowSec()) };
  }
  function drawCursor() {
    cursorFrame = 0;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, W, H);
    const info = cursorInfo();
    if (!info) { infoEl.hidden = true; return; }
    const L = layout();
    const y = Math.round(priceToY(info.price + (rowTicks - 1) / 2, view, L.plotH)) + .5, x = Math.round(info.x) + .5;
    cctx.strokeStyle = C.cursor; cctx.lineWidth = 1; cctx.setLineDash([3, 3]);
    cctx.beginPath(); cctx.moveTo(0, y); cctx.lineTo(L.plotW, y); cctx.moveTo(x, 0); cctx.lineTo(x, L.timeTop); cctx.stroke();
    cctx.setLineDash([]);
    cctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"; cctx.textBaseline = "middle";
    cctx.fillStyle = C.label; cctx.fillRect(L.plotW + 1, y - (rowTicks > 1 ? 12 : 8), AXIS_W - 2, rowTicks > 1 ? 24 : 16);
    cctx.fillStyle = C.textHi; cctx.textAlign = "left"; cctx.fillText(formatInstrumentPrice(info.price), L.plotW + 6, y - (rowTicks > 1 ? 5 : 0));
    if (rowTicks > 1) cctx.fillText(formatInstrumentPrice(info.priceEnd), L.plotW + 6, y + 6);
    const tl = formatCrosshairTimeUs(info.timeUs, zone), tw = cctx.measureText(tl).width + 12;
    const tx = Math.min(L.plotW - tw / 2, Math.max(tw / 2, x));
    cctx.fillStyle = C.label; cctx.fillRect(tx - tw / 2, L.timeTop + 2, tw, TIME_H - 4);
    cctx.fillStyle = C.textHi; cctx.textAlign = "center"; cctx.fillText(tl, tx, L.timeTop + TIME_H / 2 + 1);
    const b = info.bar;
    infoEl.hidden = false;
    infoEl.textContent = `${formatCrosshairTimeUs(info.startSec * 1e6, zone)} ${tf < 60 ? tf + "s" : tf / 60 + "m"} ${activeContract()}  `
      + `${formatInstrumentPrice(info.price)}${rowTicks > 1 ? "–" + formatInstrumentPrice(info.priceEnd) : ""}  S ${info.sell} | B ${info.buy}${info.undirected ? " N " + info.undirected : ""}`
      + (b ? `   O ${formatInstrumentPrice(b.open)} H ${formatInstrumentPrice(b.high)} L ${formatInstrumentPrice(b.low)} C ${formatInstrumentPrice(b.close)}  VOL ${b.volume}  Δ ${b.delta > 0 ? "+" : ""}${b.delta}  POC ${formatInstrumentPrice(rowsOf(b).poc)}${rowTicks > 1 ? "–" + formatInstrumentPrice(rowsOf(b).poc + rowTicks - 1) : ""}` : "   約定なし")
      + `  [${STATE_TEXT[info.state]}${info.startSec + tf > nowSec() ? "・形成中" : "・時間終了"}]`;
  }
  function hideCursor() { cursorPt = null; requestCursor(); }

  /* ---------- chrome / status ---------- */
  let contractsKey = "";
  function updateChrome() {
    const st = client.state;
    stateEl.dataset.state = st === "connected" ? "connected" : st === "error" ? "error" : "connecting";
    const tfText = (t: number) => t < 60 ? `${t}秒` : `${t / 60}分`;
    stateLabel.textContent = st === "connected" ? `${client.isReplay ? "REPLAY" : "LIVE"} · ${tfText(tf)}`
      : st === "error" ? "ERROR" : st === "reconnecting" ? `RECONNECTING ${client.stateMessage}` : "CONNECTING";
    $("#fp-effective").textContent = `${tfText(selectedTf)}${tf !== selectedTf ? `（表示 ${tfText(tf)}）` : ""} · 1行 ${rowTicks}ティック（${formatInstrumentPrice(rowTicks)}）`;
    for (const b of root.querySelectorAll<HTMLButtonElement>(".fp-tf button")) b.setAttribute("aria-pressed", String(Number(b.dataset.tf) === selectedTf));
    const contracts = store.contracts(), key = contracts.join(",");
    if (key !== contractsKey) {
      contractsKey = key;
      contractSel.replaceChildren(new Option("最新", "auto"), ...contracts.map(c => new Option(c === "UNKNOWN" ? "限月不明" : c, c)));
      contractSel.value = contracts.includes(contractChoice) ? contractChoice : "auto";
    }
    const L = layout(), [from, to] = visibleSpan(view, tf, L.plotW), now = nowSec();
    const lines: { text: string; tone?: string; retry?: boolean }[] = [];
    if (zoneWarning) lines.push({ text: zoneWarning, tone: "warn" });
    const loading = client.queued.length + (client.pendingRequest ? 1 : 0);
    if (loading) lines.push({ text: `保存済み約定を取得中 ${loading}区間` });
    const reasons = store.gapReasons(from, to);
    if (reasons.length) lines.push({ text: `表示範囲に既知の未取得区間：${reasons.join(", ")}（受信済み数量のみ表示）`, tone: "warn", retry: true });
    if (store.evicted.some(([a, b]) => a < to && b > from)) lines.push({ text: `キャッシュ上限 ${MAX_TRADES.toLocaleString()}件を超えた古い秒を破棄（不完全）`, tone: "warn", retry: true });
    if (from < now - RETAIN_SEC) lines.push({ text: "直近2時間より前は表示対象外です" });
    if (client.lastError) lines.push({ text: `取得エラー：${client.lastError}`, tone: "error", retry: true });
    if (activeContract() === "UNKNOWN" && store.tradeCount > 0) lines.push({ text: "限月不明の約定を別系列で表示（現在限月の遡及適用・価格調整なし）", tone: "warn" });
    lines.push({ text: `記録ベース${client.quality ? `（${client.quality}）` : ""}：取得記録であり取引所の完全性は保証しません` });
    statusEl.replaceChildren(...lines.map((l, i) => {
      const wrap = document.createElement("div");
      const p = document.createElement("p"); p.textContent = l.text; if (l.tone) p.dataset.tone = l.tone;
      p.dataset.testid = `text-footprint-status-${i}`; wrap.append(p);
      if (l.retry) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = "再試行";
        b.dataset.testid = `button-footprint-retry-${i}`; b.addEventListener("click", () => client.retry()); wrap.append(b);
      }
      return wrap;
    }));
    const empty = store.tradeCount === 0;
    skeleton.hidden = !(empty && (st !== "connected" || loading > 0));
    centerEl.hidden = !(empty && st === "connected" && loading === 0);
    centerEl.textContent = "この範囲に受信済みの約定はありません · 未取得区間は斜線、確認済みの無約定は空欄です";
  }

  /* ---------- interaction ---------- */
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { kind: "pan" | "axis"; x: number; y: number; view: FpView; moved: boolean } | null = null;
  let pinch: { dist: number; mid: number; view: FpView } | null = null;
  let multiTouch = false;
  const local = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: PointerEvent) => {
    const p = local(e); pointers.set(e.pointerId, p); canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { dist: Math.max(10, Math.abs(a!.x - b!.x)), mid: (a!.x + b!.x) / 2, view }; drag = null; multiTouch = true; lastTap = 0; return; }
    const L = layout();
    drag = { kind: p.x > L.plotW && p.y < L.plotH ? "axis" : "pan", x: p.x, y: p.y, view, moved: false };
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    cursorPt = e.pointerType === "touch" ? null : p; requestCursor();
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, p);
    const L = layout();
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const factor = Math.max(10, Math.abs(a!.x - b!.x)) / pinch.dist;
      const next = zoomTimeAt(pinch.view, factor, pinch.mid, selectedTf, L.plotW);
      next.endSec += (pinch.mid - (a!.x + b!.x) / 2) * next.displayTf! / next.barW;
      setView(next); return;
    }
    if (!drag) return;
    const dx = p.x - drag.x, dy = p.y - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === "axis") { setView(zoomPriceAt(drag.view, Math.exp(-dy / 150), L.plotH / 2, L.plotH)); return; }
    setView({ ...drag.view, endSec: drag.view.endSec - (dx / drag.view.barW) * (drag.view.displayTf ?? tf),
      centerPrice: drag.view.centerPrice + dy / drag.view.rowH, follow: Math.abs(dx) < 4 && drag.view.follow });
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { drag = null; multiTouch = false; }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e), L = layout();
    const delta = (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
    const factor = Math.exp(-delta / 500);
    if ((p.x > L.plotW && p.y < L.plotH) || e.shiftKey) setView(zoomPriceAt(view, factor, Math.min(p.y, L.plotH), L.plotH));
    else {
      setView(zoomTimeAt(view, factor, Math.min(p.x, L.plotW), selectedTf, L.plotW));
    }
  };
  let lastTap = 0;
  const onTap = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || drag?.moved || multiTouch) return;
    const t = performance.now(); if (t - lastTap < 320) resetView(); lastTap = t;
  };
  function resetView() {
    centered = false;
    setView({ endSec: followEnd(nowSec(), selectedTf), displayTf: selectedTf, barW: BAR_W_DEFAULT, rowH: ROW_H_DEFAULT, centerPrice: view.centerPrice, follow: true });
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", e => { onTap(e); onUp(e); });
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", hideCursor);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", resetView);
  $("#fp-reset").addEventListener("click", resetView);
  followBtn.addEventListener("click", () => setView({ ...view, follow: !view.follow, endSec: view.follow ? view.endSec : followEnd(nowSec(), tf) }));
  $("#fp-retry").addEventListener("click", () => client.retry());
  contractSel.addEventListener("change", () => { contractChoice = contractSel.value; centered = false; request(); });
  for (const b of root.querySelectorAll<HTMLButtonElement>(".fp-tf button")) b.addEventListener("click", () => {
    const next = parseTimeframe(b.dataset.tf);
    if (next === selectedTf) return;
    // Keep the time under the right edge; bar width stays, so the visible duration scales with the bar length.
    selectedTf = next;
    try { window.sessionStorage.setItem(TF_KEY, String(selectedTf)); } catch { /* not kept */ }
    setView({ ...view, displayTf: selectedTf, endSec: view.follow ? followEnd(nowSec(), selectedTf) : view.endSec });
  });
  const resize = new ResizeObserver(() => request()); resize.observe(canvas);
  const onVisibility = () => { if (!document.hidden) request(); else hideCursor(); };
  document.addEventListener("visibilitychange", onVisibility);
  // Data-driven redraws are coalesced to at most once per second; forming/follow also advance here.
  const ticker = window.setInterval(() => {
    if (document.hidden || destroyed) return;
    if (dataDirty || view.follow || performance.now() - lastDraw > 5_000) request();
  }, DATA_DRAW_MS);

  /* ---------- settings (shared time zone, read only) ---------- */
  void fetchSettings().then(doc => { zone = doc.values.timeZone === "America/Chicago" ? "ct" : "jst"; request(); })
    .catch(() => { zoneWarning = "時刻の表示設定を読めませんでした（日本時間で表示）"; request(); });

  /* ---------- debug ---------- */
  const dbg = window as Window & { __footprintDebug?: unknown };
  if (new URLSearchParams(location.search).get("debug") === "1") Object.defineProperty(dbg, "__footprintDebug", {
    configurable: true, get: () => {
      const L = layout();
      return {
        view: { ...view }, timeframe: tf, selectedTimeframe: selectedTf, rowTicks, detail: lastDetail, contract: activeContract(), layout: L,
        state: { connection: client.state, generation: store.generation, nowSec: nowSec(), liveOpenSec: store.liveOpenSec,
          coverage: store.coverage, gaps: store.gaps, noData: store.noData, evicted: store.evicted, quality: client.quality, lastError: client.lastError },
        requests: client.requests.map(r => ({ ...r })), queued: client.queued.map(r => [...r]),
        bars: paintedGroups.map(({ startSec, group }) => {
          const b = group.get(activeContract());
          return { startSec, state: store.stateOf(startSec, startSec + tf, nowSec()), rows: b ? rowsOf(b) : null, bar: b ? { ...b, prices: [...b.prices], buy: [...b.buy], sell: [...b.sell] } : null };
        }),
        draw: { count: drawCount, lastMs: timings.at(-1) ?? 0, samplesMs: [...timings], meanMs: timings.reduce((a, b) => a + b, 0) / Math.max(1, timings.length), maxMs: Math.max(0, ...timings) },
        cache: { trades: store.tradeCount, maxTrades: MAX_TRADES, seconds: store.secondCount, bars: store.cachedBars, barBuilds: store.barBuilds, evictions: store.evictions },
        cursor: cursorInfo(),
      };
    },
  });
  if (new URLSearchParams(location.search).get("debug") === "1") Object.defineProperty(window, "__footprintCounters", {
    configurable: true, get: () => ({
      draws: drawCount, barBuilds: store.barBuilds, trades: store.tradeCount,
      hidden: document.hidden, generation: store.generation, view: { ...view }, timeframe: tf,
      requests: client.requests.length, connection: client.state,
    }),
  });

  replayUi = mountReplayControls(root.querySelector<HTMLElement>(".workspace")!,
    root.querySelector<HTMLElement>(".fp-rail")!, canvas, client, () => zone,
    x => Math.floor(xToSec(x, view, tf, layout().plotW)), resetView, ACTIVE_SYMBOL);
  labelsUi = mountLabelsUi({
    symbol: ACTIVE_SYMBOL, screen: "footprint", rail: root.querySelector<HTMLElement>(".fp-rail")!,
    workspace: root.querySelector<HTMLElement>(".workspace")!, canvas,
    point: (x, y) => {
      const L = layout(), reference = client.replayPositionUs ?? store.latest?.tsUs ?? 0;
      const tsSec = Math.floor(xToSec(x, view, tf, L.plotW));
      if (x < 0 || y < 0 || x >= L.plotW || y >= L.plotH || !reference || tsSec * 1e6 > reference) return null;
      return { tsSec, priceTicks: Math.round(yToPrice(y, view, L.plotH)) };
    },
    project: label => {
      const L = layout(), reference = client.replayPositionUs ?? store.latest?.tsUs ?? 0;
      if (label.tsSec * 1e6 > reference) return null;
      const x = barLeft(label.tsSec, view, tf, L.plotW), y = priceToY(label.priceTicks, view, L.plotH);
      return x >= 0 && x < L.plotW && y >= 0 && y < L.plotH ? { x, y } : null;
    },
    context: () => ({ referenceUs: client.replayPositionUs ?? store.latest?.tsUs ?? 0,
      replay: client.isReplay, follow: view.follow }),
    approach: second => store.approachBefore(second * 1e6, activeContract()),
  });
  if (initialReplay && new URLSearchParams(location.search).get("mode") !== "replay") {
    const start = replayStart(initialReplay);
    client.startReplay(start.fromSec, start.speed, start.paused, start.headUs);
  } else client.start();
  setView(view, false);

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    saveView("footprint", ACTIVE_SYMBOL, view);
    if (frame) cancelAnimationFrame(frame);
    if (cursorFrame) cancelAnimationFrame(cursorFrame);
    labelsUi?.destroy();
    replayUi?.persistForNavigation(client.replayPositionUs);
    window.clearInterval(ticker); resize.disconnect(); client.stop();
    document.removeEventListener("visibilitychange", onVisibility);
    delete dbg.__footprintDebug;
    Reflect.deleteProperty(window, "__footprintCounters");
    root.replaceChildren();
  };
  window.addEventListener("pagehide", destroy, { once: true });
  return destroy;
}
