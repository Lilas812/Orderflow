import { it, expect } from "vitest";
import { runInNewContext } from "node:vm";
const modulePath = "./observer.mjs";
const { installObserver } = await import(modulePath);
function fixture() {
  return runInNewContext(`
  const callbacks=new Map();let next=1;
  const performance={now:()=>1};
  class WebGL2RenderingContext{
    constructor(canvas){this.canvas=canvas;this.error=0;}
    getError(){const e=this.error;this.error=0;return e;}
    isContextLost(){return false;} getExtension(){return null;}getParameter(){return "FAKE";}
    drawArrays(){}drawElements(){}clear(){}bufferData(){}bufferSubData(){}
    createBuffer(){return {};}deleteBuffer(){}
  }
  class CanvasRenderingContext2D{
    constructor(canvas){this.canvas=canvas;this.calls=[];this.fillStyle="#08090d";
      this.strokeStyle="#aab0c0";this.lineWidth=2;this.globalAlpha=1;}
    clearRect(){}
  }
  for(const api of ["setTransform","save","restore","beginPath","moveTo","lineTo",
    "fillRect","fillText","stroke","rect","clip"]){
    CanvasRenderingContext2D.prototype[api]=function(...args){
      this.calls.push({api,args,receiver:this});return "native-"+api;
    };
  }
  let bins=[];
  const viewport={bounds:{left:0,top:0,width:403,height:324},dpr:1};
  const document={querySelector:(selector)=>({
    getAttribute:()=>selector.includes("unified-controls")?JSON.stringify(viewport):"7",
    getBoundingClientRect:()=>({width:765})}),querySelectorAll:()=>bins};
  class HTMLCanvasElement{
    constructor(){this.dataset={testid:"heatmap-canvas",revision:"7"};this.isConnected=true;
      this.width=403;this.height=324;this.cssWidth=403;this.cssHeight=324;}
    getContext(kind){return kind==="webgl2"?(this.gl??=new WebGL2RenderingContext(this)):
      kind==="2d"?(this.ctx??=new CanvasRenderingContext2D(this)):null;}
    getBoundingClientRect(){return {width:this.cssWidth,height:this.cssHeight};}
    addEventListener(){}removeEventListener(){}
  }
  Object.defineProperties(WebGL2RenderingContext.prototype,{
    drawingBufferWidth:{get(){return this.canvas.width;}},
    drawingBufferHeight:{get(){return this.canvas.height;}}});
  const window={devicePixelRatio:1,innerWidth:852,innerHeight:760,
    requestAnimationFrame(fn){const id=next++;callbacks.set(id,fn);return id;},
    cancelAnimationFrame(id){callbacks.delete(id);}};
  (${installObserver.toString()})();
  const canvas=new HTMLCanvasElement(),gl=canvas.getContext("webgl2");
  ({window,canvas,gl,callbacks,setBins(b){bins=b;},
    delta(){const c=new HTMLCanvasElement();c.dataset.testid="delta-canvas";c.height=126;
      return c.getContext("2d");},
    fire(id){const fn=callbacks.get(id);callbacks.delete(id);fn(1);}})
  `);
}
it("observes actual GL buffers/draws and revision without producing fake draws", () => {
  const x = fixture(), b = x.gl.createBuffer();
  x.gl.bufferData(0, new Float32Array(6), 0); x.gl.drawArrays(0, 0, 2); x.gl.deleteBuffer(b);
  const s = x.window.__load29Observer.snapshot();
  expect(s.totals.vertices).toBe(2); expect(s.totals.uploadBytes).toBe(24);
  expect(s.totals.buffers).toBe(1); expect(s.totals.deletes).toBe(1);
  expect(s.rows[0].revision).toBe(7);
});
it("distinguishes reservation/execution/cancellation and outstanding RAF", () => {
  const x = fixture();
  const a = x.window.requestAnimationFrame(() => {}), b = x.window.requestAnimationFrame(() => {});
  x.window.cancelAnimationFrame(a); x.fire(b);
  const s = x.window.__load29Observer.snapshot();
  expect([s.totals.reserved, s.totals.callbacks, s.totals.cancelled, s.pending]).toEqual([2, 1, 1, 0]);
});
it("records true GL failure rather than UNKNOWN", () => {
  const x = fixture(); x.gl.error = 1280; x.gl.drawArrays(0, 0, 2);
  expect(x.window.__load29Observer.snapshot().fault).toBe("GL_ERROR");
});
it("fails rather than truncating records", () => {
  const x = fixture();
  expect(() => { for (let i = 0; i < 8193; i++) x.gl.clear(1); }).toThrow("OBSERVER_LIMIT");
});
it("exposes pending callbacks during disposal rather than hiding them", () => {
  const x = fixture(); x.window.requestAnimationFrame(() => {});
  expect(x.window.__load29Observer.dispose().pending).toBe(1);
});
it("does not count clear-only known-empty heatmap as a GPU geometry draw", () => {
  const x = fixture(); x.gl.clear(1);
  const s = x.window.__load29Observer.snapshot();
  expect(s.rows[0].kind).toBe("clear"); expect(s.totals.draws).toBe(0);
});
it("records Delta background and data APIs with native this, args and return values", () => {
  const x = fixture(), ctx = x.delta();
  expect(ctx.setTransform(1, 0, 0, 1, 0, 0)).toBe("native-setTransform");
  expect(ctx.fillRect(0, 0, 403, 126)).toBe("native-fillRect");
  ctx.save(); ctx.beginPath(); ctx.moveTo(0, 63); ctx.lineTo(40, 63);
  expect(ctx.stroke()).toBe("native-stroke");
  ctx.fillText("0", 2, 59); ctx.restore();
  const draw = x.window.__load29Observer.snapshot().rows.find((r: any) => r.kind === "delta-draw");
  expect(draw.revision).toBe(7); expect(draw.canvasId).toBeGreaterThan(0);
  expect(draw.contextId).toBeGreaterThan(0);
  expect(draw.operations.find((o: any) => o.api === "stroke").path).toEqual([[0, 63], [40, 63]]);
  expect(ctx.calls.find((c: any) => c.api === "fillRect").receiver).toBe(ctx);
  expect(ctx.calls.find((c: any) => c.api === "fillRect").args).toEqual([0, 0, 403, 126]);
});
it("does not synthesize a completed data draw from one background fill", () => {
  const x = fixture(), ctx = x.delta();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillRect(0, 0, 403, 126);
  expect(x.window.__load29Observer.snapshot().rows).toEqual([]);
});
it("samples resized CSS and drawing buffer dimensions independently", () => {
  const x = fixture();
  x.canvas.cssWidth = 523;
  let c = x.window.__load29Observer.geometry().canvases[0];
  expect(c.cssWidth).toBe(523); expect(c.bufferWidth).toBe(403);
  x.canvas.cssWidth = 403; x.canvas.width = 806; x.window.devicePixelRatio = 2;
  c = x.window.__load29Observer.geometry().canvases[0];
  expect(c.cssWidth).toBe(403); expect(c.bufferWidth).toBe(806);
  expect(x.window.__load29Observer.geometry().dpr).toBe(2);
});
it("restores native Canvas2D functions on observer disposal", () => {
  const x = fixture(), ctx = x.delta();
  x.window.__load29Observer.dispose();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillRect(0, 0, 403, 126);
  expect(x.window.__load29Observer.snapshot().rows).toEqual([]);
  expect(ctx.calls.length).toBe(2);
});
