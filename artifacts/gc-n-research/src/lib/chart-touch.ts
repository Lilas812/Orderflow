export interface TouchView { t0: number; t1: number; p0: number; p1: number }
export interface TouchPoint { x: number; y: number }
export interface TouchPlot { x0: number; x1: number; top: number; bottom: number }

/** Preserve the data under the initial centroid while moving/scaling the view. */
export function touchView(
  view: TouchView, before: TouchPoint[], after: TouchPoint[], plot: TouchPlot, panTime: boolean,
): TouchView {
  const count = Math.min(2, before.length, after.length);
  if (!count) return view;
  const center = (p: TouchPoint[]) => ({
    x: p.slice(0, count).reduce((n, q) => n + q.x, 0) / count,
    y: p.slice(0, count).reduce((n, q) => n + q.y, 0) / count,
  });
  const a = center(before), b = center(after);
  const distance = (p: TouchPoint[]) => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
  const scale = count === 2 ? Math.max(1, distance(before)) / Math.max(1, distance(after)) : 1;
  const tw = view.t1 - view.t0, pw = view.p1 - view.p0;
  const width = Math.max(1, plot.x1 - plot.x0), height = Math.max(1, plot.bottom - plot.top);
  const anchorT = view.t0 + (a.x - plot.x0) / width * tw;
  const anchorP = view.p0 + (plot.bottom - a.y) / height * pw;
  const time = count === 2 || panTime;
  const t0 = time ? anchorT - (b.x - plot.x0) / width * tw * scale : view.t0;
  const p0 = anchorP - (plot.bottom - b.y) / height * pw * scale;
  return { t0, t1: time ? t0 + tw * scale : view.t1, p0, p1: p0 + pw * scale };
}
