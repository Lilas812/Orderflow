// 使い方：OUT=出力先/ FLAT=1（深い板の壁なし） node --experimental-strip-types docs/evidence/zoom-lines/dummy-render.mts
// ダミー（合成）データで、拡大／縮小時の描画を実コードで比較する診断スクリプト。リポジトリは変更しない。
import { writeFileSync } from "node:fs";
const R = new URL("../../../artifacts/heatmap/src", import.meta.url).pathname;
const { SmoothingRaster, temporalQuantities } = await import(`${R}/chart/smoothing.ts`);
const { heatThresholds, positiveVisibleP99 } = await import(`${R}/chart/scale.ts`);
const { COLOR_LUT, lutIndex } = await import(`${R}/chart/palette.ts`);
const { gaussianKernel, verticalBlur, coreAlpha } = await import(`${R}/chart/glow.ts`);
import type { HeatColumn, Viewport } from "../../../artifacts/heatmap/src/domain.ts";

const OUT = (process.env.OUT ?? "./") + (process.env.FLAT === "1" ? "flat-" : "");
let seed = 12345;
const rnd = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hash = (a: number, b: number) => { let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

// ---- ダミーの GC 風の板（1秒×1ティック、両側160段） ----
const N = 10800, T0 = 1_793_000_000, LEVELS = 160;
const mid = new Float64Array(N); mid[0] = 41100;
for (let t = 1; t < N; t++) { const r = rnd(); mid[t] = mid[t - 1]! + (r < .12 ? -1 : r > .88 ? 1 : 0); }
interface Ev { from: number; to: number; price: number; size: number }
const events: Ev[] = [];
for (let i = 0; i < 45; i++) { // 長く残る大きめの板（7〜40枚、2〜30分）
  const from = Math.floor(rnd() * N), side = rnd() < .5 ? -1 : 1;
  events.push({ from, to: from + 120 + Math.floor(rnd() * 1700), price: Math.round(mid[from]!) + side * (3 + Math.floor(rnd() * 35)),
    size: 7 + Math.floor(rnd() * 34) });
}
for (let i = 0; i < 400; i++) { // すぐ消える板
  const from = Math.floor(rnd() * N), side = rnd() < .5 ? -1 : 1;
  events.push({ from, to: from + 2 + Math.floor(rnd() * 20), price: Math.round(mid[from]!) + side * (2 + Math.floor(rnd() * 15)),
    size: 6 + Math.floor(rnd() * 12) });
}
// 約定で食われたら消す
for (const e of events) for (let t = e.from; t < Math.min(e.to, N); t++)
  if ((e.price >= mid[t]! && e.price <= Math.floor(mid[t]!) + 1 && t > e.from + 1) || Math.abs(e.price - mid[t]!) < .5) { e.to = t; break; }
const bySec: Map<number, number>[] = Array.from({ length: N }, () => new Map());
for (const e of events) for (let t = e.from; t < Math.min(e.to, N); t++) bySec[t]!.set(e.price, (bySec[t]!.get(e.price) ?? 0) + e.size);

// 厚さ：最良気配の近くは1〜6枚、30ティックより遠い深い板は数十〜百枚台（1枚目の右端の数字 82〜217 を模した）
const FLAT = process.env.FLAT === "1";
const base = (dist: number) => FLAT ? 1.2 + .02 * dist : 1.2 + .02 * dist + 20 / (1 + Math.exp(-(dist - 40) / 6));
const columns: HeatColumn[] = [];
for (let t = 0; t < N; t++) {
  const bb = Math.floor(mid[t]!), ba = bb + 1, block = Math.floor(t / 240);
  const side = (start: number, dir: number) => {
    const prices = new Int32Array(LEVELS), sizes = new Uint32Array(LEVELS);
    for (let i = 0; i < LEVELS; i++) {
      const p = start + dir * i, f = .35 + 1.3 * hash(p, block);
      prices[i] = p; sizes[i] = Math.max(1, Math.round(base(i) * f)) + (bySec[t]!.get(p) ?? 0);
    }
    return { prices, sizes };
  };
  columns.push({ timeUs: (T0 + t) * 1e6, source: "history", bids: side(bb, -1), asks: side(ba, 1) });
}

const W = 1400, H = 660;
const settings = { heatUpperMode: "auto", heatUpperSize: 100, heatTopPct: 5, heatLowerMode: "pct", heatLowerPct: 80,
  heatLowerSize: 5, heatGamma: .5 } as const;

function current(view: Viewport) {
  const th = heatThresholds(columns, view, settings);
  const raster = new SmoothingRaster();
  const img = raster.frame(columns, view, W, H, { time: "mean", price: "auto" }, { upper: th.upper, lower: th.lower, gamma: .5 }, "glow", null);
  return { img: new Uint8ClampedArray(img), th };
}

/** 試作：線の太さを「画面の画素」で最低 MIN_LINE にし、重なりは最大で合成。色の計算は既存と同じ。 */
const MIN_LINE = 5;
function proposal(view: Viewport, upper: number, lower: number, gamma = .5, cols: HeatColumn[] = columns) {
  const top = view.centerPriceTicks + view.priceSpanTicks / 2, ppt = H / view.priceSpanTicks;
  const line = Math.max(ppt, MIN_LINE), half = line / 2;
  const k = Math.max(2, Math.min(10, Math.round(line)));
  const kernel = gaussianKernel(k);
  const pos = (n: number) => n > 0 && n > lower ? Math.min(1, Math.max(0, (n - lower) / Math.max(1, upper - lower))) ** gamma : 0;
  const cores: Float32Array[] = [], blurs: Float32Array[] = [], strengths: Float32Array[] = [];
  const bySecond = new Map<number, HeatColumn>(); for (const c of cols) bySecond.set(c.timeUs / 1e6, c);
  const start = view.startUs / 1e6, dx = view.durationSec / W;
  for (let x = 0; x < W; x++) {
    const from = start + x * dx, to = from + dx, refs: HeatColumn[] = [];
    for (let s = Math.floor(from); s < Math.ceil(to); s++) { const c = bySecond.get(s); if (c) refs.push(c); }
    const core = new Float32Array(H), st = new Float32Array(H);
    for (const [price, q] of temporalQuantities(refs, from, to)) {
      const t = pos(q.sum / q.weight) * Math.min(1, q.weight / (to - from));
      if (t <= 0) continue;
      const center = (top - price) / view.priceSpanTicks * H;
      for (let y = Math.max(0, Math.floor(center - half)); y < Math.min(H, Math.ceil(center + half)); y++) {
        const d = Math.abs(y + .5 - center) / half;
        const s = d < .35 ? 1 : Math.max(0, 1 - (d - .35) / .65) ** 1.5;
        if (t * s > core[y]!) { core[y] = t * s; st[y] = s; }
      }
    }
    cores.push(core); strengths.push(st); blurs.push(verticalBlur(core, kernel));
  }
  const img = new Uint8ClampedArray(W * H * 4);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    const h = ((blurs[x - 1]?.[y] ?? 0) + 2 * blurs[x]![y]! + (blurs[x + 1]?.[y] ?? 0)) / 4;
    const gi = lutIndex(Math.min(1, h * 1.8)) * 3, c = cores[x]![y]!, a = c > 0 ? coreAlpha(strengths[x]![y]!) : 0, ci = lutIndex(c) * 3;
    const o = (y * W + x) * 4;
    for (let ch = 0; ch < 3; ch++) img[o + ch] = COLOR_LUT[gi + ch]! * .9 * (1 - a) + COLOR_LUT[ci + ch]! * a;
    img[o + 3] = 255;
  }
  return img;
}

const endT = N - 1500;
const zin: Viewport = { startUs: (T0 + endT - 1200) * 1e6, durationSec: 1200, centerPriceTicks: Math.round(mid[endT - 600]!), priceSpanTicks: 60 };
let sum = 0; for (let t = 0; t < N; t++) sum += mid[t]!;
const zout: Viewport = { startUs: T0 * 1e6, durationSec: N, centerPriceTicks: Math.round(sum / N), priceSpanTicks: 300 };

// 縮小時でも「現在値の近く」だけで基準を決める案：各秒の最良気配 ±30 ティックのマスだけで上位5%・下位80%
function nearPriceThresholds(view: Viewport, band = 30) {
  const near = columns.filter(c => c.timeUs >= view.startUs && c.timeUs < view.startUs + view.durationSec * 1e6).map(c => {
    const m = (c.bids.prices[0]! + c.asks.prices[0]!) / 2;
    const cut = (s: { prices: Int32Array; sizes: Uint32Array }) => {
      const idx = [...s.prices].map((p, i) => [p, i] as const).filter(([p]) => Math.abs(p - m) <= band).map(([, i]) => i);
      return { prices: Int32Array.from(idx.map(i => s.prices[i]!)), sizes: Uint32Array.from(idx.map(i => s.sizes[i]!)) };
    };
    return { ...c, bids: cut(c.bids), asks: cut(c.asks) };
  });
  const lo = -1e9, hi = 1e9;
  return { upper: positiveVisibleP99(near, lo, hi, .95), lower: positiveVisibleP99(near, lo, hi, .80) };
}


/** 案：最良気配からの距離ごとに「その距離でふつうの厚さ」を基準にする（距離ごとの下位80%・上位5%）。 */
function distanceNormalized(ref: HeatColumn[]) {
  const D = LEVELS, samples: number[][] = Array.from({ length: D }, () => []);
  for (const c of ref) for (const s of [c.bids, c.asks]) for (let i = 0; i < D; i++) samples[i]!.push(s.sizes[i]!);
  const q = (a: number[], p: number) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]!; };
  const lo = new Float64Array(D), up = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    const band: number[] = []; for (let j = Math.max(0, i - 2); j <= Math.min(D - 1, i + 2); j++) band.push(...samples[j]!);
    lo[i] = q(band, .80); up[i] = Math.max(lo[i]! + 1, q(band, .95));
  }
  const map = (s: { prices: Int32Array; sizes: Uint32Array }) => ({ prices: s.prices,
    sizes: Uint32Array.from(s.sizes, (n, i) => n <= lo[i]! ? 0 : Math.round(1000 * Math.min(1, (n - lo[i]!) / (up[i]! - lo[i]!)))) });
  return { cols: ref.map(c => ({ ...c, bids: map(c.bids), asks: map(c.asks) })), lo, up };
}

const out: Record<string, unknown> = {};
const A = current(zin); writeFileSync(OUT + "A.rgba", A.img); out.A = { ...A.th, pxPerTick: H / zin.priceSpanTicks };
const B = current(zout); writeFileSync(OUT + "B.rgba", B.img); out.B = { ...B.th, pxPerTick: H / zout.priceSpanTicks };
writeFileSync(OUT + "C1.rgba", proposal(zout, B.th.upper, B.th.lower));
const dn = distanceNormalized(columns);
out.dist = { lo: [0, 10, 20, 30, 40, 60, 100].map(i => dn.lo[i]), up: [0, 10, 20, 30, 40, 60, 100].map(i => dn.up[i]) };
writeFileSync(OUT + "C3.rgba", proposal(zout, 1000, 0, .5, dn.cols));
writeFileSync(OUT + "A3.rgba", proposal(zin, 1000, 0, .5, dn.cols));
const near = nearPriceThresholds(zout); out.C2 = near;
writeFileSync(OUT + "C2.rgba", proposal(zout, near.upper, near.lower));
out.W = W; out.H = H;
console.log(JSON.stringify(out));
