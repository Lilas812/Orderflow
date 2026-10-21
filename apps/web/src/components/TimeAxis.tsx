import { timeToX, type Viewport } from "@workspace/core/viewport";
import { fmtJst } from "./timeformat";
import { useTimeFormat } from "./SettingsContext";

export { fmtJst };

const STEPS_S = [10n, 30n, 60n, 300n, 600n, 1800n, 3600n, 7200n];
const NS = 1_000_000_000n;

export function TimeAxis({ vp }: { vp: Viewport }) {
  const { fmt, tzLabel } = useTimeFormat();
  const w = vp.bounds.width;
  const ticks: { ns: string; x: number }[] = [];
  if (vp.latestNs !== null && w > 0) {
    const min = BigInt(vp.time.minNs), max = BigInt(vp.time.maxNs);
    const span = max - min;
    const target = BigInt(Math.max(2, Math.floor(w / 110)));
    const step = (STEPS_S.find((s) => span / (s * NS) <= target) ?? 14400n) * NS;
    for (let t = ((min + step - 1n) / step) * step; t <= max && ticks.length < 40; t += step) {
      const x = timeToX(vp, t.toString());
      if (x !== null) ticks.push({ ns: t.toString(), x });
    }
  }
  return (
    <svg className="time-axis" width={w} height={34} viewBox={`0 0 ${w} 34`} data-testid="time-axis" data-timezone={tzLabel}>
      <line x1={0} x2={w} y1={0.5} y2={0.5} className="axis-line" />
      {ticks.map((t) => (
        <g key={t.ns} data-testid={`time-tick-${t.ns}`} data-x={t.x}>
          <line x1={t.x} x2={t.x} y1={0} y2={5} className="axis-line" />
          <text x={t.x} y={20} textAnchor={t.x < 45 ? "start" : t.x > w - 45 ? "end" : "middle"}
            className="axis-text">{fmt(t.ns)}</text>
        </g>
      ))}
      {vp.latestNs === null && <text x={8} y={20} className="axis-text axis-dim">NO DATA</text>}
    </svg>
  );
}
