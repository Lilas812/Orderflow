import type { Viewport } from "../domain.ts";
import { US_PER_SECOND, clampViewport } from "../domain.ts";

export function timeUsToX(timeUs: number, viewport: Viewport, width: number): number {
  return ((timeUs - viewport.startUs) / (viewport.durationSec * US_PER_SECOND)) * width;
}

export function xToTimeUs(x: number, viewport: Viewport, width: number): number {
  return Math.round(viewport.startUs + (x / width) * viewport.durationSec * US_PER_SECOND);
}

export function priceTicksToY(priceTicks: number, viewport: Viewport, height: number): number {
  return ((viewport.centerPriceTicks + viewport.priceSpanTicks / 2 - priceTicks) / viewport.priceSpanTicks) * height;
}

export function yToPriceTicks(y: number, viewport: Viewport, height: number): number {
  return viewport.centerPriceTicks + viewport.priceSpanTicks / 2 - (y / height) * viewport.priceSpanTicks;
}

export function zoomTimeAt(viewport: Viewport, anchorUs: number, factor: number): Viewport {
  const durationSec = Math.max(10, Math.min(7_200, viewport.durationSec * factor));
  const anchorRatio = (anchorUs - viewport.startUs) / (viewport.durationSec * US_PER_SECOND);
  return clampViewport({
    ...viewport,
    durationSec,
    startUs: anchorUs - anchorRatio * durationSec * US_PER_SECOND,
  });
}

export function zoomPriceAt(viewport: Viewport, anchorTicks: number, factor: number): Viewport {
  const priceSpanTicks = Math.max(8, Math.min(1_600, viewport.priceSpanTicks * factor));
  const oldOffset = anchorTicks - viewport.centerPriceTicks;
  const ratio = oldOffset / viewport.priceSpanTicks;
  return clampViewport({
    ...viewport,
    priceSpanTicks,
    centerPriceTicks: anchorTicks - ratio * priceSpanTicks,
  });
}
