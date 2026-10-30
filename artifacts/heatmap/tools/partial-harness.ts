import { HeatmapRenderer } from "../src/chart/renderer.ts";
import { CurrentBookRenderer } from "../src/chart/current-book.ts";
import { followStartUs, backgroundDpr } from "../src/chart/coordinates.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
import type { HeatColumn } from "../src/domain.ts";

const canvas = () => {
  const c = document.createElement("canvas"); c.style.cssText = "width:320px;height:160px";
  document.body.append(c); return c;
};
function col(sec: number, center: number, n: number): HeatColumn {
  return { timeUs: sec * 1e6, source: "history",
    bids: { prices: Int32Array.of(center, center - 1), sizes: Uint32Array.of(n, 0) },
    asks: { prices: Int32Array.of(center + 1), sizes: Uint32Array.of(n + 13) } };
}
const head = 1793350000;
function run() {
  const results = [];
  for (const center of [84000, 27000]) for (const style of ["block", "glow"] as const) {
    const a = canvas(), b = canvas(), axisA = canvas(), axisB = canvas();
    const r = new HeatmapRenderer(a, axisA), full = new HeatmapRenderer(b, axisB);
    const trades = new TradeAggregator();
    r.setTrades(trades); full.setTrades(trades);
    r.setStyle(style); full.setStyle(style);
    const columns = Array.from({length: 100}, (_, i) => col(head - 90 + i, center, (i * 13) % 150));
    let previousOptions = "", frames = 0, partial = 0;
    let imageData: ImageData | undefined;
    for (let step = 0; step < 26; step++) {
      const options = { time: step > 21 ? "max" : "mean", price: step > 23 ? "none" : "auto" } as const;
      const key = JSON.stringify(options);
      if (key !== previousOptions) { r.setSmoothing(options); previousOptions = key; }
      // Reference keeps no derived profiles/image validity between draws.
      full.setSmoothing(options);
      const settings = { ...DEFAULT_SETTINGS, heatUpperMode: "size" as const, heatUpperSize: 200,
        heatLowerMode: "off" as const, heatGamma: step > 19 ? .7 : 1 };
      r.setScaleOptions(settings); full.setScaleOptions(settings);
      const width = Math.round(320 * backgroundDpr(devicePixelRatio));
      const durationSec = step > 17 ? 71.3 : 60;
      const view = { startUs: step >= 12 && step < 16 ? (head - 40) * 1e6 + step * 112357
        : followStartUs((head + (step < 9 ? step : 18 - step)) * 1e6, durationSec, width),
        durationSec, centerPriceTicks: center + .125, priceSpanTicks: step > 16 ? 18.25 : 14 };
      if (step === 4) columns[60] = col(head - 30, center, 173);
      if (step === 7) columns.splice(55, 1);
      if (step === 6 || step === 11) trades.appendLive([{ tsUs: (head - 31) * 1e6,
        recvUs: (head + step) * 1e6, seq: step, price: center, size: 7, side: "buy" }]);
      r.draw(columns, view, step, "jst"); full.draw(columns, view, step, "jst");
      const reused = (r as any).imageData as ImageData;
      if (imageData && imageData !== reused) throw Error("image_data_not_reused");
      imageData = reused;
      if (a.width !== width || a.height !== Math.round(160 * backgroundDpr(devicePixelRatio))) throw Error("background_dpr");
      if (axisA.width !== Math.round(axisA.getBoundingClientRect().width * devicePixelRatio)) throw Error("axis_native_dpr");
      const pa = a.getContext("2d")!.getImageData(0, 0, a.width, a.height).data;
      const pb = b.getContext("2d")!.getImageData(0, 0, b.width, b.height).data;
      for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) throw Error(`canvas_mismatch:${center}:${style}:${step}:${i}`);
      if (r.metrics.partialRaster && r.metrics.repaintPixels! < a.width * a.height) partial++;
      frames++;
    }
    if (!partial) throw Error("partial_path_not_exercised");
    results.push({ center, style, frames, partial, pixelsPerFrame: a.width * a.height });
    a.remove(); b.remove(); axisA.remove(); axisB.remove();
  }
  const bookCanvas = canvas(), book = new CurrentBookRenderer(bookCanvas);
  const texts: {text: string; dpr: number}[] = [];
  const ctx = bookCanvas.getContext("2d")!, original = ctx.fillText;
  ctx.fillText = function(text, x, y, maxWidth?) {
    texts.push({ text, dpr: this.getTransform().a });
    if (maxWidth === undefined) original.call(this, text, x, y); else original.call(this, text, x, y, maxWidth);
  };
  const view = { startUs: head * 1e6, durationSec: 60, centerPriceTicks: 84000, priceSpanTicks: 8 };
  for (const style of ["block", "glow"] as const)
    book.draw(col(head, 84000, 73), view, 200, (head + 48) * 1e6, { style });
  if (bookCanvas.width !== Math.round(320 * devicePixelRatio) || book.metrics.backgroundDpr !== backgroundDpr(devicePixelRatio))
    throw Error("book_resolution_split");
  if (!texts.some(t => t.text === "73") || texts.some(t => t.dpr !== devicePixelRatio)) throw Error("native_book_numbers");
  return { dpr: devicePixelRatio, effectiveDpr: backgroundDpr(devicePixelRatio), results, bookNumbers: texts,
    band: book.metrics, pass: true };
}
(window as any).partialCheck = run;
