import { useEffect, useMemo, useRef, useState } from "react";
import { executedVolume, type BookSide, type Trade } from "@workspace/core/events";
import type { QualityInterval } from "@workspace/core/quality-timeline";
import {
  buildPriceSegments, tickToY, timeToX, MAX_SPAN_NS, MIN_SPAN_NS,
  createViewport, resizeViewport, zoomTime, panTime, panPrice,
  type ChartBounds, type Viewport,
} from "@workspace/core/viewport";
import {
  DEFAULT_SCALE, captureBaseline, collectQuantityStages, relativeP95, resolveReference,
  type RelativeReference, type ScaleBaseline, type ScaleSettings,
} from "@workspace/core/heatmap-scale";
import { DEFAULT_PALETTES, type HeatmapStyle, type Palette } from "@workspace/render";
import { useViewport } from "../hooks/useViewport";
import { HeatmapCanvas, HeatmapLegend, HEATMAP_SCENES, sceneForWidth, type HeatmapId, type HeatmapScene } from "./HeatmapCanvas";
import { HeatmapDebugControls, type Rgb, type SideStatus } from "./HeatmapDebugControls";
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
  heatmap: HeatmapScene | null;
  onSelectHeatmap: (id: HeatmapId | null) => void;
}

/** Verification-mode viewport built only from existing core functions: last 60 s (R05 minimum span), price MANUAL. */
function verificationViewport(s: HeatmapScene, bounds: ChartBounds, dpr: number): Viewport {
  const base = createViewport({
    bounds, latestNs: s.endNs, dpr, price: { minTick: s.priceMinTick, maxTick: s.priceMaxTick },
  });
  return {
    ...base, time: { minNs: (BigInt(s.endNs) - MIN_SPAN_NS).toString(), maxNs: s.endNs },
    timeMode: "HISTORY", priceMode: "MANUAL",
  };
}

const SIDES: readonly BookSide[] = ["BID", "ASK"];
const recKey = (mode: string, side: BookSide, width: number) => `${mode}|${side}|${width}`;

export function ChartShell({ trades, mockOn, onToggleMock, onAddThird, heatmap: baseScene, onSelectHeatmap }: Props) {
  const tv = useViewport(trades, MOCK_QUALITY);
  const [settings, setSettings] = useState<ScaleSettings>({ ...DEFAULT_SCALE });
  const [palettes, setPalettes] = useState<Readonly<Record<BookSide, Palette>>>(DEFAULT_PALETTES);
  const [records, setRecords] = useState<Readonly<Record<string, ScaleBaseline | null>>>({});
  const [captureError, setCaptureError] = useState<string | null>(null);
  const heatmap = useMemo(() => (baseScene ? sceneForWidth(baseScene.id, settings.width) : null), [baseScene, settings.width]);
  // Candidates depend only on scene history/width/side/end, NOT threshold, palette, contrast or viewport.
  const candidates = useMemo(() => {
    const out = {} as Record<BookSide, { ref: RelativeReference | null; error: string | null }>;
    for (const side of SIDES) {
      if (!heatmap) { out[side] = { ref: null, error: null }; continue; }
      try {
        const query = { side, width: heatmap.width, priceTicks: heatmap.referencePrices, asOfNs: heatmap.endNs };
        out[side] = { ref: relativeP95(collectQuantityStages(heatmap.history, query), query), error: null };
      } catch (e) { out[side] = { ref: null, error: e instanceof Error ? e.message : String(e) }; }
    }
    return out;
  }, [heatmap]);
  // A scene/HISTORY change must not silently replace or erase a captured comparison baseline.
  const capture = (s: ScaleSettings) => {
    const out: Record<string, ScaleBaseline | null> = {};
    for (const side of SIDES) {
      const c = candidates[side].ref; if (!c) continue;
      out[recKey(s.mode, side, s.width)] = captureBaseline(s, c);
    }
    return out;
  };
  const update = (patch: Partial<ScaleSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setCaptureError(null);
    if (patch.fixedBaseline === true) {
      try { setRecords(capture(next)); } catch (e) { setCaptureError(e instanceof Error ? e.message : String(e)); }
    } else if (patch.fixedBaseline === false) setRecords({});
  };
  const recalibrate = () => {
    try { setRecords((r) => ({ ...r, ...capture(settings) })); setCaptureError(null); }
    catch (e) { setCaptureError(e instanceof Error ? e.message : String(e)); }
  };
  const sideStatus: SideStatus[] = SIDES.map((side) => {
    const cand = candidates[side];
    const record = records[recKey(settings.mode, side, settings.width)];
    let reference: number | null = null, error = cand.error;
    if (cand.ref) {
      try { reference = resolveReference(settings, cand.ref, record ?? null); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    return { side, reference, candidate: cand.ref, record, error };
  });
  const bidRef = sideStatus[0].reference, askRef = sideStatus[1].reference;
  const style = useMemo<HeatmapStyle | undefined>(() => heatmap ? {
    settings, references: { BID: bidRef, ASK: askRef }, palettes,
  } : undefined, [heatmap, settings, bidRef, askRef, palettes]);
  const setPalette = (side: BookSide, end: "low" | "high", rgb: Rgb) =>
    setPalettes((p) => ({ ...p, [side]: { ...p[side], [end]: rgb } }));
  const [hmVp, setHmVp] = useState<Viewport>(() => createViewport({ bounds: { left: 0, top: 0, width: 0, height: 0 } }));
  useEffect(() => {
    if (heatmap) setHmVp((v) => verificationViewport(heatmap, v.bounds, v.dpr));
  }, [heatmap]);
  const vp = heatmap ? hmVp : tv.vp;
  const { latest, priceAuto } = tv;
  const resize = (w: number, h: number, d: number) => {
    tv.resize(w, h, d);
    setHmVp((v) => v.bounds.width === w && v.bounds.height === h && v.dpr === d
      ? v : resizeViewport(v, { left: 0, top: 0, width: w, height: h }, d));
  };
  const zoom = (x: number, f: number) => { if (heatmap) setHmVp((v) => zoomTime(v, x, f)); else tv.zoom(x, f); };
  const panX = (dx: number) => { if (heatmap) setHmVp((v) => panTime(v, dx)); else tv.panX(dx); };
  const panY = (dy: number, start: Viewport) => {
    if (!heatmap) { tv.panY(dy, start); return; }
    setHmVp((v) => {
      if (!start.price) return v;
      return { ...v, price: panPrice(start, dy).price, priceMode: "MANUAL" };
    });
  };
  const fitFixture = () => { if (heatmap) setHmVp((v) => verificationViewport(heatmap, v.bounds, v.dpr)); };
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
  const segments = heatmap ? [] : buildPriceSegments(trades, MOCK_QUALITY);
  const pt = (t: Trade) => {
    const x = timeToX(vp, t.header.exchangeTimeNs!), y = tickToY(vp, t.priceTicks);
    return x === null || y === null ? null : { x, y };
  };
  const gaps = heatmap || vp.latestNs === null ? [] : MOCK_QUALITY.filter((i) => i.status !== "VALID").flatMap((i, n) => {
    const lat = BigInt(vp.latestNs!);
    if (BigInt(i.startNs) > lat) return [];
    const end = i.endNs !== null && BigInt(i.endNs) < lat ? i.endNs : lat.toString();
    const x0 = timeToX(vp, i.startNs), x1 = timeToX(vp, end);
    return x0 === null || x1 === null ? [] : [{ n, x0, x1, i }];
  });
  const hasData = vp.latestNs !== null;
  const spanMin = Number((BigInt(vp.time.maxNs) - BigInt(vp.time.minNs)) / 1_000_000_000n) / 60;

  return (
    <section className={heatmap ? "cs cs-heatmap" : "cs"} data-testid="chart-shell">
      <div className="cs-bar">
        <span className={`pill ${vp.timeMode === "LIVE" ? "pill-on" : ""}`} data-testid="mode-time" data-mode={vp.timeMode}>
          VIEWPORT {vp.timeMode}
        </span>
        <span className="note">viewport tracking only; not a live connection</span>
        {heatmap ? (
          <button type="button" className="btn" data-testid="button-fit-fixture" onClick={fitFixture}>検証範囲へ</button>
        ) : (
          <button type="button" className="btn" data-testid="button-latest" onClick={latest}>最新</button>
        )}
        <span className="pill" data-testid="mode-price" data-mode={vp.priceMode}>PRICE {vp.priceMode}</span>
        {heatmap ? (
          <span className="pill" data-testid="status-price-data" data-state="HEATMAP VERIFICATION">
            VERIFICATION RANGE {heatmap.priceMinTick}..{heatmap.priceMaxTick}
          </span>
        ) : (
          <span className="pill" data-testid="status-price-data" data-state={vp.priceData}>
            {vp.priceData === "VALID" ? "PRICE VALID" : "NO TRADE PRICE"}
          </span>
        )}
        <button type="button" className="btn" data-testid="button-price-auto" onClick={priceAuto} disabled={!!heatmap}>価格自動</button>
        {heatmap && <span className="note" data-testid="text-price-auto-note">AUTO disabled: fixed verification range, not a Trade price</span>}
        <span className="spacer" />
        <button type="button" className="btn" data-testid="button-heatmap-f01" aria-pressed={heatmap?.id === "F01"}
          onClick={() => onSelectHeatmap("F01")}>Heatmap F01</button>
        <button type="button" className="btn" data-testid="button-heatmap-f02" aria-pressed={heatmap?.id === "F02"}
          onClick={() => onSelectHeatmap("F02")}>Heatmap F02</button>
        <button type="button" className="btn" data-testid="button-heatmap-f03" aria-pressed={heatmap?.id === "F03"}
          onClick={() => onSelectHeatmap("F03")}>Heatmap F03</button>
        <button type="button" className="btn" data-testid="button-heatmap-off" disabled={!heatmap}
          onClick={() => onSelectHeatmap(null)}>Heatmap off</button>
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
          {heatmap && <HeatmapCanvas cells={heatmap.cells} vp={vp} style={style} />}
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
            {!heatmap && (!hasData || vp.priceData !== "VALID") && (
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
      {heatmap ? (<>
        <HeatmapDebugControls settings={settings} onChange={update} palettes={palettes} onPalette={setPalette}
          onRecalibrate={recalibrate} status={sideStatus} captureError={captureError} />
        <HeatmapLegend scene={heatmap} style={style} />
      </>) : (
        <p className="note howto" data-testid="text-mock-howto">
          MOCK fixture: {MOCK_INSTRUMENT}, 2026-01-01 00:00:00 UTC (09:00:00 JST), three Trades at +0s 80000, +300s 80100, +600s 80040 ticks;
          TRADES GAP [+360s, +540s). Verify: enable MOCK (2 events, one segment), add 3rd point (isolated marker; no line across the GAP).
        </p>
      )}
      <span hidden data-testid="heatmap-scene-list" data-ids={HEATMAP_SCENES.map((s) => s.id).join(",")} />
    </section>
  );
}
