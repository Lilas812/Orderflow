import type { Viewport } from "../domain.ts";
import { priceTicksToY } from "./coordinates.ts";
import { formatPrice } from "./format.ts";
import type { valueArea } from "../data/vp.ts";

type Area = ReturnType<typeof valueArea>;

/** Physical rows follow vpRows: subpixel ticks belong to exactly one row. */
export function vpPriceRow(price: number, view: Viewport, height: number) {
  const center = priceTicksToY(price, view, height);
  if (height < view.priceSpanTicks) {
    const row = Math.floor(center);
    return { first: row, end: row + 1, line: row + .5 };
  }
  return { first: Math.floor(priceTicksToY(price + .5, view, height)),
    end: Math.floor(priceTicksToY(price - .5, view, height)), line: center };
}

export function vpBandBounds(area: Area, view: Viewport, height: number) {
  if (area.high === null || area.low === null) return null;
  const first = Math.max(0, vpPriceRow(area.high, view, height).first);
  const end = Math.min(height, vpPriceRow(area.low, view, height).end);
  return first < end ? { first, end } : null;
}

export function vpGuides(area: Area, view: Viewport, height: number) {
  return ([["VAL", area.low], ["VAH", area.high], ["POC", area.poc]] as const)
    .flatMap(([kind, price]) => {
      if (price === null) return [];
      const y = vpPriceRow(price, view, height).line;
      return y >= 0 && y < height ? [{ kind, price, y }] : [];
    });
}

function prepare(canvas: HTMLCanvasElement, dpr: number) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** This canvas spans only the large-order and VP columns, above both bar canvases. */
export function drawVpGuides(canvas: HTMLCanvasElement, area: Area, view: Viewport, dpr: number) {
  const { ctx, width, height } = prepare(canvas, dpr);
  ctx.lineWidth = dpr;
  ctx.setLineDash([2 * dpr, 2 * dpr]);
  for (const guide of vpGuides(area, view, height)) {
    ctx.strokeStyle = guide.kind === "POC" ? "#ffffff" : "#f5a623";
    ctx.globalAlpha = guide.kind === "POC" ? 1 : .8;
    ctx.beginPath(); ctx.moveTo(0, guide.y); ctx.lineTo(width, guide.y); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;
}

/** The existing current-price label canvas stays above this independent axis canvas. */
export function drawVpLabels(canvas: HTMLCanvasElement, area: Area, view: Viewport, dpr: number) {
  const { ctx, width, height } = prepare(canvas, dpr);
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const guide of vpGuides(area, view, height)) {
    // Reuse the current-price label's 18 CSS px geometry and edge clamping.
    const y = Math.max(9 * dpr, Math.min(height - 9 * dpr, guide.y));
    ctx.fillStyle = guide.kind === "POC" ? "#333333" : "#f5a623";
    ctx.fillRect(0, y - 9 * dpr, width, 18 * dpr);
    ctx.fillStyle = guide.kind === "POC" ? "#ffffff" : "#000000";
    ctx.fillText(formatPrice(guide.price), width / 2, y, Math.max(1, width - 2 * dpr));
  }
}
