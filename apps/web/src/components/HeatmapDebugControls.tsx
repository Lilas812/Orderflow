import { useEffect, useState } from "react";
import type { BookSide } from "@workspace/core/events";
import type { RelativeReference, ScaleBaseline, ScaleSettings } from "@workspace/core/heatmap-scale";
import type { Palette } from "@workspace/render";

export type Rgb = readonly [number, number, number];
export const rgbToHex = (c: Rgb) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
export const hexToRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;

export interface SideStatus {
  side: BookSide;
  reference: number | null;
  candidate: RelativeReference | null;
  /** undefined = never calibrated for this mode/side/width; null = captured but no baseline. */
  record: ScaleBaseline | null | undefined;
  error: string | null;
}
interface Props {
  settings: ScaleSettings;
  onChange: (patch: Partial<ScaleSettings>) => void;
  palettes: Readonly<Record<BookSide, Palette>>;
  onPalette: (side: BookSide, end: "low" | "high", rgb: Rgb) => void;
  onRecalibrate: () => void;
  status: readonly SideStatus[];
  captureError: string | null;
}

interface NumProps {
  id: string; label: string; value: number; min: number; max: number; step: number;
  integer?: boolean; positive?: boolean; strictRange?: boolean;
  extra?: (v: number) => string | null; onCommit: (v: number) => void;
}
function NumField({ id, label, value, min, max, step, integer, positive, extra, onCommit }: NumProps) {
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (err === null && Number(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = (raw: string): { v?: number; e?: string } => {
    if (raw.trim() === "") return { e: "blank: enter a number" };
    const v = Number(raw);
    if (!Number.isFinite(v)) return { e: "not a finite number" };
    if (integer && !Number.isSafeInteger(v)) return { e: "safe integer required" };
    if (positive && v <= 0) return { e: "must be > 0" };
    if (v < min || (id !== "minimum-volume" && id !== "absolute-max" && v > max)) return { e: `out of range ${min}..${max}` };
    if (v < min) return { e: `must be >= ${min}` };
    const x = extra?.(v); if (x) return { e: x };
    return { v };
  };
  const onText = (raw: string) => {
    setText(raw);
    const r = check(raw);
    if (r.e) setErr(r.e); else { setErr(null); onCommit(r.v!); }
  };
  const rangeMax = Math.max(max, Number.isFinite(value) ? value : max);
  return (
    <div className="dbg-field">
      <label htmlFor={`input-${id}`}>{label}</label>
      <div className="dbg-row">
        <input id={`input-${id}`} data-testid={`input-${id}`} type="text" inputMode="decimal" value={text}
          aria-invalid={err !== null} aria-describedby={`err-${id}`} onChange={(e) => onText(e.target.value)} />
        <input data-testid={`range-${id}`} type="range" aria-label={`${label} slider`} min={min} max={rangeMax} step={step}
          value={Math.min(value, rangeMax)} onChange={(e) => onText(e.target.value)} />
      </div>
      <span id={`err-${id}`} className="dbg-err" role={err ? "alert" : undefined} data-testid={`error-${id}`}>{err ?? ""}</span>
    </div>
  );
}

const sec = (ns: string) => (Number(BigInt(ns) / 1_000_000n) / 1000).toFixed(1);

export function HeatmapDebugControls({ settings: s, onChange, palettes, onPalette, onRecalibrate, status, captureError }: Props) {
  return (
    <section className="dbg" data-testid="heatmap-debug-panel" aria-label="Heatmap debug controls">
      <div className="dbg-grid">
        <NumField id="minimum-volume" label="Minimum volume" value={s.minimumVolume} min={0} max={5000} step={1} integer
          onCommit={(v) => onChange({ minimumVolume: v })} />
        <div className="dbg-field">
          <label htmlFor="select-price-width">Price width (ticks)</label>
          <select id="select-price-width" data-testid="select-price-width" value={s.width}
            onChange={(e) => onChange({ width: Number(e.target.value) as ScaleSettings["width"] })}>
            {[1, 2, 4, 8].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        <div className="dbg-field">
          <label htmlFor="select-scale-mode">Scale mode</label>
          <select id="select-scale-mode" data-testid="select-scale-mode" value={s.mode}
            onChange={(e) => onChange({ mode: e.target.value as ScaleSettings["mode"] })}>
            <option value="ABSOLUTE">ABSOLUTE</option><option value="RELATIVE">RELATIVE</option>
          </select>
        </div>
        <NumField id="absolute-max" label="Absolute max qty" value={s.absoluteMaxQty} min={1} max={5000} step={1} integer positive
          onCommit={(v) => onChange({ absoluteMaxQty: v })} />
        <NumField id="min-intensity" label="Min intensity" value={s.minIntensity} min={0} max={1} step={0.01}
          extra={(v) => v >= s.maxIntensity ? "must be < max intensity" : null} onCommit={(v) => onChange({ minIntensity: v })} />
        <NumField id="max-intensity" label="Max intensity" value={s.maxIntensity} min={0} max={1} step={0.01}
          extra={(v) => v <= s.minIntensity ? "must be > min intensity" : null} onCommit={(v) => onChange({ maxIntensity: v })} />
        <NumField id="liquidity-contrast" label="Liquidity contrast" value={s.liquidityContrast} min={0.25} max={4} step={0.05}
          onCommit={(v) => onChange({ liquidityContrast: v })} />
        <NumField id="top-contrast" label="Top contrast" value={s.topContrast} min={0.25} max={4} step={0.05}
          onCommit={(v) => onChange({ topContrast: v })} />
      </div>
      <div className="dbg-row dbg-wrap">
        <label className="dbg-check"><input type="checkbox" data-testid="checkbox-fixed-baseline" checked={s.fixedBaseline}
          onChange={(e) => onChange({ fixedBaseline: e.target.checked })} /> Fixed baseline</label>
        <button type="button" className="btn" data-testid="button-recalibrate" disabled={!s.fixedBaseline}
          onClick={onRecalibrate}>Recalibrate</button>
        {(["BID", "ASK"] as const).map((side) => (["low", "high"] as const).map((end) => (
          <label key={side + end} className="dbg-color">{side} {end}
            <input type="color" data-testid={`palette-${side.toLowerCase()}-${end}`} value={rgbToHex(palettes[side][end])}
              onChange={(e) => onPalette(side, end, hexToRgb(e.target.value))} />
            <code>{rgbToHex(palettes[side][end]).toUpperCase()}</code>
          </label>
        )))}
      </div>
      {captureError && <p className="dbg-err" role="alert" data-testid="error-capture">{captureError}</p>}
      <div className="dbg-status">
        {status.map((st) => {
          const c = st.candidate, rec = st.record;
          const provisional = c?.status === "WARMING UP";
          return (
            <div key={st.side} className="dbg-side" data-testid={`status-relative-${st.side.toLowerCase()}`}
              data-reference={st.reference === null ? "null" : String(st.reference)} data-p95={c?.refQty ?? "null"}
              data-status={c?.status ?? "ERROR"} data-record={!s.fixedBaseline ? "off" : rec === undefined ? "uncalibrated" : rec === null ? "no-baseline" : rec.status}>
              <b>{st.side}</b> REFERENCE {st.reference === null ? "— (NO_BASELINE)" : st.reference}
              {" · "}{s.mode} P95 {c?.refQty ?? "—"}
              {c && <> · covered {sec(c.coveredDurationNs)}s / 300.0s · {c.status}</>}
              {c && <div className="dim">asOf {c.asOfNs} · window {c.window.startNs}..{c.window.endNs}</div>}
              {provisional && <div className="dbg-warn">PROVISIONAL: {c!.reason}</div>}
              {st.error && <div className="dbg-err" role="alert">{st.error}</div>}
              {s.fixedBaseline && (
                <div data-testid={`status-fixed-${st.side.toLowerCase()}`}>
                  {rec === undefined ? "FIXED: uncalibrated for this mode/width — press Recalibrate"
                    : rec === null ? "FIXED: captured NO_BASELINE (positive cells not colored)"
                    : <>FIXED {rec.mode}/{rec.width} ref {rec.refQty} asOf {rec.asOfNs}
                      {rec.status === "WARMING UP" ? " — 暫定固定 / WARMING UP" : " — READY"}
                      {s.mode === "ABSOLUTE" && rec.mode === "ABSOLUTE" && rec.refQty !== s.absoluteMaxQty &&
                        <span className="dbg-warn"> · pending candidate {s.absoluteMaxQty} (Recalibrate to apply)</span>}</>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
