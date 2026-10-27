import type { HeatColumn, Viewport } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import { resolveColumnForDrawing } from "./gaps.ts";
import type { PixelMaxGrid } from "./aggregate.ts";

const SECONDS_PER_TILE = 60;
const MAX_TIME_TILES = 128;
const MAX_PROFILE_BYTES = 48 * 1024 * 1024;

interface PriceMaxTree {
  prices: Int32Array;
  leafCount: number;
  tree: Uint32Array;
}

interface TimeTile {
  startSec: number;
  columns: Map<number, HeatColumn>;
  profiles: Map<string, Uint32Array>;
}

interface ProfileLruItem {
  tileStart: number;
  key: string;
  column: HeatColumn;
  profile: Uint32Array;
  center: number;
  span: number;
}

export interface TileCacheMetrics {
  profileHits: number;
  profileMisses: number;
  recomputedColumns: number;
  rawLevelScans: number;
  tileInvalidations: number;
  cachedProfileBytes: number;
  tileCount: number;
}

function tileStartFor(second: number): number {
  return Math.floor(second / SECONDS_PER_TILE) * SECONDS_PER_TILE;
}

function buildPriceTree(column: HeatColumn): PriceMaxTree {
  const entries: { price: number; size: number }[] = [];
  for (const levels of [column.bids, column.asks]) {
    for (let index = 0; index < levels.sizes.length; index += 1) {
      const size = levels.sizes[index]!;
      if (size >= 1) entries.push({ price: levels.prices[index]!, size });
    }
  }
  entries.sort((a, b) => a.price - b.price);
  const prices: number[] = [];
  const sizes: number[] = [];
  for (const entry of entries) {
    const last = prices.length - 1;
    if (last >= 0 && prices[last] === entry.price) sizes[last] = Math.max(sizes[last]!, entry.size);
    else {
      prices.push(entry.price);
      sizes.push(entry.size);
    }
  }
  let leafCount = 1;
  while (leafCount < sizes.length) leafCount *= 2;
  const tree = new Uint32Array(leafCount * 2);
  for (let index = 0; index < sizes.length; index += 1) tree[leafCount + index] = sizes[index]!;
  for (let index = leafCount - 1; index > 0; index -= 1) {
    tree[index] = Math.max(tree[index * 2]!, tree[index * 2 + 1]!);
  }
  return { prices: Int32Array.from(prices), leafCount, tree };
}

function lowerBound(values: Int32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: Int32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function projectPriceTree(tree: PriceMaxTree, view: Viewport, height: number, reuse?: Uint32Array): Uint32Array {
  const output = reuse?.length === height ? reuse : new Uint32Array(height);
  output.fill(0);
  const priceTop = view.centerPriceTicks + view.priceSpanTicks / 2;
  const first = upperBound(tree.prices, priceTop - view.priceSpanTicks - 0.5);
  const end = lowerBound(tree.prices, priceTop + 0.5);
  // Project each visible quoted price cell once. Querying two binary searches
  // and a segment tree for every physical row dominated price-zoom redraws.
  // Keep the exact positive-area overlap and maximum semantics of the raw path.
  for (let i = first; i < end; i++) {
    const price = tree.prices[i]!, size = tree.tree[tree.leafCount + i]!;
    const top = Math.max(0, Math.floor(((priceTop - (price + 0.5)) / view.priceSpanTicks) * height));
    const bottom = Math.min(height - 1, Math.ceil(((priceTop - (price - 0.5)) / view.priceSpanTicks) * height) - 1);
    if (top > bottom) continue;
    output[top] = Math.max(output[top]!, size);
    if (bottom > top) {
      output[bottom] = Math.max(output[bottom]!, size);
      // Only edge pixels can overlap an adjacent integer-price cell.
      // Interior rows belong solely to this price, so native fill is exact.
      if (bottom > top + 1) output.fill(size, top + 1, bottom);
    }
  }
  return output;
}

function pixelSpan(start: number, end: number, limit: number): [number, number] | null {
  if (end <= 0 || start >= limit || end <= start) return null;
  let first = Math.floor(start);
  let last = Math.ceil(end) - 1;
  if (last < first) {
    first = Math.floor((start + end) / 2);
    last = first;
  }
  first = Math.max(0, first);
  last = Math.min(limit - 1, last);
  return first <= last ? [first, last] : null;
}

/** Bounded 60-second scalar tiles. Raw level trees are built once per column object. */
export class TimeTileCache {
  private readonly tiles = new Map<number, TimeTile>();
  private readonly bySecond = new Map<number, HeatColumn>();
  private sortedSeconds: number[] = [];
  private readonly rawTrees = new WeakMap<HeatColumn, PriceMaxTree>();
  private readonly profileLru = new Map<string, ProfileLruItem>();
  private readonly latestProfiles = new WeakMap<HeatColumn, ProfileLruItem>();
  private readonly objectIds = new WeakMap<HeatColumn, number>();
  private nextObjectId = 0;
  private profileBytes = 0;
  private version = 0;
  private metricsValue: TileCacheMetrics = this.emptyMetrics();
  private dirtyTileStarts = new Set<number>();

  get metrics(): Readonly<TileCacheMetrics> {
    return { ...this.metricsValue, cachedProfileBytes: this.profileBytes, tileCount: this.tiles.size };
  }

  get dataVersion(): number { return this.version; }

  get invalidatedTiles(): readonly number[] {
    return [...this.dirtyTileStarts];
  }

  setColumns(columns: readonly HeatColumn[]): void {
    this.metricsValue = this.emptyMetrics();
    this.dirtyTileStarts = new Set<number>();
    const incoming = new Map<number, HeatColumn>();
    for (const column of columns) incoming.set(Math.floor(column.timeUs / US_PER_SECOND), column);

    const changedSeconds: number[] = [];
    for (const [second, previous] of this.bySecond) {
      const next = incoming.get(second);
      if (next === previous) continue;
      this.removeColumn(second, previous);
      changedSeconds.push(second);
    }
    for (const [second, column] of incoming) {
      if (this.bySecond.get(second) === column) continue;
      this.addColumn(second, column);
      changedSeconds.push(second);
    }
    if (changedSeconds.length > 0) {
      this.version += 1;
      this.sortedSeconds = [...this.bySecond.keys()].sort((a, b) => a - b);
      for (const second of changedSeconds) this.invalidateAround(second);
    }
    while (this.tiles.size > MAX_TIME_TILES) {
      const oldest = Math.min(...this.tiles.keys());
      if (oldest === undefined) break;
      const tile = this.tiles.get(oldest)!;
      for (const second of tile.columns.keys()) this.removeColumn(second, tile.columns.get(second)!);
      this.tiles.delete(oldest);
      this.dirtyTileStarts.add(oldest);
    }
  }

  displayColumn(second: number): HeatColumn | null {
    return resolveColumnForDrawing(second, this.bySecond, this.sortedSeconds);
  }

  projectedProfile(column: HeatColumn, view: Viewport, height: number): Uint32Array {
    const tileStart = tileStartFor(Math.floor(column.timeUs / US_PER_SECOND));
    const tile = this.tiles.get(tileStart);
    if (!tile) return new Uint32Array(height);
    const previous = this.latestProfiles.get(column);
    const key = previous?.key ?? `${this.objectId(column)}|`;
    if (previous && previous.center === view.centerPriceTicks && previous.span === view.priceSpanTicks
      && previous.profile.length === height) {
      this.metricsValue.profileHits += 1;
      this.profileLru.delete(key);
      this.profileLru.set(key, previous);
      return previous.profile;
    }
    this.metricsValue.profileMisses += 1;
    this.metricsValue.recomputedColumns += 1;
    let tree = this.rawTrees.get(column);
    if (!tree) {
      this.metricsValue.rawLevelScans += 1;
      tree = buildPriceTree(column);
      this.rawTrees.set(column, tree);
    }
    // Price zoom changes the projection on every frame. Keeping dozens of old
    // projections per column created allocation/LRU eviction spikes. Consumers
    // copy the profile into the grid synchronously; reuse only its last buffer.
    if (previous) {
      this.tiles.get(previous.tileStart)?.profiles.delete(previous.key);
      this.profileLru.delete(previous.key);
      this.profileBytes -= previous.profile.byteLength;
    }
    const profile = projectPriceTree(tree, view, height, previous?.profile);
    const item = previous ?? { tileStart, key, column, profile,
      center: view.centerPriceTicks, span: view.priceSpanTicks };
    item.profile = profile; item.center = view.centerPriceTicks; item.span = view.priceSpanTicks;
    tile.profiles.set(key, profile);
    this.profileLru.set(key, item);
    this.latestProfiles.set(column, item);
    this.profileBytes += profile.byteLength;
    this.evictProfiles();
    return profile;
  }

  aggregate(view: Viewport, width: number, height: number): PixelMaxGrid {
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const values = new Uint32Array(safeWidth * safeHeight);
    const grid = { width: safeWidth, height: safeHeight, values };
    this.aggregateStrip(grid, view, 0, safeWidth);
    return grid;
  }

  get dirtyTimeRanges(): readonly { fromSec: number; toSec: number }[] {
    return [...this.dirtyTileStarts].map(fromSec => ({ fromSec, toSec: fromSec + SECONDS_PER_TILE }));
  }

  aggregateStrip(grid: PixelMaxGrid, view: Viewport, clipFrom: number, clipTo: number): void {
    const { width: safeWidth, height: safeHeight, values } = grid;
    const clipStart = Math.max(0, Math.floor(clipFrom));
    const clipEnd = Math.min(safeWidth, Math.ceil(clipTo));
    for (let y = 0; y < safeHeight; y++) values.fill(0, y * safeWidth + clipStart, y * safeWidth + clipEnd);
    const startSec = view.startUs / US_PER_SECOND;
    const firstSec = Math.floor(startSec + clipStart / safeWidth * view.durationSec);
    const lastSec = Math.ceil(startSec + clipEnd / safeWidth * view.durationSec) - 1;
    for (let second = firstSec; second <= lastSec; second += 1) {
      const column = this.displayColumn(second);
      if (!column) continue;
      const xStart = ((second - startSec) / view.durationSec) * safeWidth;
      const xEnd = ((second + 1 - startSec) / view.durationSec) * safeWidth;
      const xRange = pixelSpan(xStart, xEnd, safeWidth);
      if (!xRange) continue;
      const left = Math.max(clipStart, xRange[0]);
      const right = Math.min(clipEnd - 1, xRange[1]);
      if (left > right) continue;
      const profile = this.projectedProfile(column, view, safeHeight);
      if (left === right) {
        // Compressed time: avoid a one-iteration inner loop and per-row multiply.
        for (let y = 0, pixel = left; y < safeHeight; y++, pixel += safeWidth) {
          const size = profile[y]!;
          if (size > values[pixel]!) values[pixel] = size;
        }
        continue;
      }
      if (right === left + 1) {
        for (let y = 0, pixel = left; y < safeHeight; y++, pixel += safeWidth) {
          const size = profile[y]!;
          if (size > values[pixel]!) values[pixel] = size;
          if (size > values[pixel + 1]!) values[pixel + 1] = size;
        }
        continue;
      }
      for (let y = 0; y < safeHeight; y += 1) {
        const size = profile[y]!;
        if (size < 1) continue;
        const rowOffset = y * safeWidth;
        for (let x = left; x <= right; x += 1) {
          const pixel = rowOffset + x;
          if (size > values[pixel]!) values[pixel] = size;
        }
      }
    }
  }

  resetMetrics(): void {
    this.metricsValue = this.emptyMetrics();
  }

  private addColumn(second: number, column: HeatColumn): void {
    this.bySecond.set(second, column);
    const startSec = tileStartFor(second);
    let tile = this.tiles.get(startSec);
    if (!tile) {
      tile = { startSec, columns: new Map(), profiles: new Map() };
      this.tiles.set(startSec, tile);
    }
    tile.columns.set(second, column);
  }

  private removeColumn(second: number, column: HeatColumn): void {
    this.bySecond.delete(second);
    const startSec = tileStartFor(second);
    const tile = this.tiles.get(startSec);
    if (tile) {
      tile.columns.delete(second);
      this.latestProfiles.delete(column);
      for (const [key, profile] of tile.profiles) {
        if (key.startsWith(`${this.objectId(column)}|`)) {
          tile.profiles.delete(key);
          this.profileLru.delete(key);
          this.profileBytes -= profile.byteLength;
        }
      }
      if (tile.columns.size === 0) this.tiles.delete(startSec);
    }
  }

  private invalidateAround(second: number): void {
    this.dirtyTileStarts.add(tileStartFor(second));
    const index = this.lowerBoundSecond(second);
    const previous = this.sortedSeconds[index - 1];
    const exact = this.sortedSeconds[index] === second;
    const next = this.sortedSeconds[index + (exact ? 1 : 0)];
    if (previous !== undefined && second - previous >= 1 && second - previous <= 3) {
      for (let gap = previous + 1; gap < second; gap += 1) this.dirtyTileStarts.add(tileStartFor(gap));
    }
    if (next !== undefined && next - second >= 1 && next - second <= 3) {
      for (let gap = second + 1; gap < next; gap += 1) this.dirtyTileStarts.add(tileStartFor(gap));
    }
    this.metricsValue.tileInvalidations = this.dirtyTileStarts.size;
  }

  private lowerBoundSecond(second: number): number {
    let low = 0;
    let high = this.sortedSeconds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sortedSeconds[middle]! < second) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private objectId(column: HeatColumn): number {
    let id = this.objectIds.get(column);
    if (id === undefined) {
      id = ++this.nextObjectId;
      this.objectIds.set(column, id);
    }
    return id;
  }

  private evictProfiles(): void {
    while (this.profileBytes > MAX_PROFILE_BYTES && this.profileLru.size > 0) {
      const oldestKey = this.profileLru.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.profileLru.get(oldestKey)!;
      this.profileLru.delete(oldestKey);
      if (this.latestProfiles.get(oldest.column)?.key === oldestKey) this.latestProfiles.delete(oldest.column);
      const tile = this.tiles.get(oldest.tileStart);
      const profile = tile?.profiles.get(oldest.key);
      if (profile) {
        tile!.profiles.delete(oldest.key);
        this.profileBytes -= profile.byteLength;
      }
    }
  }

  private emptyMetrics(): TileCacheMetrics {
    return {
      profileHits: 0,
      profileMisses: 0,
      recomputedColumns: 0,
      rawLevelScans: 0,
      tileInvalidations: 0,
      cachedProfileBytes: this.profileBytes,
      tileCount: this.tiles.size,
    };
  }
}
