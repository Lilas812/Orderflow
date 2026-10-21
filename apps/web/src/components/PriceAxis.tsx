import { useRef } from "react";
import { tickToY, type Viewport } from "@workspace/core/viewport";

const STEPS = [1, 2, 4, 8, 20, 40, 100, 200, 400, 1000, 2000, 4000];

export function PriceAxis({ vp, onPan }: { vp: Viewport; onPan: (dy: number, start: Viewport) => void }) {
  const last = useRef<{ y: number; vp: Viewport } | null>(null);
  const h = vp.bounds.height;
  const ticks: { tick: number; y: number }[] = [];
  if (vp.price && h > 0) {
    const span = vp.price.maxTick - vp.price.minTick;
    const step = STEPS.find((s) => span / s <= Math.max(2, h / 40)) ?? STEPS[STEPS.length - 1];
    for (let t = Math.ceil(vp.price.minTick / step) * step; t <= vp.price.maxTick; t += step) {
      const y = tickToY(vp, t);
      if (y !== null) ticks.push({ tick: t, y });
    }
  }
  return (
    <svg
      className="price-axis" width={72} height={h} viewBox={`0 0 72 ${h}`}
      data-testid="price-axis" data-min-tick={vp.price?.minTick ?? ""} data-max-tick={vp.price?.maxTick ?? ""}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId); last.current = { y: e.clientY, vp };
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        onPan(e.clientY - last.current.y, last.current.vp);
      }}
      onPointerUp={() => { last.current = null; }} onPointerCancel={() => { last.current = null; }}
      onLostPointerCapture={() => { last.current = null; }}
    >
      <line x1={0.5} x2={0.5} y1={0} y2={h} className="axis-line" />
      {ticks.map((t) => (
        <g key={t.tick} data-testid={`price-tick-${t.tick}`} data-y={t.y}>
          <line x1={0} x2={5} y1={t.y} y2={t.y} className="axis-line" />
          <text x={9} y={t.y + 4} className="axis-text">{(t.tick / 4).toFixed(2)}</text>
        </g>
      ))}
      {!vp.price && <text x={9} y={20} className="axis-text axis-dim">NO DATA</text>}
    </svg>
  );
}
