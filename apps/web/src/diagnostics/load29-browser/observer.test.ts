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
  class CanvasRenderingContext2D{clearRect(){}}
  const document={querySelector:()=>({getAttribute:()=>"7"})};
  class HTMLCanvasElement{
    constructor(){this.dataset={testid:"heatmap-canvas",revision:"7"};this.isConnected=true;}
    getContext(kind){return kind==="webgl2"?(this.gl??=new WebGL2RenderingContext(this)):null;}
    addEventListener(){}removeEventListener(){}
  }
  const window={requestAnimationFrame(fn){const id=next++;callbacks.set(id,fn);return id;},
    cancelAnimationFrame(id){callbacks.delete(id);}};
  (${installObserver.toString()})();
  const canvas=new HTMLCanvasElement(),gl=canvas.getContext("webgl2");
  ({window,canvas,gl,callbacks,fire(id){const fn=callbacks.get(id);callbacks.delete(id);fn(1);}})
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
