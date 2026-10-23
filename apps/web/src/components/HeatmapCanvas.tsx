import { useEffect, useRef, useState } from "react";
import { F01_BOOK, F02_TWO_TICKS, F03_GAP_TWA } from "@workspace/fixtures";
import type { L2Snapshot } from "@workspace/core/events";
import { scaleQuantity } from "@workspace/core/heatmap-scale";
import type { PriceBinWidth } from "@workspace/core/price-bins";
import {
  createMarketQualityState, ingestMarketEvent, ingestMbpBatch, markChannelCondition,
  type MarketQualityState,
} from "@workspace/core/quality-timeline";
import {
  calculateTimeWeightedDepth, type DepthHistory, type DepthRecord,
} from "@workspace/core/time-weighted-depth";
import type { Viewport } from "@workspace/core/viewport";
import {
  DISPLAY_INTERVAL_MS, HeatmapRenderer, cellColor, hitTestCell,
  type HeatmapCell, type HeatmapStyle, type RenderStatus,
} from "@workspace/render";
import { useTimeFormat } from "./SettingsContext";

/* ---------- R04 fixtures: histories computed ONCE; scenes cached per width ---------- */
export type HeatmapId = "F01" | "F02" | "F03";
export interface HeatmapScene {
  readonly id: HeatmapId;
  readonly label: string;
  readonly environment: "MOCK";
  readonly instrument: string;
  readonly width: PriceBinWidth;
  readonly startNs: string;
  readonly endNs: string;
  /** Raw depth events in the fixture, NOT the derived cell count. */
  readonly eventCount: number;
  /** Verification display range only; includes the whole bin plus padding. Not a Trade or AUTO price. */
  readonly priceMinTick: number;
  readonly priceMaxTick: number;
  readonly history: DepthHistory;
  /** Stable observed universe for reference queries (never the viewport). */
  readonly referencePrices: readonly number[];
  readonly cells: readonly HeatmapCell[];
  /** Inspection-only aggregates that are not drawn (would overlap the drawn cells). */
  readonly summaries: readonly HeatmapCell[];
}

const MOCK_ALIGNMENT = "MOCK only: exchange and receive times coincide; quality boundaries are explicitly aligned";

function initialState(snapshot: L2Snapshot): MarketQualityState {
  const h = snapshot.header;
  const rule = { scope: h.sequenceScope, continuity: {
    contiguous: true, evidence: "MOCK guarantees +1 per normalized event in each exact channel partition",
  } } as const;
  return createMarketQualityState({
    identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
      canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
    depthScope: snapshot.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "MOCK only: snapshot header sequence equals snapshotCoversSequence",
  }, h.exchangeTimeNs!);
}

function applied(state: MarketQualityState, record: unknown): MarketQualityState {
  const r = record as { batch?: readonly unknown[] };
  const result = r.batch ? ingestMbpBatch(state, r.batch) : ingestMarketEvent(state, record);
  if (!result.applied) throw new Error(`Unexpected MOCK replay rejection: ${result.reason}`);
  return result.state;
}

function replay(events: readonly DepthRecord[], evidence: string): DepthHistory {
  let state = initialState(events[0] as L2Snapshot);
  for (const e of events) state = applied(state, e);
  return { events, qualityState: state, qualityTimeAlignmentEvidence: evidence };
}
function historyF03(): DepthHistory {
  const events = F03_GAP_TWA.events as unknown as readonly DepthRecord[];
  let state = initialState(events[0] as L2Snapshot);
  state = applied(state, events[0]);
  state = markChannelCondition(state, "L2_MBP", "GAP", F03_GAP_TWA.gap.startNs,
    "MOCK declares exact missing interval [9,11)");
  state = applied(state, events[1]);
  return { events, qualityState: state, qualityTimeAlignmentEvidence: F03_GAP_TWA.timeAlignmentEvidence };
}

interface Base {
  label: string; history: DepthHistory; startNs: string; endNs: string;
  referencePrices: readonly number[]; slices: number; summary: boolean;
}
const F01_EVENTS = F01_BOOK.events as unknown as readonly DepthRecord[];
const F02_EVENTS = F02_TWO_TICKS.events as unknown as readonly DepthRecord[];
const BASES: Readonly<Record<HeatmapId, Base>> = {
  F01: { label: "F01 BID 80000 2s x5", history: replay(F01_EVENTS, MOCK_ALIGNMENT),
    startNs: F01_BOOK.expected.startNs, endNs: F01_BOOK.expected.endNs, referencePrices: [80000], slices: 5, summary: true },
  F02: { label: "F02 BID 80000/80001 10s", history: replay(F02_EVENTS, F02_TWO_TICKS.timeAlignmentEvidence),
    startNs: F02_TWO_TICKS.expected.startNs, endNs: F02_TWO_TICKS.expected.endNs, referencePrices: [80000, 80001], slices: 1, summary: false },
  F03: { label: "F03 BID 80000 gap [8,12)", history: historyF03(),
    startNs: F03_GAP_TWA.expected.startNs, endNs: F03_GAP_TWA.expected.endNs, referencePrices: [80000], slices: 1, summary: false },
};

const cache = new Map<string, HeatmapScene>();
export function sceneForWidth(id: HeatmapId, width: PriceBinWidth): HeatmapScene {
  const key = `${id}/${width}`;
  const hit = cache.get(key); if (hit) return hit;
  const base = BASES[id];
  const bins = [...new Set(base.referencePrices.map((p) => Math.floor(p / width)))];
  const t0 = BigInt(base.startNs), t1 = BigInt(base.endNs);
  const make = (cid: string, bin: number, a: bigint, b: bigint): HeatmapCell => {
    const first = bin * width;
    const result = calculateTimeWeightedDepth(base.history, {
      side: "BID", priceTicks: first, width, startNs: a.toString(), endNs: b.toString() });
    return { id: cid, priceTicks: first, result,
      ...(id === "F03" ? { missingReason: "GAP" as const } : result.status === "NO DATA" ? { missingReason: "UNKNOWN" as const } : {}) };
  };
  const cells: HeatmapCell[] = [], summaries: HeatmapCell[] = [];
  for (const bin of bins) {
    const first = bin * width, tag = width === 1 ? "" : `-w${width}`;
    const step = (t1 - t0) / BigInt(base.slices);
    for (let i = 0; i < base.slices; i++) {
      cells.push(make(`${id}-bid-${first}${tag}-${i}`, bin, t0 + step * BigInt(i), t0 + step * BigInt(i + 1)));
    }
    if (base.summary) summaries.push(make(`${id}-summary-${first}${tag}`, bin, t0, t1));
  }
  const scene: HeatmapScene = {
    id, label: base.label, environment: "MOCK", width,
    instrument: (base.history.events[0] as L2Snapshot).header.canonicalInstrumentId,
    startNs: base.startNs, endNs: base.endNs, eventCount: base.history.events.length,
    priceMinTick: Math.min(...bins) * width - 2, priceMaxTick: Math.max(...bins) * width + width - 1 + 2,
    history: base.history, referencePrices: base.referencePrices, cells, summaries,
  };
  cache.set(key, scene);
  return scene;
}

export const HEATMAP_SCENES: readonly HeatmapScene[] = [sceneForWidth("F01", 1), sceneForWidth("F02", 1), sceneForWidth("F03", 1)];
export const HeatmapDemo: Readonly<Record<HeatmapId, HeatmapScene>> = {
  F01: HEATMAP_SCENES[0], F02: HEATMAP_SCENES[1], F03: HEATMAP_SCENES[2],
};

/* ---------- Legend / verification table ---------- */
const brief = (s: HeatmapStyle) => (["BID", "ASK"] as const).map((k) => `${k} ref ${s.references[k] ?? "NO_BASELINE"}`).join(" / ");
export function HeatmapLegend({ scene, style }: { scene: HeatmapScene; style?: HeatmapStyle }) {
  const { fmt: fmtJst, tzLabel } = useTimeFormat();
  const row = (c: HeatmapCell, summary: boolean) => {
    const col = cellColor(c, style);
    let reason = "—", brightness: number | null = null;
    if (style) {
      try {
        const q = scaleQuantity(c.result, style.settings, style.references[c.result.side]);
        reason = q.reason; brightness = q.brightness;
      } catch (e) { reason = e instanceof Error ? e.message : String(e); }
    }
    const visible = col.visible === undefined ? reason === "VISIBLE" || reason === "NO DATA" : col.visible;
    return (
      <tr key={c.id} data-testid={`heatmap-row-${c.id}`} data-visible={String(visible)} data-reason={reason}>
        <td>{c.id}{summary ? " (summary, not drawn)" : ""}</td><td>{fmtJst(c.result.startNs)}</td><td>{fmtJst(c.result.endNs)}</td>
        <td>{c.priceTicks}..{c.priceTicks + c.result.width - 1}</td><td>{c.result.side}</td>
        <td>{c.result.twa === null ? "—" : c.result.twa}</td>
        <td>{c.result.coverageRatio}</td><td>{c.result.status}</td>
        <td>{col.intensity === null ? "—" : col.intensity}</td>
        <td>{visible ? "visible" : "hidden"}</td><td>{reason}</td><td>{brightness === null ? "—" : brightness.toFixed(3)}</td>
      </tr>
    );
  };
  return (
    <div className="hm-legend" data-testid="heatmap-legend">
      <p className="note" data-testid="text-legend-style">
        MOCK / SIMULATED heatmap verification.{style ? ` ${style.settings.mode} · min volume ${style.settings.minimumVolume} · width ${style.settings.width} · ${brief(style)} · fixed ${style.settings.fixedBaseline ? "ON" : "OFF"}.` : ""}
        {" "}Filtering is display-only; original TWA is unchanged. Striped amber = NO DATA (never drawn as zero).
      </p>
      <table className="hm-table" data-testid="heatmap-cell-table">
        <thead><tr><th>cell</th><th>start ({tzLabel})</th><th>end ({tzLabel})</th><th>ticks</th><th>side</th><th>TWA</th><th>coverage</th><th>status</th><th>intensity</th><th>display</th><th>reason</th><th>brightness</th></tr></thead>
        <tbody>
          {scene.cells.map((c) => row(c, false))}
          {scene.summaries.map((c) => row(c, true))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Canvas layer ---------- */
interface Tip { x: number; y: number; cell: HeatmapCell }
interface DrawInfo { count: number; vertices: number; rects: number; minNs: string; maxNs: string }
type UiStatus = RenderStatus | "INITIALIZING";

interface Props {
  cells: readonly HeatmapCell[]; vp: Viewport; style?: HeatmapStyle;
  /** "frame" (unified mode): no internal 250 ms timer; draw once per rAF when inputs changed. Default legacy "interval". */
  scheduler?: "interval" | "frame";
  revision?: number;
}

export function HeatmapCanvas({ cells, vp, style, scheduler = "interval", revision }: Props) {
  const schedulerRef = useRef(scheduler);
  const flushRef = useRef<() => void>(() => {});
  const { fmt: fmtJst } = useTimeFormat();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<HeatmapRenderer | null>(null);
  const pending = useRef({ cells, vp, style, dirty: true });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hoverRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<UiStatus>("INITIALIZING");
  const [error, setError] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [info, setInfo] = useState<DrawInfo>({ count: 0, vertices: 0, rects: 0, minNs: "", maxNs: "" });
  const [tip, setTip] = useState<Tip | null>(null);

  const p = pending.current;
  if (p.cells !== cells || p.vp !== vp || p.style !== style) { p.cells = cells; p.vp = vp; p.style = style; p.dirty = true; }

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const parent = canvas.parentElement;
    const renderer = new HeatmapRenderer(canvas, (s, e) => { setStatus(s); setError(e); });
    rendererRef.current = renderer;
    let count = 0;
    hoverRef.current = () => {
      const pt = pointer.current;
      const cell = pt ? hitTestCell(renderer.lastFrame, pt.x, pt.y) : null;
      setTip(pt && cell ? { x: pt.x, y: pt.y, cell } : null);
    };
    // Display scheduling: only the latest queued cells/viewport, only when changed, every 250 ms.
    const flush = () => {
      const q = pending.current;
      if (!q.dirty) return;
      q.dirty = false;
      try {
        const frame = renderer.draw(q.cells, q.vp, q.style);
        count += 1;
        setInfo({ count, vertices: frame.vertexCount, rects: frame.rects.length, minNs: q.vp.time.minNs, maxNs: q.vp.time.maxNs });
        setDrawError(null);
        hoverRef.current();
      } catch (e) {
        setDrawError(e instanceof Error ? e.message : String(e));
      }
    };
    const move = (e: PointerEvent) => {
      const r = parent!.getBoundingClientRect();
      pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      hoverRef.current();
    };
    const leave = () => { pointer.current = null; setTip(null); };
    parent?.addEventListener("pointermove", move);
    parent?.addEventListener("pointerleave", leave);
    flushRef.current = flush;
    flush();
    const timer = schedulerRef.current === "frame" ? null : window.setInterval(flush, DISPLAY_INTERVAL_MS);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      flushRef.current = () => {};
      parent?.removeEventListener("pointermove", move);
      parent?.removeEventListener("pointerleave", leave);
      renderer.dispose();
      rendererRef.current = null;
      hoverRef.current = () => {};
      pending.current.dirty = true; // a remounted renderer must draw again
    };
  }, []);

  useEffect(() => {
    if (schedulerRef.current !== "frame") return;
    const id = window.requestAnimationFrame(() => flushRef.current());
    return () => window.cancelAnimationFrame(id);
  });

  const failed = status === "RENDER ERROR" || status === "CONTEXT LOST" || drawError !== null;
  const shownStatus: UiStatus = drawError !== null ? "RENDER ERROR" : status;
  const shownError = drawError ?? error;
  const b = vp.bounds;
  const meta = cells.map((c) => ({
    id: c.id, priceTicks: c.priceTicks, missingReason: c.missingReason ?? null, result: c.result,
  }));
  const r = tip?.cell.result;

  return (
    <>
      <canvas ref={canvasRef} className="hm-canvas" style={{ width: b.left + b.width, height: b.top + b.height }}
        data-testid="heatmap-canvas" data-revision={revision ?? ""} data-status={shownStatus} data-error={shownError ?? ""}
        data-draw-count={info.count} data-rect-count={info.rects}
        data-drawn-min-ns={info.minNs} data-drawn-max-ns={info.maxNs}
        data-style={JSON.stringify(style ?? null)} data-vertex-count={info.vertices} data-cells={JSON.stringify(meta)} />
      <span className="hm-status" data-testid="heatmap-renderer-status" data-status={shownStatus}>
        RENDERER {shownStatus}
      </span>
      {failed && (
        <div className="hm-error" role="alert" data-testid="heatmap-renderer-error">
          RENDER ERROR{status === "CONTEXT LOST" && drawError === null ? " / context lost" : ""}
          {shownError ? `: ${shownError}` : ""}
        </div>
      )}
      {tip && r && (
        <div className="hm-tip" data-testid="heatmap-tooltip" data-cell-id={tip.cell.id}
          data-status={r.status} data-twa={r.twa === null ? "null" : String(r.twa)}
          data-coverage={String(r.coverageRatio)}
          style={{ left: tip.x > b.width - 230 ? tip.x - 222 : tip.x + 12, top: tip.y > b.height - 130 ? tip.y - 120 : tip.y + 12 }}>
          <div>start {fmtJst(r.startNs, true)} <span className="dim">{r.startNs}</span></div>
          <div>end {fmtJst(r.endNs, true)} <span className="dim">{r.endNs}</span></div>
          <div>price tick {tip.cell.priceTicks} ({(tip.cell.priceTicks / 4).toFixed(2)}) / {r.side}</div>
          <div>bin ticks {r.binId * r.width}..{r.binId * r.width + r.width - 1} (width {r.width})</div>
          <div>TWA {r.twa === null ? "—" : r.twa} / coverage {r.coverageRatio}</div>
          <div>status {r.status}</div>
          {r.status === "NO DATA" && r.partialTWA !== null && (
            <div className="dim">partialTWA {r.partialTWA} (diagnostic only; not a quantity)</div>
          )}
        </div>
      )}
    </>
  );
}
