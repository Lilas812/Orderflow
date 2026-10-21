import { timeToX, tickToY, type ChartBounds, type Viewport } from "@workspace/core/viewport";
import { bubbleOpacity, type BubbleState } from "@workspace/core/bubble-finality";
import { bubbleDiameter, DEFAULT_BUBBLE_SIZING, type BubbleSizing } from "@workspace/core/bubble-sizing";
import { evaluateBubbleFilter, type BubbleFilters } from "@workspace/core/bubble-aggregate";
import type { RenderStatus } from "./heatmapRenderer";
import { clusterBubbles, type ClusteringOptions, type VisualBubbleCluster } from "./bubbleClustering";

export const BUBBLE_LAYER_ORDER = ["background", "gap", "heatmap", "price", "bubbles", "tooltip"] as const;
/** CSS xy, local xy, straight RGBA, CSS radius, diagnostic B/S/V/Delta.
 * Diagnostic Float32 values are NOT a quantity store; exact BigInts remain in source.bucket.
 */
export const BUBBLE_FLOATS_PER_VERTEX = 13;
export interface ProjectedBubble {
  readonly source: BubbleState;
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
  readonly rgba: readonly [number, number, number, number];
  /** Display aggregate only; source is still an original R09 BubbleState. */
  readonly cluster?: VisualBubbleCluster;
}
export interface BubbleFrame {
  readonly bubbles: readonly ProjectedBubble[];
  readonly vertexData: Float32Array;
  readonly vertexCount: number;
  readonly bounds: ChartBounds;
  readonly clusters: readonly VisualBubbleCluster[];
  readonly sourceBubbles: readonly ProjectedBubble[];
}
export interface BubbleColors {
  readonly buy: readonly [number, number, number];
  readonly sell: readonly [number, number, number];
  readonly neutral: readonly [number, number, number];
}
export const DEFAULT_BUBBLE_COLORS: BubbleColors = {
  buy: [67, 250, 85], sell: [178, 53, 250], neutral: [156, 163, 180],
};
function validateColors(colors: BubbleColors): void {
  for (const key of ["buy", "sell", "neutral"] as const) {
    const rgb = colors?.[key];
    if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
      throw new RangeError("Invalid bubble RGB palette");
    }
  }
}
export function bubbleColor(source: BubbleState, colors: BubbleColors = DEFAULT_BUBBLE_COLORS): readonly [number, number, number, number] {
  validateColors(colors);
  const delta = source.bucket.delta;
  const rgb = delta === null || delta === 0n ? colors.neutral
    : delta > 0n ? colors.buy : colors.sell;
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, bubbleOpacity(source)];
}
/** Only projection, filtering and sizing. All quantity arithmetic remains in R08. */
export function projectBubbles(
  sources: readonly BubbleState[], vp: Viewport, sizing: BubbleSizing = DEFAULT_BUBBLE_SIZING,
  filters?: BubbleFilters, clustering: ClusteringOptions = { mode: "ALL" },
  colors: BubbleColors = DEFAULT_BUBBLE_COLORS,
): BubbleFrame {
  // Validate display settings even for an empty frame.
  bubbleDiameter(0, sizing);
  validateColors(colors);
  const bubbles: ProjectedBubble[] = [], values: number[] = [], bounds = vp.bounds;
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) throw new TypeError("Duplicate bubble ID in one frame");
    seen.add(source.id);
    if (source.status === "INCOMPLETE" || !evaluateBubbleFilter(source.bucket, filters).pass) continue;
    if (!vp.price || bounds.width === 0 || bounds.height === 0) continue;
    const bucket = source.bucket, start = BigInt(bucket.startNs), end = BigInt(bucket.endNs);
    if (end <= start || !Number.isSafeInteger(bucket.minTick) || !Number.isSafeInteger(bucket.maxTick)) {
      throw new TypeError("Invalid bubble bucket geometry");
    }
    const x = timeToX(vp, (start + (end - start) / 2n).toString());
    const centerTick = bucket.minTick + (bucket.maxTick - bucket.minTick) / 2;
    const y = tickToY(vp, centerTick), diameter = bubbleDiameter(bucket.V!, sizing), radius = diameter / 2;
    if (x === null || y === null || x + radius <= bounds.left || x - radius >= bounds.left + bounds.width
      || y + radius <= bounds.top || y - radius >= bounds.top + bounds.height) continue;
    const rgba = bubbleColor(source, colors);
    bubbles.push({ source, x, y, diameter, rgba });
  }
  const clusters = clusterBubbles(bubbles, clustering, sizing, filters);
  const drawn: ProjectedBubble[] = clusters.map(cluster => ({
    source: cluster.children[0].source, x: cluster.x, y: cluster.y,
    diameter: cluster.diameter, rgba: cluster.rgba, cluster,
  }));
  for (const p of drawn) {
    const r = p.diameter / 2, q = p.cluster!;
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [-1, 1], [1, -1], [1, 1]]) {
      values.push(p.x + u * r, p.y + v * r, u, v, ...p.rgba, r,
        Number(q.B), Number(q.S), Number(q.V), Number(q.delta));
    }
  }
  return { bubbles: drawn, sourceBubbles: bubbles, clusters, vertexData: new Float32Array(values),
    vertexCount: drawn.length * 6, bounds: { ...bounds } };
}
/** Hit the actual drawn aggregate, including its exact CPU children. */
export function hitTestProjectedBubble(frame: BubbleFrame, x: number, y: number): ProjectedBubble | null {
  const b = frame.bounds;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < b.left || x >= b.left + b.width
    || y < b.top || y >= b.top + b.height) return null;
  for (let i = frame.bubbles.length - 1; i >= 0; i--) {
    const p = frame.bubbles[i];
    if ((x - p.x) ** 2 + (y - p.y) ** 2 <= (p.diameter / 2) ** 2) return p;
  }
  return null;
}
/** R09-compatible original-source helper. Cluster consumers use projected hits. */
export function hitTestBubble(frame: BubbleFrame, x: number, y: number): BubbleState | null {
  return hitTestProjectedBubble(frame, x, y)?.source ?? null;
}
const VERTEX = `#version 300 es
layout(location=0) in vec2 a_position;
layout(location=1) in vec2 a_local;
layout(location=2) in vec4 a_color;
layout(location=3) in float a_radius;
uniform vec2 u_cssSize;
out vec2 v_local;
flat out vec4 v_color;
flat out float v_radius;
void main() {
  gl_Position=vec4(a_position.x/u_cssSize.x*2.0-1.0,1.0-a_position.y/u_cssSize.y*2.0,0.0,1.0);
  v_local=a_local; v_color=a_color; v_radius=a_radius;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in vec4 v_color;
flat in float v_radius;
out vec4 outColor;
void main() {
  float r=length(v_local);
  if(r>1.0) discard;
  float border=r>1.0-0.8/v_radius ? 0.65 : 1.0;
  outColor=vec4(v_color.rgb*border*v_color.a,v_color.a);
}`;

/** Dedicated transparent WebGL2 layer; context loss does not alter aggregation. */
export class BubbleRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniform: WebGLUniformLocation | null = null;
  private sources: readonly BubbleState[] = [];
  private viewport: Viewport | null = null;
  private sizing: BubbleSizing = DEFAULT_BUBBLE_SIZING;
  private filters: BubbleFilters | undefined;
  private colors: BubbleColors = DEFAULT_BUBBLE_COLORS;
  private clustering: ClusteringOptions = { mode: "ALL" };
  private disposed = false;
  private lost = false;
  status: RenderStatus = "RENDER ERROR";
  error: string | null = null;
  lastFrame: BubbleFrame = {
    bubbles: [], vertexData: new Float32Array(), vertexCount: 0,
    bounds: { left: 0, top: 0, width: 0, height: 0 }, clusters: [], sourceBubbles: [],
  };
  constructor(
    private canvas: HTMLCanvasElement,
    private onStatus: (status: RenderStatus, error: string | null) => void = () => {},
  ) {
    canvas.addEventListener("webglcontextlost", this.contextLost);
    canvas.addEventListener("webglcontextrestored", this.contextRestored);
    try { this.initialize(); } catch (e) { this.fail(e); }
  }
  private setStatus(status: RenderStatus, error: string | null = null): void {
    if (this.status !== status || this.error !== error) {
      this.status = status; this.error = error; this.onStatus(status, error);
    }
  }
  private fail(error: unknown): void {
    this.setStatus("RENDER ERROR", error instanceof Error ? error.message : String(error));
  }
  private initialize(): void {
    const gl = this.canvas.getContext("webgl2", {
      alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 unavailable; no CSS/SVG or Canvas2D bubble fallback");
    this.gl = gl;
    const shaders: WebGLShader[] = [];
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Bubble shader allocation failed");
        shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) ?? "Bubble shader compilation failed");
        }
      }
      this.program = gl.createProgram();
      if (!this.program) throw new Error("Bubble program allocation failed");
      for (const shader of shaders) gl.attachShader(this.program, shader);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(this.program) ?? "Bubble shader link failed");
      }
      this.buffer = gl.createBuffer(); this.vao = gl.createVertexArray();
      if (!this.buffer || !this.vao) throw new Error("Bubble GPU buffer allocation failed");
      this.uniform = gl.getUniformLocation(this.program, "u_cssSize");
      if (this.uniform === null) throw new Error("Missing bubble CSS-size uniform");
      gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (const [location, size, offset] of [[0, 2, 0], [1, 2, 8], [2, 4, 16], [3, 1, 32]]) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, BUBBLE_FLOATS_PER_VERTEX * 4, offset);
      }
      this.setStatus("READY");
    } catch (e) {
      this.release(); throw e;
    } finally { for (const shader of shaders) gl.deleteShader(shader); }
  }
  private release(): void {
    if (this.gl && !this.lost) {
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.program = null; this.buffer = null; this.vao = null; this.uniform = null;
  }
  private contextLost = (event: Event): void => {
    event.preventDefault(); this.lost = true; this.release();
    this.setStatus("CONTEXT LOST", "Bubble WebGL2 context lost; CPU Trade data retained");
  };
  private contextRestored = (): void => {
    if (this.disposed) return;
    this.lost = false;
    try {
      this.initialize();
      if (this.viewport) this.draw(this.sources, this.viewport, this.sizing, this.filters, this.clustering, this.colors);
    } catch (e) { this.fail(e); }
  };
  draw(
    sources: readonly BubbleState[], vp: Viewport, sizing: BubbleSizing = DEFAULT_BUBBLE_SIZING,
    filters?: BubbleFilters, clustering: ClusteringOptions = { mode: "ALL" },
    colors: BubbleColors = DEFAULT_BUBBLE_COLORS,
  ): BubbleFrame {
    if (this.disposed) throw new Error("Bubble renderer disposed");
    this.sources = sources; this.viewport = vp; this.sizing = sizing; this.filters = filters;
    this.clustering = clustering;
    this.colors = colors;
    this.lastFrame = projectBubbles(sources, vp, sizing, filters, clustering, colors);
    if (this.lost || !this.gl || !this.program) return this.lastFrame;
    const gl = this.gl, b = vp.bounds;
    const cssWidth = b.left + b.width, cssHeight = b.top + b.height;
    const width = Math.round(cssWidth * vp.dpr), height = Math.round(cssHeight * vp.dpr);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!width || !height || !b.width || !b.height) return this.lastFrame;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(b.left * vp.dpr), 0,
      width - Math.round(b.left * vp.dpr), height - Math.round(b.top * vp.dpr));
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lastFrame.vertexData, gl.DYNAMIC_DRAW);
    gl.uniform2f(this.uniform, cssWidth, cssHeight);
    gl.drawArrays(gl.TRIANGLES, 0, this.lastFrame.vertexCount);
    const code = gl.getError();
    if (code !== gl.NO_ERROR && !gl.isContextLost()) this.fail(new Error(`Bubble WebGL error ${code}`));
    else if (!gl.isContextLost()) this.setStatus("READY");
    return this.lastFrame;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestored);
    this.release(); this.status = "DISPOSED";
  }
}
