import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtremeKind, RangeData, RangeMark, TradeRef } from '@/lib/range-types';
import { clampView, elapsedUs, formatUs, refPosition } from '@/lib/range-view';

type Props = { data: RangeData; marks: RangeMark[]; guides: boolean; volume: boolean; tz: 'CT' | 'JST';
  mode: ExtremeKind | 'auto'; onMark: (ref: TradeRef, kind?: ExtremeKind, lowRef?: TradeRef) => void;
  onSelect: (i: number) => void; selected: number; jump: { session: string; serial: number } | null };
const W = 66, T = 24, B = 28;
export function RangeChart({ data, marks, guides, volume, tz, mode, onMark, onSelect, selected, jump }: Props) {
  const host = useRef<HTMLDivElement>(null), base = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null), navigator = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450, dpr: 1 });
  const [view, setView] = useState<[number, number]>([0, data.bars.length]);
  const [ruler, setRuler] = useState(false), [points, setPoints] = useState<{ us: number; ticks: number }[]>([]);
  const [notice, setNotice] = useState('');
  const shape = useRef({ lo: 0, hi: 1, bottom: 400, width: 700 });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const gestures = useRef(new Map<number, { x: number; y: number }>());
  const down = useRef({ x: 0, y: 0, lastX: 0, moved: false, distance: 0 });
  const drawing = useRef<number[]>([]);
  const currentView = useRef(view); currentView.current = view;
  const change = useCallback((a: number, z: number) => setView(clampView(a, z, data.bars.length)), [data.bars.length]);
  const pan = useCallback((fraction: number) => {
    const [a, z] = currentView.current; change(a + (z - a) * fraction, z + (z - a) * fraction);
  }, [change]);
  const zoom = useCallback((factor: number, anchor = 0.5) => {
    const [a, z] = currentView.current, span = (z - a) * factor, c = a + (z - a) * anchor;
    change(c - span * anchor, c + span * (1 - anchor));
  }, [change]);

  useEffect(() => {
    const el = host.current; if (!el) return;
    const resize = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 }));
    resize.observe(el); return () => resize.disconnect();
  }, []);
  useEffect(() => {
    if (!jump) return;
    const s = data.sessions.find(s => s.date === jump.session);
    if (s) change(s.first, s.first + s.count);
  }, [jump, data.sessions, change]);

  const draw = useCallback(() => {
    const canvas = base.current, nav = navigator.current;
    if (!canvas || !nav || !data.bars.length) return;
    const begin = performance.now();
    const { w, h, dpr } = size, width = Math.max(1, w - W), bottom = h - B - (volume ? 70 : 0);
    for (const [c, height] of [[canvas, h], [nav, 68]] as const) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(height * dpr);
      }
    }
    const ctx = canvas.getContext('2d')!, nc = nav.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, w, h);
    const [a, z] = view, span = Math.max(1, z - a), first = Math.max(0, Math.floor(a)), end = Math.min(data.bars.length, Math.ceil(z));
    let lo = Infinity, hi = -Infinity, maxVolume = 1;
    for (let i = first; i < end; i++) {
      const b = data.bars[i]; lo = Math.min(lo, b.low); hi = Math.max(hi, b.high);
      maxVolume = Math.max(maxVolume, b.buy + b.sell + b.unknown);
    }
    for (const m of marks) {
      if (m.context.inputHash !== data.inputHash) continue;
      const pos = refPosition(data.bars, m.ref);
      if (pos >= a && pos <= z) { lo = Math.min(lo, m.ref.priceTicks); hi = Math.max(hi, m.ref.priceTicks); }
    }
    const pad = Math.max(2, (hi - lo) * .07); lo -= pad; hi += pad;
    shape.current = { lo, hi, bottom, width };
    const x = (index: number) => (index - a) / span * width;
    const y = (price: number) => T + (hi - price) / (hi - lo) * (bottom - T);
    ctx.font = '11px monospace'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const price = lo + (hi - lo) * i / 5, yy = y(price);
      ctx.strokeStyle = '#27333f'; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(width, yy); ctx.stroke();
      ctx.fillStyle = '#b7c6d3'; ctx.fillText((price * data.tickSize).toFixed(data.symbol === 'NQ' ? 2 : 1), width + 5, yy);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(0, T, width, bottom - T); ctx.clip();
    for (const gap of data.gaps) {
      if (gap.at < a || gap.at > z) continue;
      const xx = x(gap.at);
      ctx.fillStyle = gap.kind === 'missing' ? '#9c713c66' : '#8a99aa25'; ctx.fillRect(xx - 2, T, 4, bottom - T);
    }
    // Pixel columns retain actual extrema; no fabricated bars for dense monthly views.
    const stride = Math.max(1, Math.ceil(span / width));
    if (volume) {
      maxVolume = 1;
      for (let i = first; i < end; i += stride) {
        let qty = 0;
        for (let j = i; j < Math.min(end, i + stride); j++) qty += data.bars[j].buy + data.bars[j].sell + data.bars[j].unknown;
        maxVolume = Math.max(maxVolume, qty);
      }
    }
    for (let i = first; i < end; i += stride) {
      const b = data.bars[i]; let high = b.high, low = b.low, partial = b.partial;
      const stop = Math.min(end, i + stride);
      for (let j = i + 1; j < stop; j++) { high = Math.max(high, data.bars[j].high); low = Math.min(low, data.bars[j].low); partial ||= data.bars[j].partial; }
      const close = data.bars[stop - 1].close, xx = x(i + .5);
      ctx.strokeStyle = partial ? '#d5ac69' : close >= b.open ? '#7cc8b2' : '#b7a1dc';
      ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xx, y(high)); ctx.lineTo(xx, y(low)); ctx.stroke();
      if (stride === 1 && width / span >= 3)
        ctx.fillRect(xx - Math.min(8, width / span * .6) / 2, Math.min(y(b.open), y(close)), Math.min(8, width / span * .6), Math.max(1, Math.abs(y(b.open) - y(close))));
    }
    if (guides) {
      ctx.strokeStyle = '#aab8c64d'; ctx.setLineDash([3, 4]); ctx.beginPath(); let lastSegment = -1;
      for (const c of data.candidates) {
        const xx = x(refPosition(data.bars, c.ref)), yy = y(c.ref.priceTicks);
        if (c.segment !== lastSegment) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        lastSegment = c.segment;
      }
      ctx.stroke(); ctx.setLineDash([]);
      for (const c of data.candidates) if (c.confirmedUs === null) {
        const xx = x(refPosition(data.bars, c.ref));
        if (xx >= 0 && xx <= width) { ctx.fillStyle = '#aab8c688'; ctx.fillText('未確定', xx + 3, y(c.ref.priceTicks) + 12); }
      }
    }
    for (const m of marks) {
      if (m.context.inputHash !== data.inputHash) continue;
      const xx = x(refPosition(data.bars, m.ref)); if (xx < 0 || xx > width) continue;
      const yy = y(m.ref.priceTicks), sign = m.kind === 'top' ? -1 : 1;
      ctx.fillStyle = m.kind === 'top' ? '#f2ad87' : '#87cbe7'; ctx.beginPath();
      ctx.moveTo(xx, yy); ctx.lineTo(xx - 5, yy + sign * 9); ctx.lineTo(xx + 5, yy + sign * 9); ctx.closePath(); ctx.fill();
      ctx.fillText(m.kind === 'top' ? 'T' : 'B', xx + 6, yy + sign * 12);
    }
    for (const p of points) {
      const xx = x(refPosition(data.bars, { tsUs: p.us } as TradeRef));
      ctx.strokeStyle = '#e3d985'; ctx.beginPath(); ctx.arc(xx, y(p.ticks), 4, 0, Math.PI * 2); ctx.stroke();
    }
    if (points.length === 2) {
      ctx.strokeStyle = '#e3d985'; ctx.beginPath();
      points.forEach((p, i) => { const xx = x(refPosition(data.bars, { tsUs: p.us } as TradeRef)); if (i) ctx.lineTo(xx, y(p.ticks)); else ctx.moveTo(xx, y(p.ticks)); }); ctx.stroke();
    }
    ctx.restore();
    let labelEdge = -120;
    for (const s of data.sessions) {
      const xx = x(s.first); if (xx < 0 || xx > width) continue;
      ctx.strokeStyle = '#526271'; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(xx, T); ctx.lineTo(xx, h - B); ctx.stroke(); ctx.setLineDash([]);
      if (xx > labelEdge + 85) { ctx.fillStyle = s.partial ? '#d5ac69' : '#afbecb'; ctx.fillText(s.date.slice(5), xx + 3, 12); labelEdge = xx; }
    }
    if (volume) for (let i = first; i < end; i += stride) {
      let qty = 0; for (let j = i; j < Math.min(end, i + stride); j++) qty += data.bars[j].buy + data.bars[j].sell + data.bars[j].unknown;
      ctx.fillStyle = '#758b9b88'; ctx.fillRect(x(i + .5), h - B - Math.min(62, qty / maxVolume * 62), Math.max(1, width / span * .65), Math.min(62, qty / maxVolume * 62));
    }
    ctx.fillStyle = '#b7c6d3';
    ctx.fillText(formatUs(data.bars[first].startUs, tz).slice(0, 16), 4, h - 12);
    const right = formatUs(data.bars[end - 1].endUs, tz).slice(0, 16) + ` ${tz}`;
    ctx.fillText(right, Math.max(4, width - 145), h - 12);
    nc.setTransform(dpr, 0, 0, dpr, 0, 0); nc.fillStyle = '#111c25'; nc.fillRect(0, 0, w, 68);
    let allLo = Infinity, allHi = -Infinity;
    for (const b of data.bars) { allLo = Math.min(allLo, b.low); allHi = Math.max(allHi, b.high); }
    const step = Math.max(1, Math.ceil(data.bars.length / w));
    nc.strokeStyle = '#6f9eaa'; nc.beginPath();
    for (let i = 0; i < data.bars.length; i += step) {
      const xx = i / data.bars.length * w, yy = 8 + (allHi - data.bars[i].close) / Math.max(1, allHi - allLo) * 50;
      if (i) nc.lineTo(xx, yy); else nc.moveTo(xx, yy);
    }
    nc.stroke(); nc.fillStyle = '#9fc7d82b'; nc.fillRect(a / data.bars.length * w, 0, span / data.bars.length * w, 68);
    nc.strokeStyle = '#b9d5e2'; nc.strokeRect(a / data.bars.length * w, 1, span / data.bars.length * w, 66);
    drawing.current.push(performance.now() - begin); if (drawing.current.length > 600) drawing.current.shift();
  }, [data, size, view, marks, guides, volume, points, tz]);
  useEffect(() => { const id = requestAnimationFrame(draw); return () => cancelAnimationFrame(id); }, [draw]);
  useEffect(() => {
    const c = overlay.current; if (!c) return;
    const frame = () => {
      if (c.width !== Math.round(size.w * size.dpr) || c.height !== Math.round(size.h * size.dpr)) {
        c.width = Math.round(size.w * size.dpr); c.height = Math.round(size.h * size.dpr);
      }
      const ctx = c.getContext('2d')!; ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0); ctx.clearRect(0, 0, size.w, size.h);
      const p = pointer.current; if (!p) return;
      ctx.strokeStyle = '#a7b5c888'; ctx.setLineDash([3, 4]); ctx.beginPath();
      ctx.moveTo(p.x, T); ctx.lineTo(p.x, shape.current.bottom); ctx.moveTo(0, p.y); ctx.lineTo(shape.current.width, p.y); ctx.stroke();
    };
    let id = 0;
    const move = () => { if (id) return; id = requestAnimationFrame(() => { id = 0; frame(); }); };
    c.addEventListener('pointermove', move); c.addEventListener('pointerleave', move); frame();
    return () => { cancelAnimationFrame(id); c.removeEventListener('pointermove', move); c.removeEventListener('pointerleave', move); };
  }, [size]);
  useEffect(() => {
    const c = overlay.current; if (!c) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); const rect = c.getBoundingClientRect(); zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, Math.max(0, Math.min(1, (e.clientX - rect.left) / shape.current.width))); };
    c.addEventListener('wheel', wheel, { passive: false }); return () => c.removeEventListener('wheel', wheel);
  }, [zoom]);
  useEffect(() => {
    const debug = {
      view, barCount: data.bars.length, size, inputHash: data.inputHash, width: data.width,
      fit: () => change(0, data.bars.length), zoom, pan,
      select: onSelect,
      markPositions: marks.map(m => ({ id: m.id, position: m.context.inputHash === data.inputHash ? refPosition(data.bars, m.ref) : null, ref: m.ref })),
      async measureFrames(count = 120) {
        const intervals: number[] = [], drawMs: number[] = []; let previous = performance.now();
        for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(now => {
          intervals.push(now - previous); previous = now; const t = performance.now(); draw(); drawMs.push(performance.now() - t); resolve();
        }));
        const stats = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return { median: a[Math.floor(a.length / 2)], p95: a[Math.min(a.length - 1, Math.floor(a.length * .95))], max: Math.max(...a), count: a.length }; };
        return { frameIntervalsMs: stats(intervals), drawingMs: stats(drawMs), size, view, bars: data.bars.length, width: data.width };
      },
    };
    (window as unknown as { __rangeChart: typeof debug }).__rangeChart = debug;
  }, [view, data, size, change, zoom, pan, draw, onSelect, marks]);
  const coords = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pick = (x: number, y: number) => {
    const { lo, hi, bottom, width } = shape.current, [a, z] = currentView.current;
    const i = Math.max(0, Math.min(data.bars.length - 1, Math.floor(a + x / width * (z - a))));
    const b = data.bars[i]; onSelect(i);
    if (ruler) {
      const ticks = Math.round(hi - (y - T) / (bottom - T) * (hi - lo));
      setPoints(p => [...(p.length === 2 ? [] : p), { us: b.startUs, ticks }]); return;
    }
    if (width / (z - a) < 4) { setNotice('縮小表示では原約定を特定できません。拡大して高値・安値を選ぶか、選択足の天／底ボタンを使ってください。'); return; }
    setNotice('');
    const highY = T + (hi - b.high) / (hi - lo) * (bottom - T), lowY = T + (hi - b.low) / (hi - lo) * (bottom - T);
    if (mode !== 'auto') { onMark(b.highRef, mode, b.lowRef); return; }
    if (Math.abs(highY - lowY) < 16 && Math.min(Math.abs(y - highY), Math.abs(y - lowY)) < 12) onMark(b.highRef, undefined, b.lowRef);
    else if (Math.abs(y - highY) < 12) onMark(b.highRef, 'top', b.lowRef);
    else if (Math.abs(y - lowY) < 12) onMark(b.highRef, 'bottom', b.lowRef);
  };
  return <section className="range-chart-panel">
    <div className="range-controls">
      <button onClick={() => change(0, data.bars.length)}>全期間フィット</button>
      <button onClick={() => zoom(.5)}>拡大 ＋</button><button onClick={() => zoom(2)}>縮小 −</button>
      <button onClick={() => pan(-.5)}>左へ</button><button onClick={() => pan(.5)}>右へ</button>
      <button aria-pressed={ruler} onClick={() => { setRuler(!ruler); setPoints([]); }}>2点定規 {ruler ? 'ON' : 'OFF'}</button>
      <span>{Math.floor(view[0]) + 1}–{Math.ceil(view[1])} / {data.bars.length}足</span>
    </div>
    <div ref={host} className="range-canvas-host">
      <canvas ref={base} data-testid="range-base" />
      <canvas ref={overlay} data-testid="range-chart" tabIndex={0} aria-label="レンジ足。拡大後に高安をクリックまたはタップ"
        style={{ touchAction: 'none' }}
        onDoubleClick={() => change(0, data.bars.length)}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId); const p = coords(e); gestures.current.set(e.pointerId, p);
          down.current = { x: p.x, y: p.y, lastX: p.x, moved: gestures.current.size > 1, distance: 0 };
        }}
        onPointerMove={e => {
          const p = coords(e); pointer.current = p;
          const [a, z] = currentView.current, i = Math.max(0, Math.min(data.bars.length - 1, Math.floor(a + p.x / shape.current.width * (z - a))));
          if (!gestures.current.size) { onSelect(i); return; }
          if (!gestures.current.has(e.pointerId)) return;
          gestures.current.set(e.pointerId, p);
          if (gestures.current.size === 2) {
            const [p1, p2] = [...gestures.current.values()], distance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            if (down.current.distance > 0 && distance > 0) zoom(down.current.distance / distance, (p1.x + p2.x) / 2 / shape.current.width);
            down.current.distance = distance; down.current.moved = true;
          } else {
            if (Math.hypot(p.x - down.current.x, p.y - down.current.y) > 5) down.current.moved = true;
            if (down.current.moved) { const delta = (down.current.lastX - p.x) / shape.current.width * (z - a); change(a + delta, z + delta); }
            down.current.lastX = p.x;
          }
        }}
        onPointerUp={e => {
          const p = coords(e), click = !down.current.moved && gestures.current.size === 1;
          gestures.current.delete(e.pointerId); down.current.distance = 0;
          if (gestures.current.size) { const remaining = [...gestures.current.values()][0]; down.current.lastX = remaining.x; down.current.moved = true; }
          if (click) pick(p.x, p.y);
        }}
        onPointerCancel={e => { gestures.current.delete(e.pointerId); down.current.moved = true; down.current.distance = 0; }}
        onLostPointerCapture={e => { gestures.current.delete(e.pointerId); }}
        onPointerLeave={() => { if (!gestures.current.size) pointer.current = null; }} />
    </div>
    <canvas ref={navigator} data-testid="range-navigator" className="range-navigator" style={{ touchAction: 'none' }}
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(), c = (e.clientX - r.left) / r.width * data.bars.length;
        const span = view[1] - view[0]; change(c - span / 2, c + span / 2);
      }}
      onPointerMove={e => { if (e.buttons !== 1) return; const r = e.currentTarget.getBoundingClientRect(), c = (e.clientX - r.left) / r.width * data.bars.length; const span = view[1] - view[0]; change(c - span / 2, c + span / 2); }} />
    <div className="range-controls">
      <label>表示開始<input aria-label="表示開始" type="range" min={0} max={Math.max(0, data.bars.length - 3)} value={view[0]} onChange={e => change(Number(e.target.value), view[1])} /></label>
      <label>表示終了<input aria-label="表示終了" type="range" min={3} max={data.bars.length} value={view[1]} onChange={e => change(view[0], Number(e.target.value))} /></label>
      <button onClick={() => onSelect(Math.max(0, selected - 1))}>選択足 ‹</button><button onClick={() => onSelect(Math.min(data.bars.length - 1, selected + 1))}>選択足 ›</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {points.length === 2 && <p className="range-ruler" data-testid="range-ruler">{((points[1].ticks - points[0].ticks) * data.tickSize).toFixed(2)}ポイント ／ {points[1].ticks - points[0].ticks} ticks ／ {elapsedUs(points[1].us - points[0].us)}</p>}
    <p className="range-help">月全体は価格包絡表示。橙＝部分足・取得欠け、縦点線＝CTセッション、灰帯＝定時休場。足を拡大して高安をクリック／タップ。ドラッグ移動・ホイール／2本指拡縮。下の縮小図で移動。</p>
  </section>;
}
