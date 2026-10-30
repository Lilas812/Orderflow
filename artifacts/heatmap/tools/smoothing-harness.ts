import { HeatmapRenderer } from "../src/chart/renderer.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";
import { SmoothingRaster } from "../src/chart/smoothing.ts";
import type { HeatColumn } from "../src/domain.ts";
const canvas = document.createElement("canvas"), axis = document.createElement("canvas");
canvas.style.cssText = "width:800px;height:400px"; axis.style.cssText = "width:60px;height:400px";
document.body.replaceChildren(canvas, axis);
document.body.style.cssText = "background:black;color:white";
const summary = (a: number[]) => { a.sort((a,b)=>a-b); return { p50: a[Math.floor(a.length*.5)], p95: a[Math.floor(a.length*.95)], max: a.at(-1) }; };
const make = (sec: number, size = sec % 10 === 0 ? 100 : 10): HeatColumn => ({
  timeUs: sec * 1e6, source: "history",
  bids: { prices: Int32Array.from({length:80},(_,i)=>100-i), sizes: Uint32Array.from({length:80},()=>size) },
  asks: { prices: Int32Array.from({length:80},(_,i)=>101+i), sizes: Uint32Array.from({length:80},()=>size) },
});
const columns = Array.from({ length: 600 }, (_,s)=>make(s));
const view = { startUs: 0, durationSec: 600, centerPriceTicks: 100, priceSpanTicks: 200 };
let renderer = new HeatmapRenderer(canvas, axis);
const reset = (legacy: boolean, style: "block"|"glow") => {
  renderer = new HeatmapRenderer(canvas, axis);
  renderer.setSmoothing(legacy ? null : { time: "mean", price: "auto" });
  renderer.setStyle(style);
  renderer.setScaleOptions({ ...DEFAULT_SETTINGS, heatUpperMode: "size", heatUpperSize: 200, heatGamma: 1, heatLowerMode: "off" });
};
async function run(legacy: boolean, style: "block"|"glow", seconds = 15) {
  reset(legacy, style);
  const input = [...columns], times: number[] = [], latest: number[] = [];
  const start = performance.now();
  renderer.draw(input, view, 0, "jst"); const initial = renderer.metrics.drawMs;
  let sequence = 0;
  while (performance.now() - start < seconds * 1000) {
    await new Promise(r => setTimeout(r, 250));
    const recv = performance.now();
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      // Numeric late correction, all other seconds keep their identities.
      const s = 580 + sequence++ % 20; input[s] = make(s, 10 + sequence % 90);
      renderer.draw(input, view, sequence, "jst", true, false);
      latest.push(performance.now() - recv); times.push(renderer.metrics.drawMs); resolve();
    }));
  }
  return { legacy, style, seconds, initial, samples: times.length, draw: summary(times), receiveToPaint: summary(latest),
    inputColumns:600, levelsPerColumn:160, viewport:view, width:800,height:400,dpr:devicePixelRatio,
    heap:(performance as any).memory?.usedJSHeapSize, metrics:renderer.metrics };
}
function comparison(time: "mean"|"max", price: "auto"|"none", style:"block"|"glow") {
  reset(false, style); renderer.setSmoothing({time,price});
  renderer.draw(Array.from({length:6000},(_,s)=>make(s)), {...view, durationSec:6000, priceSpanTicks:800}, 0,"jst");
  return renderer.metrics;
}
function assertions() {
  const raster = new SmoothingRaster(), smallView = {...view,durationSec:10,centerPriceTicks:100,priceSpanTicks:1};
  const selected = Array.from({length:10},(_,s)=>({ ...make(s), bids:{prices:Int32Array.of(100),sizes:Uint32Array.of(s?10:100)},asks:{prices:new Int32Array(),sizes:new Uint32Array()} }));
  const scale = {upper:200,lower:0,gamma:1};
  const a = raster.frame(selected, smallView,1,1,{time:"mean",price:"auto"},scale,"block",null);
  const b = raster.frame(selected, smallView,1,1,{time:"max",price:"auto"},scale,"block",null);
  if (a.slice(0,3).every((n,i)=>n===b[i])) throw Error("unsaturated_colours_equal");
  renderer.setSmoothing({time:"mean",price:"auto"});
  renderer.draw([make(0),make(5)], {...view,durationSec:10}, 0,"jst",true,false,1e6);
  return {meanRgb:[...a.slice(0,3)],maxRgb:[...b.slice(0,3)],replayCutoffUs:1e6};
}
(window as any).smoothingHarness = { run, comparison, assertions };
