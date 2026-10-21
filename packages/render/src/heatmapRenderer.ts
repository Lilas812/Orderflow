import { timeToX, tickToY, type Viewport } from "@workspace/core/viewport";
import type { TimeWeightedDepth } from "@workspace/core/time-weighted-depth";

export const REFERENCE_QUANTITY = 80; // R06 MOCK provisional ABS scale, NOT p95 or a volume filter.
export const DISPLAY_INTERVAL_MS = 250;
export const FLOATS_PER_VERTEX = 8; // CSS x,y; normalized RGBA; missing flag; diagnostic TWA or -1.
export const BACKGROUND = [8, 9, 13] as const;
export type RenderStatus = "READY" | "CONTEXT LOST" | "RENDER ERROR" | "DISPOSED";
export interface HeatmapCell {
  readonly id: string;
  readonly priceTicks: number;
  readonly result: TimeWeightedDepth;
  readonly missingReason?: "GAP" | "UNKNOWN";
}
export interface CellColor {
  readonly intensity: number | null;
  readonly rgba: readonly [number, number, number, number];
  readonly missing: boolean;
}
export interface ProjectedCell {
  readonly source: HeatmapCell;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly color: CellColor;
}
export interface HeatmapFrame {
  readonly rects: readonly ProjectedCell[];
  readonly vertexData: Float32Array;
  readonly vertexCount: number;
}

/** Display mapping only. Missingness is never coerced to a quantity or partialTWA. */
export function cellColor(cell: HeatmapCell): CellColor {
  const r = cell.result;
  if (!Number.isFinite(r.coverageRatio) || r.coverageRatio < 0 || r.coverageRatio > 1) {
    throw new RangeError("Invalid coverage");
  }
  if (r.status === "NO DATA") {
    if (r.twa !== null) throw new TypeError("NO DATA must not have a confirmed TWA");
    return { intensity: null, rgba: [213 / 255, 167 / 255, 75 / 255, 0.6], missing: true };
  }
  if (r.coverageRatio !== 1 || !Number.isFinite(r.twa) || r.twa < 0) {
    throw new TypeError("Only a fully covered, confirmed TWA can receive a quantity color");
  }
  const intensity = Math.min(1, r.twa / REFERENCE_QUANTITY);
  const low = r.side === "BID" ? [6, 28, 19] : [27, 9, 42];
  const high = r.side === "BID" ? [67, 250, 85] : [178, 53, 250];
  const rgb = intensity === 0 ? BACKGROUND : low.map((v, i) => Math.round(v + (high[i] - v) * intensity));
  return { intensity, rgba: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1], missing: false };
}

/** Shared R05 transforms; clip before Float32 conversion to keep off-screen epochs out of GPU math. */
export function projectHeatmap(cells: readonly HeatmapCell[], vp: Viewport): HeatmapFrame {
  const rects: ProjectedCell[] = [];
  const values: number[] = [];
  const b = vp.bounds;
  for (const source of cells) {
    const r = source.result;
    if (!Number.isSafeInteger(source.priceTicks) || ![1, 2, 4, 8].includes(r.width)
      || Math.floor(source.priceTicks / r.width) !== r.binId
      || BigInt(r.endNs) <= BigInt(r.startNs)) throw new TypeError("Invalid heatmap cell geometry");
    const color = cellColor(source);
    if (!vp.price || b.width === 0 || b.height === 0
      || BigInt(r.endNs) <= BigInt(vp.time.minNs) || BigInt(r.startNs) >= BigInt(vp.time.maxNs)) continue;
    const first = r.binId * r.width;
    // Display cell boundaries only. Raw integer prices and TWA results are untouched.
    const upper = first + r.width - 0.5, lower = first - 0.5;
    if (upper <= vp.price.minTick || lower >= vp.price.maxTick) continue;
    const x0 = timeToX(vp, r.startNs), x1 = timeToX(vp, r.endNs);
    const y0 = tickToY(vp, upper), y1 = tickToY(vp, lower);
    if (x0 === null || x1 === null || y0 === null || y1 === null) continue;
    const left = Math.max(b.left, x0), right = Math.min(b.left + b.width, x1);
    const top = Math.max(b.top, y0), bottom = Math.min(b.top + b.height, y1);
    if (left >= right || top >= bottom) continue;
    rects.push({ source, left, right, top, bottom, color });
    for (const [x, y] of [[left, top], [right, top], [left, bottom], [left, bottom], [right, top], [right, bottom]]) {
      values.push(x, y, ...color.rgba, color.missing ? 1 : 0, r.twa ?? -1);
    }
  }
  return { rects, vertexData: new Float32Array(values), vertexCount: rects.length * 6 };
}

/** Half-open hit testing includes known zero cells and returns the original computed result. */
export function hitTestCell(frame: HeatmapFrame, x: number, y: number): HeatmapCell | null {
  return frame.rects.find((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)?.source ?? null;
}

const VERTEX = `#version 300 es
layout(location=0) in vec2 a_position;
layout(location=1) in vec4 a_color;
layout(location=2) in float a_missing;
uniform vec2 u_cssSize;
out vec4 v_color;
out vec2 v_css;
flat out float v_missing;
void main() {
  gl_Position=vec4(a_position.x/u_cssSize.x*2.0-1.0,1.0-a_position.y/u_cssSize.y*2.0,0.0,1.0);
  v_color=a_color; v_css=a_position; v_missing=a_missing;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_css;
flat in float v_missing;
out vec4 outColor;
void main() {
  if(v_missing>0.5 && mod(floor((v_css.x+v_css.y)/6.0),2.0)>0.5) discard;
  outColor=v_color;
}`;

/** Retains only cells/viewport references, never regenerates source events or computes quantities. */
export class HeatmapRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniform: WebGLUniformLocation | null = null;
  private cells: readonly HeatmapCell[] = [];
  private viewport: Viewport | null = null;
  private disposed = false;
  private lost = false;
  status: RenderStatus = "RENDER ERROR";
  error: string | null = null;
  lastFrame: HeatmapFrame = { rects: [], vertexData: new Float32Array(), vertexCount: 0 };

  constructor(private canvas: HTMLCanvasElement, private onStatus: (status: RenderStatus, error: string | null) => void = () => {}) {
    canvas.addEventListener("webglcontextlost", this.contextLost);
    canvas.addEventListener("webglcontextrestored", this.contextRestored);
    try { this.initialize(); } catch (error) { this.fail(error); }
  }
  private setStatus(status: RenderStatus, error: string | null = null): void {
    if (status !== this.status || error !== this.error) {
      this.status = status; this.error = error; this.onStatus(status, error);
    }
  }
  private fail(error: unknown): void {
    this.setStatus("RENDER ERROR", error instanceof Error ? error.message : String(error));
  }
  private initialize(): void {
    const gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is unavailable; no fallback or simulated GPU success");
    this.gl = gl;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Shader allocation failed");
        shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compilation failed");
      }
      program = gl.createProgram();
      if (!program) throw new Error("Program allocation failed");
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Program linking failed");
      this.program = program;
      this.buffer = gl.createBuffer(); this.vao = gl.createVertexArray();
      if (!this.buffer || !this.vao) throw new Error("GPU buffer allocation failed");
      this.uniform = gl.getUniformLocation(program, "u_cssSize");
      if (this.uniform === null) throw new Error("Missing CSS-size uniform");
      gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      const stride = FLOATS_PER_VERTEX * 4;
      for (const [location, size, offset] of [[0, 2, 0], [1, 4, 8], [2, 1, 24]]) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      }
      this.setStatus("READY");
    } catch (error) {
      if (program) gl.deleteProgram(program);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.vao) gl.deleteVertexArray(this.vao);
      this.program = null; this.buffer = null; this.vao = null;
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }
  private contextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.program = null; this.buffer = null; this.vao = null;
    this.setStatus("CONTEXT LOST", "WebGL context lost; data remains unchanged");
  };
  private contextRestored = (): void => {
    if (this.disposed) return;
    this.lost = false;
    try {
      this.initialize();
      if (this.viewport) this.draw(this.cells, this.viewport);
    } catch (error) { this.fail(error); }
  };
  draw(cells: readonly HeatmapCell[], vp: Viewport): HeatmapFrame {
    if (this.disposed) throw new Error("Renderer disposed");
    this.cells = cells; this.viewport = vp;
    this.lastFrame = projectHeatmap(cells, vp);
    if (this.lost || !this.program || !this.gl) return this.lastFrame;
    const gl = this.gl, b = vp.bounds;
    const cssWidth = b.left + b.width, cssHeight = b.top + b.height;
    const width = Math.max(0, Math.round(cssWidth * vp.dpr));
    const height = Math.max(0, Math.round(cssHeight * vp.dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(BACKGROUND[0] / 255, BACKGROUND[1] / 255, BACKGROUND[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (width === 0 || height === 0 || b.width === 0 || b.height === 0) return this.lastFrame;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(b.left * vp.dpr), 0, width - Math.round(b.left * vp.dpr), height - Math.round(b.top * vp.dpr));
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lastFrame.vertexData, gl.DYNAMIC_DRAW);
    gl.uniform2f(this.uniform, cssWidth, cssHeight);
    gl.drawArrays(gl.TRIANGLES, 0, this.lastFrame.vertexCount);
    const error = gl.getError();
    if (error !== gl.NO_ERROR && !gl.isContextLost()) {
      this.fail(new Error(`WebGL error ${error}`));
    } else if (!gl.isContextLost()) this.setStatus("READY");
    return this.lastFrame;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestored);
    if (!this.lost && this.gl) {
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.status = "DISPOSED";
  }
}
