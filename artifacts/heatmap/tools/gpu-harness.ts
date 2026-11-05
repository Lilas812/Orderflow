import { HeatmapRenderer } from "../src/chart/renderer.ts";
import { CurrentBookRenderer } from "../src/chart/current-book.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
import { followStartUs, backgroundDpr } from "../src/chart/coordinates.ts";
import { glowBookColumn } from "../src/chart/glow.ts";
import type { HeatColumn, Viewport } from "../src/domain.ts";

const element = () => {
  const c = document.createElement("canvas"); c.style.cssText = "width:320px;height:160px";
  const wrap=document.createElement("div");wrap.style.cssText="position:relative;display:inline-block;width:320px;height:160px";
  wrap.append(c);document.body.append(wrap);return c;
};
const column = (sec: number, center: number, n: number): HeatColumn => ({
  timeUs: sec * 1e6, source: "history",
  bids: { prices: Int32Array.of(center, center - 1, center - 3), sizes: Uint32Array.of(n, 0, 100) },
  asks: { prices: Int32Array.of(center + 1, center + 2), sizes: Uint32Array.of(n + 13, n / 2 | 0) },
});
const head = 1793350000;
function compare(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray, width: number,
  fourUnitBand?: [number,number]) {
  let pixels = 0, max = 0, first: null | { x: number; y: number; channel: number; a: number; b: number } = null;
  for (let i = 0; i < a.length; i += 4) {
    let bad = false;
    const x=i/4%width;
    const limit=fourUnitBand && x>=fourUnitBand[0] && x<fourUnitBand[1] ? 4 : 3;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!); max = Math.max(max, d);
      if (d > limit) { bad = true; first ??= { x: i / 4 % width, y: Math.floor(i / 4 / width), channel: c, a: a[i+c]!, b: b[i+c]! }; }
    }
    if (bad) pixels++;
  }
  return { pixels, max, first };
}
async function run() {
  const results: unknown[] = [];
  const pictures:{name:string;png:string}[]=[];
  const capture=(name:string,a:{rgba:Uint8Array;width:number;height:number},b:{rgba:Uint8Array;width:number;height:number})=>{
    const c=document.createElement("canvas");c.width=a.width*2;c.height=a.height+30;
    const ctx=c.getContext("2d")!;ctx.fillStyle="#111";ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle="#fff";ctx.font="12px sans-serif";ctx.fillText("WebGL2 / "+name,4,20);ctx.fillText("Canvas 2D",a.width+4,20);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(a.rgba),a.width,a.height),0,30);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(b.rgba),b.width,b.height),a.width,30);
    pictures.push({name,png:c.toDataURL("image/png")});
  };
  for (const center of [84000, 27000]) {
    const a = element(), b = element(), aa = element(), ba = element();
    const r = new HeatmapRenderer(a, aa, () => {}, { renderer: "webgl" });
    const reference = new HeatmapRenderer(b, ba, () => {}, { renderer: "canvas" });
    const trades = new TradeAggregator();
    r.setTrades(trades); reference.setTrades(trades);
    const cols = Array.from({ length: 100 }, (_, i) => column(head - 90 + i, center, (i * 13) % 150));
    let previousOptions = "";
    let lastView: Viewport | undefined;
    for (let step = 0; step < 32; step++) {
      const style = step >= 16 && !(step>=21&&step<=23) ? "block" : "glow";
      const opts = { time: step > 23 ? "max" : "mean", price: step > 27 ? "none" : "auto" } as const;
      if (JSON.stringify(opts) !== previousOptions) { r.setSmoothing(opts); previousOptions = JSON.stringify(opts); }
      reference.setSmoothing(opts);
      r.setStyle(style); reference.setStyle(style);
      const settings = { ...DEFAULT_SETTINGS, heatUpperMode: "size" as const, heatUpperSize: step > 11 ? 150 : 200,
        heatLowerMode: step > 10 ? "size" as const : "off" as const, heatLowerSize: 30, heatGamma: step > 9 ? .7 : 1 };
      r.setScaleOptions(settings); reference.setScaleOptions(settings);
      // Isolate pixel correctness from the independent one-second scale timers:
      // both renderers must adopt the same explicitly fixed scale this frame.
      (r as any).lastScaleAt = -Infinity; (reference as any).lastScaleAt = -Infinity;
      const w = Math.round(320 * backgroundDpr(devicePixelRatio)), durationSec = step > 17 ? 137.3 : 60;
      const view: Viewport = { startUs: step >= 12 && step < 16 ? (head - 40) * 1e6 + step * 112357
        : followStartUs((head + step) * 1e6, durationSec, w), durationSec,
        centerPriceTicks: center + .125, priceSpanTicks: step > 20 ? 800 : step > 16 ? 18.25 : 14 };
      lastView = view;
      if (step === 4) cols[60] = column(head - 30, center, 173);
      if (step === 7) cols.splice(55, 1);
      if (step === 6 || step === 11) trades.appendLive([{ tsUs: (head - 31) * 1e6,
        recvUs: (head + step) * 1e6, seq: step, price: center, size: 7, side: "buy" }]);
      r.draw(cols, view, step, "jst"); reference.draw(cols, view, step, "jst");
      const pa = r.readBackground(), pb = reference.readBackground();
      const diff = compare(pa.rgba, pb.rgba, pa.width);
      if([2,8,22,26].includes(step))capture(`${center}-${step}-${style}`,pa,pb);
      results.push({ center, step, style, ...diff, gpu: r.gpuMetrics, mode: r.rendererMode, width: pa.width, height: pa.height });
    }
    // Uniform-only changes must not upload unchanged data/mask textures.
    r.setScaleOptions({ ...DEFAULT_SETTINGS, heatUpperMode: "size", heatUpperSize: 253,
      heatLowerMode: "off", heatGamma: 1.2 });
    (r as any).lastScaleAt = -Infinity;
    r.draw(cols, lastView!, 40, "jst");
    const after = r.gpuMetrics;
    if (after.uploadedColumns !== 0 || after.eatenColumns !== 0)
      throw Error("settings_reuploaded_data");
    // One-pixel follow plus a new actual second must retain the other ring slots.
    const fixed={...DEFAULT_SETTINGS,heatUpperMode:"size" as const,heatUpperSize:200,heatLowerMode:"off" as const,heatGamma:1};
    r.setSmoothing({time:"mean",price:"auto"});reference.setSmoothing({time:"mean",price:"auto"});
    r.setStyle("glow");reference.setStyle("glow");r.setScaleOptions(fixed);reference.setScaleOptions(fixed);
    const width=Math.round(320*backgroundDpr(devicePixelRatio));
    const steady={startUs:followStartUs((head+10)*1e6,60,width),durationSec:60,centerPriceTicks:center+.125,priceSpanTicks:14};
    (r as any).lastScaleAt=-Infinity;r.draw(cols,steady,41,"jst");
    const batches=r.gpuMetrics.batchedUploads;
    cols.push(column(head+10,center,71));
    steady.startUs=followStartUs((head+10)*1e6+60e6/width,60,width);
    (r as any).lastScaleAt=-Infinity;(reference as any).lastScaleAt=-Infinity;
    r.draw(cols,steady,42,"jst");reference.draw(cols,steady,42,"jst");
    const partial=r.gpuMetrics;
    if(!partial.uploadedColumns||partial.uploadedColumns>=width||partial.batchedUploads!==batches)
      throw Error(`whole_texture_uploaded_on_follow:${JSON.stringify(partial)}`);
    const incremental=r.readBackground()!, whole=reference.readBackground()!;
    results.push({center,step:"one-column-ring",style:"glow",...compare(incremental.rgba,whole.rgba,width),
      mode:r.rendererMode,gpu:partial});
    // Latest book colour strip is GPU, numbers remain native-DPR Canvas.
    const bookA = element(), bookB = element(), gpuBook = new CurrentBookRenderer(bookA), cpuBook = new CurrentBookRenderer(bookB);
    gpuBook.bandSink = r.bandSink;
    const view = { startUs: (head-50)*1e6, durationSec:60, centerPriceTicks:center+.125, priceSpanTicks:14 };
    for (const style of ["block","glow"] as const) {
      r.setStyle(style); reference.setStyle(style);
      r.setScaleOptions({ ...DEFAULT_SETTINGS, heatUpperMode:"size",heatUpperSize:200,heatLowerMode:"off",heatGamma:1 });
      reference.setScaleOptions({ ...DEFAULT_SETTINGS,heatUpperMode:"size",heatUpperSize:200,heatLowerMode:"off",heatGamma:1 });
      (r as any).lastScaleAt = -Infinity; (reference as any).lastScaleAt = -Infinity;
      r.draw(cols,view,50,"jst");reference.draw(cols,view,50,"jst");
      const latest=column(head,center,73);
      gpuBook.draw(latest,view,200,head*1e6,{style});cpuBook.draw(latest,view,200,head*1e6,{style});
      if(style==="glow" && r.gpuMetrics.bandBytes!==0)throw Error("book_style_reuploaded_quantities");
      const pa = r.readBackground()!, ref=reference.readBackground()!;
      const composed=document.createElement("canvas");composed.width=ref.width;composed.height=ref.height;
      const ctx=composed.getContext("2d")!;ctx.putImageData(new ImageData(new Uint8ClampedArray(ref.rgba),ref.width,ref.height),0,0);
      ctx.imageSmoothingEnabled=false;ctx.drawImage(bookB,0,0,ref.width,ref.height);
      const actual=ctx.getImageData(0,0,ref.width,ref.height).data;
      const end=Math.ceil(cpuBook.metrics.bandEnd!/devicePixelRatio*backgroundDpr(devicePixelRatio));
      // Numbers are a separate foreground layer, not part of readBackground().
      for(let y=0;y<ref.height;y++)for(let x=end;x<ref.width;x++)
        actual.set(ref.rgba.subarray((y*ref.width+x)*4,(y*ref.width+x+1)*4),(y*ref.width+x)*4);
      let sourceDiff: unknown = null;
      if(style==="glow"){
        const gpu=(r as any).gpu, gl=gpu.gl as WebGL2RenderingContext;
        const raw=new Uint8Array(gpu.bandRows*4);
        gl.bindFramebuffer(gl.FRAMEBUFFER,gpu.fbBand);gl.readPixels(0,0,1,gpu.bandRows,gl.RGBA,gl.UNSIGNED_BYTE,raw);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        const source=glowBookColumn(latest,view,ref.height,{upper:200,lower:0,gamma:1});
        sourceDiff=compare(raw,source.rgba,1);
      }
      const original=compare(pa.rgba,actual,ref.width);
      const allowed=devicePixelRatio===1 ? [cpuBook.metrics.bandStart!,end] as [number,number] : undefined;
      results.push({center,step:`book-${style}`,style,...compare(pa.rgba,actual,ref.width,allowed),
        originalThreeUnitFailure:original, bandTolerance:allowed?4:3,
        sourceDiff,gpu:r.gpuMetrics,mode:r.rendererMode,band:cpuBook.metrics});
      capture(`${center}-book-${style}`,pa,{rgba:new Uint8Array(actual),width:ref.width,height:ref.height});
    }
    for(const style of ["block","glow"] as const){
      gpuBook.draw(column(head,center,73),view,253,head*1e6,{style,lower:2,gamma:.7});
      if(r.gpuMetrics.bandBytes!==0||r.gpuMetrics.bandUpdates!==0)
        throw Error("book_scale_reuploaded_quantities");
    }
    r.bandSink(null);
    const previous = r.readBackground()!;
    r.loseGpuContext();
    await new Promise(resolve=>setTimeout(resolve,80));
    const fallback = r.readBackground()!;
    const lossDiff = compare(fallback.rgba,previous.rgba,previous.width);
    if(r.rendererMode!=="canvas"||lossDiff.pixels)throw Error(`context_loss_fallback:${JSON.stringify(lossDiff)}`);
    r.restoreGpuContext();
    for (let i=0;i<60 && r.rendererMode!=="webgl";i++) await new Promise(resolve=>setTimeout(resolve,50));
    if(r.rendererMode!=="webgl")throw Error(`context_restore_failed:${JSON.stringify(r.gpuMetrics)}`);
    const restored=r.readBackground()!;
    results.push({center,step:"context-restored",style:"glow",...compare(restored.rgba,previous.rgba,previous.width),
      mode:r.rendererMode,gpu:r.gpuMetrics});
    // Keep the actual canvases visible for evidence screenshots; release GL resources.
    r.destroy(); reference.destroy();
  }
  if(new URLSearchParams(location.search).has("saved")){
    const input=await(await fetch("/@fs/home/runner/workspace/data/gpu-heatmap/production-input/pixel-input.json")).json();
    for(const symbol of ["NQ","GC"]){
      const cols:HeatColumn[]=input.boards[symbol].map((c:any)=>({timeUs:c.tsSec*1e6,source:c.source,
        bids:{prices:Int32Array.from(c.bids.map((p:any)=>p.price)),sizes:Uint32Array.from(c.bids.map((p:any)=>p.size))},
        asks:{prices:Int32Array.from(c.asks.map((p:any)=>p.price)),sizes:Uint32Array.from(c.asks.map((p:any)=>p.size))}}));
      const a=element(),b=element(),r=new HeatmapRenderer(a,element(),()=>{},{renderer:"webgl"}),
        ref=new HeatmapRenderer(b,element(),()=>{},{renderer:"canvas"}),trades=new TradeAggregator();
      trades.appendLive(input.trades[symbol]);r.setTrades(trades);ref.setTrades(trades);
      const mid=(cols[0]!.bids.prices[0]!+cols[0]!.asks.prices[0]!)/2;
      for(let i=0;i<8;i++){
        const style=i%2?"block":"glow",options={time:i>3?"max":"mean",price:i>5?"none":"auto"} as const;
        r.setSmoothing(options);ref.setSmoothing(options);r.setStyle(style);ref.setStyle(style);
        const settings={...DEFAULT_SETTINGS,heatUpperMode:"size" as const,heatUpperSize:i>3?73:200,
          heatLowerMode:i>3?"size" as const:"off" as const,heatLowerSize:2,heatGamma:i>1?.7:1};
        r.setScaleOptions(settings);ref.setScaleOptions(settings);
        (r as any).lastScaleAt=-Infinity;(ref as any).lastScaleAt=-Infinity;
        const view={startUs:(input.from+i*.123)*1e6,durationSec:i<4?240:97.3,centerPriceTicks:mid+.125,
          priceSpanTicks:i<4?800:24};
        r.draw(cols,view,i,"jst",true,true,(input.to-20)*1e6);ref.draw(cols,view,i,"jst",true,true,(input.to-20)*1e6);
        const pa=r.readBackground()!,pb=ref.readBackground()!;
        results.push({symbol,step:`saved-${i}`,style,...compare(pa.rgba,pb.rgba,pa.width),
          mode:r.rendererMode,inputHash:input.inputHash,gpu:r.gpuMetrics});
        if(i===0||i===3||i===6)capture(`${symbol}-saved-${i}-${style}`,pa,pb);
      }
      r.destroy();ref.destroy();
    }
  }
  return { dpr: devicePixelRatio, results, pictures, pass: results.every((r: any) => r.mode === "webgl" && r.pixels === 0) };
}
(window as any).gpuCheck = run;
