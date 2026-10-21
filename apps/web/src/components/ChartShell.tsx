import { useEffect, useRef } from "react";
import { executedVolume, type Trade } from "@workspace/core/events";
import type { QualityInterval } from "@workspace/core/quality-timeline";
import {
  buildPriceSegments, tickToY, timeToX, MAX_SPAN_NS,
} from "@workspace/core/viewport";
import { useViewport } from "../hooks/useViewport";
import { PriceAxis } from "./PriceAxis";
import { TimeAxis, fmtJst } from "./TimeAxis";

export const MOCK_INSTRUMENT = "CME:NQ:2026-03";
export const MOCK_SESSION = "MOCK-SESSION-2026-01-01";
const T0 = 1767225600000000000n; // 2026-01-01T00:00:00Z = 09:00:00 JST
const S = 1_000_000_000n;
function mockTrade(i: number, offsetS: bigint, priceTicks: number): Trade {
  const t = (T0 + offsetS * S).toString();
  return {
    kind: "TRADE",
    header: {
      schemaVersion: 1, environment: "MOCK", source: "MOCK_DETERMINISTIC", sourceId: "MOCK-R05",
      canonicalInstrumentId: MOCK_INSTRUMENT, channel: "TRADES", sessionId: MOCK_SESSION,
      exchangeTimeNs: t, receiveTimeNs: t, sourceTimePrecision: "ns", sequenceScope: "CHANNEL",
      sequence: String(i), eventId: `mock-r05-${i}`, quality: "VALID",
    },
    tradeId: `mock-r05-trade-${i}`, priceTicks, qty: executedVolume(1),
    aggressor: "UNKNOWN", classification: "UNKNOWN",
  };
}
export const MOCK_TRADES: readonly Trade[] = [
  mockTrade(1, 0n, 80000), mockTrade(2, 300n, 80100), mockTrade(3, 600n, 80040),
];
const q = (startS: bigint, endS: bigint | null, status: "VALID" | "GAP", reason: string): QualityInterval => ({
  channel: "TRADES", startNs: (T0 + startS * S).toString(),
  endNs: endS === null ? null : (T0 + endS * S).toString(), status, reason,
  sequenceVerification: status === "VALID" ? "CONTIGUOUS" : "NOT_CHECKED", // declared MOCK evidence only
});
export const MOCK_QUALITY: readonly QualityInterval[] = [
  q(0n, 360n, "VALID", "MOCK declared"), q(360n, 540n, "GAP", "MOCK declared gap"),
  q(540n, null, "VALID", "MOCK declared"),
];

interface Props {
  trades: readonly Trade[];
  mockOn: boolean;
  onToggleMock: () => void;
  onAddThird: () => void;
}

export function ChartShell({ trades, mockOn, onToggleMock, onAddThird }: Props) {
  const { vp, resize, zoom, panX, panY, latest, priceAuto } = useViewport(trades, MOCK_QUALITY);
  const chartRef = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const resizeRef = useRef(resize); resizeRef.current = resize;

  useEffect(() => {
    const el = chartRef.current; if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      resizeRef.current(r.width, r.height, window.devicePixelRatio);
    };
    const ro = new ResizeObserver(measure); ro.observe(el); measure();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.deltaY !== 0) zoomRef.current(e.clientX - r.left, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect(); el.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", measure);
    };
  }, []);

  const { width: w, height: h } = vp.bounds;
  const segments = buildPriceSegments(trades, MOCK_QUALITY);
  const pt = (t: Trade) => {
    const x = timeToX(vp, t.header.exchangeTimeNs!), y = tickToY(vp, t.priceTicks);
    return x === null || y === null ? null : { x, y };
  };
  const gaps = vp.latestNs === null ? [] : MOCK_QUALITY.filter((i) => i.status !== "VALID").flatMap((i, n) => {
    const lat = BigInt(vp.latestNs!);
    if (BigInt(i.startNs) > lat) return [];
    const end = i.endNs !== null && BigInt(i.endNs) < lat ? i.endNs : lat.toString();
    const x0 = timeToX(vp, i.startNs), x1 = timeToX(vp, end);
    return x0 === null || x1 === null ? [] : [{ n, x0, x1, i }];
  });
  const hasData = vp.latestNs !== null;
  const spanMin = Number((BigInt(vp.time.maxNs) - BigInt(vp.time.minNs)) / 1_000_000_000n) / 60;

  return (
    <section className="cs" data-testid="chart-shell">
      <div className="cs-bar">
        <span className={`pill ${vp.timeMode === "LIVE" ? "pill-on" : ""}`} data-testid="mode-time" data-mode={vp.timeMode}>
          VIEWPORT {vp.timeMode}
        </span>
        <span className="note">viewport tracking only; not a live connection</span>
        <button type="button" className="btn" data-testid="button-latest" onClick={latest}>最新</button>
        <span className="pill" data-testid="mode-price" data-mode={vp.priceMode}>PRICE {vp.priceMode}</span>
        <span className="pill" data-testid="status-price-data" data-state={vp.priceData}>
          {vp.priceData === "VALID" ? "PRICE VALID" : "NO TRADE PRICE"}
        </span>
        <button type="button" className="btn" data-testid="button-price-auto" onClick={priceAuto}>価格自動</button>
        <span className="spacer" />
        <button type="button" className="btn" data-testid="button-mock-toggle" onClick={onToggleMock}>
          {mockOn ? "MOCK 無効化" : "MOCK 有効化"}
        </button>
        <button type="button" className="btn" data-testid="button-mock-third"
          disabled={!mockOn || trades.length !== 2} onClick={onAddThird}>MOCK 3点目を追加</button>
      </div>
      <div className="cs-grid">
        <div className="cs-chart" ref={chartRef} data-testid="chart-area"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId); drag.current = e.clientX;
          }}
          onPointerMove={(e) => {
            if (drag.current === null) return;
            const dx = e.clientX - drag.current; drag.current = e.clientX; if (dx) panX(dx);
          }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}>
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} data-testid="chart-svg"
            data-width={w} data-height={h} data-dpr={vp.dpr}>
            <defs><clipPath id="chart-clip"><rect x={0} y={0} width={w} height={h} /></clipPath></defs>
            <text x={12} y={20} className="wm">MOCK / SIMULATED</text>
            <g clipPath="url(#chart-clip)">
              {gaps.map((g) => (
                <g key={g.n} data-testid={`gap-${g.n}`} data-x0={g.x0} data-x1={g.x1}>
                  <rect x={g.x0} y={0} width={Math.max(0, g.x1 - g.x0)} height={h} className="gap-band" />
                  <text x={g.x0 + 6} y={38} className="gap-text">GAP: TRADES</text>
                </g>
              ))}
              {segments.map((seg, i) => {
                const pts = seg.map(pt).filter((p): p is { x: number; y: number } => p !== null);
                return (
                  <g key={i} data-testid={`segment-${i}`} data-points={pts.length}>
                    {pts.length > 1 && <polyline className="price-line"
                      points={pts.map((p) => `${p.x},${p.y}`).join(" ")} />}
                    {seg.length === 1 && pts[0] && <circle cx={pts[0].x} cy={pts[0].y} r={3} className="iso-dot" />}
                  </g>
                );
              })}
            </g>
            {(!hasData || vp.priceData !== "VALID") && (
              <text x={w / 2} y={h / 2} textAnchor="middle" className="empty-text">
                {hasData ? "NO DATA • NO TRADE PRICE" : "NO DATA"}
              </text>
            )}
          </svg>
        </div>
        <PriceAxis vp={vp} onPan={panY} />
        <TimeAxis vp={vp} />
      </div>
      <div className="cs-info" data-testid="viewport-info">
        <span>Time (JST): <b data-testid="text-time-min" data-ns={vp.time.minNs}>{hasData ? fmtJst(vp.time.minNs, true) : "—"}</b>
          {" → "}<b data-testid="text-time-max" data-ns={vp.time.maxNs}>{hasData ? fmtJst(vp.time.maxNs, true) : "—"}</b></span>
        <span>Price ticks: <b data-testid="text-price-min">{vp.price?.minTick ?? "—"}</b>
          {" → "}<b data-testid="text-price-max">{vp.price?.maxTick ?? "—"}</b></span>
        <span data-testid="text-span">Span {hasData ? spanMin.toFixed(1) : "—"} min (recommended max {String(MAX_SPAN_NS / 60_000_000_000n / 60n)} h)</span>
      </div>
      <p className="note howto" data-testid="text-mock-howto">
        MOCK fixture: {MOCK_INSTRUMENT}, 2026-01-01 00:00:00 UTC (09:00:00 JST), three Trades at +0s 80000, +300s 80100, +600s 80040 ticks;
        TRADES GAP [+360s, +540s). Verify: enable MOCK (2 events, one segment), add 3rd point (isolated marker; no line across the GAP).
      </p>
    </section>
  );
}
