import { useEffect, useRef, useState } from "react";
import { F01_BOOK, F03_GAP_TWA } from "@workspace/fixtures";
import type { L2Snapshot } from "@workspace/core/events";
import {
  createMarketQualityState, ingestMarketEvent, ingestMbpBatch, markChannelCondition,
  type MarketQualityState,
} from "@workspace/core/quality-timeline";
import {
  calculateTimeWeightedDepth, type DepthHistory, type DepthRecord,
} from "@workspace/core/time-weighted-depth";
import type { Viewport } from "@workspace/core/viewport";
import {
  DISPLAY_INTERVAL_MS, REFERENCE_QUANTITY, HeatmapRenderer, cellColor, hitTestCell,
  type HeatmapCell, type RenderStatus,
} from "@workspace/render";
import { fmtJst } from "./TimeAxis";

/* ---------- R04 fixtures computed ONCE at module scope (never per frame) ---------- */
export type HeatmapId = "F01" | "F03";
export interface HeatmapScene {
  readonly id: HeatmapId;
  readonly label: string;
  readonly environment: "MOCK";
  readonly instrument: string;
  readonly startNs: string;
  readonly endNs: string;
  /** Raw depth events in the fixture, NOT the derived cell count. */
  readonly eventCount: number;
  /** Verification display range only; not a Trade or AUTO price. */
  readonly priceMinTick: number;
  readonly priceMaxTick: number;
  readonly cells: readonly HeatmapCell[];
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

function buildF01(): HeatmapScene {
  const events = F01_BOOK.events as unknown as readonly DepthRecord[];
  let state = initialState(events[0] as L2Snapshot);
  for (const e of events) state = applied(state, e);
  const history: DepthHistory = { events, qualityState: state, qualityTimeAlignmentEvidence: MOCK_ALIGNMENT };
  const origin = BigInt(F01_BOOK.expected.startNs);
  const cells: HeatmapCell[] = [];
  for (let i = 0; i < 5; i++) {
    const startNs = (origin + BigInt(i) * 2_000_000_000n).toString();
    const endNs = (origin + BigInt(i + 1) * 2_000_000_000n).toString();
    cells.push({
      id: `F01-bid-80000-${i}`, priceTicks: 80000,
      result: calculateTimeWeightedDepth(history, { side: "BID", priceTicks: 80000, width: 1, startNs, endNs }),
    });
  }
  return {
    id: "F01", label: "F01 BID 80000 2s x5", environment: "MOCK", instrument: F01_BOOK.events[0].header.canonicalInstrumentId,
    startNs: F01_BOOK.expected.startNs, endNs: F01_BOOK.expected.endNs, eventCount: events.length,
    priceMinTick: 79998, priceMaxTick: 80002, cells,
  };
}

function buildF03(): HeatmapScene {
  const events = F03_GAP_TWA.events as unknown as readonly DepthRecord[];
  let state = initialState(events[0] as L2Snapshot);
  state = applied(state, events[0]);
  state = markChannelCondition(state, "L2_MBP", "GAP", F03_GAP_TWA.gap.startNs,
    "MOCK declares exact missing interval [9,11)");
  state = applied(state, events[1]);
  const history: DepthHistory = {
    events, qualityState: state, qualityTimeAlignmentEvidence: F03_GAP_TWA.timeAlignmentEvidence,
  };
  const { startNs, endNs } = F03_GAP_TWA.expected;
  return {
    id: "F03", label: "F03 BID 80000 gap [8,12)", environment: "MOCK",
    instrument: F03_GAP_TWA.events[0].header.canonicalInstrumentId,
    startNs, endNs, eventCount: events.length, priceMinTick: 79998, priceMaxTick: 80002,
    cells: [{
      id: "F03-bid-80000-0", priceTicks: 80000, missingReason: "GAP",
      result: calculateTimeWeightedDepth(history, { side: "BID", priceTicks: 80000, width: 1, startNs, endNs }),
    }],
  };
}

export const HEATMAP_SCENES: readonly HeatmapScene[] = [buildF01(), buildF03()];
export const HeatmapDemo: Readonly<Record<HeatmapId, HeatmapScene>> = {
  F01: HEATMAP_SCENES[0], F03: HEATMAP_SCENES[1],
};

/* ---------- Legend / verification table ---------- */
export function HeatmapLegend({ scene }: { scene: HeatmapScene }) {
  return (
    <div className="hm-legend" data-testid="heatmap-legend">
      <p className="note">
        MOCK / SIMULATED heatmap verification. Color reference {REFERENCE_QUANTITY} is a provisional fixed MOCK scale
        (not p95, not a filter). Striped amber = NO DATA (never drawn as zero).
      </p>
      <table className="hm-table" data-testid="heatmap-cell-table">
        <thead><tr><th>cell</th><th>start (JST)</th><th>end (JST)</th><th>tick</th><th>side</th><th>TWA</th><th>coverage</th><th>status</th><th>intensity</th></tr></thead>
        <tbody>
          {scene.cells.map((c) => {
            const col = cellColor(c);
            return (
              <tr key={c.id} data-testid={`heatmap-row-${c.id}`}>
                <td>{c.id}</td><td>{fmtJst(c.result.startNs)}</td><td>{fmtJst(c.result.endNs)}</td>
                <td>{c.priceTicks}</td><td>{c.result.side}</td>
                <td>{c.result.twa === null ? "—" : c.result.twa}</td>
                <td>{c.result.coverageRatio}</td><td>{c.result.status}</td>
                <td>{col.intensity === null ? "—" : col.intensity}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Canvas layer ---------- */
interface Tip { x: number; y: number; cell: HeatmapCell }
interface DrawInfo { count: number; rects: number; minNs: string; maxNs: string }
type UiStatus = RenderStatus | "INITIALIZING";

interface Props { cells: readonly HeatmapCell[]; vp: Viewport }

export function HeatmapCanvas({ cells, vp }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<HeatmapRenderer | null>(null);
  const pending = useRef({ cells, vp, dirty: true });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hoverRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<UiStatus>("INITIALIZING");
  const [error, setError] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [info, setInfo] = useState<DrawInfo>({ count: 0, rects: 0, minNs: "", maxNs: "" });
  const [tip, setTip] = useState<Tip | null>(null);

  const p = pending.current;
  if (p.cells !== cells || p.vp !== vp) { p.cells = cells; p.vp = vp; p.dirty = true; }

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
        const frame = renderer.draw(q.cells, q.vp);
        count += 1;
        setInfo({ count, rects: frame.rects.length, minNs: q.vp.time.minNs, maxNs: q.vp.time.maxNs });
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
    flush();
    const timer = window.setInterval(flush, DISPLAY_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      parent?.removeEventListener("pointermove", move);
      parent?.removeEventListener("pointerleave", leave);
      renderer.dispose();
      rendererRef.current = null;
      hoverRef.current = () => {};
      pending.current.dirty = true; // a remounted renderer must draw again
    };
  }, []);

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
        data-testid="heatmap-canvas" data-status={shownStatus} data-error={shownError ?? ""}
        data-draw-count={info.count} data-rect-count={info.rects}
        data-drawn-min-ns={info.minNs} data-drawn-max-ns={info.maxNs}
        data-reference-quantity={REFERENCE_QUANTITY} data-cells={JSON.stringify(meta)} />
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
