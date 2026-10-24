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
  const canvasIds = new WeakMap(), contextIds = new WeakMap(), cycles = new WeakMap();
  let nextIdentity = 0;
  const id = (map, value) => { if (!map.has(value)) map.set(value, ++nextIdentity); return map.get(value); };
  // Observe an actual synchronous Delta effect, bounded by setTransform and the
  // outer restore. Never synthesize a draw or call the product effect ourselves.
  for (const api of ["setTransform", "save", "restore", "beginPath", "moveTo", "lineTo",
    "fillRect", "fillText", "stroke", "rect", "clip"]) {
    wrap(CanvasRenderingContext2D.prototype, api, old => function (...args) {
      const out = old.apply(this, args);
      const canvas = this.canvas;
      if (!enabled || canvas?.dataset?.testid !== "delta-canvas") return out;
      if (api === "setTransform") {
        cycles.set(this, { kind: "delta-draw", canvasId: id(canvasIds, canvas),
          contextId: id(contextIds, this), started: performance.now(),
          revision: Number(document.querySelector('[data-testid="text-unified-revisions"]')?.getAttribute("data-revision") ?? -1),
          width: canvas.width, height: canvas.height, operations: [], path: [], depth: 0 });
        return out;
      }
      const cycle = cycles.get(this);
      if (!cycle) return out;
      if (api === "save") cycle.depth++;
      if (api === "beginPath") cycle.path = [];
      if (api === "moveTo" || api === "lineTo") {
        if (cycle.path.length >= 512) throw Error("DELTA_PATH_CAP");
        cycle.path.push([...args]);
      }
      if (["fillRect", "fillText", "stroke", "rect", "clip"].includes(api)) {
        if (cycle.operations.length >= 512) throw Error("DELTA_OPERATION_CAP");
        cycle.operations.push({ api, args: api === "fillText" ? args.slice(1) : [...args],
          ...(api === "fillText" ? { text: String(args[0]) } : {}),
          style: String(api === "stroke" ? this.strokeStyle : this.fillStyle).toLowerCase(),
          alpha: this.globalAlpha, lineWidth: this.lineWidth,
          ...(api === "stroke" ? { path: cycle.path.map(p => [...p]) } : {}) });
      }
      if (api === "restore" && --cycle.depth === 0) {
        const viewport = document.querySelector('[data-testid="unified-controls"]')?.getAttribute("data-diagnostic-viewport");
        cycle.viewport = viewport ? JSON.parse(viewport) : null;
        const candidates = [...document.querySelectorAll('[data-testid^="delta-row-"]')];
        cycle.placeholders = candidates.filter(el => el.dataset.testid === "delta-row-empty").map(el => ({
          text: el.textContent,
          hasBinFields: ["delta", "b", "s", "u", "revision", "x0", "x1", "direction", "quality"]
            .some(key => el.dataset[key] !== undefined),
        }));
        cycle.binRows = candidates.filter(el => el.dataset.testid !== "delta-row-empty").map(el => ({
          id: el.dataset.testid.slice("delta-row-".length), delta: el.dataset.delta,
          B: el.dataset.b, S: el.dataset.s, U: el.dataset.u, quality: el.dataset.quality,
          revision: Number(el.dataset.revision), direction: el.dataset.direction,
          x0: Number(el.dataset.x0), x1: Number(el.dataset.x1) }));
        cycle.ended = performance.now();
        delete cycle.path; delete cycle.depth;
        row(cycle); cycles.delete(this);
      }
      return out;
    });
  }
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
    geometry: () => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      parentWidth: document.querySelector('[data-testid="load29-page"]')?.getBoundingClientRect().width,
      canvases: [...contexts].map(c => {
        const r = c.canvas.getBoundingClientRect();
        return { layer: layerOf(c.canvas), connected: c.canvas.isConnected, cssWidth: r.width, cssHeight: r.height,
          width: c.canvas.width, height: c.canvas.height,
          bufferWidth: c.gl.drawingBufferWidth, bufferHeight: c.gl.drawingBufferHeight };
      }) }),
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
