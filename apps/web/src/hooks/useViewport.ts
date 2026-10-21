import { useCallback, useEffect, useRef, useState } from "react";
import type { Trade } from "@workspace/core/events";
import type { QualityInterval } from "@workspace/core/quality-timeline";
import {
  autoPrice, buildPriceSegments, createViewport, goLatest, panPrice, panTime, receiveLatest, resizeViewport, zoomTime,
  type Viewport,
} from "@workspace/core/viewport";

export interface ViewportDisplayOptions { initialMinutes?: number; autoMarginPercent?: number }

function latestOf(trades: readonly Trade[], quality: readonly QualityInterval[]): string | null {
  let best: bigint | null = null;
  for (const t of buildPriceSegments(trades, quality).flat()) {
    const h = t.header;
    if (t.kind !== "TRADE" || h.quality !== "VALID" || h.exchangeTimeNs === null) continue;
    const v = BigInt(h.exchangeTimeNs);
    if (best === null || v > best) best = v;
  }
  return best === null ? null : best.toString();
}

const spanOf = (minutes: number) => BigInt(minutes) * 60_000_000_000n;

/**
 * Pure-engine viewport state. Latest comes only from valid ordinary Trade events.
 * Display options are read through refs: a settings change never resets the viewport.
 * initialMinutes applies only to new-dataset initialization and explicit Latest.
 */
export function useViewport(trades: readonly Trade[], quality: readonly QualityInterval[], options: ViewportDisplayOptions = {}) {
  const opt = useRef({ minutes: options.initialMinutes ?? 30, margin: options.autoMarginPercent ?? 15 });
  opt.current = { minutes: options.initialMinutes ?? 30, margin: options.autoMarginPercent ?? 15 };
  const [vp, setVp] = useState<Viewport>(() =>
    createViewport({ bounds: { left: 0, top: 0, width: 0, height: 0 }, initialSpanNs: spanOf(opt.current.minutes) }));
  const data = useRef({ trades, quality });
  data.current = { trades, quality };

  const update = useCallback((fn: (v: Viewport) => Viewport, force = false) => {
    setVp((v) => autoPrice(fn(v), data.current.trades, data.current.quality, force, opt.current.margin));
  }, []);

  useEffect(() => {
    setVp((v) => {
      const last = latestOf(trades, quality);
      const received = last === null ? v : receiveLatest(v, last);
      const next = trades.length === 0
        ? createViewport({ bounds: v.bounds, dpr: v.dpr, initialSpanNs: spanOf(opt.current.minutes) })
        : last !== null && v.latestNs === null && v.timeMode === "LIVE"
          ? goLatest(received, spanOf(opt.current.minutes)) : received;
      return autoPrice(next, trades, quality, false, opt.current.margin);
    });
  }, [trades, quality]);

  // AUTO margin preview: re-evaluate only while AUTO; MANUAL is never overridden.
  const margin = options.autoMarginPercent ?? 15;
  useEffect(() => {
    setVp((v) => (v.priceMode === "AUTO"
      ? autoPrice(v, data.current.trades, data.current.quality, false, margin) : v));
  }, [margin]);

  const resize = useCallback((width: number, height: number, dpr: number) => {
    setVp((v) => {
      const b = v.bounds;
      if (b.width === width && b.height === height && v.dpr === dpr) return v;
      return resizeViewport(v, { left: 0, top: 0, width, height }, dpr);
    });
  }, []);
  const zoom = useCallback((x: number, f: number) => update((v) => zoomTime(v, x, f)), [update]);
  const panX = useCallback((dx: number) => update((v) => panTime(v, dx)), [update]);
  const panY = useCallback((dy: number, start: Viewport) => update((v) => {
    // Use the cumulative gesture, so sub-Tick pointer moves aren't discarded.
    // Keep the CURRENT time state even if it changed during the price gesture.
    const moved = panPrice(start, dy);
    return start.price ? { ...v, price: moved.price, priceMode: "MANUAL" } : v;
  }), [update]);
  const latest = useCallback(() => update((v) => goLatest(v, spanOf(opt.current.minutes))), [update]);
  const priceAuto = useCallback(() => update((v) => v, true), [update]);
  return { vp, resize, zoom, panX, panY, latest, priceAuto };
}
