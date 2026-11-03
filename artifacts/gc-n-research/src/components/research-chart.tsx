import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, MoveHorizontal, MoveVertical, Plus, RotateCcw, Scan } from 'lucide-react';
import { useChartTouch } from '@/hooks/use-chart-touch';
import { useFrameState } from '@/hooks/use-frame-state';
import { useChartDpr } from '@/hooks/use-chart-dpr';
import { prepareCanvas } from '@/lib/chart-canvas';
import {
  type Candle,
  type Level,
  type ProfileRow,
  type SessionData,
  type Tz,
  MINUTE_MS,
  candleAt,
  clamp,
  formatDateTime,
  formatPrice,
  formatQty,
  formatTime,
  levelCenter,
  niceTickStep,
  niceTimeStepMin,
} from '@/lib/research';

const C = {
  plot: '#fbf8f1',
  profileBg: '#f3efe5',
  grid: '#e6dfd0',
  axisText: '#5b6573',
  axisBg: '#efe9dc',
  up: '#2d6b78',
  down: '#a9473a',
  bar: '#9aa3ae',
  barHit: '#e0338a',
  pink: '#e0338a',
  cross: '#2a3442',
  sessionEdge: '#c9bfa9',
};

const MAX_PPM = 48;
const AXIS_W = 64;
const TIME_H = 26;
const TOP = 6;
const GAP = 10;

interface View {
  t0: number;
  t1: number;
  p0: number; // low price ticks
  p1: number; // high price ticks
}

interface Props {
  data: SessionData;
  profile: ProfileRow[]; // bucketed previous-session N profile
  bucketTicks: number;
  levels: Level[];
  tz: Tz;
}

function layout(w: number, h: number) {
  const profileW = clamp(Math.round(w * 0.22), 150, 300);
  const candleX0 = profileW + GAP;
  const candleX1 = w - AXIS_W;
  return { profileW, candleX0, candleX1, plotTop: TOP, plotBottom: h - TIME_H, w, h };
}
type Layout = ReturnType<typeof layout>;

function fitPrice(candles: Candle[], levels: Level[], profile: ProfileRow[], t0: number, t1: number) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.timeMs + MINUTE_MS < t0 || c.timeMs > t1) continue;
    lo = Math.min(lo, c.lowTicks);
    hi = Math.max(hi, c.highTicks);
  }
  for (const l of levels) {
    lo = Math.min(lo, l.priceTicks);
    hi = Math.max(hi, l.priceTicks + l.bucketTicks - 1);
  }
  if (!isFinite(lo)) {
    for (const r of profile) {
      lo = Math.min(lo, r.priceTicks);
      hi = Math.max(hi, r.priceTicks);
    }
  }
  if (!isFinite(lo)) return { p0: 0, p1: 100 };
  const pad = Math.max(5, (hi - lo) * 0.08);
  return { p0: lo - pad, p1: hi + pad };
}

export function ResearchChart({ data, profile, bucketTicks, levels, tz }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const dpr = useChartDpr();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useFrameState<View | null>(null);
  const [hover, setHover] = useFrameState<{ x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const L = useMemo(() => layout(size.w, size.h), [size]);
  const LRef = useRef(L);
  LRef.current = L;

  const { sessionStartMs: sStart, sessionEndMs: sEnd, candles } = data;

  // Resize observer
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(1, L.candleX1 - L.candleX0);

  const timeBounds = useCallback(
    (t0: number, t1: number) => {
      const full = sEnd - sStart;
      const minSpan = (plotW / MAX_PPM) * MINUTE_MS;
      const maxSpan = full;
      let span = clamp(t1 - t0, minSpan, Math.max(minSpan, maxSpan));
      let a = t0 + (t1 - t0 - span) / 2;
      if (span >= full) {
        span = full;
        a = sStart;
      }
      a = clamp(a, sStart, sEnd - span);
      return { t0: a, t1: a + span };
    },
    [sStart, sEnd, plotW],
  );

  const resetView = useCallback(() => {
    if (plotW <= 1) return;
    const t = timeBounds(sStart, sEnd);
    setView({ ...t, ...fitPrice(candles, levels, profile, t.t0, t.t1) });
  }, [plotW, sStart, sEnd, candles, levels, profile, timeBounds]);

  // Initialise once size is known (component is keyed by session upstream).
  const inited = useRef(false);
  useEffect(() => {
    if (!inited.current && size.w > 0) {
      inited.current = true;
      resetView();
    }
  }, [size.w, resetView]);

  // Re-clamp time when width changes
  useEffect(() => {
    setView((v) => (v ? { ...v, ...timeBounds(v.t0, v.t1) } : v));
  }, [timeBounds]);

  const zoomTime = useCallback(
    (factor: number, anchorFrac = 0.5) => {
      setView((v) => {
        if (!v) return v;
        const span = (v.t1 - v.t0) * factor;
        const anchor = v.t0 + (v.t1 - v.t0) * anchorFrac;
        return { ...v, ...timeBounds(anchor - span * anchorFrac, anchor + span * (1 - anchorFrac)) };
      });
    },
    [timeBounds],
  );
  const zoomPrice = useCallback((factor: number, anchorFrac = 0.5) => {
    setView((v) => {
      if (!v) return v;
      const span = clamp((v.p1 - v.p0) * factor, 8, 200000);
      const anchor = v.p0 + (v.p1 - v.p0) * anchorFrac;
      return { ...v, p0: anchor - span * anchorFrac, p1: anchor + span * (1 - anchorFrac) };
    });
  }, []);
  const panTime = useCallback(
    (dMs: number) => setView((v) => (v ? { ...v, ...timeBounds(v.t0 + dMs, v.t1 + dMs) } : v)),
    [timeBounds],
  );
  const panPrice = useCallback(
    (dTicks: number) => setView((v) => (v ? { ...v, p0: v.p0 + dTicks, p1: v.p1 + dTicks } : v)),
    [],
  );
  const fitPriceNow = useCallback(() => {
    setView((v) => (v ? { ...v, ...fitPrice(candles, levels, profile, v.t0, v.t1) } : v));
  }, [candles, levels, profile]);

  // Wheel (non-passive)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      const l = LRef.current;
      if (!v) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const f = Math.exp(clamp(e.deltaY, -200, 200) * 0.0015);
      const inCandles = x >= l.candleX0 && x < l.candleX1;
      if (inCandles && !e.shiftKey) {
        zoomTime(f, clamp((x - l.candleX0) / (l.candleX1 - l.candleX0), 0, 1));
      } else {
        zoomPrice(f, clamp((l.plotBottom - y) / (l.plotBottom - l.plotTop), 0, 1));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTime, zoomPrice]);

  // Drag
  const touch = useChartTouch({
    view,
    plot: { x0: L.candleX0, x1: L.candleX1, top: L.plotTop, bottom: L.plotBottom },
    apply: setView, onHover: setHover,
    constrain: (v) => {
      const span = clamp(v.p1 - v.p0, 8, 200000), mid = (v.p0 + v.p1) / 2;
      return { ...timeBounds(v.t0, v.t1), p0: mid - span / 2, p1: mid + span / 2 };
    },
  });
  const drag = useRef<{ x: number; y: number; v: View; inCandles: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (touch.down(e)) return;
    if (!view) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, v: view, inCandles: x >= L.candleX0 && x < L.candleX1 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (touch.move(e)) return;
    const r = e.currentTarget.getBoundingClientRect();
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const tpp = (d.v.t1 - d.v.t0) / plotW;
    const ppp = (d.v.p1 - d.v.p0) / (L.plotBottom - L.plotTop);
    const t = d.inCandles ? timeBounds(d.v.t0 - dx * tpp, d.v.t1 - dx * tpp) : { t0: d.v.t0, t1: d.v.t1 };
    setView({ ...t, p0: d.v.p0 + dy * ppp, p1: d.v.p1 + dy * ppp });
  };
  const endDrag = () => {
    drag.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!view) return;
    const tStep = (view.t1 - view.t0) * 0.1;
    const pStep = (view.p1 - view.p0) * 0.1;
    const map: Record<string, () => void> = {
      ArrowLeft: () => panTime(-tStep),
      ArrowRight: () => panTime(tStep),
      ArrowUp: () => panPrice(pStep),
      ArrowDown: () => panPrice(-pStep),
      '+': () => zoomTime(0.8),
      '=': () => zoomTime(0.8),
      '-': () => zoomTime(1.25),
      r: resetView,
    };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const maxQty = useMemo(() => profile.reduce((m, r) => Math.max(m, r.quantity), 0), [profile]);
  const levelSet = useMemo(() => new Set(levels.map((l) => l.priceTicks)), [levels]);

  // Draw
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !view || size.w === 0) return;
    const ctx = prepareCanvas(cv, size.w, size.h, dpr);
    draw(ctx, L, view, data, profile, bucketTicks, levels, levelSet, maxQty, tz);
  }, [view, size, L, data, profile, bucketTicks, levels, levelSet, maxQty, tz, dpr]);

  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv || !view || size.w === 0) return;
    const ctx = prepareCanvas(cv, size.w, size.h, dpr);
    ctx.clearRect(0, 0, size.w, size.h);
    drawCrosshair(ctx, L, view, tz, hover);
  }, [view, size, L, tz, hover, dpr]);

  // Hover readout
  const readout = useMemo(() => {
    if (!hover || !view || hover.y < L.plotTop || hover.y > L.plotBottom) return null;
    const price = view.p0 + ((L.plotBottom - hover.y) / (L.plotBottom - L.plotTop)) * (view.p1 - view.p0);
    const pt = Math.round(price);
    const inCandles = hover.x >= L.candleX0 && hover.x < L.candleX1;
    const inProfile = hover.x < L.profileW;
    let timeMs: number | null = null;
    let candle: Candle | null = null;
    if (inCandles) {
      const t = view.t0 + ((hover.x - L.candleX0) / plotW) * (view.t1 - view.t0);
      timeMs = Math.floor(t / MINUTE_MS) * MINUTE_MS;
      candle = candleAt(candles, t);
    }
    let prof: ProfileRow | null = null;
    if (inProfile) {
      const key = Math.floor(pt / bucketTicks) * bucketTicks;
      prof = profile.find((r) => r.priceTicks === key) ?? { priceTicks: key, quantity: 0, count: 0 };
    }
    return { pt, timeMs, candle, prof, inCandles, inProfile };
  }, [hover, view, L, plotW, candles, profile, bucketTicks]);

  const ppm = view ? plotW / ((view.t1 - view.t0) / MINUTE_MS) : 0;

  const btn =
    'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-sm border border-border bg-card px-1.5 text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5" role="toolbar" aria-label="チャート操作">
        <span className="mr-1 text-[11px] uppercase tracking-wider text-muted-foreground">時間</span>
        <button className={btn} aria-label="時間ズームイン" data-testid="button-time-zoom-in" onClick={() => zoomTime(0.7)}>
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button className={btn} aria-label="時間ズームアウト" data-testid="button-time-zoom-out" onClick={() => zoomTime(1.4)}>
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button className={btn} aria-label="時間を左へ" data-testid="button-time-pan-left" onClick={() => view && panTime(-(view.t1 - view.t0) * 0.25)}>
          <MoveHorizontal className="h-3.5 w-3.5" />←
        </button>
        <button className={btn} aria-label="時間を右へ" data-testid="button-time-pan-right" onClick={() => view && panTime((view.t1 - view.t0) * 0.25)}>
          →<MoveHorizontal className="h-3.5 w-3.5" />
        </button>
        <span className="mx-1 h-4 w-px bg-border" />
        <span className="mr-1 text-[11px] uppercase tracking-wider text-muted-foreground">価格</span>
        <button className={btn} aria-label="価格ズームイン" data-testid="button-price-zoom-in" onClick={() => zoomPrice(0.7)}>
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button className={btn} aria-label="価格ズームアウト" data-testid="button-price-zoom-out" onClick={() => zoomPrice(1.4)}>
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button className={btn} aria-label="価格を上へ" data-testid="button-price-pan-up" onClick={() => view && panPrice((view.p1 - view.p0) * 0.2)}>
          <MoveVertical className="h-3.5 w-3.5" />↑
        </button>
        <button className={btn} aria-label="価格を下へ" data-testid="button-price-pan-down" onClick={() => view && panPrice(-(view.p1 - view.p0) * 0.2)}>
          <MoveVertical className="h-3.5 w-3.5" />↓
        </button>
        <button className={btn} aria-label="表示範囲の価格に合わせる" data-testid="button-price-fit" onClick={fitPriceNow}>
          <Scan className="h-3.5 w-3.5" />フィット
        </button>
        <span className="mx-1 h-4 w-px bg-border" />
        <button className={btn} aria-label="表示をリセット" data-testid="button-view-reset" onClick={resetView}>
          <RotateCcw className="h-3.5 w-3.5" />リセット
        </button>
        <span className="ml-auto tabular text-[11px] text-muted-foreground" data-testid="text-view-range" aria-live="polite">
          {view
            ? `${formatTime(view.t0, tz)}–${formatTime(view.t1, tz)} ${tz} · ${ppm.toFixed(1)}px/分 · ${formatPrice(view.p0)}–${formatPrice(view.p1)}`
            : '—'}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-x-auto">
        <div ref={wrapRef} className="relative h-full min-h-[400px] min-w-[320px] sm:min-w-[720px]">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="img"
            aria-label={`左: 前セッション${data.previousSession ?? '—'} N約定プロファイル、右: ${data.session} 1分足。スマホは2本指でズーム、1本指で移動。PCはホイールでズーム、ドラッグでパン、矢印キーで移動、Rでリセット`}
            data-testid="canvas-research-chart"
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => { if (!touch.end(e)) endDrag(); }}
            onPointerCancel={(e) => { if (!touch.end(e, true)) endDrag(); }}
            onLostPointerCapture={(e) => { if (!touch.end(e, true)) endDrag(); }}
            onPointerLeave={() => {
              setHover(null);
            }}
            onKeyDown={onKeyDown}
          />
          <canvas ref={overlayRef} aria-hidden="true" data-testid="canvas-research-overlay" className="pointer-events-none absolute inset-0 h-full w-full" />
          {readout && hover && (
            <div
              className="pointer-events-none absolute z-10 rounded-sm border border-popover-border bg-popover/95 px-2 py-1.5 text-[11px] shadow-sm"
              style={{
                left: hover.x + 14 + 190 > size.w ? hover.x - 200 : hover.x + 14,
                top: clamp(hover.y + 12, 0, Math.max(0, size.h - 120)),
                width: 186,
              }}
              data-testid="tooltip-crosshair"
            >
              <div className="tabular font-semibold">価格 {formatPrice(readout.pt)}</div>
              {readout.inProfile && readout.prof && (
                <div className="tabular text-muted-foreground">
                  前N {formatPrice(readout.prof.priceTicks)}
                  {bucketTicks > 1 ? `–${formatPrice(readout.prof.priceTicks + bucketTicks - 1)}` : ''}
                  <br />
                  数量 {formatQty(readout.prof.quantity)} · 件数 {formatQty(readout.prof.count)}
                </div>
              )}
              {readout.inCandles && readout.timeMs !== null && (
                <>
                  <div className="tabular">{formatDateTime(readout.timeMs, tz)}</div>
                  {readout.candle ? (
                    <div className="tabular grid grid-cols-2 gap-x-2 text-muted-foreground">
                      <span>O {formatPrice(readout.candle.openTicks)}</span>
                      <span>H {formatPrice(readout.candle.highTicks)}</span>
                      <span>L {formatPrice(readout.candle.lowTicks)}</span>
                      <span>C {formatPrice(readout.candle.closeTicks)}</span>
                      <span>数量 {formatQty(readout.candle.quantity)}</span>
                      <span>件数 {formatQty(readout.candle.count)}</span>
                    </div>
                  ) : (
                    <div className="text-muted-foreground">約定なし(ギャップ)</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {/* QA readout (always present, mirrors hover) */}
      <div className="sr-only" data-testid="text-hover-readout" aria-live="off">
        {readout
          ? `price=${formatPrice(readout.pt)}${readout.timeMs !== null ? ` time=${formatDateTime(readout.timeMs, tz)}` : ''}${
              readout.candle
                ? ` O=${formatPrice(readout.candle.openTicks)} H=${formatPrice(readout.candle.highTicks)} L=${formatPrice(readout.candle.lowTicks)} C=${formatPrice(readout.candle.closeTicks)} qty=${readout.candle.quantity}`
                : ''
            }`
          : ''}
      </div>
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  v: View,
  data: SessionData,
  profile: ProfileRow[],
  bucket: number,
  levels: Level[],
  levelSet: Set<number>,
  maxQty: number,
  tz: Tz,
) {
  const { w, h, profileW, candleX0, candleX1, plotTop, plotBottom } = L;
  const plotH = plotBottom - plotTop;
  const pw = candleX1 - candleX0;
  const yOf = (ticks: number) => plotBottom - ((ticks - v.p0) / (v.p1 - v.p0)) * plotH;
  const xOf = (ms: number) => candleX0 + ((ms - v.t0) / (v.t1 - v.t0)) * pw;
  const ppt = plotH / (v.p1 - v.p0);
  const ppm = pw / ((v.t1 - v.t0) / MINUTE_MS);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.axisBg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = C.profileBg;
  ctx.fillRect(0, plotTop, profileW, plotH);
  ctx.fillStyle = C.plot;
  ctx.fillRect(candleX0, plotTop, pw, plotH);

  ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  // Price grid (shared)
  const step = niceTickStep(ppt);
  const first = Math.ceil(v.p0 / step) * step;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = C.axisText;
  ctx.textAlign = 'left';
  for (let p = first; p <= v.p1; p += step) {
    const y = Math.round(yOf(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(profileW, y);
    ctx.moveTo(candleX0, y);
    ctx.lineTo(candleX1, y);
    ctx.stroke();
    ctx.fillText(formatPrice(p), candleX1 + 6, y);
  }

  // Time grid
  const stepMin = niceTimeStepMin(ppm);
  const stepMs = stepMin * MINUTE_MS;
  ctx.textAlign = 'center';
  for (let t = Math.ceil(v.t0 / stepMs) * stepMs; t <= v.t1; t += stepMs) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.fillStyle = C.axisText;
    ctx.fillText(formatTime(t, tz), x, plotBottom + TIME_H / 2);
  }

  // Session edges
  ctx.save();
  ctx.beginPath();
  ctx.rect(candleX0, plotTop, pw, plotH);
  ctx.clip();
  ctx.strokeStyle = C.sessionEdge;
  ctx.setLineDash([4, 4]);
  for (const t of [data.sessionStartMs, data.sessionEndMs]) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Candles — only existing minutes; missing minutes stay empty (gaps)
  const bodyW = Math.max(1, Math.floor(ppm * 0.7));
  for (const c of data.candles) {
    if (c.timeMs + MINUTE_MS < v.t0 || c.timeMs > v.t1) continue;
    const xc = Math.round(xOf(c.timeMs + MINUTE_MS / 2));
    const up = c.closeTicks >= c.openTicks;
    const col = up ? C.up : C.down;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(xc + 0.5, yOf(c.highTicks));
    ctx.lineTo(xc + 0.5, yOf(c.lowTicks));
    ctx.stroke();
    const yo = yOf(c.openTicks);
    const yc = yOf(c.closeTicks);
    const top = Math.min(yo, yc);
    const bh = Math.max(1, Math.abs(yc - yo));
    const bx = xc - Math.floor(bodyW / 2);
    if (up && bodyW >= 4) {
      ctx.fillStyle = C.plot;
      ctx.fillRect(bx, top, bodyW, bh);
      ctx.strokeRect(bx + 0.5, top + 0.5, bodyW - 1, Math.max(0, bh - 1));
    } else ctx.fillRect(bx, top, bodyW, bh);
  }
  ctx.restore();

  // Profile bars (previous session N only)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, plotTop, profileW, plotH);
  ctx.clip();
  const barH = Math.max(1, ppt * bucket - (ppt * bucket > 3 ? 1 : 0));
  const maxLen = profileW - 8;
  for (const r of profile) {
    const yTop = yOf(r.priceTicks + bucket - 0.5);
    if (yTop > plotBottom || yTop + barH < plotTop) continue;
    const len = maxQty > 0 ? Math.max(1, (r.quantity / maxQty) * maxLen) : 0;
    ctx.fillStyle = levelSet.has(r.priceTicks) ? C.barHit : C.bar;
    ctx.globalAlpha = levelSet.has(r.priceTicks) ? 0.85 : 0.75;
    ctx.fillRect(4, yTop, len, barH);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Pink levels spanning BOTH panes
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, plotTop, candleX1, plotH);
  ctx.clip();
  ctx.strokeStyle = C.pink;
  ctx.lineWidth = 1.5;
  for (const l of levels) {
    const y = Math.round(yOf(levelCenter(l))) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(candleX1, y);
    ctx.stroke();
    ctx.fillStyle = C.pink;
    ctx.textAlign = 'right';
    ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillText(`#${l.rank}`, profileW - 4, y - 7);
  }
  ctx.restore();
  ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  for (const l of levels) {
    const y = yOf(levelCenter(l));
    if (y < plotTop || y > plotBottom) continue;
    ctx.fillStyle = C.pink;
    ctx.fillRect(candleX1, y - 8, AXIS_W, 16);
    ctx.fillStyle = '#fff7fb';
    ctx.fillText(formatPrice(levelCenter(l)), candleX1 + 6, y);
  }

  // Pane separator
  ctx.fillStyle = C.axisBg;
  ctx.fillRect(profileW, 0, GAP, h);

  // Pane titles
  ctx.font = '10px "IBM Plex Sans JP", sans-serif';
  ctx.fillStyle = C.axisText;
  ctx.textAlign = 'left';
  ctx.fillText(`前N ${data.previousSession ?? '—'}${data.previousPartial ? ' (部分)' : ''}`, 6, plotTop + 10);
  ctx.fillText(`${data.session} 1分足${data.partial ? ' (部分)' : ''}`, candleX0 + 6, plotTop + 10);

}

function drawCrosshair(
  ctx: CanvasRenderingContext2D, L: Layout, v: View, tz: Tz,
  hover: { x: number; y: number } | null,
) {
  const { candleX0, candleX1, plotTop, plotBottom } = L;
  const plotH = plotBottom - plotTop, pw = candleX1 - candleX0;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Crosshair
  if (hover && hover.y >= plotTop && hover.y <= plotBottom) {
    ctx.strokeStyle = C.cross;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const y = Math.round(hover.y) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(candleX1, y);
    if (hover.x >= candleX0 && hover.x < candleX1) {
      const x = Math.round(hover.x) + 0.5;
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const price = v.p0 + ((plotBottom - hover.y) / plotH) * (v.p1 - v.p0);
    ctx.fillStyle = C.cross;
    ctx.fillRect(candleX1, hover.y - 8, AXIS_W, 16);
    ctx.fillStyle = '#f6f2e8';
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillText(formatPrice(Math.round(price)), candleX1 + 6, hover.y);
    if (hover.x >= candleX0 && hover.x < candleX1) {
      const t = Math.floor((v.t0 + ((hover.x - candleX0) / pw) * (v.t1 - v.t0)) / MINUTE_MS) * MINUTE_MS;
      const label = formatTime(t, tz);
      ctx.fillStyle = C.cross;
      ctx.fillRect(hover.x - 24, plotBottom + 2, 48, TIME_H - 4);
      ctx.fillStyle = '#f6f2e8';
      ctx.textAlign = 'center';
      ctx.fillText(label, hover.x, plotBottom + TIME_H / 2);
    }
  }
}
