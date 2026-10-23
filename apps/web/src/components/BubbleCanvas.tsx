import { useEffect, useRef, useState } from "react";
import { R09_OVERLAY_DEPTH, R09_SCENARIOS, R10_OVERLAY_DEPTH, R10_SCENARIOS } from "@workspace/fixtures";
import { createMarketQualityState, ingestMarketEvent } from "@workspace/core/quality-timeline";
import { calculateTimeWeightedDepth, type DepthHistory } from "@workspace/core/time-weighted-depth";
import type { HeatmapCell } from "@workspace/render";
import type { BubbleState } from "@workspace/core/bubble-finality";
import type { BubbleSizing } from "@workspace/core/bubble-sizing";
import type { Viewport } from "@workspace/core/viewport";
import { DISPLAY_INTERVAL_MS, type RenderStatus } from "@workspace/render";
import { BubbleRenderer, hitTestProjectedBubble, type BubbleColors } from "@workspace/render/bubbles";
import type { BubbleFilters } from "@workspace/core/bubble-aggregate";
import type { ClusteringOptions } from "@workspace/render/bubble-clustering";
import { BubbleTooltip, type BubbleTip } from "./BubbleTooltip";

const BUCKET_NS = 2_000_000_000n;
const OVERLAY_EVIDENCE = "Explicit R09/R10 overlay MOCK depth: exchange and receive times coincide; not F01";
export interface BubbleBackdrop { cells: readonly HeatmapCell[]; error: string | null; label: string }

/** New synthetic overlay cells (BID 80000, ASK 80001, width 1) from the existing R03/R04 engines. Never F01. */
export function bubbleBackdropCells(scenarioId: string): BubbleBackdrop {
  const isR10 = R10_SCENARIOS.some((s) => s.id === scenarioId);
  const label = isR10
    ? "R10 overlay MOCK depth (BID 80000 qty 100 / ASK 80001 qty 75, queried 8 s), not F01 and not R09"
    : "R09 overlay MOCK depth (BID 80000 qty 100 / ASK 80001 qty 75), not F01";
  const snap = isR10 ? R10_OVERLAY_DEPTH[scenarioId] : R09_OVERLAY_DEPTH[scenarioId];
  const scn = [...R09_SCENARIOS, ...R10_SCENARIOS].find((s) => s.id === scenarioId);
  if (!snap || !scn) return { cells: [], error: `No overlay depth fixture for ${scenarioId}`, label };
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
    const startNs = start.toString(), endNs = (start + (isR10 ? 4n : 1n) * BUCKET_NS).toString();
    const make = (side: "BID" | "ASK", priceTicks: number): HeatmapCell => ({
      id: `${isR10 ? "R10" : "R09"}-overlay-${scenarioId}-${side.toLowerCase()}-${priceTicks}`, priceTicks,
      result: calculateTimeWeightedDepth(history, { side, priceTicks, width: 1, startNs, endNs }),
    });
    return { cells: [make("BID", 80000), make("ASK", 80001)], error: null, label };
  } catch (e) {
    return { cells: [], error: e instanceof Error ? e.message : String(e), label };
  }
}

type UiStatus = RenderStatus | "INITIALIZING";
interface Props {
  bubbles: readonly BubbleState[]; vp: Viewport; sizing: BubbleSizing; clustering?: ClusteringOptions;
  filters?: BubbleFilters; colors?: BubbleColors;
  /** "frame" (unified mode): no internal 250 ms timer; rAF draw only when inputs changed. */
  scheduler?: "interval" | "frame";
  revision?: number;
}

export function BubbleCanvas({ bubbles, vp, sizing, clustering, filters, colors, scheduler = "interval", revision }: Props) {
  const schedulerRef = useRef(scheduler);
  const flushRef = useRef<() => void>(() => {});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pending = useRef({ bubbles, vp, sizing, clustering, filters, colors, dirty: true });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pinned = useRef<string | null>(null);
  const hoverRef = useRef<() => void>(() => {});
  const unpinRef = useRef<() => void>(() => {});
  const lastVp = useRef<Viewport>(vp);
  const lastSrc = useRef<{ b: readonly BubbleState[]; c?: ClusteringOptions; f?: BubbleFilters }>({ b: bubbles, c: clustering, f: filters });
  const [status, setStatus] = useState<UiStatus>("INITIALIZING");
  const [error, setError] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [verts, setVerts] = useState(0);
  const [display, setDisplay] = useState(0);
  const [tip, setTip] = useState<BubbleTip | null>(null);

  const p = pending.current;
  if (p.bubbles !== bubbles || p.vp !== vp || p.sizing !== sizing || p.clustering !== clustering
    || p.filters !== filters || p.colors !== colors) {
    p.bubbles = bubbles; p.vp = vp; p.sizing = sizing; p.clustering = clustering;
    p.filters = filters; p.colors = colors; p.dirty = true;
  }

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const parent = canvas.parentElement;
    const renderer = new BubbleRenderer(canvas, (s, e) => {
      setStatus(s); setError(e);
      if (s !== "READY") { pinned.current = null; setTip(null); }
    });
    let n = 0;
    const idOf = (b: { source: BubbleState; cluster?: { id: string } }) => b.cluster?.id ?? b.source.id;
    unpinRef.current = () => { pinned.current = null; setTip(null); };
    hoverRef.current = () => {
      const frame = renderer.lastFrame;
      if (renderer.status !== "READY" || !frame) { pinned.current = null; setTip(null); return; }
      if (pinned.current) {
        const pb = frame.bubbles.find((b) => idOf(b) === pinned.current);
        if (!pb) { pinned.current = null; setTip(null); return; }
        setTip((t) => ({ x: t?.x ?? pb.x, y: t?.y ?? pb.y, state: pb.source, diameter: pb.diameter, cluster: pb.cluster, pinned: true }));
        return;
      }
      const pt = pointer.current;
      const hit = pt ? hitTestProjectedBubble(frame, pt.x, pt.y) : null;
      if (!pt || !hit) { setTip(null); return; }
      setTip({ x: pt.x, y: pt.y, state: hit.source, diameter: hit.diameter, cluster: hit.cluster });
    };
    const flush = () => {
      const q = pending.current;
      if (!q.dirty) return;
      q.dirty = false;
      try {
        const frame = renderer.draw(q.bubbles, q.vp, q.sizing, q.filters, q.clustering, q.colors);
        n += 1; setCount(n); setVerts(frame.vertexCount); setDisplay(frame.clusters.length); setDrawError(null);
        const changed = q.vp !== lastVp.current || q.bubbles !== lastSrc.current.b || q.clustering !== lastSrc.current.c
          || q.filters !== lastSrc.current.f;
        lastVp.current = q.vp; lastSrc.current = { b: q.bubbles, c: q.clustering, f: q.filters };
        if (changed) { pinned.current = null; setTip(null); }
        else hoverRef.current();
      } catch (e) {
        setDrawError(e instanceof Error ? e.message : String(e));
      }
    };
    let down: { x: number; y: number } | null = null;
    const inTip = (t: EventTarget | null) => t instanceof Element && !!t.closest(".bb-tip");
    const local = (e: PointerEvent) => { const r = parent!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const move = (e: PointerEvent) => {
      if (inTip(e.target)) return;
      pointer.current = local(e);
      if (!pinned.current) hoverRef.current();
    };
    const pdown = (e: PointerEvent) => { if (!inTip(e.target)) down = { x: e.clientX, y: e.clientY }; };
    const pup = (e: PointerEvent) => {
      if (!down || inTip(e.target)) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if (moved > 4) return;
      const frame = renderer.lastFrame, pt = local(e);
      const hit = frame && renderer.status === "READY" ? hitTestProjectedBubble(frame, pt.x, pt.y) : null;
      if (!hit) { pinned.current = null; setTip(null); return; }
      pinned.current = idOf(hit);
      setTip({ x: pt.x, y: pt.y, state: hit.source, diameter: hit.diameter, cluster: hit.cluster, pinned: true });
    };
    const leave = () => { pointer.current = null; if (!pinned.current) setTip(null); };
    parent?.addEventListener("pointermove", move);
    parent?.addEventListener("pointerleave", leave);
    parent?.addEventListener("pointerdown", pdown);
    parent?.addEventListener("pointerup", pup);
    flushRef.current = flush;
    flush();
    const timer = schedulerRef.current === "frame" ? null : window.setInterval(flush, DISPLAY_INTERVAL_MS);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      flushRef.current = () => {};
      parent?.removeEventListener("pointermove", move);
      parent?.removeEventListener("pointerleave", leave);
      parent?.removeEventListener("pointerdown", pdown);
      parent?.removeEventListener("pointerup", pup);
      renderer.dispose();
      hoverRef.current = () => {};
      unpinRef.current = () => {};
      pointer.current = null; pinned.current = null;
      pending.current.dirty = true;
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

  return (
    <>
      <canvas ref={canvasRef} className="bb-canvas" style={{ width: b.left + b.width, height: b.top + b.height }}
        data-testid="bubble-canvas" data-revision={revision ?? ""} data-status={shownStatus} data-error={shownError ?? ""}
        data-draw-count={count} data-vertex-count={verts} data-bubble-count={bubbles.length}
        data-display-count={display} />
      <span className="bb-status" data-testid="bubble-gl-status" data-status={shownStatus}>
        BUBBLE GL {shownStatus}
      </span>
      {failed && (
        <div className="bb-error" role="alert" data-testid="bubble-error">
          BUBBLE RENDER ERROR{status === "CONTEXT LOST" && drawError === null ? " / context lost" : ""}
          {shownError ? `: ${shownError}` : ""}
        </div>
      )}
      {tip && !failed && <BubbleTooltip key={tip.cluster?.id ?? tip.state.id} tip={tip} width={b.width} height={b.height}
        onClose={() => unpinRef.current()} />}
    </>
  );
}
