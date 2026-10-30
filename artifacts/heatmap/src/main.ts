import "./index.css";
import { ColumnCache } from "./data/cache.ts";
import { RealtimeClient, type ConnectionState, type HelloMessage, type SocketStatus } from "./data/socket.ts";
import { US_PER_SECOND, clampViewport, type Viewport, bestMidpoint } from "./domain.ts";
import { BOOK_OVERLAY_FRACTION, followStartUs, timeUsToX, xToTimeUs, zoomPriceAt, zoomTimeAt } from "./chart/coordinates.ts";
import { HeatmapRenderer, type DrawMetrics } from "./chart/renderer.ts";
import { formatAxisTicks, type DisplayZone } from "./chart/timezone.ts";
import { CurrentTradeState } from "./data/trade-aggregate.ts";
import { TradeOverlayRenderer } from "./chart/trade-overlay.ts";
import { CurrentBookRenderer } from "./chart/current-book.ts";
import { LayerScheduler } from "./chart/layer-scheduler.ts";
import { BigOrderFeed } from "./data/big-orders.ts";
import { BigOrderRenderer, visibleBigOrders } from "./chart/big-orders.ts";
import { FrameProfile } from "./chart/frame-profile.ts";
import { VpState } from "./data/vp.ts";
import { VpRenderer } from "./chart/vp.ts";
import { DeltaRenderer } from "./chart/delta.ts";
import { deltaBounds, deltaSeconds } from "./chart/delta-geometry.ts";
import { defaultDocument, fetchSettings, putSettings, resolveSettings, settingsChanges } from "./data/settings.ts";
import { SettingsRecovery } from "./data/settings-recovery.ts";
import type { SettingsDocument } from "./data/settings.ts";
import { mountSettingsUi } from "./components/settings-ui.ts";
import { LIVE_RESET_SEC, REPLAY_RESET_SEC, resetViewport } from "./chart/view-reset.ts";
import { boardGridTemplate } from "./chart/layout.ts";
import { AutoPriceScale, resetTimeViewport } from "./chart/axis-view.ts";
import { bindDoubleActivation } from "./chart/double-activation.ts";
import { isFootprintRoute, isLongVpRoute } from "./long-vp/view-math.ts";
import { loadView, saveView } from "./view-memory.ts";
import { viewSwitchHtml } from "./long-vp/nav.ts";
import { CrosshairOverlay } from "./chart/crosshair.ts";
import { ACTIVE_SYMBOL, initializeInstrumentUi } from "./instrument.ts";
import { DailyState } from "./data/daily.ts";
import { DailyIndicatorRenderer } from "./chart/daily-renderer.ts";

declare global {
  interface Window {
    readonly __heatmapDebug?: Readonly<HeatmapDebugSnapshot>;
    readonly __heatmapColumnDelivery?: RealtimeClient["columnDeliveries"];
    readonly __heatmapFrameStats?: ReturnType<FrameProfile["snapshot"]>;
    readonly __heatmapDeltaBars?: ReturnType<DeltaRenderer["snapshot"]>;
    readonly __heatmapTradeOverlay?: ReturnType<TradeOverlayRenderer["snapshot"]>;
    readonly __heatmapRecentTrades?: Readonly<Record<string, unknown>>;
  }
}

export interface HeatmapDebugSnapshot {
  crosshair: ReturnType<CrosshairOverlay["snapshot"]>;
  settings: ReturnType<typeof resolveSettings>;
  sharedColumns: ReturnType<BigOrderFeed["sharing"]>;
  delta: DeltaRenderer["metrics"];
  vp: VpRenderer["metrics"];
  bigOrders: BigOrderRenderer["metrics"] & {
    threshold: number | null; tracking: BigOrderFeed["tracker"]["metrics"];
    top: number; minSec: number; topInvalid: boolean; minSecInvalid: boolean;
    rebuildCount: number; orders: ReturnType<typeof visibleBigOrders>;
  };
  currentBook: CurrentBookRenderer["metrics"];
  overlayDrawCount: number;
  overlay: TradeOverlayRenderer["metrics"];
  bubbleMin: number;
  bubbleMinInvalid: boolean;
  currentPrice: number | null;
  replayHeadUs: number | null;
  depthDrawCount: number;
  traffic: RealtimeClient["traffic"];
  loadingRanges: number;
  drawBreakdown: DrawMetrics;
  connection: ConnectionState;
  viewport: Readonly<Viewport>;
  follow: boolean;
  rangeRequestCount: number;
  latestTimeUs: number | null;
  cachedColumns: number;
  cachedTrades: number;
  drawFps: number;
  drawMeanMs: number;
  drawMaxMs: number;
  aggregationMs: number;
  scaleMs: number;
  p99: number;
  receiveBytesPerMinute: number;
  partialRaster: boolean;
  repaintPixels: number;
  profileHits: number;
  recomputedColumns: number;
  rawLevelScans: number;
  cachedProfileBytes: number;
}

type Point = { x: number; y: number };

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");
initializeInstrumentUi();

// Screen switch: ?view=longvp mounts the long-term VP screen only; the heatmap (and its WebSocket) never starts.
if (isLongVpRoute(window.location.search)) {
  void import("./long-vp/app.ts").then(m => {
    const destroy = m.mountLongVp(root);
    window.addEventListener("market-switch", destroy, { once: true });
  })
    .catch(e => { root.textContent = `長期VP画面を読み込めませんでした：${e instanceof Error ? e.message : e}`; });
} else if (isFootprintRoute(window.location.search)) {
  // ?view=footprint: dedicated footprint screen with its own socket; heatmap never starts.
  void import("./footprint/app.ts").then(m => {
    const destroy = m.mountFootprint(root);
    window.addEventListener("market-switch", destroy, { once: true });
  })
    .catch(e => { root.textContent = `フットプリント画面を読み込めませんでした：${e instanceof Error ? e.message : e}`; });
} else runHeatmap(root);

function runHeatmap(root: HTMLElement): void {
document.title = `${ACTIVE_SYMBOL} | Order flow heatmap`;

root.innerHTML = `
  <div class="app-shell">
    <aside class="tool-rail" aria-label="Tools frame">
      <div class="brand-mark" aria-label="${ACTIVE_SYMBOL} instrument">${ACTIVE_SYMBOL}</div>
      <span class="rail-caption">Tools · Phase 9</span>
    </aside>
    <main class="workspace">
      <header class="masthead">
        <div class="instrument"><strong>${ACTIVE_SYMBOL} / DEPTH</strong><span>ONE-SECOND BOOK HISTORY</span></div>
        ${viewSwitchHtml("heatmap")}
        <div class="market-state" data-testid="connection-state" data-state="connecting" aria-live="polite">
          <i class="state-dot" aria-hidden="true"></i><span id="connection-label">CONNECTING</span>
        </div>
      </header>
      <section class="board" aria-label="${ACTIVE_SYMBOL} order-flow instrument panels">
        <section class="region heat-region" aria-label="Heatmap">
          <div class="heat-overlay"><strong>${ACTIVE_SYMBOL}</strong>DEPTH / 1s <span id="scale-value"></span></div>
          <canvas class="heat-canvas" id="heatmap" aria-label="${ACTIVE_SYMBOL} order-book depth heatmap. Horizontal axis is time; vertical axis is price in instrument ticks.">
            Canvas 2D heatmap. Depth data will be visible when the browser supports Canvas.
          </canvas>
          <canvas class="book-canvas current-book-overlay" id="current-book" aria-label="Current buy and sell quantities overlaid on the rightmost 20%"></canvas>
          <canvas class="trade-overlay" id="trade-overlay" aria-label="Trade price line, volume bubbles and current price"></canvas>
          <canvas class="trade-overlay" id="daily-vwap" aria-label="Daily session VWAP, yellow, unadjusted"></canvas>
          <div id="empty-state" class="state-message" role="status" aria-live="polite">Waiting for feed · no synthetic data</div>
          <div id="status-banner" class="status-banner" role="status" aria-live="polite"></div>
          <pre id="debug-panel" class="debug-panel" hidden></pre>
        </section>
        <section class="region price-region" aria-label="Price axis">
          <canvas class="axis-price" id="price-axis" aria-label="Shared price axis in NQ quarter-point increments."></canvas>
          <canvas class="trade-overlay vp-labels" id="vp-labels" aria-label="POC, VAH and VAL price labels"></canvas>
          <canvas class="trade-overlay" id="current-price-label" aria-hidden="true"></canvas>
        </section>
        <section class="region large-region" aria-label="Large orders frame">
          <canvas class="book-canvas" id="big-orders" aria-label="Persistent large order quantities by price, extending left from the right edge"></canvas>
          <span class="region-label">Large orders</span>
        </section>
        <section class="region vp-region" aria-label="Volume profile frame">
          <canvas class="book-canvas" id="volume-profile" aria-label="Session volume profile, white POC and orange 70 percent value area"></canvas>
          <span class="region-label">Volume profile</span><span id="vp-loading" class="region-hint" role="status">取り込み中</span>
        </section>
        <canvas class="vp-guides" id="vp-guides" aria-label="POC, VAH and VAL lines across large orders and volume profile"></canvas>
        <section class="region delta-region" aria-label="Delta histogram frame">
          <canvas class="book-canvas" id="delta" aria-label="Delta: interval buy quantity minus sell quantity. White positive, purple negative."></canvas>
          <span class="region-label">Delta</span>
        </section>
        <section class="region delta-scale-region" aria-label="Delta scale frame">
          <canvas class="book-canvas" id="delta-scale" aria-label="Delta maximum, zero, negative maximum and interval seconds"></canvas>
        </section>
        <section class="region large-lower-region" aria-label="Lower large orders frame">
          <span class="region-label">Large orders</span>
        </section>
        <section class="region vp-lower-region" aria-label="Lower volume profile frame">
          <span class="region-label">VP</span>
        </section>
        <div class="region time-region" id="time-axis" aria-label="Time axis in selected time zone"></div>
      </section>
    </main>
  </div>
`;

const board = document.querySelector<HTMLElement>(".board")!;
function applyLayout(): void {
  const visible = activeSettings.values.bigOrdersVisible;
  board.classList.toggle("big-hidden", !visible);
  board.style.gridTemplateColumns = boardGridTemplate(visible);
}
const canvas = required<HTMLCanvasElement>("heatmap");
const axisCanvas = required<HTMLCanvasElement>("price-axis");
const autoPriceLabel = document.createElement("span");
autoPriceLabel.className = "auto-price-label";
autoPriceLabel.textContent = "AUTO";
autoPriceLabel.hidden = true;
axisCanvas.parentElement!.append(autoPriceLabel);
const heatRegion = document.querySelector<HTMLElement>(".heat-region")!;
const timeAxis = required<HTMLDivElement>("time-axis");
const connectionLabel = required<HTMLSpanElement>("connection-label");
const connectionIndicator = document.querySelector<HTMLElement>(".market-state")!;
const emptyState = required<HTMLDivElement>("empty-state");
const statusBanner = required<HTMLDivElement>("status-banner");
const debugPanel = required<HTMLPreElement>("debug-panel");
const scaleValue = required<HTMLSpanElement>("scale-value");
const renderer = new HeatmapRenderer(canvas, axisCanvas, () => drawScheduler.request("heat"));
const cache = new ColumnCache();
const dailyState = new DailyState(ACTIVE_SYMBOL);
const dailyOptions = { vwap: true, cvd: true };
try {
  const stored = JSON.parse(sessionStorage.getItem("heatmap.daily-indicators") ?? "null");
  if (typeof stored?.vwap === "boolean") dailyOptions.vwap = stored.vwap;
  if (typeof stored?.cvd === "boolean") dailyOptions.cvd = stored.cvd;
} catch { /* Blocked tab storage never triggers a settings PUT. */ }
const dailyRegion = document.createElement("section");
dailyRegion.className = "region daily-cvd-region";
dailyRegion.innerHTML = '<canvas class="book-canvas" id="daily-cvd" aria-label="Daily CVD, buy minus sell cumulative quantity"></canvas>';
board.append(dailyRegion);
const dailyAxis = document.createElement("section");
dailyAxis.className = "region daily-cvd-axis";
dailyAxis.innerHTML = '<canvas class="book-canvas" id="daily-cvd-axis" aria-label="CVD quantity axis"></canvas>';
board.append(dailyAxis);
const dailyRenderer = new DailyIndicatorRenderer(required("daily-vwap"), required("daily-cvd"), required("daily-cvd-axis"));
const dailyControls = document.createElement("span");
dailyControls.className = "daily-controls";
dailyControls.innerHTML = '<button type="button" id="toggle-daily-vwap">VWAP</button><button type="button" id="toggle-daily-cvd">CVD</button><span id="daily-quality"></span>';
root.querySelector(".masthead")?.append(dailyControls);
function syncDailyOptions() {
  board.classList.toggle("daily-on", dailyOptions.cvd);
  dailyRegion.hidden = dailyAxis.hidden = !dailyOptions.cvd;
  for (const key of ["vwap", "cvd"] as const)
    required<HTMLButtonElement>(`toggle-daily-${key}`).setAttribute("aria-pressed", String(dailyOptions[key]));
}
syncDailyOptions();
for (const key of ["vwap", "cvd"] as const) {
  required(`toggle-daily-${key}`).addEventListener("click", () => {
    dailyOptions[key] = !dailyOptions[key]; syncDailyOptions();
    try { sessionStorage.setItem("heatmap.daily-indicators", JSON.stringify(dailyOptions)); } catch { /* Tab-only. */ }
    scheduleDraw(); renderTimeAxis();
  });
}
const bookRenderer = new CurrentBookRenderer(required<HTMLCanvasElement>("current-book"));
let settingsLoaded = false;
let settingsGeneration = 0;
let appliedUpdatedAt: number | null = null;
let settingsWarning = "";
let activeSettings = resolveSettings(defaultDocument(), window.location.search);
applyLayout();
let bigOptions = { top: { value: activeSettings.values.bigTopPct, invalid: activeSettings.invalid.includes("bigTop 無効") },
  minSec: { value: activeSettings.values.bigMinSec, invalid: activeSettings.invalid.includes("bigMinSec 無効") } };
const bigFeed = new BigOrderFeed(bigOptions.top.value);
const bigRenderer = new BigOrderRenderer(required<HTMLCanvasElement>("big-orders"));
const vpState = new VpState();
const vpRenderer = new VpRenderer(required<HTMLCanvasElement>("volume-profile"), () => drawScheduler.request("vp"),
  required<HTMLCanvasElement>("vp-guides"), required<HTMLCanvasElement>("vp-labels"));
const vpLoading = required<HTMLElement>("vp-loading");
const deltaRenderer = new DeltaRenderer(required<HTMLCanvasElement>("delta"), required<HTMLCanvasElement>("delta-scale"));
let profiledDeltaDraws = 0;
let profiledVpDraws = 0;
const overlayRenderer = new TradeOverlayRenderer(
  required<HTMLCanvasElement>("trade-overlay"),
  required<HTMLCanvasElement>("current-price-label"),
);
let bubbleMinimum = { value: activeSettings.values.bubbleMin, invalid: activeSettings.invalid.includes("bubbleMin 無効") };
const currentTrade = new CurrentTradeState();
const initialQuote = new CurrentTradeState();
let initialCutoffUs = 0;
let replayHeadUs: number | null = null;
let depthDrawCount = 0;
let overlayDrawCount = 0;
let displayZone: DisplayZone = "jst";
const debugMode = new URLSearchParams(window.location.search).get("debug") === "1";
if (debugMode) Object.defineProperty(window, "__heatmapDaily", {
  configurable: true,
  get: () => ({ ...dailyState.snapshot(), options: { ...dailyOptions }, metrics: { ...dailyRenderer.metrics } }),
});

let viewport: Viewport = {
  startUs: (Date.now() * 1_000) - LIVE_RESET_SEC * US_PER_SECOND,
  durationSec: LIVE_RESET_SEC,
  centerPriceTicks: 0,
  priceSpanTicks: 160,
};
const crosshair = new CrosshairOverlay(board, canvas, axisCanvas, timeAxis, () => viewport, () => displayZone,
  () => !document.querySelector("dialog[open]"));
let follow = true;
// Independent per-screen view memory: a paused (non-follow) heatmap view is restored; follow keeps today's reset.
const savedHeatView = loadView<{ viewport: Viewport; follow: boolean }>("heatmap", ACTIVE_SYMBOL);
if (savedHeatView && !savedHeatView.follow && Number.isFinite(savedHeatView.viewport?.startUs)
  && new URLSearchParams(window.location.search).get("mode") !== "replay"
  && savedHeatView.viewport.startUs > Date.now() * 1_000 - 7_000 * US_PER_SECOND) {
  viewport = clampViewport(savedHeatView.viewport); follow = false;
}
window.addEventListener("pagehide", () => saveView("heatmap", ACTIVE_SYMBOL, { viewport, follow }));
const autoPrice = new AutoPriceScale();
let autoPriceTimer: ReturnType<typeof setTimeout> | null = null;
let centeredOnData = false;
let receivedColumnRevision = 0;
let requestCount = 0;
let connection: ConnectionState = "connecting";
let latestStatus: SocketStatus | null = null;
const tradeAgeLabel = document.createElement("span");
tradeAgeLabel.id = "trade-age";
root.querySelector(".market-state")?.append(tradeAgeLabel);
let latestTradeHeadUs: number | null = null;
let pendingTradeTiming: { receivedAt: number; sentAtUs: number | null; recvUs: number; tsUs: number; seq: number } | null = null;
const latestPaintSamples: { receiveToPaintMs: number; serverSendToPaintMs: number | null; upstreamAgeMs: number; seq: number }[] = [];
let hello: HelloMessage | null = null;
let lastConnectionMessage = "";
let lastDataError = "";
let hasHello = false;
let bytesPerMinute = 0;
let drawSamples: { at: number; ms: number }[] = [];
let drawInstants: number[] = [];
let lastMetrics: DrawMetrics = renderer.metrics;
const frameProfile = new FrameProfile();
let pendingTimeAxisMs = 0;
let profiledBookDraws = 0, profiledBigDraws = 0;
let pointerPoints = new Map<number, Point>();
let pointerStart: { id: number; x: number; y: number; view: Viewport } | null = null;
let pinchStart: { distance: number; midpointX: number; anchorUs: number; view: Viewport } | null = null;
let priceDrag: { id: number; y: number; view: Viewport } | null = null;
let lastTap: { at: number; x: number; y: number } | null = null;
const tapStarts = new Map<number, { x: number; y: number; at: number }>();

const client = new RealtimeClient(cache, {
  shareColumn: c => bigFeed.shareColumn(c),
  onConnection: (state, message) => {
    connection = state;
    lastConnectionMessage = message ?? "";
    updateStatus();
    updateDebugPanel();
  },
  onHello: (message) => {
    void settingsRecovery.connected();
    hello = message;
    vpState.reset(); vpLoading.hidden = false;
    currentTrade.reset(); initialQuote.reset();
    latestTradeHeadUs = null; pendingTradeTiming = null;
    dailyState.reset();
    initialCutoffUs = (message.mode === "replay" ? replayFromSec()! * US_PER_SECOND
      : Math.floor(message.serverTimeUs / US_PER_SECOND) * US_PER_SECOND) - 1;
    bigFeed.beginInitial(initialCutoffUs);
    replayHeadUs = message.mode === "replay" ? initialCutoffUs + 1 : null;
    lastDataError = "";
    if (!hasHello && message.mode === "replay") viewport = { ...viewport, durationSec: REPLAY_RESET_SEC };
    if (!hasHello && !follow) hasHello = true;
    else if (!hasHello || follow) {
      const replayFrom = replayFromSec();
      const endUs = message.mode === "replay" && replayFrom !== null
        ? replayFrom * US_PER_SECOND
        : message.serverTimeUs;
      viewport = { ...viewport, startUs: endUs - (1 - BOOK_OVERLAY_FRACTION) * viewport.durationSec * US_PER_SECOND };
      hasHello = true;
    }
    positionPriceFromData();
    syncRetentionAndRequests();
    updateStatus();
    renderTimeAxis();
    scheduleDraw();
  },
  onStatus: (message) => {
    latestStatus = message;
    updateStatus();
  },
  onColumns: (_columns, _kind, reqId) => {
    bigFeed.accept(_columns, _kind, reqId);
    if (_kind === 1 && !client.initialLoading) drawScheduler.request("big");
    if (_kind === 1 && replayHeadUs !== null) {
      for (const c of _columns) replayHeadUs = Math.max(replayHeadUs, c.timeUs + US_PER_SECOND);
    }
    receivedColumnRevision += 1;
    if (follow && !client.initialLoading && cache.latestTimeUs !== null) {
      alignFollowToPhysicalPixel();
    }
    if (!client.initialLoading) positionPriceFromData();
    syncRetentionAndRequests();
    updateStatus();
    renderTimeAxis();
    scheduleDraw();
    updateDebugPanel();
  },
  onLatestBook: (column) => {
    cache.setLatestBook(column);
    const wasCentered = centeredOnData;
    positionPriceFromData();
    if (!wasCentered && centeredOnData) scheduleDraw();
    else drawScheduler.request("book");
  },
  onRangeComplete: (reqId) => {
    if (reqId === 0) {
      bigFeed.completeInitial();
      if (!currentTrade.trade && initialQuote.trade) currentTrade.accept([initialQuote.trade]);
      if (follow && cache.latestTimeUs !== null) alignFollowToPhysicalPixel();
      positionPriceFromData();
    }
    syncRetentionAndRequests(); updateStatus(); renderTimeAxis(); scheduleDraw(); updateDebugPanel();
  },
  onTrades: () => {
    scheduleDraw(false);
    updateDebugPanel();
  },
  onVp: (message) => {
    vpState.accept(message);
    vpLoading.hidden = !vpState.loading;
    drawScheduler.request("vp");
  },
  onDaily: message => {
    if (dailyState.accept(message)) drawScheduler.request("daily");
  },
  onTradeBatch: (trades, reqId, timing) => {
    if (reqId === 0) initialQuote.accept(trades, initialCutoffUs);
    else if (reqId === null) {
      currentTrade.accept(trades);
      if (replayHeadUs !== null) for (const t of trades) replayHeadUs = Math.max(replayHeadUs, t.tsUs);
      for (const t of trades) latestTradeHeadUs = Math.max(latestTradeHeadUs ?? 0, t.tsUs);
      if (timing && trades.length) {
        const last = trades.at(-1)!;
        pendingTradeTiming = { ...timing, recvUs: last.recvUs, tsUs: last.tsUs, seq: last.seq };
      }
      // A forming second and an unfinalized/missing book cannot hold the price
      // position back. Browsing remains pinned; depth raster is not requested.
      const oldStart = viewport.startUs;
      if (follow) alignFollowToPhysicalPixel();
      if (oldStart !== viewport.startUs) {
        // Shift the existing depth bitmap only; no P99, recolor or history scan.
        // Its confirmed columns keep their actual time while trades lead it.
        const ctx = canvas.getContext("2d");
        if (ctx && canvas.width && canvas.height) {
          const dx = (oldStart - viewport.startUs) / (viewport.durationSec * US_PER_SECOND) * canvas.width;
          ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "copy";
          ctx.drawImage(canvas, dx, 0); ctx.restore();
        }
        renderTimeAxis();
      }
      positionPriceFromData();
      updateTradeAge();
    }
  },
  onError: (message) => {
    lastDataError = message;
    updateStatus();
  },
  onReplayEnded: () => {
    updateStatus();
    scheduleDraw();
  },
  onBytesPerMinute: (bytes) => {
    bytesPerMinute = bytes;
  },
  onRangeRequest: () => {
    requestCount += 1;
    updateDebugPanel();
  },
});

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function replayFromSec(): number | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("from");
  if (params.get("mode") !== "replay" || !value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positionPriceFromData(): void {
  // A paused user may already have positioned/zoomed an initially empty view.
  // A later history response must not silently recenter that view.
  if (centeredOnData || !follow) return;
  const midpoint = currentTrade.trade?.price ?? bestMidpoint(cache.latestBook ?? cache.columns.at(-1));
  if (midpoint === null) return;
  viewport = { ...viewport, centerPriceTicks: midpoint };
  centeredOnData = true;
}

function syncRetentionAndRequests(): void {
  const toUs = viewport.startUs + viewport.durationSec * US_PER_SECOND;
  cache.setRetentionAnchor(viewport.startUs, toUs, follow, cache.latestTimeUs);
  const requestEnd = follow && cache.latestTimeUs !== null ? Math.min(toUs, cache.latestTimeUs + US_PER_SECOND) : toUs;
  const bounds = deltaBounds(viewport, deltaSeconds(viewport.durationSec, Math.max(1, canvas.getBoundingClientRect().width)));
  client.requestVisible(bounds.fromUs / US_PER_SECOND,
    Math.ceil(Math.min(bounds.toUs, follow ? requestEnd : bounds.toUs) / US_PER_SECOND));
}

function alignFollowToPhysicalPixel(): void {
  const head = Math.max(cache.latestTimeUs ?? 0, latestTradeHeadUs ?? 0);
  if (!head) return;
  const width = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
  viewport.startUs = followStartUs(head, viewport.durationSec, width);
}
function setViewport(next: Viewport, pan = false): void {
  const clamped = clampViewport(next);
  viewport = autoPrice.enabled ? { ...clamped, centerPriceTicks: viewport.centerPriceTicks,
    priceSpanTicks: viewport.priceSpanTicks } : clamped;
  if (pan) follow = false;
  if (follow) alignFollowToPhysicalPixel();
  syncRetentionAndRequests();
  renderTimeAxis();
  scheduleDraw();
  updateStatus();
}

function resetView(): void {
  disableAutoPrice();
  const reference = cache.latestTimeUs !== null ? cache.latestTimeUs
    : hello?.serverTimeUs ?? Date.now() * 1_000;
  const midpoint = currentTrade.trade?.price ?? initialQuote.trade?.price ?? bestMidpoint(cache.latestBook ?? cache.columns.at(-1));
  if (midpoint !== null) {
    viewport.centerPriceTicks = midpoint;
    centeredOnData = true;
  }
  follow = true;
  viewport = resetViewport(hello?.mode === "replay" ? replayHeadUs ?? reference : reference,
    viewport.centerPriceTicks, Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1))),
    hello?.mode === "replay" ? "replay" : "live");
  refreshVisibleRange();
  renderTimeAxis();
  scheduleDraw();
  updateStatus();
}

function disableAutoPrice(): void {
  autoPrice.disable();
  autoPriceLabel.hidden = true;
  if (autoPriceTimer !== null) clearTimeout(autoPriceTimer);
  autoPriceTimer = null;
}

function requestAutoPrice(): void {
  autoPrice.invalidate();
  if (autoPriceTimer !== null) return;
  const delay = autoPrice.delay(performance.now());
  if (delay === null) return;
  autoPriceTimer = setTimeout(() => {
    autoPriceTimer = null;
    const next = autoPrice.fit(performance.now(), viewport, cache.tradeAggregation,
      currentTrade.trade?.price ?? initialQuote.trade?.price
        ?? bestMidpoint(cache.latestBook ?? cache.columns.at(-1)) ?? viewport.centerPriceTicks);
    if (!next) { requestAutoPrice(); return; }
    viewport = next;
    centeredOnData = true;
    drawScheduler.request("all");
  }, delay);
}

function enableAutoPrice(): void {
  autoPrice.enable();
  autoPriceLabel.hidden = false;
  requestAutoPrice();
}

function resetTimeView(): void {
  const reference = cache.latestTimeUs ?? hello?.serverTimeUs ?? Date.now() * 1_000;
  viewport = resetTimeViewport(viewport, hello?.mode === "replay" ? replayHeadUs ?? reference : reference,
    Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1))),
    hello?.mode === "replay" ? "replay" : "live");
  follow = true;
  refreshVisibleRange();
  renderTimeAxis();
  scheduleDraw();
  updateStatus();
}

const drawScheduler = new LayerScheduler(draw => requestAnimationFrame(draw), {
  daily: () => {
    const points = dailyState.series(), state = dailyState.snapshot();
    dailyRenderer.draw(points, viewport, { ...dailyOptions, historyRevision: dailyState.historyRevision,
      partial: true, unknown: state.unknownQuantity > 0 });
    required("daily-quality").textContent = !state.available ? "日次配信未対応／未受信"
      : `${state.loading ? "途中集計" : "取得分"}・未調整${state.unknownQuantity ? `・限月不明 ${state.unknownQuantity}枚` : ""}`;
  },
  depth: (redrawAxes) => {
      const columns = cache.columns;
      renderer.setTrades(cache.tradeAggregation);
      renderer.draw(columns, viewport, receivedColumnRevision, displayZone, columns.length > 0, redrawAxes);
      depthDrawCount++;
  },
  book: () => bookRenderer.draw(cache.latestBook, viewport, renderer.metrics.p99,
    cache.latestTimeUs === null ? null : cache.latestTimeUs + US_PER_SECOND,
    { lower: renderer.metrics.lower ?? 0, gamma: renderer.metrics.gamma ?? 1, style: renderer.heatStyle }),
  // Hidden column: tracking continues in bigFeed, only the drawing is skipped (SPEC 7.3).
  big: () => { if (activeSettings.values.bigOrdersVisible) bigRenderer.draw(bigFeed.tracker.snapshot(), viewport, bigOptions.minSec.value); },
  vp: () => vpRenderer.draw(vpState, viewport),
  delta: () => deltaRenderer.draw(cache.tradeAggregation, viewport,
    replayHeadUs ?? Math.max((cache.latestTimeUs ?? 0) + US_PER_SECOND, currentTrade.trade?.tsUs ?? 0),
    initialCutoffUs + 1),
  trades: () => {
    overlayRenderer.draw(cache.tradeAggregation, viewport, bubbleMinimum.value,
      currentTrade.trade?.price ?? null, replayHeadUs ?? Math.max(
        (cache.latestTimeUs ?? 0) + US_PER_SECOND, currentTrade.trade?.tsUs ?? 0), activeSettings.values.bubbleScale);
    overlayDrawCount++;
  },
  after: (redrewDepth, drawStart, redrewTrades) => {
    if (redrewTrades && pendingTradeTiming && !document.hidden) {
      const t = pendingTradeTiming; pendingTradeTiming = null;
      latestPaintSamples.push({ receiveToPaintMs: performance.now() - t.receivedAt,
        serverSendToPaintMs: t.sentAtUs === null ? null : Date.now() - t.sentAtUs / 1000,
        upstreamAgeMs: (t.recvUs - t.tsUs) / 1000, seq: t.seq });
      if (latestPaintSamples.length > 1000) latestPaintSamples.shift();
    }
    crosshair.request();
    if (debugMode) {
      const depthMetrics = renderer.metrics;
      const frameMs = performance.now() - drawStart;
      frameProfile.record({ at: performance.now(), totalMs: frameMs + pendingTimeAxisMs,
        heatmapMs: redrewDepth ? Math.max(0, depthMetrics.drawMs - (depthMetrics.axisMs ?? 0)) : 0,
        priceAxisMs: redrewDepth ? depthMetrics.axisMs ?? 0 : 0, timeAxisMs: pendingTimeAxisMs,
        tradesMs: redrewTrades ? overlayRenderer.metrics.overlayMs : 0,
        bookMs: bookRenderer.metrics.drawCount !== profiledBookDraws ? bookRenderer.metrics.drawMs : 0,
        bigMs: bigRenderer.metrics.drawCount !== profiledBigDraws ? bigRenderer.metrics.drawMs : 0,
        vpMs: vpRenderer.metrics.drawCount !== profiledVpDraws ? vpRenderer.metrics.drawMs : 0,
        deltaMs: deltaRenderer.metrics.drawCount !== profiledDeltaDraws ? deltaRenderer.metrics.drawMs : 0,
        depth: redrewDepth, aggregationMs: redrewDepth ? depthMetrics.aggregationMs : 0,
        scaleMs: redrewDepth ? depthMetrics.scaleMs : 0,
        rasterMs: redrewDepth ? depthMetrics.rasterMs ?? 0 : 0,
        colorMs: redrewDepth ? depthMetrics.colorMs ?? 0 : 0,
        uploadMs: redrewDepth ? depthMetrics.uploadMs ?? 0 : 0,
        tileSyncMs: redrewDepth ? depthMetrics.tileSyncMs ?? 0 : 0 });
      profiledBookDraws = bookRenderer.metrics.drawCount; profiledBigDraws = bigRenderer.metrics.drawCount;
      profiledVpDraws = vpRenderer.metrics.drawCount;
      profiledDeltaDraws = deltaRenderer.metrics.drawCount;
      pendingTimeAxisMs = 0;
    }
    // Preserve the Phase 4 frame sample population; book-only frames have separate metrics.
    if (redrewDepth || redrewTrades) {
    lastMetrics = { ...renderer.metrics,
      ...(redrewDepth ? {} : { rasterRebuilt: false, aggregationMs: 0, scaleMs: 0, rasterMs: 0,
        tileSyncMs: 0, colorMs: 0, uploadMs: 0, axisMs: 0, partialRaster: false, repaintPixels: 0,
        rawLevelScans: 0, recomputedColumns: 0 }),
      drawMs: performance.now() - drawStart };
    const now = performance.now();
    drawInstants.push(now);
    drawSamples.push({ at: now, ms: lastMetrics.drawMs });
    drawSamples = drawSamples.filter((sample) => now - sample.at < 30_000).slice(-120);
    drawInstants = drawInstants.filter((time) => now - time < 1_000);
    const s = activeSettings.values;
    const upperMode = s.heatUpperMode === "auto" ? `上位${s.heatTopPct}%` : "枚数指定";
    const lower = s.heatLowerMode === "off" ? "なし" : `${lastMetrics.lower ?? 0}（${s.heatLowerMode === "pct" ? `下位${s.heatLowerPct}%` : "枚数指定"}）`;
    scaleValue.textContent = cache.size ? `上限 ${lastMetrics.p99}（${upperMode}）／下限 ${lower}` : "";
    }
    if (debugMode) updateDebugPanel();
  },
}, true);

function scheduleDraw(redrawDepth = true): void {
  if (!settingsLoaded) return;
  requestAutoPrice();
  drawScheduler.request(redrawDepth ? "all" : "trades");
  if (!redrawDepth) drawScheduler.request("delta");
}

function renderTimeAxis(): void {
  if (!settingsLoaded) return;
  crosshair.request();
  const started = performance.now();
  const rect = heatRegion.getBoundingClientRect();
  const ticks = formatAxisTicks(viewport.startUs, viewport.durationSec, rect.width, displayZone);
  timeAxis.replaceChildren();
  if (ticks.length === 0) { pendingTimeAxisMs += performance.now() - started; return; }
  const width = Math.max(1, rect.width);
  for (const tick of ticks) {
    const label = document.createElement("span");
    label.textContent = tick.label;
    label.style.position = "absolute";
    label.style.left = `${Math.max(0, Math.min(100, (timeUsToX(tick.timeUs, viewport, width) / width) * 100))}%`;
    label.style.transform = tick.timeUs - viewport.startUs < 20_000_000
      ? "translateX(0)" : tick.timeUs > viewport.startUs + viewport.durationSec * US_PER_SECOND - 20_000_000
        ? "translateX(-100%)" : "translateX(-50%)";
    timeAxis.append(label);
  }
  pendingTimeAxisMs += performance.now() - started;
}

function updateTradeAge(): void {
  tradeAgeLabel.textContent = !currentTrade.trade ? "" : replayHeadUs !== null ? "REPLAY"
    : `DATA AGE ${Math.max(0, (Date.now() * 1000 - currentTrade.trade.tsUs) / 1e6).toFixed(1)}s`;
}

function updateStatus(): void {
  updateTradeAge();
  connectionIndicator.dataset.state = connection === "reconnecting" ? "connecting"
    : connection === "replay-ended" ? "connected" : connection;
  const text = connection === "connected"
    ? (hello?.mode === "replay" ? "REPLAY" : "CONNECTED")
    : connection === "replay-ended" ? "REPLAY ENDED"
      : connection === "error" ? "CONNECTION ERROR"
        : connection === "reconnecting" ? "RECONNECTING"
          : "CONNECTING";
  connectionLabel.textContent = text;
  const statusText = extractUpstreamStatus(latestStatus);
  const parts = [
    settingsWarning,
    client.loadingRangeCount ? `Loading ${client.loadingRangeCount} range(s)` : "",
    lastConnectionMessage,
    statusText,
    lastDataError ? `Data message: ${lastDataError}` : "",
  ].filter(Boolean);
  statusBanner.textContent = parts.join(" · ");

  if (cache.size > 0) {
    emptyState.hidden = true;
    return;
  }
  emptyState.hidden = false;
  if (connection === "replay-ended") emptyState.textContent = "Replay complete · end of stored interval";
  else if (connection === "error") emptyState.textContent = lastConnectionMessage || "Connection failed · retrying";
  else if (connection === "reconnecting") emptyState.textContent = "Connection interrupted · reconnecting";
  else if (connection === "connected") emptyState.textContent = "Connected · waiting for confirmed depth columns";
  else emptyState.textContent = "Waiting for feed · no synthetic data";
}

function extractUpstreamStatus(status: SocketStatus | null): string {
  if (!status || !status.status || typeof status.status !== "object") return "";
  const body = status.status;
  const upstream = body.upstream;
  if (upstream && typeof upstream === "object") {
    const record = upstream as Record<string, unknown>;
    if (typeof record.state === "string") return `Upstream ${record.state}`;
    if (typeof record.connected === "boolean") return `Upstream ${record.connected ? "connected" : "disconnected"}`;
  }
  return "";
}

function updateDebugPanel(): void {
  if (!debugMode) return;
  bytesPerMinute = client.bytesPerMinute;
  const now = performance.now();
  const fps = drawInstants.filter((time) => now - time < 1_000).length;
  const sample = drawSamples.slice(-30).map((entry) => entry.ms);
  const mean = sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : 0;
  const maximum = sample.length ? Math.max(...sample) : 0;
  debugPanel.hidden = false;
  debugPanel.textContent = `${fps} draw/s · ${mean.toFixed(2)} / ${maximum.toFixed(2)} ms
${cache.size.toLocaleString()} columns · steady ${(bytesPerMinute / 1_024).toFixed(1)} KiB/min (expanded)
initial ${(client.traffic.initialBytes / 1_024).toFixed(1)} KiB · ${client.traffic.initialElapsedMs ?? "loading"} ms
range ${(client.traffic.rangeBytes / 1_024).toFixed(1)} KiB · ${client.traffic.extensions || "no compression"} · expanded bytes
${connection.toUpperCase()} · ${follow ? "FOLLOW" : "BROWSE"} · ${requestCount} range
${lastMetrics.lowerAdjusted ? "下限を上限の手前に合わせた" : ""}
${overlayRenderer.metrics.bubbleCount} bubbles · min ${bubbleMinimum.value}${bubbleMinimum.invalid ? " · bubbleMin 無効" : ""}
line ${overlayRenderer.metrics.lineMs.toFixed(2)} / bubble ${overlayRenderer.metrics.bubbleMs.toFixed(2)} ms
book ${bookRenderer.metrics.meanMs.toFixed(2)} / ${bookRenderer.metrics.maxMs.toFixed(2)} ms (mean / max, last 30)
book ${bookRenderer.metrics.drawCount} / depth ${depthDrawCount} / overlay ${overlayDrawCount} draws
VP ${vpRenderer.metrics.prices} prices · POC ${vpRenderer.metrics.poc ?? "none"} · VA ${vpRenderer.metrics.low ?? "none"}–${vpRenderer.metrics.high ?? "none"}
VP ${vpRenderer.metrics.meanMs.toFixed(2)} / ${vpRenderer.metrics.maxMs.toFixed(2)} ms · ${vpState.loading ? "取り込み中" : "ready"}
Delta ${deltaRenderer.metrics.seconds}s · ${deltaRenderer.metrics.visibleCount} bars · max |Δ| ${deltaRenderer.metrics.maximum}
Delta ${deltaRenderer.metrics.meanMs.toFixed(2)} / ${deltaRenderer.metrics.maxMs.toFixed(2)} ms · ${deltaRenderer.metrics.omittedCount} incomplete
big ${bigRenderer.metrics.visibleCount} · threshold ${bigFeed.tracker.snapshot().threshold ?? "none"} · top ${bigOptions.top.value}% · min ${bigOptions.minSec.value}s${bigOptions.top.invalid ? " · bigTop 無効" : ""}${bigOptions.minSec.invalid ? " · bigMinSec 無効" : ""}
big decision ${bigFeed.tracker.metrics.decisionMs.toFixed(2)} ms · draw ${bigRenderer.metrics.meanMs.toFixed(2)} / ${bigRenderer.metrics.maxMs.toFixed(2)} ms
 big ${bigRenderer.metrics.drawCount} draws · longest ${bigRenderer.metrics.longestSec}s
${Object.entries(activeSettings.values).map(([key, value]) => `${key} ${value} (${activeSettings.sources[key as keyof typeof activeSettings.sources]})`).join(" · ")}`;
}

function debugSnapshot(): HeatmapDebugSnapshot {
  const now = performance.now();
  const sample = drawSamples.slice(-30).map((entry) => entry.ms);
  return Object.freeze({
    crosshair: crosshair.snapshot(),
    settings: structuredClone(activeSettings),
    sharedColumns: bigFeed.sharing(cache.columns),
    delta: { ...deltaRenderer.metrics },
    vp: vpRenderer.metrics,
    bigOrders: { ...bigRenderer.metrics, threshold: bigFeed.tracker.snapshot().threshold,
      tracking: { ...bigFeed.tracker.metrics }, top: bigOptions.top.value, minSec: bigOptions.minSec.value,
      topInvalid: bigOptions.top.invalid, minSecInvalid: bigOptions.minSec.invalid,
      rebuildCount: bigFeed.tracker.metrics.rebuildCount,
      orders: visibleBigOrders(bigFeed.tracker.snapshot(), viewport, bigOptions.minSec.value) },
    currentBook: { ...bookRenderer.metrics },
    overlayDrawCount,
    overlay: { ...overlayRenderer.metrics },
    bubbleMin: bubbleMinimum.value,
    bubbleMinInvalid: bubbleMinimum.invalid,
    currentPrice: currentTrade.trade?.price ?? null,
    replayHeadUs,
    depthDrawCount,
    traffic: client.traffic,
    loadingRanges: client.loadingRangeCount,
    drawBreakdown: lastMetrics,
    connection,
    viewport: Object.freeze({ ...viewport }),
    follow,
    rangeRequestCount: requestCount,
    latestTimeUs: cache.latestTimeUs,
    cachedColumns: cache.size,
    cachedTrades: cache.tradeCount,
    drawFps: drawInstants.filter((time) => now - time < 1_000).length,
    drawMeanMs: sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : 0,
    drawMaxMs: sample.length ? Math.max(...sample) : 0,
    aggregationMs: lastMetrics.aggregationMs,
    scaleMs: lastMetrics.scaleMs,
    p99: lastMetrics.p99,
    receiveBytesPerMinute: client.bytesPerMinute,
    partialRaster: lastMetrics.partialRaster ?? false,
    repaintPixels: lastMetrics.repaintPixels ?? 0,
    profileHits: lastMetrics.profileHits ?? 0,
    recomputedColumns: lastMetrics.recomputedColumns ?? 0,
    rawLevelScans: lastMetrics.rawLevelScans ?? 0,
    cachedProfileBytes: lastMetrics.cachedProfileBytes ?? 0,
  });
}

function columnDeliverySnapshot() { return client.columnDeliveries; }
/** On-demand evidence only; bounded output, never called by the animation loop. */
function recentTradeSnapshot() {
  const toUs = Math.max(currentTrade.trade?.tsUs ?? 0, (cache.latestTimeUs ?? 0) + US_PER_SECOND);
  const fromUs = Math.floor(toUs / US_PER_SECOND) * US_PER_SECOND - 10 * US_PER_SECOND;
  return { fromUs, toUs, revision: cache.tradeAggregation.revision,
    trades: cache.tradeAggregation.trades.filter(t => t.tsUs >= fromUs),
    cells: cache.tradeAggregation.cells(fromUs, toUs + US_PER_SECOND),
    lastPrices: cache.tradeAggregation.lastPrices(fromUs, toUs + 1) };
}
if (debugMode) {
  Object.defineProperty(window, "__heatmapRecentTrades", { get: recentTradeSnapshot });
  Object.defineProperty(window, "__heatmapTradeOverlay", { get: () => overlayRenderer.snapshot() });
  Object.defineProperty(window, "__heatmapDeltaBars", { get: () => deltaRenderer.snapshot() });
  Object.defineProperty(window, "__heatmapLatency", { configurable: true, get: () => latestPaintSamples.slice() });
  Object.defineProperty(window, "__heatmapFrameStats", { get: () => frameProfile.snapshot() });
  Object.defineProperty(window, "__heatmapColumnDelivery", { get: columnDeliverySnapshot });
  Object.defineProperty(window, "__heatmapDebug", {
    configurable: false,
    enumerable: true,
    get: debugSnapshot,
  });
  window.setInterval(updateDebugPanel, 1_000);
}

function localPoint(event: PointerEvent, element: HTMLElement): Point {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pointerDown(event: PointerEvent): void {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  const point = localPoint(event, canvas);
  canvas.setPointerCapture(event.pointerId);
  pointerPoints.set(event.pointerId, point);
  tapStarts.set(event.pointerId, { ...point, at: performance.now() });
  if (pointerPoints.size === 2) {
    tapStarts.clear();
    lastTap = null;
    const points = [...pointerPoints.values()];
    const midpointX = (points[0]!.x + points[1]!.x) / 2;
    pinchStart = {
      distance: Math.max(1, Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y)),
      midpointX,
      anchorUs: xToTimeUs(midpointX, viewport, Math.max(1, canvas.clientWidth)),
      view: { ...viewport },
    };
    pointerStart = null;
    return;
  }
  pointerStart = { id: event.pointerId, x: point.x, y: point.y, view: { ...viewport } };
}

function pointerMove(event: PointerEvent): void {
  if (!pointerPoints.has(event.pointerId)) return;
  const point = localPoint(event, canvas);
  pointerPoints.set(event.pointerId, point);
  const tapStart = tapStarts.get(event.pointerId);
  if (tapStart && Math.hypot(point.x - tapStart.x, point.y - tapStart.y) > 8) tapStarts.delete(event.pointerId);
  if (pointerPoints.size >= 2 && pinchStart) {
    const points = [...pointerPoints.values()];
    const distance = Math.max(1, Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y));
    const midpointX = (points[0]!.x + points[1]!.x) / 2;
    const factor = pinchStart.distance / distance;
    const zoomed = zoomTimeAt(pinchStart.view, pinchStart.anchorUs, factor);
    const midpointShift = (midpointX - pinchStart.midpointX) / Math.max(1, canvas.clientWidth)
      * zoomed.durationSec * US_PER_SECOND;
    // In follow mode, a pinch zoom keeps the latest column at its fixed anchor.
    // Browsing retains the normal midpoint translation; one-pointer pan exits follow.
    setViewport({ ...zoomed, startUs: zoomed.startUs - midpointShift });
    return;
  }
  if (!pointerStart || pointerStart.id !== event.pointerId) return;
  const dx = point.x - pointerStart.x;
  const width = Math.max(1, canvas.clientWidth);
  setViewport({ ...pointerStart.view, startUs: pointerStart.view.startUs - (dx / width) * pointerStart.view.durationSec * US_PER_SECOND }, true);
}

function pointerUp(event: PointerEvent): void {
  const point = pointerPoints.get(event.pointerId);
  const tapStart = tapStarts.get(event.pointerId);
  tapStarts.delete(event.pointerId);
  pointerPoints.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (pointerPoints.size < 2) pinchStart = null;
  if (pointerPoints.size === 1) {
    const [id, remaining] = [...pointerPoints.entries()][0]!;
    pointerStart = { id, x: remaining.x, y: remaining.y, view: { ...viewport } };
  } else pointerStart = null;
  if (point && tapStart && event.type !== "pointercancel" && event.pointerType === "touch" && performance.now() - tapStart.at < 320) {
    const now = performance.now();
    if (lastTap && now - lastTap.at < 320 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 26) {
      resetView();
      lastTap = null;
    } else lastTap = { at: now, x: point.x, y: point.y };
  }
}

function refreshVisibleRange(): void {
  const toUs = viewport.startUs + viewport.durationSec * US_PER_SECOND;
  cache.removeCoverage(Math.floor(viewport.startUs / US_PER_SECOND), Math.ceil(toUs / US_PER_SECOND));
  syncRetentionAndRequests();
}

function wheel(event: WheelEvent): void {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const anchorUs = xToTimeUs(x, viewport, Math.max(1, rect.width));
  const factor = Math.exp(Math.max(-2, Math.min(2, event.deltaY * 0.0015)));
  setViewport(zoomTimeAt(viewport, anchorUs, factor));
}

function pricePointerDown(event: PointerEvent): void {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  event.preventDefault();
  const point = localPoint(event, axisCanvas);
  axisCanvas.setPointerCapture(event.pointerId);
  priceDrag = { id: event.pointerId, y: point.y, view: { ...viewport } };
}

function pricePointerMove(event: PointerEvent): void {
  if (!priceDrag || priceDrag.id !== event.pointerId) return;
  const point = localPoint(event, axisCanvas);
  if (Math.abs(point.y - priceDrag.y) === 0) return;
  disableAutoPrice();
  const factor = Math.exp(Math.max(-2, Math.min(2, (point.y - priceDrag.y) * 0.008)));
  setViewport(zoomPriceAt(priceDrag.view, priceDrag.view.centerPriceTicks, factor));
}

function pricePointerUp(event: PointerEvent): void {
  if (priceDrag?.id !== event.pointerId) return;
  if (axisCanvas.hasPointerCapture(event.pointerId)) axisCanvas.releasePointerCapture(event.pointerId);
  priceDrag = null;
}

canvas.addEventListener("pointerdown", pointerDown);
canvas.addEventListener("pointermove", pointerMove);
canvas.addEventListener("pointerup", pointerUp);
canvas.addEventListener("pointercancel", pointerUp);
canvas.addEventListener("wheel", wheel, { passive: false });
canvas.addEventListener("dblclick", resetView);
axisCanvas.addEventListener("pointerdown", pricePointerDown);
axisCanvas.addEventListener("pointermove", pricePointerMove);
axisCanvas.addEventListener("pointerup", pricePointerUp);
axisCanvas.addEventListener("pointercancel", pricePointerUp);
const clearAxisGestures = [
  bindDoubleActivation(axisCanvas, enableAutoPrice),
  bindDoubleActivation(timeAxis, resetTimeView),
  bindDoubleActivation(document.querySelector<HTMLElement>(".large-region")!, resetView),
  bindDoubleActivation(document.querySelector<HTMLElement>(".vp-region")!, resetView),
];
window.addEventListener("resize", () => {
  if (follow) alignFollowToPhysicalPixel();
  renderTimeAxis();
  scheduleDraw();
});
const resizeObserver = new ResizeObserver(() => {
  if (follow) alignFollowToPhysicalPixel();
  renderTimeAxis();
  scheduleDraw();
});
resizeObserver.observe(heatRegion);

const settingsUi = mountSettingsUi(document.querySelector<HTMLElement>(".tool-rail")!, {
  load: fetchSettings, save: putSettings, onSaved: applySettings, onReset: resetView,
  overridden: activeSettings.overridden,
  onModalChange: (open) => {
    if (!open) return;
    crosshair.hide();
    for (const clear of clearAxisGestures) clear();
    for (const id of pointerPoints.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (priceDrag && axisCanvas.hasPointerCapture(priceDrag.id)) axisCanvas.releasePointerCapture(priceDrag.id);
    pointerPoints.clear(); tapStarts.clear(); pointerStart = pinchStart = priceDrag = lastTap = null;
  },
});
// The native modal makes the workspace inert; rendering/feed processing continue.
void settingsUi;

function applySettings(doc: SettingsDocument): void {
  // A delayed response from an older PUT must not undo a newer successful PUT.
  if (doc.updatedAt !== null && appliedUpdatedAt !== null && doc.updatedAt < appliedUpdatedAt) return;
  appliedUpdatedAt = doc.updatedAt;
  settingsGeneration++;
  const next = resolveSettings(doc, window.location.search);
  const change = settingsChanges(activeSettings.values, next.values);
  activeSettings = next;
  bubbleMinimum = { value: next.values.bubbleMin, invalid: next.invalid.includes("bubbleMin 無効") };
  bigOptions = { top: { value: next.values.bigTopPct, invalid: next.invalid.includes("bigTop 無効") },
    minSec: { value: next.values.bigMinSec, invalid: next.invalid.includes("bigMinSec 無効") } };
  displayZone = next.values.timeZone === "America/Chicago" ? "ct" : "jst";
  settingsWarning = "";
  if (change.heat) { renderer.setScaleOptions(next.values); if (settingsLoaded) drawScheduler.request("heat"); }
  if (change.bubbles && settingsLoaded) drawScheduler.request("trades");
  if (change.style) { renderer.setStyle(next.values.heatStyle); if (settingsLoaded) drawScheduler.request("heat"); }
  if (change.layout) {
    applyLayout();
    if (follow) alignFollowToPhysicalPixel();
    renderTimeAxis();
    if (settingsLoaded) drawScheduler.request("all");
  }
  if (change.big) { bigFeed.reconfigure(next.values.bigTopPct); if (settingsLoaded) drawScheduler.request("big"); }
  if (change.time) renderTimeAxis();
  updateStatus(); updateDebugPanel();
}

let readGeneration = 0;
const settingsRecovery = new SettingsRecovery(async () => {
  readGeneration = settingsGeneration;
  return fetchSettings();
}, doc => {
  if (settingsGeneration === readGeneration) applySettings(doc);
}, () => {
  if (settingsGeneration === readGeneration) {
    settingsWarning = "設定を読めませんでした";
    console.error("設定を読めませんでした");
    updateStatus(); updateDebugPanel();
  }
});
async function startWithSettings() {
  await settingsRecovery.read();
  settingsLoaded = true;
  renderTimeAxis(); updateStatus(); scheduleDraw(); client.start();
  window.addEventListener("market-switch", () => { crosshair.hide(); client.stop(); }, { once: true });
}
void startWithSettings();
}
