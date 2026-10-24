import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { diagnostics } from "../diagnostics/mockDiagnostics";
import type { DeltaBar, DeltaBin, DeltaFrame } from "@workspace/core/delta-timeline";
import type { Viewport } from "@workspace/core/viewport";
import { useTimeFormat } from "./SettingsContext";

const rec = (o: unknown) => o as Record<string, unknown>;
export const scopeText = (scope: unknown) =>
  Object.entries(rec(scope)).map(([k, v]) => `${k}=${String(v)}`).join(" / ");
const sessionOf = (scope: unknown) => String(rec(scope).sessionId ?? "");
const utc = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
const WITHHELD = "withheld (not computed)";

interface Props {
  observation?: boolean;
  revision?: number;
  frame: DeltaFrame | null;
  vp: Viewport;
  sourceOf: ReadonlyMap<DeltaBin, string>;
  error: string | null;
  onZoom: (x: number, f: number) => void;
  onPan: (dx: number) => void;
}

export function DeltaPanel({ frame, vp, sourceOf, error, onZoom, onPan, revision, observation = false }: Props) {
  useLayoutEffect(() => { if (revision !== undefined) diagnostics()?.add("received", revision, -1, "delta"); }, [revision]);
  const { fmt: fmtJst, tzLabel } = useTimeFormat();
  const ref = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<number | null>(null);
  const [hover, setHover] = useState<{ bar: DeltaBar; x: number; y: number } | null>(null);
  const [status, setStatus] = useState("NO DATA");
  const [renderError, setRenderError] = useState<string | null>(null);
  const zoomRef = useRef(onZoom); zoomRef.current = onZoom;
  const w = vp.bounds.width, h = frame?.height ?? 126;

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest(".dl-tip")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.deltaY !== 0) zoomRef.current(e.clientX - r.left, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  useEffect(() => { setHover(null); }, [frame, vp]);

  useEffect(() => {
    const c = cv.current; if (!c) return;
    const dpr = vp.dpr;
    c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
    if (!frame || w <= 0) { setStatus(error ? "RENDER ERROR" : "NO DATA"); setRenderError(null); return; }
    const ctx = c.getContext("2d");
    if (!ctx) { setStatus("RENDER ERROR"); setRenderError("Canvas2D unavailable; no image or SVG fallback"); return; }
    setRenderError(null);
    const d = revision === undefined ? undefined : diagnostics(), started = d ? performance.now() : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#08090d"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(frame.plot.left, 0, frame.plot.width, h); ctx.clip();
    for (const b of frame.bars) {
      const bw = Math.max(0, b.x1 - b.x0);
      if ((b.direction === "UP" || b.direction === "DOWN") && b.top !== null && b.bottom !== null) {
        ctx.globalAlpha = b.opacity;
        ctx.fillStyle = b.direction === "UP" ? "#17C96B" : "#B548DB";
        ctx.fillRect(b.x0, Math.min(b.top, b.bottom), bw, Math.max(1, Math.abs(b.bottom - b.top)));
        ctx.globalAlpha = 1;
      } else if (b.direction === "ZERO") {
        ctx.strokeStyle = "#AAB0C0"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(b.x0, frame.zeroY); ctx.lineTo(b.x0 + bw, frame.zeroY); ctx.stroke();
        ctx.fillStyle = "#AAB0C0"; ctx.font = "10px Consolas, monospace";
        ctx.fillText("0", b.x0 + 2, frame.zeroY - 4);
      } else {
        ctx.save(); ctx.beginPath(); ctx.rect(b.x0, 0, bw, h); ctx.clip();
        ctx.fillStyle = "rgba(213,167,75,0.08)"; ctx.fillRect(b.x0, 0, bw, h);
        ctx.strokeStyle = "#D5A74B"; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = b.x0 - h; x < b.x0 + bw; x += 8) { ctx.moveTo(x, h); ctx.lineTo(x + h, 0); }
        ctx.stroke();
        if (bw > 56) {
          ctx.fillStyle = "#D5A74B"; ctx.font = "10px Consolas, monospace";
          ctx.fillText(b.direction, b.x0 + 4, 14);
        }
        ctx.restore();
      }
    }
    ctx.strokeStyle = "#6b7390"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(frame.plot.left, frame.zeroY); ctx.lineTo(frame.plot.left + frame.plot.width, frame.zeroY); ctx.stroke();
    ctx.restore();
    setStatus(frame.bars.length ? "CANVAS2D OK" : "NO DATA");
    d?.add("draw", revision, -1, "delta", performance.now() - started, frame.bars.length);
  }, [frame, vp.dpr, w, h, error, revision]);

  const limit = frame ? frame.scaleLimitDenominator === 1n ? frame.scaleLimitNumerator.toString()
    : `${frame.scaleLimitNumerator / frame.scaleLimitDenominator}.${frame.scaleLimitNumerator % frame.scaleLimitDenominator}` : "-";
  const find = (x: number) => frame?.bars.find((b) => x >= b.x0 && x < b.x1) ?? null;
  const b = hover?.bar.bin;

  return (
    <>
      <div className="dl-panel" ref={ref} data-testid="delta-panel" data-time-mode={vp.timeMode} style={{ height: h }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = e.clientX; }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (drag.current !== null) {
            const dx = e.clientX - drag.current; drag.current = e.clientX; if (dx) { setHover(null); onPan(dx); }
            return;
          }
          const bar = find(e.clientX - r.left);
          setHover(bar ? { bar, x: e.clientX - r.left, y: e.clientY - r.top } : null);
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onPointerLeave={() => setHover(null)} onLostPointerCapture={() => { drag.current = null; }}>
        <canvas ref={cv} className="dl-canvas" data-testid="delta-canvas" data-status={status}
          data-zero-y={frame?.zeroY ?? ""} style={{ width: w, height: h }} />
        <span className="dl-label">{observation ? "DELTA / COVERAGE UNKNOWN / WITHHELD" : "DELTA (Buy - Sell) / exact Trade bins / MOCK"} / {status}</span>
        {(error || renderError) && <div className="dbg-warn dl-err" role="alert">DELTA ERROR: {error ?? renderError}</div>}
        {hover && b && (
          <div className="dl-tip" data-testid="delta-tooltip"
            role="tooltip"
            style={{ left: Math.min(hover.x + 12, Math.max(0, w - 350)), top: -260 }}>
            <div>{utc(b.startNs).slice(0, 10)} UTC / MOCK independent source: {sourceOf.get(b) ?? "unknown"}</div>
            <div>{tzLabel} {fmtJst(b.startNs, true)} .. {fmtJst(b.endNs, true)}</div>
            <div>UTC {utc(b.startNs).slice(11)} .. {utc(b.endNs).slice(11)}</div>
            <div>B {b.B.toString()} / S {b.S.toString()} / U {b.U.toString()}</div>
            <div>V_raw {b.V_raw.toString()} / V {b.V === null ? WITHHELD : b.V.toString()}</div>
            <div>Delta {b.delta === null ? WITHHELD : b.delta.toString()} / trades {b.tradesCount}</div>
            <div>{b.quality} / {b.status} / rev {b.revision} / {hover.bar.direction}</div>
            <div className="dim">scope {scopeText(b.scope)}</div>
            {b.issues.length > 0 && <div className="dim">issues {b.issues.join("; ")}</div>}
          </div>
        )}
      </div>
      <div className="dl-yscale" data-testid="delta-yscale">
        <span>+{limit}</span>
        <span>0</span>
        <span>-{limit}</span>
        <span className="dim">max|D| {frame?.maxAbsDelta.toString() ?? "-"}</span>
      </div>
    </>
  );
}

export function DeltaTable({ frame, sourceOf }: { frame: DeltaFrame | null; sourceOf: ReadonlyMap<DeltaBin, string> }) {
  const { fmt: fmtJst, tzLabel } = useTimeFormat();
  const bars = frame?.bars ?? [];
  return (
    <table className="hm-table" data-testid="delta-table">
      <thead><tr><th>source (independent MOCK)</th><th>session</th><th>time bin</th><th>start ({tzLabel})</th><th>end ({tzLabel})</th>
        <th>B</th><th>S</th><th>U</th><th>V_raw</th><th>V</th><th>Delta</th><th>quality</th><th>status</th><th>rev</th><th>final</th>
        <th>direction</th><th>x0</th><th>x1</th></tr></thead>
      <tbody>
        {bars.map((br) => {
          const b = br.bin;
          return (
            <tr key={`${scopeText(b.scope)}|${b.id}`} data-testid={`delta-row-${b.id}`} data-scope={scopeText(b.scope)}
              data-session={sessionOf(b.scope)} data-time-bin={b.timeBinId} data-start-ns={b.startNs} data-end-ns={b.endNs}
              data-x0={br.x0} data-x1={br.x1} data-b={b.B.toString()} data-s={b.S.toString()} data-u={b.U.toString()}
              data-v-raw={b.V_raw.toString()} data-v={b.V === null ? "" : b.V.toString()}
              data-delta={b.delta === null ? "" : b.delta.toString()} data-revision={b.revision}
              data-quality={b.quality} data-status={b.status} data-direction={br.direction}>
              <td>{sourceOf.get(b) ?? "?"}</td><td>{sessionOf(b.scope) || "-"}</td><td title={b.id}>{b.timeBinId}</td>
              <td>{fmtJst(b.startNs, true)}</td><td>{fmtJst(b.endNs, true)}</td>
              <td>{b.B.toString()}</td><td>{b.S.toString()}</td><td>{b.U.toString()}</td><td>{b.V_raw.toString()}</td>
              <td>{b.V === null ? WITHHELD : b.V.toString()}</td><td>{b.delta === null ? WITHHELD : b.delta.toString()}</td>
              <td>{b.quality}</td><td>{b.status}</td><td>{b.revision}</td><td>{String(b.finalized)}</td>
              <td>{br.direction}</td><td>{br.x0.toFixed(2)}</td><td>{br.x1.toFixed(2)}</td>
            </tr>
          );
        })}
        {bars.length === 0 && (
          <tr data-testid="delta-row-empty"><td colSpan={18}>NO DATA: no Delta bin in the supplied ranges (not a statement of zero activity).</td></tr>
        )}
      </tbody>
    </table>
  );
}
