import { useCallback, useEffect, useRef, useState } from "react";
import type { Trade } from "@workspace/core/events";
import type { QualityInterval } from "@workspace/core/quality-timeline";
import {
  autoPrice, buildPriceSegments, createViewport, goLatest, panPrice, panTime, receiveLatest, resizeViewport, zoomTime,
  type Viewport,
} from "@workspace/core/viewport";

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

/** Pure-engine viewport state. Latest comes only from valid ordinary Trade events. */
export function useViewport(trades: readonly Trade[], quality: readonly QualityInterval[]) {
  const [vp, setVp] = useState<Viewport>(() =>
    createViewport({ bounds: { left: 0, top: 0, width: 0, height: 0 } }));
  const data = useRef({ trades, quality });
  data.current = { trades, quality };

  const update = useCallback((fn: (v: Viewport) => Viewport, force = false) => {
    setVp((v) => autoPrice(fn(v), data.current.trades, data.current.quality, force));
  }, []);

  useEffect(() => {
    setVp((v) => {
      const last = latestOf(trades, quality);
      const next = trades.length === 0
        ? createViewport({ bounds: v.bounds, dpr: v.dpr })
        : last === null ? v : receiveLatest(v, last);
      return autoPrice(next, trades, quality);
    });
  }, [trades, quality]);

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
  const latest = useCallback(() => update((v) => goLatest(v)), [update]);
  const priceAuto = useCallback(() => update((v) => v, true), [update]);
  return { vp, resize, zoom, panX, panY, latest, priceAuto };
}
