import "./long-vp.css";
import "../components/settings-ui.css";
import { fetchSettings } from "../data/settings.ts";
import { LongVpStore } from "./store.ts";
import { defaults, type SettingsDocument, type SettingsValues } from "./settings-schema.ts";
import { fetchLongVpSettings, mountLongVpSettings } from "./settings-modal.ts";
import {
  aggregateBars, barMinutes, buildProfiles, buildSeries, groupLevels, latestContract, pixelRows, pocExtensionEnd,
  type Bar, type DayData, type Profile, type Series,
} from "./model.ts";
import { dayEndSec, dayStartSec, latestTradingDate, nextTradingDate, shiftDate, tradingDatesBetween, weekKey, weekStartSec } from "./time.ts";
import { clampView, fitPrice, initialView, type LvView } from "./view-math.ts";
import { viewSwitchHtml } from "./nav.ts";
import { LongVpCrosshair, cvdScale, cvdY } from "./crosshair.ts";
import { ACTIVE_SYMBOL, formatInstrumentPrice } from "../instrument.ts";
import { loadView, saveView } from "../view-memory.ts";

const C = {
  bg: "#000000", grid: "#15141d", sep: "#252431", weekSep: "#3a3850", text: "#8e8c9c", textHi: "#d9d9d9",
  price: "#d9d9d9", up: "#3ddc84", down: "#a64dff", vwap: "#ffd60a", va: "#00d8ff",
  poc: "#ffffff", vaLine: "#f5a623", vpBar: "#d9d9d9", gap: "#ff9a3c", unadj: "#ff6f67", cvd: "#ffffff",
};
const SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const AXIS_W = 70, MIN_DIVIDER = .3, MAX_DIVIDER = .9;
const priceText = formatInstrumentPrice;

export function mountLongVp(root: HTMLElement): () => void {
  document.title = `${ACTIVE_SYMBOL} | Long-term volume profile`;
  for (const [selector, content] of [
    ['meta[name="description"]', `${ACTIVE_SYMBOL}の日次・週次出来高プロファイル、週VWAPと週CVD。`],
    ['meta[property="og:title"]', `${ACTIVE_SYMBOL} | Long-term volume profile`],
    ['meta[property="og:description"]', `${ACTIVE_SYMBOL}の日次・週次VP、週VWAPと週CVD。`],
  ]) document.querySelector(selector)?.setAttribute("content", content);
  root.innerHTML = `
  <div class="app-shell">
    <aside class="tool-rail su-rail" aria-label="Tools">
      <button class="su-tool" type="button" id="lv-settings" title="設定" aria-label="設定" aria-haspopup="dialog" data-testid="button-settings"><svg ${SVG}><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg></button>
      <button class="su-tool" type="button" id="lv-reset" title="表示リセット" aria-label="表示リセット" data-testid="button-view-reset"><svg ${SVG}><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><circle cx="12" cy="12" r="1.6"/></svg></button>
    </aside>
    <main class="workspace">
      <header class="masthead">
        <div class="instrument"><strong>${ACTIVE_SYMBOL} / LONG VP</strong><span>ADJUSTED TO FRONT CONTRACT</span></div>
        ${viewSwitchHtml("longvp")}
        <div class="market-state" id="lv-state" data-state="connecting" data-testid="status-longvp"><i class="state-dot" aria-hidden="true"></i><span id="lv-state-label">LOADING</span></div>
      </header>
      <section class="lv-board" aria-label="Long-term volume profile">
        <div class="lv-frame">
          <canvas class="lv-canvas" id="lv-canvas" aria-label="Adjusted NQ price with period volume profiles, weekly VWAP and weekly CVD"></canvas>
          <div class="lv-legend" id="lv-legend"></div>
          <div class="lv-skeleton" id="lv-skeleton"></div>
          <div class="lv-center" id="lv-center" role="status" hidden></div>
          <div class="lv-status" id="lv-status" aria-live="polite"></div>
        </div>
      </section>
    </main>
  </div>`;
  const canvas = root.querySelector<HTMLCanvasElement>("#lv-canvas")!;
  const ctx = canvas.getContext("2d")!;
  const statusEl = root.querySelector<HTMLElement>("#lv-status")!;
  const centerEl = root.querySelector<HTMLElement>("#lv-center")!;
  const skeleton = root.querySelector<HTMLElement>("#lv-skeleton")!;
  const legend = root.querySelector<HTMLElement>("#lv-legend")!;
  const stateEl = root.querySelector<HTMLElement>("#lv-state")!;
  const stateLabel = root.querySelector<HTMLElement>("#lv-state-label")!;

  let settings: SettingsValues = { ...defaults };
  let appliedUpdatedAt: number | null = null;
  let settingsWarning = "", zoneWarning = "";
  let timeZone: "Asia/Tokyo" | "America/Chicago" = "Asia/Tokyo";
  let view: LvView = initialView(Date.now() / 1000);
  let autoPrice = true, divider = 75 / 95, destroyed = false, frame = 0;
  const savedView = loadView<{ view: LvView; autoPrice: boolean }>("longvp", ACTIVE_SYMBOL);
  if (savedView && Number.isFinite(savedView.view?.startSec) && Number.isFinite(savedView.view?.endSec)) {
    view = clampView(savedView.view, Date.now() / 1000); autoPrice = savedView.autoPrice !== false;
  }

  const store = new LongVpStore(() => { syncData(); request(); });

  /* ---------- derived data, memoized on store revision ---------- */
  let seriesKey = "", series: Series | null = null, dates: string[] = [], loadedDays: DayData[] = [];
  let profilesKey = "", profiles: Profile[] = [];
  let baseDraws = 0, seriesBuilds = 0, profileBuilds = 0;
  function neededDates(): string[] {
    const upper = latestTradingDate(Date.now() / 1000);
    const first = nextTradingDate(view.startSec);
    let to = latestTradingDate(view.endSec);
    if (to > upper) to = upper;
    const from = shiftDate(weekKey(first), 1); // Monday: whole-week totals even when viewing midweek
    if (from > to) return [];
    let endWeek = shiftDate(weekKey(to), 5);
    if (endWeek > upper) endWeek = upper;
    return tradingDatesBetween(from, endWeek);
  }
  function syncData() {
    dates = neededDates();
    store.ensure(dates.filter(d => d !== store.today?.tradingDate));
  }
  function derive() {
    const key = `${store.revision}|${dates[0]}|${dates.at(-1)}`;
    if (key !== seriesKey) {
      seriesBuilds++;
      seriesKey = key;
      loadedDays = store.loaded(dates);
      const all = store.today ? [...loadedDays, store.today] : loadedDays;
      series = buildSeries(loadedDays, store.rolls, ACTIVE_SYMBOL === "GC" ? store.frontContract : latestContract(all, store.rolls));
      profilesKey = "";
    }
    const pk = `${seriesKey}|${settings.vpPeriod}|${settings.rthOnly}`;
    if (pk !== profilesKey && series) {
      profileBuilds++;
      profilesKey = pk;
      profiles = buildProfiles(series, settings.vpPeriod, settings.rthOnly, loadedDays.map(d => d.tradingDate));
    }
  }

  /* ---------- layout ---------- */
  let W = 1, H = 1, dpr = 1;
  function layout() {
    const plotW = Math.max(1, W - AXIS_W);
    const timeH = Math.max(20, Math.round(H * .05));
    const avail = H - timeH;
    const cvd = settings.showWeeklyCvd;
    const priceH = cvd ? Math.round(avail * divider) : avail;
    return { plotW, timeH, priceH, cvdTop: priceH, cvdH: cvd ? avail - priceH : 0, timeTop: avail };
  }
  const xOf = (t: number, plotW: number) => (t - view.startSec) / (view.endSec - view.startSec) * plotW;
  const yOf = (p: number, h: number) => (view.priceHigh - p) / (view.priceHigh - view.priceLow) * h;
  let cvdAxis = cvdScale([], 0, 10);
  const cursor = new LongVpCrosshair(canvas, () => ({ ...layout(), width: W, height: H, view: { ...view }, cvd: cvdAxis, timeZone }));
  const debugWindow = window as Window & { __longVpDebug?: unknown };
  if (new URLSearchParams(location.search).get("debug") === "1") Object.defineProperty(debugWindow, "__longVpDebug", {
    configurable: true, get: () => ({ cursor: cursor.snapshot(), view: { ...view }, layout: layout(), timeZone,
      cvdAxis: { ...cvdAxis }, baseDraws, seriesBuilds, profileBuilds, settings: { ...settings },
      todayBuiltAtUs: store.today?.builtAtUs ?? null,
      profiles: profiles.map(p => ({ key: p.key, total: p.total, poc: p.poc })) }),
  });

  function request() { if (!frame && !destroyed) frame = requestAnimationFrame(draw); }

  function draw() {
    baseDraws++;
    frame = 0;
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, rect.width); H = Math.max(1, rect.height);
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    derive();
    const L = layout();
    if (autoPrice && series) {
      const fit = fitPrice(series.bars, view.startSec, view.endSec, L.priceH);
      if (fit) view = { ...view, ...fit };
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    drawGrid(L); drawGaps(L); drawSeparators(L);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, L.plotW, L.priceH); ctx.clip();
    if (settings.showVp) drawProfiles(L);
    if (settings.showPrice) drawPrice(L);
    if (settings.showWeeklyVwap) drawVwap(L);
    ctx.restore();
    if (settings.showVp) drawProfileLabels(L);
    drawPriceAxis(L);
    if (settings.showWeeklyCvd) drawCvd(L);
    drawTimeAxis(L);
    updateOverlay();
    cursor.request();
  }

  function drawGrid(L: ReturnType<typeof layout>) {
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (const p of priceTicks(L.priceH)) { const y = Math.round(yOf(p, L.priceH)) + .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.plotW, y); ctx.stroke(); }
    ctx.strokeStyle = C.sep;
    ctx.beginPath(); ctx.moveTo(0, L.timeTop + .5); ctx.lineTo(W, L.timeTop + .5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L.plotW + .5, 0); ctx.lineTo(L.plotW + .5, L.timeTop); ctx.stroke();
    if (L.cvdH) {
      ctx.strokeStyle = "#51476d"; ctx.beginPath(); ctx.moveTo(0, L.cvdTop + .5); ctx.lineTo(W, L.cvdTop + .5); ctx.stroke();
      ctx.fillStyle = "#51476d"; ctx.fillRect(W / 2 - 14, L.cvdTop - 1, 28, 3);
    }
  }
  function hatch(x0: number, x1: number, y0: number, y1: number, alpha: number) {
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.strokeStyle = C.gap; ctx.globalAlpha = alpha; ctx.lineWidth = 1;
    for (let x = x0 - (y1 - y0); x < x1; x += 6) { ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x + (y1 - y0), y0); ctx.stroke(); }
    ctx.restore();
  }
  function drawGaps(L: ReturnType<typeof layout>) {
    if (!series) return;
    for (const [a, b] of series.gaps) {
      if (b < view.startSec || a > view.endSec) continue;
      const x0 = Math.max(0, xOf(a, L.plotW)), x1 = Math.min(L.plotW, Math.max(xOf(b, L.plotW), x0 + 2));
      ctx.fillStyle = C.gap; ctx.globalAlpha = .05; ctx.fillRect(x0, 0, x1 - x0, L.timeTop); ctx.globalAlpha = 1;
      hatch(x0, x1, L.timeTop - 8, L.timeTop, .55);
    }
    // Stored-but-absent trading dates are shown too: no data is never drawn as flat.
    for (const d of store.missingDates(dates)) {
      const a = [dayStartSec(d), dayEndSec(d)];
      if (a[1] < view.startSec || a[0] > view.endSec) continue;
      hatch(Math.max(0, xOf(a[0], L.plotW)), Math.min(L.plotW, xOf(a[1], L.plotW)), L.timeTop - 8, L.timeTop, .25);
    }
  }
  function drawSeparators(L: ReturnType<typeof layout>) {
    ctx.lineWidth = 1;
    for (const p of profiles) {
      if (p.startSec < view.startSec || p.startSec > view.endSec) continue;
      const x = Math.round(xOf(p.startSec, L.plotW)) + .5;
      ctx.strokeStyle = C.sep; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, L.priceH); ctx.stroke();
    }
    // Week boundaries span price and CVD so both panes line up.
    const weeks = new Set(dates.map(weekKey));
    ctx.strokeStyle = C.weekSep; ctx.setLineDash([3, 3]);
    for (const w of weeks) {
      const t = weekStartSec(shiftDate(w, 1));
      if (t < view.startSec || t > view.endSec) continue;
      const x = Math.round(xOf(t, L.plotW)) + .5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, L.timeTop); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function visibleProfiles() { return profiles.filter(p => p.endSec > view.startSec && p.startSec < view.endSec && p.total > 0); }
  function profileRows(L: ReturnType<typeof layout>) {
    const g = settings.vpTickGroup;
    return visibleProfiles().map(p => {
      const rows = pixelRows(groupLevels(p.levels, g), g, pr => yOf(pr, L.priceH) * dpr, Math.round(L.priceH * dpr));
      let max = 0; for (const r of rows) max = Math.max(max, r.v);
      return { p, rows, max };
    });
  }
  function drawProfiles(L: ReturnType<typeof layout>) {
    const rows = profileRows(L);
    const globalMax = Math.max(1, ...rows.map(r => r.max));
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const { p, rows: rs, max } of rows) {
      const x0 = xOf(p.startSec, L.plotW) * dpr, pw = (xOf(p.endSec, L.plotW) - xOf(p.startSec, L.plotW)) * dpr;
      const scale = settings.vpNormalization === "period" ? Math.max(1, max) : globalMax;
      const full = pw * settings.vpWidthPct / 100;
      const vaTop = p.vah !== null ? yOf(p.vah + .5, L.priceH) * dpr : 0, vaBot = p.val !== null ? yOf(p.val - .5, L.priceH) * dpr : 0;
      for (const r of rs) {
        const len = Math.max(1, full * r.v / scale);
        const inVa = r.y + r.h > vaTop && r.y < vaBot;
        ctx.fillStyle = inVa ? C.vaLine : C.vpBar; ctx.globalAlpha = inVa ? .26 : .16;
        ctx.fillRect(Math.round(x0), r.y, len, r.h);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    for (const { p } of rows) {
      const x0 = xOf(p.startSec, L.plotW), x1 = xOf(p.endSec, L.plotW);
      const line = (price: number | null, color: string, dash: number[], from: number, to: number) => {
        if (price === null) return;
        const y = Math.round(yOf(price, L.priceH)) + .5;
        ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.stroke();
      };
      ctx.lineWidth = 1;
      if (settings.showVah) line(p.vah, C.vaLine, [4, 3], x0, x1);
      if (settings.showVal) line(p.val, C.vaLine, [4, 3], x0, x1);
      if (settings.showPoc) line(p.poc, C.poc, [], x0, x1);
      if (settings.showPocExtension && p.poc !== null) { ctx.globalAlpha = .55; line(p.poc, C.poc, [2, 2], x1, xOf(pocExtensionEnd(p.key, settings.vpPeriod), L.plotW)); ctx.globalAlpha = 1; }
      ctx.setLineDash([]);
      if (settings.showValueArea && p.vah !== null && p.val !== null) {
        ctx.strokeStyle = C.va; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0 + 1, yOf(p.vah + .5, L.priceH)); ctx.lineTo(x0 + 1, yOf(p.val - .5, L.priceH)); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }
  function drawProfileLabels(L: ReturnType<typeof layout>) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, L.plotW, L.priceH); ctx.clip();
    for (const p of visibleProfiles()) {
      const x0 = Math.max(4, xOf(p.startSec, L.plotW) + 4);
      for (const [on, name, price, color] of [[settings.showVah, "VAH", p.vah, C.vaLine], [settings.showPoc, "POC", p.poc, C.poc],
        [settings.showVal, "VAL", p.val, C.vaLine]] as const) {
        if (!on || price === null) continue;
        const y = yOf(price, L.priceH);
        ctx.fillStyle = color; ctx.globalAlpha = .9;
        ctx.fillText(`${name} ${priceText(price)}`, x0, name === "VAL" ? y + 10 : y - 3);
      }
      ctx.globalAlpha = 1;
    }
    for (const p of profiles) {
      if (!p.unadjustable || p.endSec < view.startSec || p.startSec > view.endSec) continue;
      ctx.fillStyle = C.unadj;
      ctx.fillText("調整不能", Math.max(4, xOf(p.startSec, L.plotW) + 4), 22);
    }
    ctx.restore();
  }
  function rangeBars(bars: Bar[]) {
    let lo = 0, hi = bars.length;
    const from = view.startSec - 14400;
    while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < from) lo = m + 1; else hi = m; }
    const out: Bar[] = [];
    for (let i = lo; i < bars.length && bars[i].t <= view.endSec + 14400; i++) out.push(bars[i]);
    return out;
  }
  let lastBarMinutes = 1;
  function drawPrice(L: ReturnType<typeof layout>) {
    if (!series) return;
    const secPerPx = (view.endSec - view.startSec) / L.plotW;
    const minutes = barMinutes(secPerPx, settings.priceStyle === "candles" ? 5 : 1.5);
    lastBarMinutes = minutes;
    const bars = aggregateBars(rangeBars(series.bars), minutes, view.startSec, view.endSec);
    const size = minutes * 60;
    if (settings.priceStyle === "candles") {
      const bw = Math.max(1, size / secPerPx * .7);
      for (const b of bars) {
        const x = xOf(b.t + size / 2, L.plotW), up = b.c >= b.o;
        ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yOf(b.h + .5, L.priceH)); ctx.lineTo(Math.round(x) + .5, yOf(b.l - .5, L.priceH)); ctx.stroke();
        const yo = yOf(b.o, L.priceH), yc = yOf(b.c, L.priceH);
        ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yo - yc)));
      }
      return;
    }
    ctx.strokeStyle = C.price; ctx.lineWidth = 1.25; ctx.beginPath();
    let prev = -Infinity;
    for (const b of bars) {
      const x = xOf(b.t + size, L.plotW), y = yOf(b.c, L.priceH);
      if (b.t - prev > size * 3) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = b.t;
    }
    ctx.stroke(); ctx.lineWidth = 1;
  }
  function drawVwap(L: ReturnType<typeof layout>) {
    if (!series) return;
    ctx.strokeStyle = C.vwap; ctx.lineWidth = 1.25; ctx.beginPath();
    let week = "";
    for (const p of series.vwap) {
      if (p.t < view.startSec - 3600 || p.t > view.endSec + 3600) { week = ""; continue; }
      const x = xOf(p.t, L.plotW), y = yOf(p.v, L.priceH);
      if (p.week !== week) { ctx.moveTo(x, y); week = p.week; } else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.lineWidth = 1;
  }
  function priceTicks(h: number) {
    const span = view.priceHigh - view.priceLow, target = Math.max(2, h / 48);
    const steps = [1, 2, 4, 8, 20, 40, 80, 200, 400, 800, 2000, 4000, 8000];
    const step = steps.find(s => span / s <= target) ?? 8000;
    const out: number[] = [];
    for (let p = Math.ceil(view.priceLow / step) * step; p <= view.priceHigh; p += step) out.push(p);
    return out;
  }
  function drawPriceAxis(L: ReturnType<typeof layout>) {
    ctx.fillStyle = C.text; ctx.textAlign = "left";
    for (const p of priceTicks(L.priceH)) {
      const y = yOf(p, L.priceH);
      if (y < 8 || y > L.priceH - 4) continue;
      ctx.fillText(priceText(p), L.plotW + 6, y + 3);
    }
    if (autoPrice) { ctx.fillStyle = "#555366"; ctx.fillText("AUTO", L.plotW + 6, 10); }
    if (settings.showWeeklyVwap && series) {
      const last = series.vwap.filter(v => v.t <= view.endSec).at(-1);
      if (last) label(L.plotW, yOf(last.v, L.priceH), priceText(Math.round(last.v)), C.vwap, "#000000", L.priceH);
    }
    if (settings.showPrice && series) {
      const last = rangeBars(series.bars).filter(b => b.t <= view.endSec).at(-1);
      if (last) label(L.plotW, yOf(last.c, L.priceH), priceText(last.c), "#e9e3ff", "#000000", L.priceH);
    }
  }
  function label(x: number, y: number, text: string, bg: string, fg: string, maxY: number) {
    if (y < 0 || y > maxY) return;
    ctx.fillStyle = bg; ctx.fillRect(x + 1, y - 7, AXIS_W - 2, 14);
    ctx.fillStyle = fg; ctx.fillText(text, x + 6, y + 3);
  }
  function drawCvd(L: ReturnType<typeof layout>) {
    if (!series || L.cvdH < 10) return;
    const pts = series.cvd.filter(p => p.t >= view.startSec && p.t <= view.endSec + 60);
    cvdAxis = cvdScale(pts, L.cvdTop, L.cvdH);
    const pad = (cvdAxis.high - cvdAxis.low) / 1.16 * .08;
    const lo = cvdAxis.low + pad, hi = cvdAxis.high - pad;
    const y = (v: number) => cvdY(v, cvdAxis);
    ctx.strokeStyle = C.sep; ctx.beginPath(); ctx.moveTo(0, Math.round(y(0)) + .5); ctx.lineTo(L.plotW, Math.round(y(0)) + .5); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(0, L.cvdTop, L.plotW, L.cvdH); ctx.clip();
    ctx.strokeStyle = C.cvd; ctx.lineWidth = 1.25; ctx.beginPath();
    let week = "", prev = -Infinity;
    for (const p of pts) {
      const x = xOf(p.t, L.plotW), yy = y(p.v);
      if (p.week !== week || p.t - prev > 3 * 3600) { ctx.moveTo(x, yy); week = p.week; } else ctx.lineTo(x, yy);
      prev = p.t;
    }
    ctx.stroke(); ctx.lineWidth = 1; ctx.restore();
    ctx.fillStyle = C.text;
    ctx.fillText("WEEKLY CVD", 8, L.cvdTop + 12);
    ctx.fillText(compact(hi), L.plotW + 6, L.cvdTop + 12);
    ctx.fillText("0", L.plotW + 6, Math.min(L.cvdTop + L.cvdH - 4, Math.max(L.cvdTop + 22, y(0) + 3)));
    ctx.fillText(compact(lo), L.plotW + 6, L.cvdTop + L.cvdH - 4);
  }
  function drawTimeAxis(L: ReturnType<typeof layout>) {
    const span = view.endSec - view.startSec, steps = [3600, 7200, 14400, 21600, 43200, 86400, 172800, 604800, 1209600];
    const step = steps.find(s => (s / span) * L.plotW >= 92) ?? 1209600;
    const fmt = new Intl.DateTimeFormat("ja-JP", { timeZone, month: "2-digit", day: "2-digit",
      ...(step < 86400 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}) });
    const off = tzOffsetSec(view.startSec, timeZone);
    ctx.fillStyle = C.text; ctx.textAlign = "center";
    for (let t = Math.ceil((view.startSec + off) / step) * step - off; t < view.endSec; t += step) {
      const x = xOf(t, L.plotW);
      if (x < 30 || x > L.plotW - 30) continue;
      ctx.fillText(fmt.format(t * 1000), x, L.timeTop + L.timeH / 2 + 3);
    }
    ctx.textAlign = "right";
    ctx.fillText(timeZone === "Asia/Tokyo" ? "JST" : "CT", W - 6, L.timeTop + L.timeH / 2 + 3);
    ctx.textAlign = "left";
  }

  /* ---------- overlay & status ---------- */
  function updateOverlay() {
    const lines: { text: string; tone?: string; retry?: () => void }[] = [];
    if (settingsWarning) lines.push({ text: settingsWarning, tone: "warn", retry: () => void loadSettings() });
    if (zoneWarning) lines.push({ text: zoneWarning, tone: "warn" });
    if (store.daysState === "loading") lines.push({ text: "日次データを読み込み中…" });
    if (store.daysState === "error") lines.push({ text: `日次データを読めませんでした：${store.daysError}`, tone: "error", retry: () => store.retry() });
    if (store.daysState === "disabled") lines.push({ text: store.daysError, tone: "error", retry: () => store.retry() });
    if (store.rollsState === "error" || store.rollsState === "disabled") lines.push({ text: `乗り換え記録：${store.rollsError}。古い限月は調整不能`, tone: "error", retry: () => void store.loadRolls() });
    if (store.todayState === "error" || store.todayState === "disabled") lines.push({ text: store.todayError, tone: store.todayState === "error" ? "error" : "warn", retry: () => void store.pollToday() });
    if (series && series.unadjustableDates.size) lines.push({ text: `調整不能 ${series.unadjustableDates.size}日：${ACTIVE_SYMBOL === "GC" ? "限月不明／価格差未確認の" : "乗り換えを確認できない限月の"}価格行を省いています（CVDは表示）`, tone: "warn" });
    const incomplete = loadedDays.filter(d => !d.complete && d.tradingDate !== store.today?.tradingDate).length;
    if (incomplete) lines.push({ text: `不完全な取引日 ${incomplete}（斜線が欠損区間）`, tone: "warn" });
    const missing = store.missingDates(dates).length;
    if (missing && store.daysState === "idle") lines.push({ text: `保存データなし ${missing}取引日（斜線）。蓄積・補充後は再試行で読み直せます。`, tone: "warn", retry: () => store.retry() });
    statusEl.replaceChildren(...lines.map((l, i) => {
      const wrap = document.createElement("div");
      const p = document.createElement("p"); p.textContent = l.text; if (l.tone) p.dataset.tone = l.tone;
      p.dataset.testid = `text-longvp-status-${i}`;
      wrap.append(p);
      if (l.retry) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = "再試行";
        b.dataset.testid = `button-longvp-retry-${i}`; b.addEventListener("click", l.retry!); wrap.append(b);
      }
      return wrap;
    }));
    const loading = store.daysState === "loading" && loadedDays.length === 0;
    skeleton.hidden = !loading;
    const noData = !loading && store.daysState === "idle" && loadedDays.length === 0 && !store.today;
    centerEl.hidden = !(noData || dates.length === 0 || (store.daysState === "disabled" && loadedDays.length === 0));
    centerEl.textContent = dates.length === 0 ? "この範囲は取引日がありません（週末または未来）"
      : store.daysState === "disabled" ? "長期VPはサーバーで無効です · 蓄積データを表示できません"
        : ACTIVE_SYMBOL === "GC" && series?.unadjustableDates.size
          ? "限月不明／調整不能のため価格を表示できません · 生データを保持し、週CVDは表示します"
          : "この範囲に蓄積データはありません · 移動して過去や当日を表示できます";
    const err = store.daysState === "error" || store.daysState === "disabled";
    stateEl.dataset.state = err ? "error" : store.daysState === "loading" ? "connecting" : "connected";
    stateLabel.textContent = err ? "DATA ERROR" : store.daysState === "loading" ? "LOADING"
      : store.today ? `TODAY ${store.today.tradingDate}` : "HISTORY";
    legend.innerHTML = `<strong>${settings.vpPeriod === "day" ? "DAILY" : "WEEKLY"} VP${settings.rthOnly ? " · RTH" : ""}</strong>`
      + (settings.showPrice ? `<span>${settings.priceStyle === "candles" ? "CANDLES" : "LINE"} ${lastBarMinutes}m</span>` : "")
      + (settings.showWeeklyVwap ? `<span><i style="background:${C.vwap}"></i>WEEKLY VWAP</span>` : "")
      + (settings.showValueArea ? `<span><i style="background:${C.va}"></i>VA 70%</span>` : "")
      + `<span>${store.cachedDays} days cached</span>`;
  }

  /* ---------- interaction ---------- */
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { kind: "pan" | "divider" | "axis"; x: number; y: number; view: LvView; divider: number; moved: boolean } | null = null;
  let pinch: { dist: number; mid: number; view: LvView } | null = null;
  function setView(next: LvView) { view = clampView(next, Date.now() / 1000); syncData(); request(); }
  function local(e: PointerEvent | WheelEvent | MouseEvent) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function zoomTime(factor: number, x: number) {
    const L = layout(), anchor = view.startSec + (x / L.plotW) * (view.endSec - view.startSec);
    setView({ ...view, startSec: anchor - (anchor - view.startSec) * factor, endSec: anchor + (view.endSec - anchor) * factor });
  }
  function zoomPrice(factor: number) {
    autoPrice = false;
    const mid = (view.priceHigh + view.priceLow) / 2, half = (view.priceHigh - view.priceLow) / 2 * factor;
    setView({ ...view, priceHigh: mid + half, priceLow: mid - half });
  }
  function hitKind(p: { x: number; y: number }): "pan" | "divider" | "axis" {
    const L = layout();
    if (L.cvdH && Math.abs(p.y - L.cvdTop) <= 6) return "divider";
    if (p.x > L.plotW && p.y < L.priceH) return "axis";
    return "pan";
  }
  const onDown = (e: PointerEvent) => {
    const p = local(e); pointers.set(e.pointerId, p);
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.max(10, Math.abs(a.x - b.x)), mid: (a.x + b.x) / 2, view }; drag = null; return;
    }
    drag = { kind: hitKind(p), x: p.x, y: p.y, view, divider, moved: false };
    canvas.dataset.drag = drag.kind;
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    if (!pointers.has(e.pointerId)) { canvas.dataset.hover = hitKind(p) === "pan" ? "" : hitKind(p); return; }
    pointers.set(e.pointerId, p);
    const L = layout();
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const factor = pinch.dist / Math.max(10, Math.abs(a.x - b.x));
      const v = pinch.view, anchor = v.startSec + pinch.mid / L.plotW * (v.endSec - v.startSec);
      const mid = (a.x + b.x) / 2, shift = (mid - pinch.mid) / L.plotW * (v.endSec - v.startSec) * factor;
      setView({ ...v, startSec: anchor - (anchor - v.startSec) * factor - shift, endSec: anchor + (v.endSec - anchor) * factor - shift });
      return;
    }
    if (!drag) return;
    const dx = p.x - drag.x, dy = p.y - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    const v = drag.view;
    if (drag.kind === "divider") {
      const avail = H - Math.max(20, Math.round(H * .05));
      divider = Math.min(MAX_DIVIDER, Math.max(MIN_DIVIDER, drag.divider + dy / avail)); request(); return;
    }
    if (drag.kind === "axis") {
      autoPrice = false;
      const f = Math.exp(dy / 150), mid = (v.priceHigh + v.priceLow) / 2, half = (v.priceHigh - v.priceLow) / 2 * f;
      setView({ ...view, priceHigh: mid + half, priceLow: mid - half }); return;
    }
    const dt = -dx / L.plotW * (v.endSec - v.startSec);
    const next = { ...v, startSec: v.startSec + dt, endSec: v.endSec + dt };
    if (drag.y < L.priceH && Math.abs(dy) > 4) autoPrice = false;
    if (!autoPrice && drag.y < L.priceH) {
      const dp = dy / L.priceH * (v.priceHigh - v.priceLow);
      next.priceHigh = v.priceHigh + dp; next.priceLow = v.priceLow + dp;
    } else { next.priceHigh = view.priceHigh; next.priceLow = view.priceLow; }
    setView(next);
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { drag = null; canvas.dataset.drag = ""; }
    else if (pointers.size === 1) { const [id, p] = [...pointers.entries()][0]; drag = { kind: "pan", x: p.x, y: p.y, view, divider, moved: true }; void id; }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e), L = layout();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(delta / 600);
    if (p.x > L.plotW && p.y < L.priceH) zoomPrice(factor); else zoomTime(factor, Math.min(p.x, L.plotW));
  };
  let lastTap = 0;
  const onTapEnd = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || drag?.moved) return;
    const now = performance.now();
    if (now - lastTap < 320) resetView();
    lastTap = now;
  };
  function resetView() { autoPrice = true; view = initialView(Date.now() / 1000); syncData(); request(); }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", e => { onTapEnd(e); onUp(e); });
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", resetView);
  root.querySelector<HTMLButtonElement>("#lv-reset")!.addEventListener("click", resetView);
  const resize = new ResizeObserver(() => request());
  resize.observe(canvas);

  /* ---------- settings ---------- */
  function applySettings(doc: SettingsDocument) {
    if (doc.updatedAt !== null && appliedUpdatedAt !== null && doc.updatedAt < appliedUpdatedAt) return;
    appliedUpdatedAt = doc.updatedAt;
    settings = { ...doc.values }; settingsWarning = "";
    request();
  }
  async function loadSettings() {
    try { applySettings(await fetchLongVpSettings()); }
    catch (e) { settingsWarning = `長期VPの設定を読めませんでした（初期値で表示）：${e instanceof Error ? e.message : e}`; request(); }
  }
  const modal = mountLongVpSettings({
    button: root.querySelector<HTMLButtonElement>("#lv-settings")!,
    onSaved: applySettings,
    onOpenChange: open => { if (open) { cursor.hide(); pointers.clear(); drag = null; pinch = null; } },
  });
  async function loadZone() {
    try { const doc = await fetchSettings(); timeZone = doc.values.timeZone; zoneWarning = ""; }
    catch { zoneWarning = "時刻の表示設定を読めませんでした（日本時間で表示）"; }
    request();
  }

  void loadSettings(); void loadZone();
  syncData(); store.start(); request();

  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      // BFCache freezes this document; it will NOT re-run the module on Back.
      saveView("longvp", ACTIVE_SYMBOL, { view, autoPrice });
    } else destroy();
  };
  const onResume = () => { if (!document.hidden) { store.resume(); request(); } };
  window.addEventListener("pageshow", onResume);
  document.addEventListener("visibilitychange", onResume);
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    saveView("longvp", ACTIVE_SYMBOL, { view, autoPrice });
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect(); store.destroy(); modal.destroy(); cursor.destroy();
    delete debugWindow.__longVpDebug;
    root.replaceChildren();
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onResume);
    document.removeEventListener("visibilitychange", onResume);
  };
  window.addEventListener("pagehide", onPageHide);
  return destroy;
}

function compact(v: number) { const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v)); }
function tzOffsetSec(sec: number, zone: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(sec * 1000)) o[p.type] = p.value;
  return (Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute) / 1000) - Math.floor(sec / 60) * 60;
}

