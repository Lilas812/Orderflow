import { useRef, type PointerEvent } from 'react';
import { touchView, type TouchPoint, type TouchPlot, type TouchView } from '@/lib/chart-touch';

/** Touch only: desktop wheel/drag handlers remain unchanged. */
export function useChartTouch({
  view, plot, apply, constrain, onTap, onHover,
}: {
  view: TouchView | null; plot: TouchPlot;
  apply: (v: TouchView) => void; constrain: (v: TouchView) => TouchView;
  onTap?: (p: TouchPoint) => void; onHover?: (p: TouchPoint | null) => void;
}) {
  const current = useRef(view);
  current.current = view;
  const points = useRef(new Map<number, TouchPoint>());
  const base = useRef<{ view: TouchView; points: TouchPoint[]; panTime: boolean } | null>(null);
  const tap = useRef<TouchPoint | null>(null);
  const rebase = () => {
    const p = [...points.current.values()].slice(0, 2);
    base.current = current.current && p.length
      ? { view: current.current, points: p, panTime: p[0].x >= plot.x0 && p[0].x <= plot.x1 }
      : null;
  };
  const local = (e: PointerEvent<HTMLCanvasElement>): TouchPoint => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== 'touch') return false;
    if (!current.current) return true;
    e.preventDefault();
    const p = local(e);
    points.current.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    tap.current = points.current.size === 1 ? p : null;
    onHover?.(null);
    rebase();
    return true;
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== 'touch') return false;
    if (!points.current.has(e.pointerId) || !base.current) return true;
    e.preventDefault();
    const p = local(e);
    points.current.set(e.pointerId, p);
    if (tap.current && Math.abs(p.x - tap.current.x) + Math.abs(p.y - tap.current.y) > 3) tap.current = null;
    if (tap.current) return true;
    const b = base.current;
    const v = constrain(touchView(b.view, b.points, [...points.current.values()], plot, b.panTime));
    current.current = v;
    apply(v);
    return true;
  };
  const end = (e: PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    if (e.pointerType !== 'touch') return false;
    if (!points.current.has(e.pointerId)) return true;
    const p = local(e), start = tap.current;
    const tapped = !cancelled && points.current.size === 1 && start
      && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) <= 3;
    points.current.delete(e.pointerId);
    tap.current = null;
    rebase(); // 2→1: continue panning from the current view, without a jump.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (tapped) { onHover?.(p); onTap?.(p); }
    else onHover?.(null);
    return true;
  };
  return { down, move, end };
}
