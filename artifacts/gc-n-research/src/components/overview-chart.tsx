import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Minus, MoveHorizontal, MoveVertical, Plus, Scan } from 'lucide-react';
import { type Tz, TZ_NAME, MINUTE_MS, clamp, formatDateTime, formatPrice, formatQty, niceTickStep } from '@/lib/research';
import { overlapSegments, type OverviewModel, type ResearchLine } from '@/lib/overview';
import { useChartTouch } from '@/hooks/use-chart-touch';
import { useFrameState } from '@/hooks/use-frame-state';
import { useChartDpr } from '@/hooks/use-chart-dpr';
import { prepareCanvas } from '@/lib/chart-canvas';

const C = {
  plot: '#fbf8f1',
  profileBg: '#f3efe5',
  grid: '#e6dfd0',
  axisText: '#5b6573',
  axisBg: '#efe9dc',
  up: '#2d6b78',
  down: '#a9473a',
  bar: '#9aa3ae',
  pink: '#e0338a',
  cross: '#2a3442',
  edge: '#c9bfa9',
  gap: 'rgba(91,101,115,0.10)',
  partial: 'rgba(196,145,46,0.16)',
  sel: '#1f2a37',
};
const AXIS_W = 64;
const TIME_H = 30;
const TOP = 8;
const GAP = 8;
const DAY = 86_400_000;

interface View { t0: number; t1: number; p0: number; p1: number }

export function lineCenter(l: ResearchLine) {
  return l.priceTicks + (l.bucketTicks - 1) / 2;
}

/** Relative source-date age is a retrospective visual aid, not level selection. */
export function useLineDecor(lines: ResearchLine[]) {
  return useMemo(() => {
    const sources = [...new Set(lines.map((l) => l.sourceSession))].sort();
    const m = new Map<string, { alpha: number }>();
    for (const l of lines) {
      const rank = sources.indexOf(l.sourceSession);
      const age = sources.length > 1 ? rank / (sources.length - 1) : 1; // 1 = newest
      m.set(l.id, { alpha: 0.28 + 0.72 * age });
    }
    return m;
  }, [lines]);
}

function tzOffset(ms: number, tz: Tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ_NAME[tz], hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ms);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
const STEPS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];

interface Props {
  model: OverviewModel;
  chartMinutes: 1 | 5;
  tz: Tz;
  selectedId: string | null;
  onPick: (ids: string[]) => void;
  bucketTicks: number;
}

export function OverviewChart({ model, chartMinutes, tz, selectedId, onPick, bucketTicks }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const dpr = useChartDpr();
  const [size, setSize] = useState({ w: 900, h: 520 });
  const [hover, setHover] = useFrameState<{ x: number; y: number } | null>(null);
  const decor = useLineDecor(model.lines);
  const segments = useMemo(() => new Map(model.lines.map(l => [l.id, overlapSegments(l, model.lines)])), [model.lines]);
  const barMs = chartMinutes * MINUTE_MS;

  const fit = useCallback((): View => {
    let lo = Infinity, hi = -Infinity;
    for (const c of model.candles) { lo = Math.min(lo, c.lowTicks); hi = Math.max(hi, c.highTicks); }
    for (const l of model.lines) { lo = Math.min(lo, l.priceTicks); hi = Math.max(hi, l.priceTicks + l.bucketTicks - 1); }
    if (!isFinite(lo)) for (const r of model.profile) { lo = Math.min(lo, r.priceTicks); hi = Math.max(hi, r.priceTicks); }
    if (!isFinite(lo)) { lo = 0; hi = 100; }
    const pad = Math.max(4, (hi - lo) * 0.04);
    return { t0: model.timeStartMs, t1: model.timeEndMs, p0: lo - pad, p1: hi + pad };
  }, [model]);
  const [view, setView] = useFrameState<View>(fit);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(320, e.contentRect.width), h: Math.max(380, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = useMemo(() => {
    const profileW = clamp(Math.round(size.w * 0.16), 90, 220);
    return { profileW, x0: profileW + GAP, x1: size.w - AXIS_W, top: TOP, bottom: size.h - TIME_H, w: size.w, h: size.h };
  }, [size]);
  const xOf = (t: number, v = view) => L.x0 + ((t - v.t0) / (v.t1 - v.t0)) * (L.x1 - L.x0);
  const yOf = (p: number, v = view) => L.bottom - ((p - v.p0) / (v.p1 - v.p0)) * (L.bottom - L.top);
  const tOf = (x: number) => view.t0 + ((x - L.x0) / (L.x1 - L.x0)) * (view.t1 - view.t0);
  const pOf = (y: number) => view.p0 + ((L.bottom - y) / (L.bottom - L.top)) * (view.p1 - view.p0);

  const span = model.timeEndMs - model.timeStartMs;
  const clampView = useCallback((v: View): View => {
    let w = clamp(v.t1 - v.t0, 30 * MINUTE_MS, span);
    let t0 = clamp(v.t0, model.timeStartMs, model.timeEndMs - w);
    const pr = clamp(v.p1 - v.p0, 6, 100000);
    const pm = (v.p0 + v.p1) / 2;
    w = Math.max(w, 1);
    t0 = isFinite(t0) ? t0 : model.timeStartMs;
    return { t0, t1: t0 + w, p0: pm - pr / 2, p1: pm + pr / 2 };
  }, [model.timeStartMs, model.timeEndMs, span]);

  const zoomT = (f: number, anchor?: number) => setView((v) => {
    const a = anchor ?? (v.t0 + v.t1) / 2;
    return clampView({ ...v, t0: a - (a - v.t0) * f, t1: a + (v.t1 - a) * f });
  });
  const zoomP = (f: number, anchor?: number) => setView((v) => {
    const a = anchor ?? (v.p0 + v.p1) / 2;
    return clampView({ ...v, p0: a - (a - v.p0) * f, p1: a + (v.p1 - a) * f });
  });
  const panT = (frac: number) => setView((v) => clampView({ ...v, t0: v.t0 + (v.t1 - v.t0) * frac, t1: v.t1 + (v.t1 - v.t0) * frac }));
  const panP = (frac: number) => setView((v) => ({ ...v, p0: v.p0 + (v.p1 - v.p0) * frac, p1: v.p1 + (v.p1 - v.p0) * frac }));

  // wheel: time zoom (shift/alt: price zoom)
  const geomRef = useRef({ L, view });
  geomRef.current = { L, view };
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { L: g, view: v } = geomRef.current;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const f = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      if (e.shiftKey || e.altKey || x > g.x1) {
        zoomP(f, v.p0 + ((g.bottom - y) / (g.bottom - g.top)) * (v.p1 - v.p0));
      } else {
        zoomT(f, v.t0 + ((x - g.x0) / (g.x1 - g.x0)) * (v.t1 - v.t0));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampView]);

  // line geometry for hit test
  const hitLines = useMemo(() => model.lines.map((l) => ({ l, xa: Math.max(l.startMs, view.t0), xb: Math.min(l.endMs, view.t1) })).filter((g) => g.xb > g.xa), [model.lines, view.t0, view.t1]);
  const hitAt = (x: number, y: number) => {
    if (x < L.x0 || x > L.x1) return [] as ResearchLine[];
    const t = tOf(x);
    return hitLines.filter((g) => t >= g.xa && t <= g.xb && Math.abs(yOf(lineCenter(g.l)) - y) <= 5).map((g) => g.l).sort((a, b) => a.startMs - b.startMs);
  };

  // draw
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = prepareCanvas(cv, L.w, L.h, dpr);
    ctx.fillStyle = C.plot; ctx.fillRect(0, 0, L.w, L.h);
    ctx.fillStyle = C.profileBg; ctx.fillRect(0, L.top, L.profileW, L.bottom - L.top);
    const v = view;
    const pxPerTick = (L.bottom - L.top) / (v.p1 - v.p0);
    const pStep = niceTickStep(pxPerTick, 26);
    ctx.font = '10px "IBM Plex Mono", monospace';

    // price grid
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let p = Math.ceil(v.p0 / pStep) * pStep; p <= v.p1; p += pStep) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.x1, y); ctx.stroke();
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(L.x0, L.top, L.x1 - L.x0, L.bottom - L.top); ctx.clip();

    // availability: shade unavailable gaps, hatch partial days
    const days = [...model.daily].sort((a, b) => a.availableStartMs - b.availableStartMs);
    let cursor = model.timeStartMs;
    const shade = (a: number, b: number, col: string) => {
      if (b <= a) return;
      const xa = xOf(a), xb = xOf(b);
      ctx.fillStyle = col; ctx.fillRect(xa, L.top, xb - xa, L.bottom - L.top);
    };
    for (const d of days) {
      if (d.availableEndMs <= d.availableStartMs) continue;
      shade(cursor, d.availableStartMs, C.gap);
      cursor = Math.max(cursor, d.availableEndMs);
    }
    shade(cursor, model.timeEndMs, C.gap);
    for (const d of days) if (d.partial) shade(d.availableStartMs, d.availableEndMs, C.partial);

    // time grid
    const pxPerMin = (L.x1 - L.x0) / ((v.t1 - v.t0) / MINUTE_MS);
    const step = STEPS.find((s) => s * pxPerMin >= 70) ?? 10080;
    const off = tzOffset(v.t0, tz);
    const stepMs = step * MINUTE_MS;
    const labels: { x: number; s: string; major: boolean }[] = [];
    for (let t = Math.ceil((v.t0 + off) / stepMs) * stepMs - off; t <= v.t1; t += stepMs) {
      const x = Math.round(xOf(t)) + 0.5;
      const local = new Date(t + tzOffset(t, tz));
      const major = local.getUTCHours() === 0 && local.getUTCMinutes() === 0;
      ctx.strokeStyle = major ? C.edge : C.grid;
      ctx.beginPath(); ctx.moveTo(x, L.top); ctx.lineTo(x, L.bottom); ctx.stroke();
      const mm = String(local.getUTCMonth() + 1).padStart(2, '0'), dd = String(local.getUTCDate()).padStart(2, '0');
      const hm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
      labels.push({ x, s: step >= 1440 || major ? `${mm}-${dd}` : hm, major });
    }

    // candles
    const bw = ((L.x1 - L.x0) * barMs) / (v.t1 - v.t0);
    for (const c of model.candles) {
      if (c.timeMs + barMs < v.t0 || c.timeMs > v.t1) continue;
      const xa = xOf(c.timeMs), xm = xa + bw / 2;
      const col = c.closeTicks >= c.openTicks ? C.up : C.down;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(xm, yOf(c.highTicks)); ctx.lineTo(xm, yOf(c.lowTicks)); ctx.stroke();
      if (bw >= 3) {
        const yo = yOf(c.openTicks), yc = yOf(c.closeTicks);
        ctx.fillRect(xa + bw * 0.15, Math.min(yo, yc), bw * 0.7, Math.max(1, Math.abs(yo - yc)));
      }
    }

    // lines: origin -> expiry, clipped to view
    for (const g of hitLines) {
      const d = decor.get(g.l.id)!;
      const y = Math.round(yOf(lineCenter(g.l))) + 0.5;
      const sel = g.l.id === selectedId;
      ctx.globalAlpha = sel ? 1 : d.alpha;
      ctx.strokeStyle = sel ? C.sel : C.pink;
      ctx.setLineDash(g.l.sourcePartial || g.l.historyShort ? [5, 3] : []);
      const xa = xOf(g.xa), xb = xOf(g.xb);
      for (const segment of segments.get(g.l.id) ?? []) {
        const a = Math.max(segment.startMs, g.xa), b = Math.min(segment.endMs, g.xb);
        if (a >= b) continue;
        ctx.lineWidth = (sel ? 1.5 : 1) * (1 + Math.min(3, segment.count - 1) * 0.9);
        ctx.beginPath(); ctx.moveTo(xOf(a), y); ctx.lineTo(xOf(b), y); ctx.stroke();
      }
      ctx.setLineDash([]);
      if (g.l.startMs >= v.t0) { ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(xa - 1, y - 3, 2, 6); }
      if (sel) for (const e of g.l.events) {
        if (e.timeMs < v.t0 || e.timeMs > v.t1) continue;
        ctx.fillStyle = e.outcome === 'reaction' ? C.up : e.outcome === 'breakout' ? C.down : C.axisText;
        ctx.beginPath(); ctx.arc(xOf(e.timeMs), y, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
    ctx.restore();

    // profile (shared price axis)
    let maxQ = 0;
    for (const r of model.profile) maxQ = Math.max(maxQ, r.quantity);
    const linePrices = new Set(model.lines.map((l) => l.priceTicks));
    const bucket = bucketTicks;
    const rowH = Math.max(1, pxPerTick * bucket - (pxPerTick * bucket > 3 ? 1 : 0));
    for (const r of model.profile) {
      if (r.priceTicks + bucket < v.p0 || r.priceTicks > v.p1) continue;
      const wq = maxQ ? (r.quantity / maxQ) * (L.profileW - 6) : 0;
      ctx.fillStyle = linePrices.has(r.priceTicks) ? C.pink : C.bar;
      ctx.fillRect(L.profileW - wq, yOf(r.priceTicks + bucket - 0.5), wq, rowH);
    }

    // axes
    ctx.fillStyle = C.axisBg; ctx.fillRect(L.x1, 0, AXIS_W, L.h); ctx.fillRect(0, L.bottom, L.w, TIME_H);
    ctx.fillStyle = C.axisText; ctx.textBaseline = 'middle';
    for (let p = Math.ceil(v.p0 / pStep) * pStep; p <= v.p1; p += pStep) ctx.fillText(formatPrice(p), L.x1 + 6, yOf(p));
    ctx.textBaseline = 'top';
    for (const lb of labels) if (lb.x > L.x0 && lb.x < L.x1) {
      ctx.font = lb.major ? '600 10px "IBM Plex Mono", monospace' : '10px "IBM Plex Mono", monospace';
      ctx.fillText(lb.s, lb.x + 3, L.bottom + 8);
    }
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText(tz, L.x1 + 6, L.bottom + 8);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, view, model, hitLines, decor, selectedId, tz, barMs, bucketTicks, segments, dpr]);

  // Pointer movement only clears/redraws the transparent overlay.
  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv) return;
    const ctx = prepareCanvas(cv, L.w, L.h, dpr);
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.font = '10px "IBM Plex Mono", monospace';
    if (hover && hover.y > L.top && hover.y < L.bottom) {
      ctx.strokeStyle = C.cross; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, hover.y + 0.5); ctx.lineTo(L.x1, hover.y + 0.5); ctx.stroke();
      if (hover.x > L.x0 && hover.x < L.x1) { ctx.beginPath(); ctx.moveTo(hover.x + 0.5, L.top); ctx.lineTo(hover.x + 0.5, L.bottom); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = C.cross; ctx.fillRect(L.x1, hover.y - 8, AXIS_W, 16);
      ctx.fillStyle = C.plot; ctx.textBaseline = 'middle';
      ctx.fillText(formatPrice(Math.round(pOf(hover.y))), L.x1 + 6, hover.y);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, view, hover, dpr]);

  // drag
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean; axis: boolean } | null>(null);
  const hoverInfo = hover ? hitAt(hover.x, hover.y) : [];
  const touch = useChartTouch({
    view, plot: L, apply: setView, constrain: clampView, onHover: setHover,
    onTap: (p) => { const hits = hitAt(p.x, p.y); if (hits.length) onPick(hits.map(h => h.id)); },
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1" role="toolbar" aria-label="チャート操作">
        <Btn id="fit" label="全期間にフィット" onClick={() => setView(fit())}><Scan className="h-3.5 w-3.5" /><span className="text-[11px]">フィット</span></Btn>
        <span className="mx-1 h-4 w-px bg-border" />
        <MoveHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <Btn id="time-left" label="時間を左へ" onClick={() => panT(-0.25)}><ChevronLeft className="h-3.5 w-3.5" /></Btn>
        <Btn id="time-zoom-in" label="時間拡大" onClick={() => zoomT(1 / 1.5)}><Plus className="h-3.5 w-3.5" /></Btn>
        <Btn id="time-zoom-out" label="時間縮小" onClick={() => zoomT(1.5)}><Minus className="h-3.5 w-3.5" /></Btn>
        <Btn id="time-right" label="時間を右へ" onClick={() => panT(0.25)}><ChevronRight className="h-3.5 w-3.5" /></Btn>
        <span className="mx-1 h-4 w-px bg-border" />
        <MoveVertical className="h-3.5 w-3.5 text-muted-foreground" />
        <Btn id="price-up" label="価格を上へ" onClick={() => panP(0.15)}><ChevronUp className="h-3.5 w-3.5" /></Btn>
        <Btn id="price-zoom-in" label="価格拡大" onClick={() => zoomP(1 / 1.4)}><Plus className="h-3.5 w-3.5" /></Btn>
        <Btn id="price-zoom-out" label="価格縮小" onClick={() => zoomP(1.4)}><Minus className="h-3.5 w-3.5" /></Btn>
        <Btn id="price-down" label="価格を下へ" onClick={() => panP(-0.15)}><ChevronDown className="h-3.5 w-3.5" /></Btn>
        <span className="tabular ml-auto truncate text-[10px] text-muted-foreground" data-testid="text-chart-view">
          {formatDateTime(view.t0, tz)} — {formatDateTime(view.t1, tz)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div ref={wrapRef} className="relative h-full min-h-[460px] min-w-[320px] sm:min-w-[640px]">
          <canvas
            ref={canvasRef}
            data-testid="canvas-overview"
            className="absolute inset-0 h-full w-full touch-none"
            style={{ cursor: hoverInfo.length ? 'pointer' : 'crosshair' }}
            onPointerDown={(e) => {
              if (touch.down(e)) return;
              const r = e.currentTarget.getBoundingClientRect();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX - r.left, y: e.clientY - r.top, v: viewRef.current, moved: false, axis: e.clientX - r.left > L.x1 };
            }}
            onPointerMove={(e) => {
              if (touch.move(e)) return;
              const r = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - r.left, y = e.clientY - r.top;
              setHover({ x, y });
              const d = drag.current;
              if (!d) return;
              const dx = x - d.x, dy = y - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
              if (!d.moved) return;
              const v = d.v;
              const dp = (dy / (L.bottom - L.top)) * (v.p1 - v.p0);
              if (d.axis) {
                const f = Math.exp(dy / 200);
                const m = (v.p0 + v.p1) / 2;
                setView(clampView({ ...v, p0: m - ((v.p1 - v.p0) / 2) * f, p1: m + ((v.p1 - v.p0) / 2) * f }));
                return;
              }
              const dt = (dx / (L.x1 - L.x0)) * (v.t1 - v.t0);
              setView(clampView({ t0: v.t0 - dt, t1: v.t1 - dt, p0: v.p0 + dp, p1: v.p1 + dp }));
            }}
            onPointerUp={(e) => {
              if (touch.end(e)) return;
              const d = drag.current;
              drag.current = null;
              if (d && !d.moved) {
                const r = e.currentTarget.getBoundingClientRect();
                const hits = hitAt(e.clientX - r.left, e.clientY - r.top);
                if (hits.length) onPick(hits.map((h) => h.id));
              }
            }}
            onPointerCancel={(e) => { if (!touch.end(e, true)) drag.current = null; }}
            onLostPointerCapture={(e) => { if (!touch.end(e, true)) drag.current = null; }}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={() => setView(fit())}
          />
          <canvas ref={overlayRef} aria-hidden="true" data-testid="canvas-overview-overlay" className="pointer-events-none absolute inset-0 h-full w-full" />
          {hover && hoverInfo.length > 0 && (
            <div
              className="pointer-events-none absolute z-10 rounded-sm border border-popover-border bg-popover px-2 py-1 text-[10px] shadow-sm"
              style={{ left: Math.min(hover.x + 12, L.w - 220), top: Math.max(4, hover.y - 40) }}
              data-testid="tooltip-line"
            >
              {hoverInfo.slice(0, 4).map((l) => (
                <div key={l.id} className="tabular">
                  {formatPrice(lineCenter(l))} · 起点 {l.sourceSession} · N {formatQty(l.quantity)} · 接触 {l.stats.touches}
                </div>
              ))}
              {hoverInfo.length > 4 && <div className="text-muted-foreground">他 {hoverInfo.length - 4} 本</div>}
              <div className="text-muted-foreground">クリックで詳細</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Btn({ id, label, onClick, children }: { id: string; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} data-testid={`button-${id}`} onClick={onClick} className="inline-flex h-6 items-center gap-1 rounded-sm border border-input bg-card px-1.5 hover:bg-accent">
      {children}
    </button>
  );
}
