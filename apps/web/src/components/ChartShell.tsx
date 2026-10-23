import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DisplaySettings } from "@workspace/core/settings-schema";
import { hexToRgb as hexToRgbSchema } from "@workspace/core/settings-schema";
import type { BubbleColors } from "@workspace/render/bubbles";
import { DEFAULT_BUBBLE_FILTERS } from "@workspace/core/bubble-aggregate";
import { useTimeFormat, type HeatmapActionsRef } from "./SettingsContext";
/** Small finite verification Trades must not all disappear under the default 15-lot filter.
 * This display-only preset never changes global settings or accepted quantities.
 */
export const UNIFIED_BUBBLE_FILTERS = {
  volume: { ...DEFAULT_BUBBLE_FILTERS.volume, enabled: false },
  absoluteDelta: { ...DEFAULT_BUBBLE_FILTERS.absoluteDelta, enabled: false },
  imbalancePercent: { ...DEFAULT_BUBBLE_FILTERS.imbalancePercent, enabled: false },
} as const;
import { executedVolume, type BookSide, type Trade } from "@workspace/core/events";
import type { QualityInterval } from "@workspace/core/quality-timeline";
import {
  buildPriceSegments, tickToY, timeToX, MAX_SPAN_NS, MIN_SPAN_NS,
  createViewport, resizeViewport, zoomTime, panTime, panPrice, goLatest, autoPrice, zoomPrice,
  type ChartBounds, type Viewport,
} from "@workspace/core/viewport";
import {
  captureBaseline, collectQuantityStages, relativeP95, resolveReference, DEFAULT_SCALE,
  type RelativeReference, type ScaleBaseline, type ScaleSettings,
} from "@workspace/core/heatmap-scale";
import { projectHeatmap, REFERENCE_QUANTITY, type HeatmapCell, type HeatmapStyle, type Palette } from "@workspace/render";
import { useViewport } from "../hooks/useViewport";
import { HeatmapCanvas, HeatmapLegend, HEATMAP_SCENES, sceneForWidth, type HeatmapId, type HeatmapScene } from "./HeatmapCanvas";
import { HeatmapDebugControls, rgbToHex, type Rgb, type SideStatus } from "./HeatmapDebugControls";
import { R09_SCENARIOS, R10_SCENARIOS, R10_CONTINUITY, R11_DELTA_CASES } from "@workspace/fixtures";
import {
  advanceDeltaWatermark, createDeltaTimeline, ingestDeltaTrade, projectDeltaTimeline, queryDeltaTimeline,
  setDeltaCondition, type DeltaBin, type DeltaFrame, type DeltaTimeline,
} from "@workspace/core/delta-timeline";
import { DeltaPanel, DeltaTable } from "./DeltaPanel";
import type { BubbleDensity, ClusteringOptions } from "@workspace/render/bubble-clustering";

const ALL_SCN = [...R09_SCENARIOS, ...R10_SCENARIOS];
const DENSITIES: readonly BubbleDensity[] = ["ALL", "STANDARD", "HIGH_COMPRESSION"];
import { type BubbleSizing, type BubbleSizingMode } from "@workspace/core/bubble-sizing";
import type { BubbleFilters } from "@workspace/core/bubble-aggregate";
import {
  advanceBubbleWatermark, createBubbleFinality, ingestBubbleTrade, setBubbleCondition,
} from "@workspace/core/bubble-finality";
import { projectBubbles } from "@workspace/render/bubbles";
import { BubbleCanvas, bubbleBackdropCells } from "./BubbleCanvas";
import { PriceAxis } from "./PriceAxis";
import { R12_LADDER_SCENARIOS } from "@workspace/fixtures";
import { buildLadderView, type LadderView, type LadderTopEvidence } from "@workspace/core/ladder-view";
import { createMarketQualityState, ingestMarketEvent, markChannelCondition } from "@workspace/core/quality-timeline";
import { LadderPanel } from "./LadderPanel";

const EMPTY_SOURCE_OF = new Map<DeltaBin, string>();
import { TimeAxis } from "./TimeAxis";
import { VolumeProfilePanel } from "./VolumeProfilePanel";
import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import { unifiedChecks, type UnifiedSnapshot } from "../hooks/useMockAnalysisSession";

/** Integrated finite MOCK controller surface (owned by App via useMockAnalysisSession). */
export interface UnifiedProps {
  snap: UnifiedSnapshot;
  speeds: readonly number[];
  onStart: (inputEveryMs: number) => void;
  onStop: () => void;
  onRestart: (inputEveryMs: number) => void;
  onExit: () => void;
}
const UNI_START = BigInt(UNIFIED_MOCK_STREAM.query.startNs);
/** Fixed bounded source range (0..14 s, 7 cells); reused by the shared Viewport seed. Never the 30 min default. */
const UNI_SEED = { endNs: (UNI_START + 15n * 1_000_000_000n).toString(), priceMinTick: 79998, priceMaxTick: 80005, spanNs: 16n * 1_000_000_000n };
const UNI_NO_SOURCE = new Map<DeltaBin, string>();

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
  ladderId: string | null;
  onSelectLadder: (id: string | null) => void;
  /** Raw L2 inputs ingested by the independent Ladder MOCK. */
  onLadderRaw: (n: number) => void;
  /** PREVIEW display settings from the settings controller (single source of truth). */
  display: DisplaySettings;
  onDisplay: (next: (s: DisplaySettings) => DisplaySettings) => void;
  heatmapActionsRef: HeatmapActionsRef;
  onOpenSettings: () => void;
  unified?: UnifiedProps;
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

export function ChartShell({ trades, mockOn, onToggleMock, onAddThird, heatmap: baseScene, onSelectHeatmap, bubbleId, onSelectBubble, onBubbleRaw, deltaId, onSelectDelta, onDeltaRaw, ladderId, onSelectLadder, onLadderRaw, display, onDisplay, heatmapActionsRef, onOpenSettings, unified }: Props) {
  const [uniSpeed, setUniSpeed] = useState<number>(unified?.snap.inputEveryMs ?? 300);
  const { fmt: fmtJst, tzLabel } = useTimeFormat();
  const tv = useViewport(trades, MOCK_QUALITY, {
    initialMinutes: display.viewport.initialMinutes, autoMarginPercent: display.viewport.autoMarginPercent,
  });
  const settings: ScaleSettings = display.heatmap.scale;
  const palKey = JSON.stringify(display.heatmap.palettes);
  const palettes = useMemo<Readonly<Record<BookSide, Palette>>>(() => {
    const p = display.heatmap.palettes;
    return {
      BID: { low: hexToRgbSchema(p.BID.low), high: hexToRgbSchema(p.BID.high) },
      ASK: { low: hexToRgbSchema(p.ASK.low), high: hexToRgbSchema(p.ASK.high) },
    } as unknown as Readonly<Record<BookSide, Palette>>;
  }, [palKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const records: Readonly<Record<string, ScaleBaseline | null>> = display.heatmap.baselines;
  const [captureError, setCaptureError] = useState<string | null>(null);
  const writeHeatmap = (scale: ScaleSettings, baselines: Record<string, ScaleBaseline | null>) =>
    onDisplay((s) => ({ ...s, heatmap: { ...s.heatmap, scale, baselines } }));
  const sizingKey = JSON.stringify(display.bubbles.sizing);
  const sizing = useMemo<BubbleSizing>(() => display.bubbles.sizing, [sizingKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtersKey = JSON.stringify(display.bubbles.filters);
  const bubbleFilters = useMemo<BubbleFilters>(() => display.bubbles.filters, [filtersKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const colorsKey = JSON.stringify(display.bubbles.colors);
  const bubbleColors = useMemo<BubbleColors>(() => ({
    buy: hexToRgbSchema(display.bubbles.colors.buy), sell: hexToRgbSchema(display.bubbles.colors.sell),
    neutral: hexToRgbSchema(display.bubbles.colors.neutral),
  }), [colorsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const bsMode: BubbleSizingMode = display.bubbles.sizing.mode;
  const density: BubbleDensity = display.bubbles.density;
  const setBsMode = (mode: BubbleSizingMode) =>
    onDisplay((s) => ({ ...s, bubbles: { ...s.bubbles, sizing: { ...s.bubbles.sizing, mode } } }));
  const setDensity = (d: BubbleDensity) => onDisplay((s) => ({ ...s, bubbles: { ...s.bubbles, density: d } }));
  const pl = display.priceLine;
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
    setCaptureError(null);
    let rec: Record<string, ScaleBaseline | null> = { ...records };
    if (patch.fixedBaseline === true) {
      try { rec = capture(next); } catch (e) { setCaptureError(e instanceof Error ? e.message : String(e)); }
    } else if (patch.fixedBaseline === false) rec = {};
    writeHeatmap(next, rec);
  };
  const recalibrate = () => {
    try { writeHeatmap(settings, { ...records, ...capture(settings) }); setCaptureError(null); }
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
  // R09/R10 backdrop remains the fixed, width-1 ABS verification layer.
  // Share colors without inventing an R07 observation history for that scope.
  const backdropStyle = useMemo<HeatmapStyle>(() => ({
    settings: { ...DEFAULT_SCALE, minimumVolume: 0, absoluteMaxQty: REFERENCE_QUANTITY },
    references: { BID: REFERENCE_QUANTITY, ASK: REFERENCE_QUANTITY }, palettes,
  }), [palettes]);
  const setPalette = (side: BookSide, end: "low" | "high", rgb: Rgb) =>
    onDisplay((s) => ({ ...s, heatmap: { ...s.heatmap, palettes: { ...s.heatmap.palettes,
      [side]: { ...s.heatmap.palettes[side], [end]: rgbToHex(rgb).toUpperCase() } } } }));
  const hasCandidate = !!(candidates.BID.ref || candidates.ASK.ref);
  heatmapActionsRef.current = {
    settings, update, recalibrate, status: sideStatus, captureError,
    canRecalibrate: settings.fixedBaseline && hasCandidate,
    recalibrateReason: !settings.fixedBaseline ? "Enable fixed baseline first."
      : !hasCandidate ? "No heatmap scene loaded: there is no candidate baseline to capture." : null,
  };
  const [hmVp, setHmVp] = useState<Viewport>(() => createViewport({ bounds: { left: 0, top: 0, width: 0, height: 0 } }));
  useEffect(() => {
    if (heatmap) setHmVp((v) => verificationViewport(heatmap, v.bounds, v.dpr));
  }, [baseScene?.id]); // Display-only price-bin edits never reset HISTORY or MANUAL price.
  const uniOn = !!unified && unified.snap.phase !== "OFF";
  const uniFrame = unified?.snap.frame ?? null;
  const uniRun = unified?.snap.runId ?? 0;
  // Seed only on explicit start/restart: notifications, pan, zoom and resize never reset HISTORY.
  useEffect(() => {
    if (uniOn) setHmVp((v) => verificationViewport(UNI_SEED, v.bounds, v.dpr));
  }, [uniRun, uniOn]);
  const uniRev = uniFrame?.revision;
  const uniCells = useMemo<readonly HeatmapCell[]>(() => (uniFrame?.heatmap.cells ?? []).map((r, i) => ({
    id: `uni-${r.side.toLowerCase()}-${r.binId * r.width}-${i}`, priceTicks: r.binId * r.width, result: r,
    ...(r.status === "NO DATA" ? { missingReason: "UNKNOWN" as const } : {}),
  })), [uniFrame]);
  const uniBubbles = useMemo(() => uniFrame?.bubbles.items ?? [], [uniFrame]);
  const uniChecks = useMemo(() => (uniFrame ? unifiedChecks(uniFrame) : []), [uniFrame]);
  /* ---- R09 bubble verification (independent of heatmap F01; viewport reset on scenario id only) ---- */
  const scn = useMemo(() => (bubbleId ? ALL_SCN.find((s) => s.id === bubbleId) ?? null : null), [bubbleId]);
  const isR10 = !!scn && R10_SCENARIOS.some((s) => s.id === scn.id);
  const [stage, setStage] = useState(0);
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

  /* ---- R12 Ladder: independent latest-book replay; never retimes other layers ---- */
  const lad = useMemo(() => (ladderId ? R12_LADDER_SCENARIOS.find((s) => s.id === ladderId) ?? null : null), [ladderId]);
  const [lStep, setLStep] = useState(0);
  const [ladW, setLadW] = useState(300);
  useEffect(() => { setLStep(0); }, [ladderId]);
  const lIdx = lad ? Math.min(lStep, lad.steps.length - 1) : 0;
  const otherActive = !!heatmap || !!scn || !!dcase || uniOn;
  const otherRef = useRef(otherActive); otherRef.current = otherActive;
  const ladderSeed = useMemo(() => lad ? { endNs: lad.endNs, priceMinTick: lad.priceMinTick, priceMaxTick: lad.priceMaxTick } : null, [lad]);
  useEffect(() => {
    if (ladderSeed && !otherRef.current) setHmVp((v) => verificationViewport(ladderSeed, v.bounds, v.dpr));
  }, [ladderSeed]);
  const lReplay = useMemo(() => {
    if (!lad) return null;
    try {
      let st = createMarketQualityState(lad.config, lad.startNs);
      let n = 0;
      for (let i = 0; i <= lIdx; i++) {
        const step = lad.steps[i];
        for (; n < step.eventCount; n++) st = ingestMarketEvent(st, lad.events[n]).state;
        if (step.condition) {
          const c = step.condition;
          st = markChannelCondition(st, c.channel, c.status, c.atNs, c.reason);
        }
      }
      const covers = st.lastGoodBook.snapshotCoversSequence;
      const evidence: LadderTopEvidence | undefined = covers === undefined || covers === null ? undefined
        : lad.topEvidence.find((e) => e.snapshotCoversSequence === covers);
      return { st, evidence, raw: n, error: null as string | null };
    } catch (e) { return { st: null, evidence: undefined, raw: 0, error: e instanceof Error ? e.message : String(e) }; }
  }, [lad, lIdx]);
  const onLadderRawRef = useRef(onLadderRaw); onLadderRawRef.current = onLadderRaw;
  const lRaw = lReplay?.raw ?? 0;
  useEffect(() => { onLadderRawRef.current(lRaw); }, [lRaw, ladderId]);
  const ladderOn = !!lad;
  const ladderOnly = ladderOn && !otherActive && trades.length === 0;

  const fixed = otherActive || ladderOnly;
  // The legacy R05 hook owns time tracking and has no arbitrary setter. Its
  // price-zoom result is shared by ALL projections, never a ladder-only scale.
  const [sharedPrice, setSharedPrice] = useState<Pick<Viewport, "price" | "priceMode"> | null>(null);
  useEffect(() => { setSharedPrice(null); }, [mockOn, fixed]);
  const vp = fixed ? hmVp : sharedPrice ? { ...tv.vp, ...sharedPrice } : tv.vp;
  const ladderView = useMemo<{ view: LadderView | null; error: string | null }>(() => {
    if (!lad || !lReplay) return { view: null, error: null };
    if (lReplay.error) return { view: null, error: lReplay.error };
    if (vp.bounds.height <= 0 || !vp.price) return { view: null, error: null };
    try { return { view: buildLadderView(lReplay.st, vp, lReplay.evidence), error: null }; }
    catch (e) { return { view: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [lad, lReplay, vp]);
  const dFrame = useMemo<{ frame: DeltaFrame | null; error: string | null }>(() => {
    if (uniOn) {
      // Already-derived bins from the frame; projection only (no replay/aggregation).
      if (!uniFrame || vp.bounds.width <= 0) return { frame: null, error: null };
      try { return { frame: projectDeltaTimeline(uniFrame.delta.items, vp, 126), error: null }; }
      catch (e) { return { frame: null, error: e instanceof Error ? e.message : String(e) }; }
    }
    if (!dcase && ladderOn) {
      if (vp.bounds.width <= 0) return { frame: null, error: null };
      try { return { frame: projectDeltaTimeline([], vp, 126), error: null }; }
      catch (e) { return { frame: null, error: e instanceof Error ? e.message : String(e) }; }
    }
    if (!dcase || !dReplay || vp.bounds.width <= 0) return { frame: null, error: dReplay?.error ?? null };
    try { return { frame: projectDeltaTimeline(dReplay.bins, vp, 126), error: dReplay.error }; }
    catch (e) { return { frame: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [dcase, dReplay, vp, ladderOn, uniOn, uniFrame]);
  const projected = useMemo(() => {
    if (!scn || vp.bounds.width <= 0) return null;
    try {
      const f = projectBubbles(bubbles, vp, sizing, bubbleFilters, clustering, bubbleColors);
      return { list: f.bubbles, sources: f.sourceBubbles, clusters: f.clusters, error: null as string | null };
    } catch (e) { return { list: null, sources: null, clusters: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [scn, bubbles, vp, sizing, clustering, bubbleFilters, bubbleColors]);
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
    if (!fixed) { tv.panY(dy, start); setSharedPrice(null); return; }
    setHmVp((v) => {
      if (!start.price) return v;
      return { ...v, price: panPrice(start, dy).price, priceMode: "MANUAL" };
    });
  };
  const fitFixture = () => {
    const seed = heatmap ?? bubbleSeed ?? dSeed ?? ladderSeed;
    if (seed) setHmVp((v) => verificationViewport(seed, v.bounds, v.dpr));
  };
  const zoomY = (y: number, f: number) => {
    if (fixed) setHmVp((v) => zoomPrice(v, y, f));
    else setSharedPrice((price) => {
      const next = zoomPrice({ ...tv.vp, ...price }, y, f);
      return { price: next.price, priceMode: next.priceMode };
    });
  };
  const normalPriceAuto = () => { setSharedPrice(null); priceAuto(); };
  const ladderAuto = () => { setHmVp((v) => autoPrice({ ...v, priceMode: "AUTO" }, [], [], false, display.viewport.autoMarginPercent)); };
  const chartRef = useRef<HTMLDivElement>(null);
  const zoomYRef = useRef(zoomY); zoomYRef.current = zoomY;
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
      if (e.shiftKey) {
        // Shift+wheel: shared price zoom only; time viewport untouched.
        const d = e.deltaY || e.deltaX;
        if (d !== 0) zoomYRef.current(e.clientY - r.top, d > 0 ? 1.15 : 1 / 1.15);
        return;
      }
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
    if (heatmap || uniOn) return [];
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
  }, [heatmap, uniOn, scn, dcase, dReplay, replayed, trades]);
  const scopeLines = dcase ? dcase.sources.slice(1).flatMap((s) => {
    const x = timeToX(vp, s.range.startNs);
    return x === null ? [] : [{ x, label: s.label }];
  }) : [];
  const pt = (t: Trade) => {
    const x = timeToX(vp, t.header.exchangeTimeNs!), y = tickToY(vp, t.priceTicks);
    return x === null || y === null ? null : { x, y };
  };
  const gaps = heatmap || uniOn || vp.latestNs === null ? [] : (dcase ? dcase.sources.flatMap((s) => [...s.quality]) as unknown as readonly QualityInterval[] : (scn?.quality ?? MOCK_QUALITY)).filter((i) => i.status !== "VALID").flatMap((i, n) => {
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
        {(dcase || ladderOn) && fixed && <button type="button" className="btn" data-testid={dcase ? "button-delta-latest" : "button-ladder-latest"}
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
        <button type="button" className="btn" data-testid="button-price-auto" onClick={ladderOnly ? ladderAuto : normalPriceAuto} disabled={fixed && !ladderOnly}>価格自動</button>
        {ladderOnly ? <span className="note" data-testid="text-price-auto-note">検証用レンジ保持／Trade価格なし</span>
          : fixed && <span className="note" data-testid="text-price-auto-note">AUTO disabled: fixed verification range, not a Trade price</span>}
        <span className="spacer" />
        <select className="btn" data-testid="select-ladder" aria-label="Ladder MOCK case" value={ladderId ?? ""}
          onChange={(e) => onSelectLadder(e.target.value === "" ? null : e.target.value)}>
          <option value="">Ladder off</option>
          {R12_LADDER_SCENARIOS.map((c) => <option key={c.id} value={c.id}>Ladder {c.id}</option>)}
        </select>
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
        {unified && (uniOn ? <>
          <span className="pill pill-on" data-testid="status-unified" data-phase={unified.snap.phase}>UNIFIED MOCK {unified.snap.phase}</span>
          <button type="button" className="btn" data-testid="button-unified-stop" disabled={unified.snap.phase !== "RUNNING"}
            onClick={unified.onStop}>統合MOCK停止</button>
          <button type="button" className="btn" data-testid="button-unified-restart" onClick={() => unified.onRestart(uniSpeed)}>統合MOCK再開始</button>
          <button type="button" className="btn" data-testid="button-unified-exit" onClick={unified.onExit}>統合MOCK終了</button>
        </> : <button type="button" className="btn btn-primary" data-testid="button-unified-start"
          onClick={() => unified.onStart(uniSpeed)}>統合MOCK開始</button>)}
        {unified && <select className="btn" data-testid="select-unified-speed" aria-label="Unified MOCK input interval"
          value={uniSpeed} disabled={unified.snap.phase === "RUNNING"} onChange={(e) => setUniSpeed(Number(e.target.value))}>
          {unified.speeds.map((m) => <option key={m} value={m}>{m} ms/input</option>)}
        </select>}
        <button type="button" className="btn" data-testid="button-mock-toggle" onClick={onToggleMock}>
          {mockOn ? "MOCK 無効化" : "MOCK 有効化"}
        </button>
        <button type="button" className="btn" data-testid="button-mock-third"
          disabled={!mockOn || trades.length !== 2} onClick={onAddThird}>MOCK 3点目を追加</button>
      </div>
      <div className={`cs-grid${dcase || ladderOn || uniOn ? " cs-delta" : ""}${ladderOn ? " cs-ladder" : ""}${uniOn ? " cs-vp" : ""}`}
        style={ladderOn ? ({ "--lad-w": `${ladW}px` } as CSSProperties) : undefined}>
        <div className="cs-chart" ref={chartRef} data-testid="chart-area"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId); drag.current = e.clientX;
          }}
          onPointerMove={(e) => {
            if (drag.current === null) return;
            const dx = e.clientX - drag.current; drag.current = e.clientX; if (dx) panX(dx);
          }}
          onContextMenu={(e) => { e.preventDefault(); drag.current = null; onOpenSettings(); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}>
          {heatmap && <HeatmapCanvas cells={heatmap.cells} vp={vp} style={style} />}
          {uniOn && uniFrame && <HeatmapCanvas cells={uniCells} vp={vp} style={backdropStyle} scheduler="frame" revision={uniRev} />}
          {uniOn && uniFrame && <BubbleCanvas bubbles={uniBubbles} vp={vp} sizing={sizing} clustering={clustering} filters={UNIFIED_BUBBLE_FILTERS} colors={bubbleColors} scheduler="frame" revision={uniRev} />}
          {(scn || dcase) && <svg className="bb-gaps" width={w} height={h} data-testid="bubble-gap-layer">
            {gaps.map(g => <g key={g.n}>
              <rect x={g.x0} y={0} width={Math.max(0, g.x1 - g.x0)} height={h} className="gap-band" />
              <text x={g.x0 + 6} y={38} className="gap-text">GAP: TRADES</text>
            </g>)}
          </svg>}
          {scn && backdrop && backdrop.cells.length > 0 && <div className="bb-depth"
            style={{ "--bb-depth-clip": backdropClip } as CSSProperties}>
            <HeatmapCanvas cells={backdrop.cells} vp={vp} style={backdropStyle} />
          </div>}
          {scn && <BubbleCanvas bubbles={bubbles} vp={vp} sizing={sizing} clustering={clustering} filters={bubbleFilters} colors={bubbleColors} />}
          {dcase && showDeltaBubbles && <BubbleCanvas bubbles={dBubbles} vp={vp} sizing={sizing} clustering={clustering} filters={bubbleFilters} colors={bubbleColors} />}
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
                    {pl.visible && pts.length > 1 && <polyline className="price-line" data-testid="price-line"
                      style={{ stroke: pl.color, strokeWidth: pl.width, strokeOpacity: pl.opacity }}
                      points={pts.map((p) => `${p.x},${p.y}`).join(" ")} />}
                    {pl.visible && seg.length === 1 && pts[0] && <circle cx={pts[0].x} cy={pts[0].y} r={3} className="iso-dot"
                      style={{ fill: pl.color, fillOpacity: pl.opacity }} />}
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
        <PriceAxis vp={vp} onPan={panY} onZoom={zoomY} />
        {uniOn ? (
          <DeltaPanel frame={dFrame.frame} vp={vp} sourceOf={UNI_NO_SOURCE} error={dFrame.error} onZoom={zoom} onPan={panX} revision={uniRev} />
        ) : dcase && dReplay ? (
          <DeltaPanel frame={dFrame.frame} vp={vp} sourceOf={dReplay.sourceOf} error={dFrame.error}
            onZoom={zoom} onPan={panX} />
        ) : ladderOn && (
          <DeltaPanel frame={dFrame.frame} vp={vp} sourceOf={EMPTY_SOURCE_OF} error={dFrame.error}
            onZoom={zoom} onPan={panX} />
        )}
        <TimeAxis vp={vp} />
        {uniOn && <VolumeProfilePanel profile={uniFrame?.volumeProfile.value ?? null} vp={vp} revision={uniRev ?? null} />}
        {lad && <LadderPanel view={ladderView.view} timeMode={vp.timeMode} error={ladderView.error ?? lReplay?.error ?? null}
          observedNs={lad.steps[lIdx].asOfNs} stepLabel={`step ${lIdx + 1}/${lad.steps.length}: ${lad.steps[lIdx].label}`} />}
      </div>
      {lad && (
        <div className="dbg bb-dbg" data-testid="ladder-controls">
          <div className="dbg-row dbg-wrap">
            <span data-testid="text-ladder-case">LADDER MOCK {lad.id}: {lad.label}. Independent L2 MOCK input; latest selected book, not tied to chart time.</span>
            <button type="button" className="btn" data-testid="button-ladder-prev" disabled={lIdx === 0}
              onClick={() => setLStep(lIdx - 1)}>Step -</button>
            <span data-testid="text-ladder-step" data-step={lIdx}>step {lIdx + 1}/{lad.steps.length}: {lad.steps[lIdx].label}</span>
            <button type="button" className="btn" data-testid="button-ladder-next" disabled={lIdx >= lad.steps.length - 1}
              onClick={() => setLStep(lIdx + 1)}>Step +</button>
            <label className="dbg-field">width {ladW}px
              <input type="range" data-testid="ladder-width" min={280} max={440} value={ladW}
                onChange={(e) => setLadW(Number(e.target.value))} />
            </label>
          </div>
          <div data-testid="text-ladder-raw">raw market events ingested {lRaw} (independent Ladder MOCK input; F07 includes a Trade-channel event; not derived from rows)</div>
          {otherActive && <div className="note" data-testid="text-ladder-scope">Ladder and chart layers are independent MOCK comparison data scopes, not one market session.</div>}
        </div>
      )}
      <div className="cs-info" data-testid="viewport-info">
        <span>Time ({tzLabel}): <b data-testid="text-time-min" data-ns={vp.time.minNs}>{hasData ? fmtJst(vp.time.minNs, true) : "—"}</b>
          {" → "}<b data-testid="text-time-max" data-ns={vp.time.maxNs}>{hasData ? fmtJst(vp.time.maxNs, true) : "—"}</b></span>
        <span>Price ticks: <b data-testid="text-price-min">{vp.price?.minTick ?? "—"}</b>
          {" → "}<b data-testid="text-price-max">{vp.price?.maxTick ?? "—"}</b></span>
        <span data-testid="text-span">Span {hasData ? spanMin.toFixed(1) : "—"} min (recommended max {String(MAX_SPAN_NS / 60_000_000_000n / 60n)} h)</span>
      </div>
      {uniOn && unified && (
        <div className="dbg bb-dbg" data-testid="unified-controls">
          <div className="dbg-row dbg-wrap">
            <span data-testid="text-unified-source">MOCK / SIMULATED (NOT LIVE) single finite artificial stream {UNIFIED_MOCK_STREAM.scope.config.identity.sourceId}: {UNIFIED_MOCK_STREAM.inputs.length} inputs / 11 market events / 6 Trades. Only readRenderFrame(query) feeds the layers.</span>
            <span data-testid="text-unified-bubble-preset">Unified verification: volume/Delta/imbalance display filters OFF; incomplete bubbles withheld, quantities unchanged. Legacy filter settings are preserved.</span>
          </div>
          <div data-testid="text-unified-counts">
            state {unified.snap.status?.state ?? "-"} / reason {unified.snap.status?.reason ?? "-"} / inputs {unified.snap.status?.processedInputs ?? 0}/{unified.snap.status?.sourceInputs ?? UNIFIED_MOCK_STREAM.inputs.length}
            {" "}/ market received {unified.snap.status?.processedMarketEvents ?? 0} / accepted {unified.snap.status?.acceptedMarketEvents ?? 0}
            {" "}/ notices {unified.snap.notices} / {unified.snap.inputEveryMs} ms per input / timers {unified.snap.status?.timers ?? 0}
          </div>
          {uniFrame ? (<>
            <div data-testid="text-unified-revisions" data-revision={uniFrame.revision}>
              common revision <b data-testid="rev-frame">{uniFrame.revision}</b>: heatmap <b data-testid="rev-heatmap">{uniFrame.heatmap.revision}</b>
              {" "}/ bubbles <b data-testid="rev-bubbles">{uniFrame.bubbles.revision}</b> / delta <b data-testid="rev-delta">{uniFrame.delta.revision}</b>
              {" "}/ VP <b data-testid="rev-vp">{uniFrame.volumeProfile.revision}</b> / quality <b data-testid="rev-quality">{uniFrame.quality.revision}</b>
              {" "}/ book <b data-testid="rev-book">{uniFrame.book.revision}</b>
            </div>
            <div data-testid="text-unified-quality" data-l2={uniFrame.quality.channels.L2_MBP.status}>
              L2 (latest) {uniFrame.quality.channels.L2_MBP.status}{uniFrame.quality.channels.L2_MBP.status !== "VALID" ? " - BOOK UNCERTAIN until an eligible Snapshot (L2 only)" : ""}
              {" "}/ TRADES {uniFrame.quality.channels.TRADES.status} / book levels {uniFrame.book.levels.length}
              {" "}/ heatmap NO DATA cells {uniFrame.heatmap.cells.filter((c) => c.status === "NO DATA").length}/{uniFrame.heatmap.cells.length} (never drawn as zero)
              {" "}/ Delta withheld bins {uniFrame.delta.items.filter((b) => b.delta === null).length} (UNKNOWN aggressor never BUY/SELL)
            </div>
            {uniFrame.status === "STOPPED" && <div className="dbg-warn" role="alert" data-testid="text-unified-stop">STOPPED: {uniFrame.stop?.reason ?? "no reason"}</div>}
            {unified.snap.phase === "COMPLETED" && (
              <div data-testid="unified-checks">
                {uniChecks.map((c) => <span key={c.name} data-testid={`check-${c.name.replace(/\W+/g, "-").toLowerCase()}`} data-ok={String(c.ok)}>{c.ok ? "MATCH" : "MISMATCH"} {c.name} [{c.detail}]; </span>)}
              </div>
            )}
          </>) : <div data-testid="unified-waiting">NO DATA yet: waiting for the first notification (not zero activity).</div>}
          <DeltaTable frame={dFrame.frame} sourceOf={UNI_NO_SOURCE} />
          <p className="note">MOCK / SIMULATED. Historical L2 quality is not in the frame; GAP is shown by NO DATA cells and the latest L2 status only. WebGL2 layers: software backends (SwiftShader) do not represent physical GPU performance.</p>
        </div>
      )}
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
            Backdrop: {backdrop?.label}. {backdrop?.error ? `UNAVAILABLE: ${backdrop.error}` : "Fixed ABS R06 verification scale/width; shared color palette only. Explicit synthetic MOCK, not a TWA of F01."}
          </div>
          {replayed?.error && <div className="dbg-warn" role="alert" data-testid="bubble-replay-error">REPLAY ERROR: {replayed.error}</div>}
          {projected?.error && <div className="dbg-warn" role="alert" data-testid="bubble-project-error">PROJECTION ERROR: {projected.error}</div>}
          <table className="hm-table" data-testid="bubble-table">
            <thead><tr><th>bubble</th><th>start ({tzLabel})</th><th>end ({tzLabel})</th><th>ticks</th><th>B</th><th>S</th><th>U</th><th>V_raw</th><th>V</th><th>delta</th>
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
          {unified && "Press 統合MOCK開始 to run the finite integrated MOCK (nothing starts automatically). "}
          MOCK fixture: {MOCK_INSTRUMENT}, 2026-01-01 00:00:00 UTC (09:00:00 JST), three Trades at +0s 80000, +300s 80100, +600s 80040 ticks;
          TRADES GAP [+360s, +540s). Verify: enable MOCK (2 events, one segment), add 3rd point (isolated marker; no line across the GAP).
        </p>
      )}
      <span hidden data-testid="heatmap-scene-list" data-ids={HEATMAP_SCENES.map((s) => s.id).join(",")} />
    </section>
  );
}
