/** Browser-only external observer. Never changes market state, renderer input, or results. */
export function installObserver() {
  const rows = [], contexts = new Set(), pending = new Map(), saved = [];
  const totals = { reserved: 0, callbacks: 0, cancelled: 0, draws: 0, vertices: 0,
    uploadBytes: 0, buffers: 0, deletes: 0, errors: 0, loss: 0, restore: 0 };
  let fault = null, enabled = true;
  const layerOf = canvas => canvas?.dataset?.testid?.replace("-canvas", "") ?? "other";
  const row = r => {
    if (rows.length >= 8192) { fault = "OBSERVER_LIMIT"; throw Error(fault); }
    rows.push({ at: performance.now(), ...r });
  };
  const wrap = (target, name, factory) => {
    const old = target[name]; target[name] = factory(old); saved.push(() => { target[name] = old; });
  };
  wrap(HTMLCanvasElement.prototype, "getContext", old => function (kind, ...args) {
    const context = old.call(this, kind, ...args);
    if (kind === "webgl2" && context && ![...contexts].some(x => x.gl === context)) {
      const c = { canvas: this, gl: context }; contexts.add(c);
      const loss = () => { totals.loss++; }, restore = () => { totals.restore++; };
      this.addEventListener("webglcontextlost", loss); this.addEventListener("webglcontextrestored", restore);
      saved.push(() => { this.removeEventListener("webglcontextlost", loss); this.removeEventListener("webglcontextrestored", restore); });
    }
    return context;
  });
  const nativeError = WebGL2RenderingContext.prototype.getError;
  // Delta is Canvas2D, not WebGL. Its real clear call marks a draw effect;
  // the public parent revision is read at that effect, not invented as a GL draw.
  wrap(CanvasRenderingContext2D.prototype, "clearRect", old => function (...args) {
    const out = old.apply(this, args);
    if (this.canvas?.dataset?.testid === "delta-canvas") row({ kind: "delta-clear",
      revision: Number(document.querySelector('[data-testid="text-unified-revisions"]')?.getAttribute("data-revision") ?? -1) });
    return out;
  });
  for (const method of ["drawArrays", "drawElements", "clear", "bufferData", "bufferSubData", "createBuffer", "deleteBuffer"]) {
    wrap(WebGL2RenderingContext.prototype, method, old => function (...args) {
      const begin = performance.now(), out = old.apply(this, args), ms = performance.now() - begin;
      const layer = layerOf(this.canvas), revision = Number(this.canvas.dataset.revision ?? -1);
      if (method === "clear") row({ kind: "clear", layer, revision, ms });
      else if (method.startsWith("draw")) {
        totals.draws++; const vertices = method === "drawArrays" ? args[2] : args[1];
        totals.vertices += vertices; row({ kind: "draw", layer, revision, ms, vertices });
        if (nativeError.call(this) !== 0) { totals.errors++; fault = "GL_ERROR"; }
      } else if (method === "bufferData" || method === "bufferSubData") {
        const data = args[method === "bufferData" ? 1 : 2];
        totals.uploadBytes += typeof data === "number" ? data : data?.byteLength ?? 0;
      } else if (method === "createBuffer" && out) totals.buffers++;
      else if (method === "deleteBuffer" && args[0]) totals.deletes++;
      return out;
    });
  }
  wrap(window, "requestAnimationFrame", old => function (fn) {
    const stack = new Error().stack ?? "", layer = /HeatmapCanvas/.test(stack) ? "heatmap" :
      /BubbleCanvas/.test(stack) ? "bubble" : "other";
    const due = performance.now(); let id;
    id = old.call(this, time => {
      pending.delete(id);
      if (enabled) { totals.callbacks++; row({ kind: "raf", layer, wait: performance.now() - due }); }
      const begin = performance.now(); fn(time);
      if (enabled) row({ kind: "raf-cpu", layer, ms: performance.now() - begin });
    });
    if (enabled) { totals.reserved++; pending.set(id, layer); }
    return id;
  });
  wrap(window, "cancelAnimationFrame", old => function (id) {
    if (pending.delete(id) && enabled) totals.cancelled++;
    return old.call(this, id);
  });
  window.__load29Observer = {
    snapshot: () => ({ totals: { ...totals }, pending: pending.size, fault, rows: [...rows],
      contexts: [...contexts].map(c => ({ layer: layerOf(c.canvas), revision: Number(c.canvas.dataset.revision ?? -1),
        connected: c.canvas.isConnected, lost: c.gl.isContextLost(), error: c.gl.isContextLost() ? null : nativeError.call(c.gl),
        renderer: c.gl.getParameter(c.gl.getExtension("WEBGL_debug_renderer_info")?.UNMASKED_RENDERER_WEBGL ?? c.gl.RENDERER) })) }),
    dispose() {
      enabled = false; for (const restore of saved.reverse()) restore();
      saved.length = 0; contexts.clear();
      return { pending: pending.size, fault };
    },
  };
}
