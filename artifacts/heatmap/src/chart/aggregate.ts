import type { HeatColumn, Viewport } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import { resolveColumnForDrawing } from "./gaps.ts";

export interface PixelMaxGrid {
  width: number;
  height: number;
  values: Uint32Array;
}

function pixelSpan(start: number, end: number, limit: number): [number, number] | null {
  if (end <= 0 || start >= limit || end <= start) return null;
  let first = Math.floor(start);
  let last = Math.ceil(end) - 1;
  if (last < first) {
    const center = Math.floor((start + end) / 2);
    first = center;
    last = center;
  }
  first = Math.max(0, first);
  last = Math.min(limit - 1, last);
  return first <= last ? [first, last] : null;
}

export function computePixelMax(
  columns: readonly HeatColumn[],
  viewport: Viewport,
  width: number,
  height: number,
): PixelMaxGrid {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const grid: PixelMaxGrid = { width: safeWidth, height: safeHeight, values: new Uint32Array(safeWidth * safeHeight) };
  updatePixelMax(grid, columns, viewport, 0, safeWidth);
  return grid;
}

export function shiftPixelGridHorizontally(grid: PixelMaxGrid, shift: number): PixelMaxGrid {
  const amount = Math.max(-grid.width, Math.min(grid.width, Math.trunc(shift)));
  const values = new Uint32Array(grid.values.length);
  for (let y = 0; y < grid.height; y += 1) {
    const row = y * grid.width;
    const destinationStart = Math.max(0, amount);
    const destinationEnd = Math.min(grid.width, grid.width + amount);
    if (destinationStart < destinationEnd) {
      const sourceStart = destinationStart - amount;
      values.set(grid.values.subarray(row + sourceStart, row + sourceStart + destinationEnd - destinationStart), row + destinationStart);
    }
  }
  return { width: grid.width, height: grid.height, values };
}

/** Conservative physical-pixel shift: neighboring bins combine by max, never by averaging. */
export function shiftPixelGridByMax(grid: PixelMaxGrid, shift: number): PixelMaxGrid {
  const values = new Uint32Array(grid.values.length);
  for (let y = 0; y < grid.height; y += 1) {
    const row = y * grid.width;
    for (let x = 0; x < grid.width; x += 1) {
      const sourceX = x - shift;
      const left = Math.floor(sourceX);
      const right = Math.ceil(sourceX);
      const leftValue = left >= 0 && left < grid.width ? grid.values[row + left]! : 0;
      const rightValue = right >= 0 && right < grid.width ? grid.values[row + right]! : 0;
      values[row + x] = Math.max(leftValue, rightValue);
    }
  }
  return { width: grid.width, height: grid.height, values };
}

/** Rebuilds only a physical-pixel strip; used when a pan moves an integral pixel amount. */
export function updatePixelMax(
  grid: PixelMaxGrid,
  columns: readonly HeatColumn[],
  viewport: Viewport,
  clipStartX: number,
  clipEndX: number,
): void {
  const safeWidth = grid.width;
  const safeHeight = grid.height;
  const clipStart = Math.max(0, Math.floor(clipStartX));
  const clipEnd = Math.min(safeWidth, Math.ceil(clipEndX));
  if (clipStart >= clipEnd) return;
  for (let y = 0; y < safeHeight; y += 1) {
    grid.values.fill(0, y * safeWidth + clipStart, y * safeWidth + clipEnd);
  }
  const bySecond = new Map<number, HeatColumn>();
  const sortedSeconds: number[] = [];
  for (const column of columns) {
    const sec = Math.floor(column.timeUs / US_PER_SECOND);
    bySecond.set(sec, column);
    sortedSeconds.push(sec);
  }
  sortedSeconds.sort((a, b) => a - b);
  const startSec = viewport.startUs / US_PER_SECOND;
  const endSec = startSec + viewport.durationSec;
  const firstSec = Math.floor(startSec);
  const lastSec = Math.ceil(endSec) - 1;
  const topPrice = viewport.centerPriceTicks + viewport.priceSpanTicks / 2;
  const bottomPrice = viewport.centerPriceTicks - viewport.priceSpanTicks / 2;

  for (let sec = firstSec; sec <= lastSec; sec += 1) {
    const column = resolveColumnForDrawing(sec, bySecond, sortedSeconds);
    if (!column) continue;
    const xRange = pixelSpan(((sec - startSec) / viewport.durationSec) * safeWidth,
      (((sec + 1) - startSec) / viewport.durationSec) * safeWidth, safeWidth);
    if (!xRange) continue;
    const clippedLeft = Math.max(xRange[0], clipStart);
    const clippedRight = Math.min(xRange[1], clipEnd - 1);
    if (clippedLeft > clippedRight) continue;
    for (const levels of [column.bids, column.asks]) {
      for (let index = 0; index < levels.sizes.length; index += 1) {
        const size = levels.sizes[index]!;
        const price = levels.prices[index]!;
        if (size < 1 || price < bottomPrice - 0.5 || price > topPrice + 0.5) continue;
        const yStart = ((topPrice - (price + 0.5)) / viewport.priceSpanTicks) * safeHeight;
        const yEnd = ((topPrice - (price - 0.5)) / viewport.priceSpanTicks) * safeHeight;
        const yRange = pixelSpan(yStart, yEnd, safeHeight);
        if (!yRange) continue;
        for (let y = yRange[0]; y <= yRange[1]; y += 1) {
          const rowOffset = y * safeWidth;
          for (let x = clippedLeft; x <= clippedRight; x += 1) {
            const pixel = rowOffset + x;
            if (size > grid.values[pixel]!) grid.values[pixel] = size;
          }
        }
      }
    }
  }
}

export function visibleActualColumns(columns: readonly HeatColumn[], viewport: Viewport): HeatColumn[] {
  const fromUs = viewport.startUs;
  const toUs = fromUs + viewport.durationSec * US_PER_SECOND;
  return columns.filter((column) => column.timeUs >= fromUs - US_PER_SECOND && column.timeUs < toUs);
}
