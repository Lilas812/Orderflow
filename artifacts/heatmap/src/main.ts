import "./index.css";
import { ColumnCache } from "./data/cache.ts";
import { RealtimeClient, type ConnectionState, type HelloMessage, type SocketStatus } from "./data/socket.ts";
import { US_PER_SECOND, clampViewport, type Viewport, bestMidpoint } from "./domain.ts";
import { BOOK_OVERLAY_FRACTION, followStartUs, timeUsToX, xToTimeUs, zoomPriceAt, zoomTimeAt } from "./chart/coordinates.ts";
import { HeatmapRenderer, type DrawMetrics } from "./chart/renderer.ts";
import { formatAxisTicks, zoneFromSearch, type DisplayZone } from "./chart/timezone.ts";
import { CurrentTradeState } from "./data/trade-aggregate.ts";
import { TradeOverlayRenderer } from "./chart/trade-overlay.ts";
import { parseBubbleMin } from "./chart/trade-geometry.ts";
import { CurrentBookRenderer } from "./chart/current-book.ts";
import { LayerScheduler } from "./chart/layer-scheduler.ts";
import { BigOrderFeed, parseBigOrderOptions } from "./data/big-orders.ts";
import { BigOrderRenderer, visibleBigOrders } from "./chart/big-orders.ts";
import { FrameProfile } from "./chart/frame-profile.ts";
import { VpState } from "./data/vp.ts";
import { VpRenderer } from "./chart/vp.ts";

declare global {
  interface Window {
    readonly __heatmapDebug?: Readonly<HeatmapDebugSnapshot>;
    readonly __heatmapColumnDelivery?: ReturnType<typeof columnDeliverySnapshot>;
    readonly __heatmapFrameStats?: ReturnType<FrameProfile["snapshot"]>;
  }
}

export interface HeatmapDebugSnapshot {
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

root.innerHTML = `
  <div class="app-shell">
    <aside class="tool-rail" aria-label="Tools frame">
      <div class="brand-mark" aria-label="NQ instrument">NQ</div>
      <span class="rail-caption">Tools · Phase 9</span>
    </aside>
    <main class="workspace">
      <header class="masthead">
        <div class="instrument"><strong>NQ / DEPTH</strong><span>ONE-SECOND BOOK HISTORY</span></div>
        <div class="market-state" data-testid="connection-state" data-state="connecting" aria-live="polite">
          <i class="state-dot" aria-hidden="true"></i><span id="connection-label">CONNECTING</span>
        </div>
      </header>
      <section class="board" aria-label="NQ order-flow instrument panels">
        <section class="region heat-region" aria-label="Heatmap">
          <div class="heat-overlay"><strong>NQ</strong>DEPTH / 1s <span id="scale-value"></span></div>
          <canvas class="heat-canvas" id="heatmap" aria-label="NQ order-book depth heatmap. Horizontal axis is time; vertical axis is price in quarter-point ticks.">
            Canvas 2D heatmap. Depth data will be visible when the browser supports Canvas.
          </canvas>
          <canvas class="book-canvas current-book-overlay" id="current-book" aria-label="Current buy and sell quantities overlaid on the rightmost 20%"></canvas>
          <canvas class="trade-overlay" id="trade-overlay" aria-label="Trade price line, volume bubbles and current price"></canvas>
          <div id="empty-state" class="state-message" role="status" aria-live="polite">Waiting for feed · no synthetic data</div>
          <div id="status-banner" class="status-banner" role="status" aria-live="polite"></div>
          <pre id="debug-panel" class="debug-panel" hidden></pre>
        </section>
        <section class="region price-region" aria-label="Price axis">
          <canvas class="axis-price" id="price-axis" aria-label="Shared price axis in NQ quarter-point increments."></canvas>
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
        <section class="region delta-region" aria-label="Delta histogram frame">
          <span class="region-label">Delta</span><span class="region-hint">Phase 8 · empty frame</span>
        </section>
        <section class="region delta-scale-region" aria-label="Delta scale frame">
          <span class="region-label">Delta scale</span>
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

const canvas = required<HTMLCanvasElement>("heatmap");
const axisCanvas = required<HTMLCanvasElement>("price-axis");
const heatRegion = document.querySelector<HTMLElement>(".heat-region")!;
const timeAxis = required<HTMLDivElement>("time-axis");
const connectionLabel = required<HTMLSpanElement>("connection-label");
const connectionIndicator = document.querySelector<HTMLElement>(".market-state")!;
const emptyState = required<HTMLDivElement>("empty-state");
const statusBanner = required<HTMLDivElement>("status-banner");
const debugPanel = required<HTMLPreElement>("debug-panel");
const scaleValue = required<HTMLSpanElement>("scale-value");
const renderer = new HeatmapRenderer(canvas, axisCanvas, () => scheduleDraw());
const cache = new ColumnCache();
const bookRenderer = new CurrentBookRenderer(required<HTMLCanvasElement>("current-book"));
const bigOptions = parseBigOrderOptions(window.location.search);
const bigFeed = new BigOrderFeed(bigOptions.top.value);
const bigRenderer = new BigOrderRenderer(required<HTMLCanvasElement>("big-orders"));
const vpState = new VpState();
const vpRenderer = new VpRenderer(required<HTMLCanvasElement>("volume-profile"), () => drawScheduler.request("vp"));
const vpLoading = required<HTMLElement>("vp-loading");
let profiledVpDraws = 0;
const overlayRenderer = new TradeOverlayRenderer(
  required<HTMLCanvasElement>("trade-overlay"),
  required<HTMLCanvasElement>("current-price-label"),
);
const bubbleMinimum = parseBubbleMin(window.location.search);
const currentTrade = new CurrentTradeState();
const initialQuote = new CurrentTradeState();
let initialCutoffUs = 0;
let replayHeadUs: number | null = null;
let depthDrawCount = 0;
let overlayDrawCount = 0;
const displayZone: DisplayZone = zoneFromSearch(window.location.search);
const debugMode = new URLSearchParams(window.location.search).get("debug") === "1";

let viewport: Viewport = {
  startUs: (Date.now() * 1_000) - 600 * US_PER_SECOND,
  durationSec: 600,
  centerPriceTicks: 0,
  priceSpanTicks: 160,
};
let follow = true;
let centeredOnData = false;
let receivedColumnRevision = 0;
let requestCount = 0;
let connection: ConnectionState = "connecting";
let latestStatus: SocketStatus | null = null;
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
  onConnection: (state, message) => {
    connection = state;
    lastConnectionMessage = message ?? "";
    updateStatus();
    updateDebugPanel();
  },
  onHello: (message) => {
    hello = message;
    vpState.reset(); vpLoading.hidden = false;
    currentTrade.reset(); initialQuote.reset();
    initialCutoffUs = (message.mode === "replay" ? replayFromSec()! * US_PER_SECOND
      : Math.floor(message.serverTimeUs / US_PER_SECOND) * US_PER_SECOND) - 1;
    bigFeed.beginInitial(initialCutoffUs);
    replayHeadUs = message.mode === "replay" ? initialCutoffUs + 1 : null;
    lastDataError = "";
    if (!hasHello || follow) {
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
    const previousBackfill = backfillState(latestStatus);
    latestStatus = message;
    if (previousBackfill === "running" && backfillState(message) === "complete" && hello?.mode === "live" && follow) {
      refreshVisibleRange();
    }
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
  onTradeBatch: (trades, reqId) => {
    if (reqId === 0) initialQuote.accept(trades, initialCutoffUs);
    else if (reqId === null) {
      currentTrade.accept(trades);
      if (replayHeadUs !== null) for (const t of trades) replayHeadUs = Math.max(replayHeadUs, t.tsUs);
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
  if (centeredOnData) return;
  const midpoint = bestMidpoint(cache.latestBook ?? cache.columns.at(-1));
  if (midpoint === null) return;
  viewport = { ...viewport, centerPriceTicks: midpoint };
  centeredOnData = true;
}

function syncRetentionAndRequests(): void {
  const toUs = viewport.startUs + viewport.durationSec * US_PER_SECOND;
  cache.setRetentionAnchor(viewport.startUs, toUs, follow, cache.latestTimeUs);
  const requestEnd = follow && cache.latestTimeUs !== null ? Math.min(toUs, cache.latestTimeUs + US_PER_SECOND) : toUs;
  client.requestVisible(Math.floor(viewport.startUs / US_PER_SECOND), Math.ceil(requestEnd / US_PER_SECOND));
}

function alignFollowToPhysicalPixel(): void {
  if (cache.latestTimeUs === null) return;
  const width = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
  viewport.startUs = followStartUs(cache.latestTimeUs, viewport.durationSec, width);
}
function setViewport(next: Viewport, pan = false): void {
  viewport = clampViewport(next);
  if (pan) follow = false;
  if (follow) alignFollowToPhysicalPixel();
  syncRetentionAndRequests();
  renderTimeAxis();
  scheduleDraw();
  updateStatus();
}

function resetView(): void {
  const reference = cache.latestTimeUs !== null ? cache.latestTimeUs + US_PER_SECOND
    : hello?.serverTimeUs ?? Date.now() * 1_000;
  const midpoint = bestMidpoint(cache.latestBook ?? cache.columns.at(-1));
  if (midpoint !== null) {
    viewport.centerPriceTicks = midpoint;
    centeredOnData = true;
  }
  follow = true;
  viewport = { ...viewport, startUs: reference - (1 - BOOK_OVERLAY_FRACTION) * 600 * US_PER_SECOND, durationSec: 600, priceSpanTicks: 160 };
  alignFollowToPhysicalPixel();
  refreshVisibleRange();
  renderTimeAxis();
  scheduleDraw();
  updateStatus();
}

const drawScheduler = new LayerScheduler(draw => requestAnimationFrame(draw), {
  depth: () => {
      const columns = cache.columns;
      renderer.draw(columns, viewport, receivedColumnRevision, displayZone, columns.length > 0);
      depthDrawCount++;
  },
  book: () => bookRenderer.draw(cache.latestBook, viewport, renderer.metrics.p99),
  big: () => bigRenderer.draw(bigFeed.tracker.snapshot(), viewport, bigOptions.minSec.value),
  vp: () => vpRenderer.draw(vpState, viewport),
  trades: () => {
    overlayRenderer.draw(cache.tradeAggregation, viewport, bubbleMinimum.value,
      currentTrade.trade?.price ?? null, replayHeadUs ?? Math.max(
        (cache.latestTimeUs ?? 0) + US_PER_SECOND, currentTrade.trade?.tsUs ?? 0));
    overlayDrawCount++;
  },
  after: (redrewDepth, drawStart, redrewTrades) => {
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
        depth: redrewDepth, aggregationMs: redrewDepth ? depthMetrics.aggregationMs : 0,
        scaleMs: redrewDepth ? depthMetrics.scaleMs : 0,
        rasterMs: redrewDepth ? depthMetrics.rasterMs ?? 0 : 0,
        colorMs: redrewDepth ? depthMetrics.colorMs ?? 0 : 0,
        uploadMs: redrewDepth ? depthMetrics.uploadMs ?? 0 : 0,
        tileSyncMs: redrewDepth ? depthMetrics.tileSyncMs ?? 0 : 0 });
      profiledBookDraws = bookRenderer.metrics.drawCount; profiledBigDraws = bigRenderer.metrics.drawCount;
      profiledVpDraws = vpRenderer.metrics.drawCount;
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
    scaleValue.textContent = cache.size ? `P99 ${lastMetrics.p99}` : "";
    }
    if (debugMode) updateDebugPanel();
  },
});

function scheduleDraw(redrawDepth = true): void {
  drawScheduler.request(redrawDepth ? "all" : "trades");
}

function renderTimeAxis(): void {
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

function updateStatus(): void {
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
${overlayRenderer.metrics.bubbleCount} bubbles · min ${bubbleMinimum.value}${bubbleMinimum.invalid ? " · bubbleMin 無効" : ""}
line ${overlayRenderer.metrics.lineMs.toFixed(2)} / bubble ${overlayRenderer.metrics.bubbleMs.toFixed(2)} ms
book ${bookRenderer.metrics.meanMs.toFixed(2)} / ${bookRenderer.metrics.maxMs.toFixed(2)} ms (mean / max, last 30)
book ${bookRenderer.metrics.drawCount} / depth ${depthDrawCount} / overlay ${overlayDrawCount} draws
VP ${vpRenderer.metrics.prices} prices · POC ${vpRenderer.metrics.poc ?? "none"} · VA ${vpRenderer.metrics.low ?? "none"}–${vpRenderer.metrics.high ?? "none"}
VP ${vpRenderer.metrics.meanMs.toFixed(2)} / ${vpRenderer.metrics.maxMs.toFixed(2)} ms · ${vpState.loading ? "取り込み中" : "ready"}
big ${bigRenderer.metrics.visibleCount} · threshold ${bigFeed.tracker.snapshot().threshold ?? "none"} · top ${bigOptions.top.value}% · min ${bigOptions.minSec.value}s${bigOptions.top.invalid ? " · bigTop 無効" : ""}${bigOptions.minSec.invalid ? " · bigMinSec 無効" : ""}
big decision ${bigFeed.tracker.metrics.decisionMs.toFixed(2)} ms · draw ${bigRenderer.metrics.meanMs.toFixed(2)} / ${bigRenderer.metrics.maxMs.toFixed(2)} ms
big ${bigRenderer.metrics.drawCount} draws · longest ${bigRenderer.metrics.longestSec}s`;
}

function debugSnapshot(): HeatmapDebugSnapshot {
  const now = performance.now();
  const sample = drawSamples.slice(-30).map((entry) => entry.ms);
  return Object.freeze({
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
if (debugMode) {
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

function backfillState(status: SocketStatus | null): unknown {
  const phase = status?.status?.phase2a;
  if (!phase || typeof phase !== "object") return null;
  const backfill = (phase as Record<string, unknown>).backfill;
  return backfill && typeof backfill === "object" ? (backfill as Record<string, unknown>).state : null;
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

renderTimeAxis();
updateStatus();
client.start();
