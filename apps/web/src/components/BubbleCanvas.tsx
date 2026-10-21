import { useEffect, useRef, useState } from "react";
import { R09_OVERLAY_DEPTH, R09_SCENARIOS } from "@workspace/fixtures";
import { createMarketQualityState, ingestMarketEvent } from "@workspace/core/quality-timeline";
import { calculateTimeWeightedDepth, type DepthHistory } from "@workspace/core/time-weighted-depth";
import type { HeatmapCell } from "@workspace/render";
import type { BubbleState } from "@workspace/core/bubble-finality";
import type { BubbleSizing } from "@workspace/core/bubble-sizing";
import type { Viewport } from "@workspace/core/viewport";
import { DISPLAY_INTERVAL_MS, type RenderStatus } from "@workspace/render";
import { BubbleRenderer, hitTestBubble } from "@workspace/render/bubbles";
import { BubbleTooltip, type BubbleTip } from "./BubbleTooltip";

const BUCKET_NS = 2_000_000_000n;
const OVERLAY_EVIDENCE = "Explicit R09 overlay MOCK depth: exchange and receive times coincide; not F01";
export interface BubbleBackdrop { cells: readonly HeatmapCell[]; error: string | null; label: string }

/** New synthetic R09 overlay cells (BID 80000, ASK 80001, width 1) from the existing R03/R04 engines. Never F01. */
export function bubbleBackdropCells(scenarioId: string): BubbleBackdrop {
  const label = "R09 overlay MOCK depth (BID 80000 qty 100 / ASK 80001 qty 75), not F01";
  const snap = R09_OVERLAY_DEPTH[scenarioId];
  const scn = R09_SCENARIOS.find((s) => s.id === scenarioId);
  if (!snap || !scn) return { cells: [], error: `No R09 overlay depth fixture for ${scenarioId}`, label };
  try {
    const h = snap.header;
    const rule = { scope: h.sequenceScope, continuity: {
      contiguous: true, evidence: "MOCK guarantees +1 per normalized event in each exact channel partition",
    } } as const;
    const state0 = createMarketQualityState({
      identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
        canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
      depthScope: snap.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
      snapshotAlignmentEvidence: "MOCK only: snapshot header sequence equals snapshotCoversSequence",
    }, h.exchangeTimeNs!);
    const r = ingestMarketEvent(state0, snap);
    if (!r.applied) throw new Error(`Overlay snapshot rejected: ${r.reason}`);
    const history: DepthHistory = {
      events: [snap], qualityState: r.state, qualityTimeAlignmentEvidence: OVERLAY_EVIDENCE,
    };
    const t0 = scn.events.reduce((m, e) => { const t = BigInt(e.header.exchangeTimeNs!); return m === null || t < m ? t : m; }, null as bigint | null);
    const start = ((t0 ?? 0n) / BUCKET_NS) * BUCKET_NS;
    const startNs = start.toString(), endNs = (start + BUCKET_NS).toString();
    const make = (side: "BID" | "ASK", priceTicks: number): HeatmapCell => ({
      id: `R09-overlay-${scenarioId}-${side.toLowerCase()}-${priceTicks}`, priceTicks,
      result: calculateTimeWeightedDepth(history, { side, priceTicks, width: 1, startNs, endNs }),
    });
    return { cells: [make("BID", 80000), make("ASK", 80001)], error: null, label };
  } catch (e) {
    return { cells: [], error: e instanceof Error ? e.message : String(e), label };
  }
}

type UiStatus = RenderStatus | "INITIALIZING";
interface Props { bubbles: readonly BubbleState[]; vp: Viewport; sizing: BubbleSizing }

export function BubbleCanvas({ bubbles, vp, sizing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pending = useRef({ bubbles, vp, sizing, dirty: true });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hoverRef = useRef<() => void>(() => {});
  const lastVp = useRef<Viewport>(vp);
  const [status, setStatus] = useState<UiStatus>("INITIALIZING");
  const [error, setError] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [verts, setVerts] = useState(0);
  const [tip, setTip] = useState<BubbleTip | null>(null);

  const p = pending.current;
  if (p.bubbles !== bubbles || p.vp !== vp || p.sizing !== sizing) {
    p.bubbles = bubbles; p.vp = vp; p.sizing = sizing; p.dirty = true;
  }

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const parent = canvas.parentElement;
    const renderer = new BubbleRenderer(canvas, (s, e) => {
      setStatus(s); setError(e);
      if (s !== "READY") setTip(null);
    });
    let n = 0;
    hoverRef.current = () => {
      const pt = pointer.current;
      const frame = renderer.lastFrame;
      if (renderer.status !== "READY") { setTip(null); return; }
      const hit = pt && frame ? hitTestBubble(frame, pt.x, pt.y) : null;
      if (!pt || !hit || !frame) { setTip(null); return; }
      const pr = frame.bubbles.find((b) => b.source.id === hit.id);
      setTip({ x: pt.x, y: pt.y, state: hit, diameter: pr ? pr.diameter : null });
    };
    const flush = () => {
      const q = pending.current;
      if (!q.dirty) return;
      q.dirty = false;
      try {
        const frame = renderer.draw(q.bubbles, q.vp, q.sizing);
        n += 1; setCount(n); setVerts(frame.vertexCount); setDrawError(null);
        if (q.vp !== lastVp.current) { lastVp.current = q.vp; setTip(null); }
        else hoverRef.current();
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
      hoverRef.current = () => {};
      pointer.current = null;
      pending.current.dirty = true;
    };
  }, []);

  const failed = status === "RENDER ERROR" || status === "CONTEXT LOST" || drawError !== null;
  const shownStatus: UiStatus = drawError !== null ? "RENDER ERROR" : status;
  const shownError = drawError ?? error;
  const b = vp.bounds;

  return (
    <>
      <canvas ref={canvasRef} className="bb-canvas" style={{ width: b.left + b.width, height: b.top + b.height }}
        data-testid="bubble-canvas" data-status={shownStatus} data-error={shownError ?? ""}
        data-draw-count={count} data-vertex-count={verts} data-bubble-count={bubbles.length} />
      <span className="bb-status" data-testid="bubble-gl-status" data-status={shownStatus}>
        BUBBLE GL {shownStatus}
      </span>
      {failed && (
        <div className="bb-error" role="alert" data-testid="bubble-error">
          BUBBLE RENDER ERROR{status === "CONTEXT LOST" && drawError === null ? " / context lost" : ""}
          {shownError ? `: ${shownError}` : ""}
        </div>
      )}
      {tip && <BubbleTooltip tip={tip} width={b.width} height={b.height} />}
    </>
  );
}
