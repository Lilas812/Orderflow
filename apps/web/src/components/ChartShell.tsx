import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { executedVolume, type BookSide, type Trade } from "@workspace/core/events";
import type { QualityInterval } from "@workspace/core/quality-timeline";
import {
  buildPriceSegments, tickToY, timeToX, MAX_SPAN_NS, MIN_SPAN_NS,
  createViewport, resizeViewport, zoomTime, panTime, panPrice, goLatest,
  type ChartBounds, type Viewport,
} from "@workspace/core/viewport";
import {
  DEFAULT_SCALE, captureBaseline, collectQuantityStages, relativeP95, resolveReference,
  type RelativeReference, type ScaleBaseline, type ScaleSettings,
} from "@workspace/core/heatmap-scale";
import { DEFAULT_PALETTES, projectHeatmap, type HeatmapStyle, type Palette } from "@workspace/render";
import { useViewport } from "../hooks/useViewport";
import { HeatmapCanvas, HeatmapLegend, HEATMAP_SCENES, sceneForWidth, type HeatmapId, type HeatmapScene } from "./HeatmapCanvas";
import { HeatmapDebugControls, type Rgb, type SideStatus } from "./HeatmapDebugControls";
import { R09_SCENARIOS, R10_SCENARIOS, R10_CONTINUITY, R11_DELTA_CASES } from "@workspace/fixtures";
import {
  advanceDeltaWatermark, createDeltaTimeline, ingestDeltaTrade, projectDeltaTimeline, queryDeltaTimeline,
  setDeltaCondition, type DeltaBin, type DeltaFrame, type DeltaTimeline,
} from "@workspace/core/delta-timeline";
import { DeltaPanel, DeltaTable } from "./DeltaPanel";
import type { BubbleDensity, ClusteringOptions } from "@workspace/render/bubble-clustering";

const ALL_SCN = [...R09_SCENARIOS, ...R10_SCENARIOS];
const DENSITIES: readonly BubbleDensity[] = ["ALL", "STANDARD", "HIGH_COMPRESSION"];
import {
  DEFAULT_BUBBLE_SIZING, type BubbleSizing, type BubbleSizingMode,
} from "@workspace/core/bubble-sizing";
import {
  advanceBubbleWatermark, createBubbleFinality, ingestBubbleTrade, setBubbleCondition,
} from "@workspace/core/bubble-finality";
import { projectBubbles } from "@workspace/render/bubbles";
import { BubbleCanvas, bubbleBackdropCells } from "./BubbleCanvas";
import { PriceAxis } from "./PriceAxis";
import { TimeAxis, fmtJst } from "./TimeAxis";

export const MOCK_INSTRUMENT = "CME:NQ:2026-03";
export const MOCK_SESSION = "MOCK-SESSION-2026-01-01";
const T0 = 1767225600000000000n; // 2026-01-01T00:00:00Z = 09:00:00 JST
const S = 1_000_000_000n;
const BUBBLE_NS = 2_000_000_000n;
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
  bubbleId: string | null;
  onSelectBubble: (id: string | null) => void;
  /** Raw Trade inputs ingested at the selected stage (not derived bubbles). */
  onBubbleRaw: (n: number) => void;
  deltaId: string | null;
  onSelectDelta: (id: string | null) => void;
  /** Raw Trade inputs ingested across all independent Delta sources. */
  onDeltaRaw: (n: number) => void;
}

/** Verification-mode viewport built only from existing core functions: last 60 s (R05 minimum span), price MANUAL. */
function verificationViewport(s: { endNs: string; priceMinTick: number; priceMaxTick: number; spanNs?: bigint }, bounds: ChartBounds, dpr: number): Viewport {
  const base = createViewport({
    bounds, latestNs: s.endNs, dpr, price: { minTick: s.priceMinTick, maxTick: s.priceMaxTick },
  });
  return {
    ...base, time: { minNs: (BigInt(s.endNs) - (s.spanNs ?? MIN_SPAN_NS)).toString(), maxNs: s.endNs },
    timeMode: "HISTORY", priceMode: "MANUAL",
  };
}

const SIDES: readonly BookSide[] = ["BID", "ASK"];
const recKey = (mode: string, side: BookSide, width: number) => `${mode}|${side}|${width}`;

export function ChartShell({ trades, mockOn, onToggleMock, onAddThird, heatmap: baseScene, onSelectHeatmap, bubbleId, onSelectBubble, onBubbleRaw, deltaId, onSelectDelta, onDeltaRaw }: Props) {
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
  /* ---- R09 bubble verification (independent of heatmap F01; viewport reset on scenario id only) ---- */
  const scn = useMemo(() => (bubbleId ? ALL_SCN.find((s) => s.id === bubbleId) ?? null : null), [bubbleId]);
  const isR10 = !!scn && R10_SCENARIOS.some((s) => s.id === scn.id);
  const [stage, setStage] = useState(0);
  const [bsMode, setBsMode] = useState<BubbleSizingMode>(DEFAULT_BUBBLE_SIZING.mode);
  const [density, setDensity] = useState<BubbleDensity>("STANDARD");
  const [spanS, setSpanS] = useState(600);
  const [selCluster, setSelCluster] = useState<string | null>(null);
  useEffect(() => { setStage(0); setSpanS(600); setSelCluster(null); }, [bubbleId]);
  const bubbleSeed = useMemo(() => {
    if (!scn) return null;
    const t0 = scn.events.reduce((m, e) => { const t = BigInt(e.header.exchangeTimeNs!); return m === null || t < m ? t : m; }, null as bigint | null);
    const start = ((t0 ?? 0n) / BUBBLE_NS) * BUBBLE_NS;
    if (isR10) {
      return { endNs: (start + 30n * S).toString(), priceMinTick: 79900, priceMaxTick: 80100, spanNs: BigInt(spanS) * S };
    }
    return { endNs: (start + 6n * S).toString(), priceMinTick: 79980, priceMaxTick: 80020 };
  }, [scn, isR10, spanS]);
  const dcase = useMemo(() => (deltaId ? R11_DELTA_CASES.find((c) => c.id === deltaId) ?? null : null), [deltaId]);
  const clustering = useMemo<ClusteringOptions>(() => {
    const c = isR10 && scn ? R10_CONTINUITY[scn.id] : dcase?.id === "DENSITY" ? R10_CONTINUITY["DENSITY"] : undefined;
    return { mode: density, continuity: c ? [c] : [] };
  }, [density, isR10, scn, dcase]);
  const backdrop = useMemo(() => (bubbleId ? bubbleBackdropCells(bubbleId) : null), [bubbleId]);
  useEffect(() => {
    if (bubbleSeed) setHmVp((v) => verificationViewport(bubbleSeed, v.bounds, v.dpr));
  }, [bubbleSeed]);
  const stageIdx = scn ? Math.min(stage, scn.steps.length - 1) : 0;
  const replayed = useMemo(() => {
    if (!scn) return null;
    try {
      let st = createBubbleFinality(scn.events[0].header, scn.quality);
      let ingested = 0;
      for (let i = 0; i <= stageIdx; i++) {
        const step = scn.steps[i];
        for (; ingested < step.tradeCount; ingested++) st = ingestBubbleTrade(st, scn.events[ingested]);
        if (step.condition) st = setBubbleCondition(st, step.condition);
        if (step.progressNs) {
          st = advanceBubbleWatermark(st, {
            exchangeTimeNs: step.progressNs, trusted: true,
            evidence: "Explicit R09 MOCK event-time progress, not wallclock", scope: st.store.scope,
          });
        }
      }
      return { fin: st, raw: ingested, error: null as string | null };
    } catch (e) { return { fin: null, raw: 0, error: e instanceof Error ? e.message : String(e) }; }
  }, [scn, stageIdx]);
  const bubbles = useMemo(() => replayed?.fin?.bubbles ?? [], [replayed]);
  const sizing = useMemo<BubbleSizing>(() => ({ ...DEFAULT_BUBBLE_SIZING, mode: bsMode }), [bsMode]);
  const onBubbleRawRef = useRef(onBubbleRaw); onBubbleRawRef.current = onBubbleRaw;
  const rawNow = scn ? replayed?.raw ?? 0 : 0;
  useEffect(() => { onBubbleRawRef.current(rawNow); }, [rawNow, bubbleId]);
  /* ---- R11 Delta: independent sources replayed separately; overlay/sizing/density never touch this memo ---- */
  const [dStage, setDStage] = useState(0);
  const [showDeltaBubbles, setShowDeltaBubbles] = useState(true);
  useEffect(() => { setDStage(0); }, [deltaId]);
  const dIdx = dcase ? Math.min(dStage, dcase.steps.length - 1) : 0;
  const dSeed = useMemo(() => dcase ? {
    endNs: dcase.endNs, priceMinTick: dcase.priceMinTick, priceMaxTick: dcase.priceMaxTick, spanNs: BigInt(dcase.spanNs),
  } : null, [dcase]);
  useEffect(() => {
    if (dSeed) setHmVp((v) => verificationViewport(dSeed, v.bounds, v.dpr));
  }, [dSeed]);
  const dReplay = useMemo(() => {
    if (!dcase) return null;
    try {
      const tls: DeltaTimeline[] = dcase.sources.map((s) => createDeltaTimeline(s.header, s.quality, s.alignment));
      const ing = dcase.sources.map(() => 0);
      for (let i = 0; i <= dIdx; i++) {
        const step = dcase.steps[i];
        dcase.sources.forEach((s, k) => {
          let st = tls[k];
          for (; ing[k] < (step.counts[k] ?? 0); ing[k]++) st = ingestDeltaTrade(st, s.events[ing[k]]);
          const c = step.conditions?.[k];
          if (c) st = setDeltaCondition(st, c);
          const p = step.progressNs?.[k];
          if (p) {
            st = advanceDeltaWatermark(st, {
              exchangeTimeNs: p, trusted: true,
              evidence: "Explicit R11 MOCK event-time progress, not wallclock", scope: st.tradeState.store.scope,
            });
          }
          tls[k] = st;
        });
      }
      const sourceOf = new Map<DeltaBin, string>();
      const bins: DeltaBin[] = dcase.sources.flatMap((s, k) => {
        const q = queryDeltaTimeline(tls[k], s.range.startNs, s.range.endNs);
        q.forEach((b) => sourceOf.set(b, s.label));
        return [...q];
      });
      return { tls, bins, sourceOf, raw: ing.reduce((a, b) => a + b, 0), error: null as string | null };
    } catch (e) {
      return { tls: [] as DeltaTimeline[], bins: [] as DeltaBin[], sourceOf: new Map<DeltaBin, string>(), raw: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }, [dcase, dIdx]);
  const onDeltaRawRef = useRef(onDeltaRaw); onDeltaRawRef.current = onDeltaRaw;
  const dRaw = dReplay?.raw ?? 0;
  useEffect(() => { onDeltaRawRef.current(dRaw); }, [dRaw, deltaId]);
  const dBubbles = useMemo(() => dReplay?.tls.flatMap((t) => t.tradeState.bubbles) ?? [], [dReplay]);

  const fixed = !!heatmap || !!scn || !!dcase;
  const vp = fixed ? hmVp : tv.vp;
  const dFrame = useMemo<{ frame: DeltaFrame | null; error: string | null }>(() => {
    if (!dcase || !dReplay || vp.bounds.width <= 0) return { frame: null, error: dReplay?.error ?? null };
    try { return { frame: projectDeltaTimeline(dReplay.bins, vp, 126), error: dReplay.error }; }
    catch (e) { return { frame: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [dcase, dReplay, vp]);
  const projected = useMemo(() => {
    if (!scn || vp.bounds.width <= 0) return null;
    try {
      const f = projectBubbles(bubbles, vp, sizing, undefined, clustering);
      return { list: f.bubbles, sources: f.sourceBubbles, clusters: f.clusters, error: null as string | null };
    } catch (e) { return { list: null, sources: null, clusters: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [scn, bubbles, vp, sizing, clustering]);
  const selected = projected?.clusters?.find((c) => c.id === selCluster) ?? null;
  // The unchanged opaque R06 canvas is clipped to its actual R09 tile footprint.
  // This exposes the lower TRADES-gap layer without inventing depth outside cells.
  const backdropClip = useMemo(() => {
    const rects = backdrop ? projectHeatmap(backdrop.cells, vp).rects : [];
    if (!rects.length) return "inset(100%)";
    const l = Math.min(...rects.map(r => r.left)), r = Math.max(...rects.map(r => r.right));
    const t = Math.min(...rects.map(r => r.top)), b = Math.max(...rects.map(r => r.bottom));
    return `polygon(${l}px ${t}px,${r}px ${t}px,${r}px ${b}px,${l}px ${b}px)`;
  }, [backdrop, vp]);
  const { latest, priceAuto } = tv;
  const resize = (w: number, h: number, d: number) => {
    tv.resize(w, h, d);
    setHmVp((v) => v.bounds.width === w && v.bounds.height === h && v.dpr === d
      ? v : resizeViewport(v, { left: 0, top: 0, width: w, height: h }, d));
  };
  const zoom = (x: number, f: number) => { if (fixed) setHmVp((v) => zoomTime(v, x, f)); else tv.zoom(x, f); };
  const panX = (dx: number) => { if (fixed) setHmVp((v) => panTime(v, dx)); else tv.panX(dx); };
  const panY = (dy: number, start: Viewport) => {
    if (!fixed) { tv.panY(dy, start); return; }
    setHmVp((v) => {
      if (!start.price) return v;
      return { ...v, price: panPrice(start, dy).price, priceMode: "MANUAL" };
    });
  };
  const fitFixture = () => {
    const seed = heatmap ?? bubbleSeed ?? dSeed;
    if (seed) setHmVp((v) => verificationViewport(seed, v.bounds, v.dpr));
  };
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
      // Interactive source details scroll locally, never zoom the shared chart.
      if (e.target instanceof Element && e.target.closest(".bb-tip")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.deltaY !== 0) zoomRef.current(e.clientX - r.left, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", measure);
    // Moving between monitors / browser scaling may change DPR without a CSS resize.
    // Re-arm the query after each change; keep R05 transforms and viewport units intact.
    let resolution: MediaQueryList | null = null;
    const watchResolution = () => {
      resolution?.removeEventListener("change", watchResolution);
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution.addEventListener("change", watchResolution);
      measure();
    };
    watchResolution();
    return () => {
      ro.disconnect(); el.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", measure);
      resolution?.removeEventListener("change", watchResolution);
    };
  }, []);

  const { width: w, height: h } = vp.bounds;
  const segments = useMemo(() => {
    if (heatmap) return [];
    if (dcase) {
      // Each source is built separately; sessions are never concatenated or bridged.
      if (!dReplay) return [];
      return dcase.sources.flatMap((s, k) => {
        const st = dReplay.tls[k]?.tradeState.store;
        if (!st || st.issues.length > 0) return [];
        return buildPriceSegments(st.trades, s.quality.map((q) => ({
          ...q, sequenceVerification: q.status === "VALID" ? "CONTIGUOUS" as const : "NOT_CHECKED" as const,
        })));
      });
    }
    if (scn) {
      const fin = replayed?.fin;
      // No price line when the store reports unresolved issues; corrections are not part of the line.
      if (!fin || fin.store.issues.length > 0) return [];
      return buildPriceSegments(fin.store.trades, scn.quality.map(q => ({
        ...q, sequenceVerification: q.status === "VALID" ? "CONTIGUOUS" as const : "NOT_CHECKED" as const,
      })));
    }
    return buildPriceSegments(trades, MOCK_QUALITY);
  }, [heatmap, scn, dcase, dReplay, replayed, trades]);
  const scopeLines = dcase ? dcase.sources.slice(1).flatMap((s) => {
    const x = timeToX(vp, s.range.startNs);
    return x === null ? [] : [{ x, label: s.label }];
  }) : [];
  const pt = (t: Trade) => {
    const x = timeToX(vp, t.header.exchangeTimeNs!), y = tickToY(vp, t.priceTicks);
    return x === null || y === null ? null : { x, y };
  };
  const gaps = heatmap || vp.latestNs === null ? [] : (dcase ? dcase.sources.flatMap((s) => [...s.quality]) as unknown as readonly QualityInterval[] : (scn?.quality ?? MOCK_QUALITY)).filter((i) => i.status !== "VALID").flatMap((i, n) => {
    const lat = BigInt(vp.latestNs!);
    if (BigInt(i.startNs) > lat) return [];
    const end = i.endNs !== null && BigInt(i.endNs) < lat ? i.endNs : lat.toString();
    const x0 = timeToX(vp, i.startNs), x1 = timeToX(vp, end);
    return x0 === null || x1 === null ? [] : [{ n, x0, x1, i }];
  });
  const hasData = vp.latestNs !== null;
  const spanMin = Number((BigInt(vp.time.maxNs) - BigInt(vp.time.minNs)) / 1_000_000_000n) / 60;

  return (
    <section className={fixed ? "cs cs-heatmap" : "cs"} data-testid="chart-shell">
      <div className="cs-bar">
        <span className={`pill ${vp.timeMode === "LIVE" ? "pill-on" : ""}`} data-testid="mode-time" data-mode={vp.timeMode}>
          VIEWPORT {vp.timeMode}
        </span>
        <span className="note">viewport tracking only; not a live connection</span>
        {dcase && <button type="button" className="btn" data-testid="button-delta-latest"
          onClick={() => setHmVp((v) => goLatest(v))}>最新（MOCK検証軸）</button>}
        {fixed ? (
          <button type="button" className="btn" data-testid="button-fit-fixture" onClick={fitFixture}>検証範囲へ</button>
        ) : (
          <button type="button" className="btn" data-testid="button-latest" onClick={latest}>最新</button>
        )}
        <span className="pill" data-testid="mode-price" data-mode={vp.priceMode}>PRICE {vp.priceMode}</span>
        {heatmap ? (
          <span className="pill" data-testid="status-price-data" data-state="HEATMAP VERIFICATION">
            VERIFICATION RANGE {heatmap.priceMinTick}..{heatmap.priceMaxTick}
          </span>
        ) : scn ? (
          <span className="pill" data-testid="status-price-data" data-state="BUBBLE VERIFICATION">
            VERIFICATION RANGE {bubbleSeed?.priceMinTick}..{bubbleSeed?.priceMaxTick}
          </span>
        ) : (
          <span className="pill" data-testid="status-price-data" data-state={vp.priceData}>
            {vp.priceData === "VALID" ? "PRICE VALID" : "NO TRADE PRICE"}
          </span>
        )}
        <button type="button" className="btn" data-testid="button-price-auto" onClick={priceAuto} disabled={fixed}>価格自動</button>
        {fixed && <span className="note" data-testid="text-price-auto-note">AUTO disabled: fixed verification range, not a Trade price</span>}
        <span className="spacer" />
        <select className="btn" data-testid="select-delta" aria-label="Delta MOCK case" value={deltaId ?? ""}
          onChange={(e) => onSelectDelta(e.target.value === "" ? null : e.target.value)}>
          <option value="">Delta off</option>
          {R11_DELTA_CASES.map((c) => <option key={c.id} value={c.id}>Delta {c.id}</option>)}
        </select>
        <select className="btn" data-testid="select-bubble" aria-label="Bubble verification scenario" value={bubbleId ?? ""}
          onChange={(e) => onSelectBubble(e.target.value === "" ? null : e.target.value)}>
          <option value="">Bubble off</option>
          {ALL_SCN.map((s) => <option key={s.id} value={s.id}>Bubble {s.id}</option>)}
        </select>
        <button type="button" className="btn" data-testid="button-bubble-off" disabled={!scn}
          onClick={() => onSelectBubble(null)}>Bubble off</button>
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
      <div className={dcase ? "cs-grid cs-delta" : "cs-grid"}>
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
          {(scn || dcase) && <svg className="bb-gaps" width={w} height={h} data-testid="bubble-gap-layer">
            {gaps.map(g => <g key={g.n}>
              <rect x={g.x0} y={0} width={Math.max(0, g.x1 - g.x0)} height={h} className="gap-band" />
              <text x={g.x0 + 6} y={38} className="gap-text">GAP: TRADES</text>
            </g>)}
          </svg>}
          {scn && backdrop && backdrop.cells.length > 0 && <div className="bb-depth"
            style={{ "--bb-depth-clip": backdropClip } as CSSProperties}>
            <HeatmapCanvas cells={backdrop.cells} vp={vp} />
          </div>}
          {scn && <BubbleCanvas bubbles={bubbles} vp={vp} sizing={sizing} clustering={clustering} />}
          {dcase && showDeltaBubbles && <BubbleCanvas bubbles={dBubbles} vp={vp} sizing={sizing} clustering={clustering} />}
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} data-testid="chart-svg"
            data-width={w} data-height={h} data-dpr={vp.dpr}>
            <defs><clipPath id="chart-clip"><rect x={0} y={0} width={w} height={h} /></clipPath></defs>
            <text x={12} y={20} className="wm">MOCK / SIMULATED</text>
            <g clipPath="url(#chart-clip)">
              {scopeLines.map((l) => (
                <g key={l.label} data-testid="delta-scope-boundary">
                  <line x1={l.x} x2={l.x} y1={0} y2={h} className="bb-scope-line" />
                  <text x={l.x + 4} y={h - 8} className="bb-scope-text">scope boundary: {l.label} (independent MOCK, not combined)</text>
                </g>
              ))}
              {!scn && !dcase && gaps.map((g) => (
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
            {!fixed && (!hasData || vp.priceData !== "VALID") && (
              <text x={w / 2} y={h / 2} textAnchor="middle" className="empty-text">
                {hasData ? "NO DATA • NO TRADE PRICE" : "NO DATA"}
              </text>
            )}
          </svg>
        </div>
        <PriceAxis vp={vp} onPan={panY} />
        {dcase && dReplay && (
          <DeltaPanel frame={dFrame.frame} vp={vp} sourceOf={dReplay.sourceOf} error={dFrame.error}
            onZoom={zoom} onPan={panX} />
        )}
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
      </>) : dcase && dReplay ? (
        <div className="dbg bb-dbg" data-testid="delta-controls">
          <div className="dbg-row dbg-wrap">
            <span data-testid="text-delta-case">FIXED DELTA MOCK {dcase.id}: {dcase.label}. Multiple independent MOCK sources/sessions on one shared UTC axis; never combined or interpolated.</span>
            <button type="button" className="btn" data-testid="button-delta-prev" disabled={dIdx === 0}
              onClick={() => setDStage(dIdx - 1)}>Step -</button>
            <span data-testid="text-delta-step" data-step={dIdx}>step {dIdx + 1}/{dcase.steps.length}: {dcase.steps[dIdx].label}</span>
            <button type="button" className="btn" data-testid="button-delta-next" disabled={dIdx >= dcase.steps.length - 1}
              onClick={() => setDStage(dIdx + 1)}>Step +</button>
            <label className="dbg-check">
              <input type="checkbox" data-testid="toggle-delta-bubbles" checked={showDeltaBubbles}
                onChange={(e) => setShowDeltaBubbles(e.target.checked)} />
              show bubble overlay (Delta unaffected)
            </label>
            <label className="dbg-field">sizing
              <select data-testid="select-bubble-sizing" value={bsMode} onChange={(e) => setBsMode(e.target.value as BubbleSizingMode)}>
                {(["FIXED", "LINEAR", "SQRT", "LOG"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="dbg-field">density
              <select data-testid="select-bubble-density" value={density} onChange={(e) => setDensity(e.target.value as BubbleDensity)}>
                {DENSITIES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <div data-testid="text-delta-sources">
            {dcase.sources.map((s) => `${s.label} [${s.range.startNs}..${s.range.endNs}) ${s.alignment.timeAxis}`).join(" | ")} / raw Trade inputs ingested {dRaw}
          </div>
          {dReplay.error && <div className="dbg-warn" role="alert" data-testid="delta-replay-error">REPLAY ERROR: {dReplay.error}</div>}
          <DeltaTable frame={dFrame.frame} sourceOf={dReplay.sourceOf} />
          <p className="note">MOCK / SIMULATED. Delta quantities come from core bins (exact bigint), not from pixels or bubbles. Canvas2D rendering; no GPU claim. Gaps and unobserved ranges are NO DATA, never zero.</p>
        </div>
      ) : scn ? (
        <div className="dbg bb-dbg" data-testid="bubble-controls">
          <div className="dbg-row dbg-wrap">
            <span data-testid="text-bubble-scenario">MOCK / SIMULATED bubble scenario {scn.id}: {scn.label}</span>
            <button type="button" className="btn" data-testid="button-bubble-prev" disabled={stageIdx === 0}
              onClick={() => setStage(stageIdx - 1)}>Step -</button>
            <span data-testid="text-bubble-step" data-step={stageIdx}>
              step {stageIdx + 1}/{scn.steps.length}: {scn.steps[stageIdx].label}
            </span>
            <button type="button" className="btn" data-testid="button-bubble-next" disabled={stageIdx >= scn.steps.length - 1}
              onClick={() => setStage(stageIdx + 1)}>Step +</button>
            <label className="dbg-field">sizing
              <select data-testid="select-bubble-sizing" value={bsMode} onChange={(e) => setBsMode(e.target.value as BubbleSizingMode)}>
                {(["FIXED", "LINEAR", "SQRT", "LOG"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="dbg-field">density
              <select data-testid="select-bubble-density" value={density} onChange={(e) => setDensity(e.target.value as BubbleDensity)}>
                {DENSITIES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            {isR10 && <>
              <button type="button" className="btn" data-testid="button-bubble-span-10m" aria-pressed={spanS === 600}
                onClick={() => setSpanS(600)}>10 min</button>
              <button type="button" className="btn" data-testid="button-bubble-span-3m" aria-pressed={spanS === 180}
                onClick={() => setSpanS(180)}>3 min</button>
            </>}
          </div>
          <div data-testid="bubble-cluster-count" data-source-count={bubbles.length}
            data-display-count={projected?.clusters?.length ?? 0}>
            source bubbles {bubbles.length} / displayed clusters {projected?.clusters?.length ?? 0} / density {density} / continuity {clustering.continuity?.length ? "explicit MOCK exchange-time" : "none (no merging across unknown alignment)"}
          </div>
          <div data-testid="text-bubble-condition">
            condition {replayed?.fin?.condition ?? "—"} / watermark {replayed?.fin?.watermarkNs ?? "none"} / max valid exchange ns {replayed?.fin?.maxSeenValidExchangeNs ?? "none"} / raw events ingested {rawNow}
          </div>
          <div className="note" data-testid="text-bubble-backdrop">
            Backdrop: {backdrop?.label}. {backdrop?.error ? `UNAVAILABLE: ${backdrop.error}` : "Default ABS R06 display; explicit synthetic MOCK, not a TWA of F01."}
          </div>
          {replayed?.error && <div className="dbg-warn" role="alert" data-testid="bubble-replay-error">REPLAY ERROR: {replayed.error}</div>}
          {projected?.error && <div className="dbg-warn" role="alert" data-testid="bubble-project-error">PROJECTION ERROR: {projected.error}</div>}
          <table className="hm-table" data-testid="bubble-table">
            <thead><tr><th>bubble</th><th>start (JST)</th><th>end (JST)</th><th>ticks</th><th>B</th><th>S</th><th>U</th><th>V_raw</th><th>V</th><th>delta</th>
              <th>bucket</th><th>state</th><th>rev</th><th>final</th><th>quality</th><th>diameter</th><th>alpha</th><th>x</th><th>y</th></tr></thead>
            <tbody>
              {bubbles.map((b) => {
                const k = b.bucket;
                const cl = projected?.clusters?.find((c) => c.childrenIds.includes(b.id)) ?? null;
                const pr = projected?.sources?.find((p) => p.source === b) ?? null;
                return (
                  <tr key={b.id} data-testid={`bubble-row-${b.id}`} data-status={b.status} data-revision={b.revision}
                    data-projected={String(!!pr)} data-cluster-id={cl?.id ?? ""}>
                    <td title={b.id}>{b.id}</td><td>{fmtJst(k.startNs)}</td><td>{fmtJst(k.endNs)}</td><td>{k.minTick}..{k.maxTick}</td>
                    <td>{k.B.toString()}</td><td>{k.S.toString()}</td><td>{k.U.toString()}</td><td>{k.V_raw.toString()}</td>
                    <td>{k.V === null ? "withheld (incomplete)" : k.V.toString()}</td>
                    <td>{k.delta === null ? "withheld (incomplete)" : k.delta.toString()}</td>
                    <td>{k.status}</td><td>{b.status}</td><td>{b.revision}</td><td>{String(b.finalized)}</td>
                    <td>{k.quality.length ? k.quality.join(",") : "—"}</td>
                    <td>{pr ? pr.diameter.toFixed(6) : "not drawn"}</td><td>{pr ? pr.rgba[3].toFixed(3) : "—"}</td>
                    <td>{pr ? pr.x.toFixed(2) : "—"}</td><td>{pr ? pr.y.toFixed(2) : "—"}</td>
                  </tr>
                );
              })}
              {bubbles.length === 0 && (
                <tr data-testid="bubble-row-empty"><td colSpan={20}>No bubble state yet at this step (no accepted Trade bucket; not a statement of zero market activity).</td></tr>
              )}
            </tbody>
          </table>
          <table className="hm-table" data-testid="bubble-cluster-table">
            <thead><tr><th>cluster</th><th>children</th><th>B</th><th>S</th><th>V</th><th>delta</th><th>state</th><th>rev</th><th>diameter</th>
              <th>x</th><th>y</th><th>bounds x</th><th>bounds y</th><th>audit</th></tr></thead>
            <tbody>
              {(projected?.clusters ?? []).map((c) => (
                <tr key={c.id} data-testid={`bubble-cluster-row-${c.id}`} data-children-count={c.children.length}
                  data-selected={String(c.id === selCluster)}>
                  <td title={c.id}>{c.id}</td><td>{c.children.length}</td><td>{c.B.toString()}</td><td>{c.S.toString()}</td>
                  <td>{c.V.toString()}</td><td>{c.delta.toString()}</td><td>{c.status}</td><td>{c.revision}</td>
                  <td>{c.diameter.toFixed(6)}</td><td>{c.x.toFixed(2)}</td><td>{c.y.toFixed(2)}</td>
                  <td>{c.spread.minX.toFixed(2)}..{c.spread.maxX.toFixed(2)}</td>
                  <td>{c.spread.minY.toFixed(2)}..{c.spread.maxY.toFixed(2)}</td>
                  <td><button type="button" className="btn" data-testid={`button-cluster-audit-${c.id}`}
                    onClick={() => setSelCluster(c.id === selCluster ? null : c.id)}>{c.id === selCluster ? "Hide" : "Audit"}</button></td>
                </tr>
              ))}
              {!(projected?.clusters?.length) && (
                <tr data-testid="bubble-cluster-row-empty"><td colSpan={14}>No displayed cluster at this step or viewport.</td></tr>
              )}
            </tbody>
          </table>
          {selected && (
            <div className="bb-audit" data-testid="bubble-cluster-audit" data-cluster-id={selected.id}>
              <div>Selected cluster {selected.id}: {selected.children.length} source bubbles, {selected.status} / rev {selected.revision}</div>
              <div>B {selected.B.toString()} / S {selected.S.toString()} / V {selected.V.toString()} / Delta {selected.delta.toString()} / |Delta|/V {selected.imbalancePercent.toFixed(6)}%</div>
              <div>time {selected.startNs} .. {selected.endNs} ns / ticks {selected.minTick}..{selected.maxTick}</div>
              <div>children {selected.childrenIds.join(", ")}</div>
              <div>spread maxCenterDistance {selected.spread.maxCenterDistance.toFixed(3)} px / footprint {selected.spread.footprintWidth.toFixed(3)} x {selected.spread.footprintHeight.toFixed(3)} px
                / center width {selected.spread.width.toFixed(3)} height {selected.spread.height.toFixed(3)}</div>
              <div>Quantities are source Trade aggregates, not inferred from pixels.</div>
            </div>
          )}
          <p className="note">MOCK / SIMULATED. CPU projection values are not proof of GPU success; check BUBBLE GL status. Hidden or INCOMPLETE buckets are listed here, never treated as no activity.</p>
        </div>
      ) : (
        <p className="note howto" data-testid="text-mock-howto">
          MOCK fixture: {MOCK_INSTRUMENT}, 2026-01-01 00:00:00 UTC (09:00:00 JST), three Trades at +0s 80000, +300s 80100, +600s 80040 ticks;
          TRADES GAP [+360s, +540s). Verify: enable MOCK (2 events, one segment), add 3rd point (isolated marker; no line across the GAP).
        </p>
      )}
      <span hidden data-testid="heatmap-scene-list" data-ids={HEATMAP_SCENES.map((s) => s.id).join(",")} />
    </section>
  );
}
