import type { ProfileFrame } from "./smoothing.ts";
import { COLOR_LUT, COLOR_LUT_STEPS } from "./palette.ts";
import { gaussianKernel, rowStrengths } from "./glow.ts";

/**
 * WebGL2 background renderer (heatmap + current-book colour band only).
 * Data on GPU (all NEAREST, texelFetch only):
 *  - data:     RG32F  W x H ring (R = projected quantity, G = coverage) — one texel column per physical
 *              column, slot = (absolute pixel + x) mod W; only columns whose cached profile id changed are
 *              uploaded with texSubImage2D (column-wise, or one batched upload when >25% changed).
 *  - eaten:    R8     W x H ring with the same slot mapping as data; only 1 x H columns whose mask signature
 *              changed for their slot are uploaded (full upload only on allocation / context init).
 *  - strength: R32F   H x 1 row strength (glow K sub-row), uploaded on price geometry change.
 *  - lut:      RGBA8  256 x 1 COLOR_LUT.
 *  - core/blur:R32F   W x H render targets (pass 1: scale+fade+strength, pass 2: vertical Gaussian).
 *  - band:     R32F   1 x N latest book only (block: per physical row size; glow: per price max size),
 *              bandCol RGBA8 1 x (N*K) glow column render target, sampled bilinearly like drawImage.
 * Upper/lower/gamma/style are uniforms: changing them never re-uploads data or eaten textures.
 */
export interface GpuScale { upper: number; lower: number; gamma: number }
export interface GpuBandRequest {
  width: number; height: number; paintStart: number; paintEnd: number; scale: GpuScale;
  /** Selects the shader path only; both quantity vectors below always describe the same latest book. */
  style: "block" | "glow";
  /** Block input: one size per physical band row (length = height). */
  rows: ArrayLike<number>;
  /** Glow input: max size per price (glowBookColumn geometry) plus its stretch geometry. */
  sizes: ArrayLike<number>; k: number; yTop: number; destHeight: number;
}
export interface GpuInfo {
  gpuName: string; cpuMs: number; gpuMs: number | null; timer: boolean;
  textures: { name: string; width: number; height: number; bytes: number }[]; estimatedBytes: number;
  uploadedColumns: number; uploadedColumnsTotal: number; batchedUploads: number;
  eatenColumns: number; eatenColumnsTotal: number; bandColumns: number; bandColumnsTotal: number;
  /** Logical latest-book quantity updates (any band texture changed) and uploaded bytes, per call / cumulative. */
  bandUpdates: number; bandBytes: number; bandBytesTotal: number; bandRowsUploads: number; bandSizesUploads: number; contextLosses: number; restores: number;
}

const VS = `#version 300 es
void main() { vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0); }`;
const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
uniform sampler2D u_data; uniform int u_W; uniform int u_H; uniform int u_base;
uniform float u_upper; uniform float u_lower; uniform float u_gamma;
vec2 dataAt(int x, int y) { return texelFetch(u_data, ivec2((x + u_base) % u_W, y), 0).rg; }
float posOf(float n) {
  if (!(n > 0.0 && n > u_lower)) return 0.0;
  float t = clamp((n - u_lower) / max(1.0, u_upper - u_lower), 0.0, 1.0);
  return t <= 0.0 ? 0.0 : pow(t, u_gamma);
}
`;
const CORE_FS = HEAD + `
uniform sampler2D u_eaten; uniform sampler2D u_strength; uniform int u_step; uniform int u_glow;
int stateAt(int x, int y) {
  if (x < 0 || x >= u_W) return 2;
  vec2 d = dataAt(x, y);
  if (d.g == 0.0) return 2;
  return posOf(d.r) > 0.0 ? 1 : 0;
}
bool eatenAt(int x, int y) { if (x < 0 || x >= u_W) return false; return texelFetch(u_eaten, ivec2((x + u_base) % u_W, y), 0).r > 0.5; }
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  vec2 d = dataAt(x, y);
  float fade = 1.0, st = 1.0;
  if (u_glow == 1) {
    st = texelFetch(u_strength, ivec2(y, 0), 0).r;
    if (stateAt(x, y) != 1) fade = 0.0;
    else {
      float appear = 1.0;
      for (int k = 0; k < 6; k++) { int s = stateAt(x - (k + 1) * u_step, y); if (s == 1) continue; if (s == 0) appear = float(k + 1) / 7.0; break; }
      float cancel = 1.0;
      for (int k = 0; k < 4; k++) { int s = stateAt(x + (k + 1) * u_step, y); if (s == 1) continue;
        if (s == 0 && !eatenAt(x + k * u_step, y)) cancel = float(k + 1) / 5.0; break; }
      fade = appear * cancel;
    }
  }
  o = vec4(posOf(d.r) * fade * st, 0.0, 0.0, 1.0);
}`;
const BLUR_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o; uniform sampler2D u_core; uniform int u_H; uniform int u_r; uniform float u_k[65];
void main() {
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
  float s = 0.0;
  for (int i = -32; i <= 32; i++) {
    if (i < -u_r || i > u_r) continue;
    int yy = y + i; if (yy < 0 || yy >= u_H) continue;
    s += texelFetch(u_core, ivec2(x, yy), 0).r * u_k[u_r - i];
  }
  o = vec4(s, 0.0, 0.0, 1.0);
}`;
/** Glow book column (glowBookColumn equivalent): rows = N*K, written to an RGBA8 target (8-bit like the scratch canvas). */
const BAND_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o; uniform sampler2D u_band; uniform sampler2D u_lut; uniform int u_K; uniform int u_rows; uniform int u_r;
uniform float u_k[65]; uniform float u_s[10]; uniform float u_upper; uniform float u_lower; uniform float u_gamma; uniform int u_nan;
float cpos(float n) {
  if (!(n >= 1.0) || n <= u_lower || u_nan == 1) return 0.0;
  float t = min(1.0, max(0.0, (n - u_lower) / max(1.0, u_upper - u_lower)));
  return u_gamma == 1.0 ? t : (t <= 0.0 ? 0.0 : pow(t, u_gamma));
}
float coreAt(int j) { if (j < 0 || j >= u_rows) return 0.0; return cpos(texelFetch(u_band, ivec2(0, j / u_K), 0).r) * u_s[j % u_K]; }
vec3 lut(float p) { int i = int(floor(clamp(p, 0.0, 1.0) * 255.0 + 0.5)); return texelFetch(u_lut, ivec2(i, 0), 0).rgb * 255.0; }
void main() {
  int j = int(gl_FragCoord.y);
  float h = 0.0;
  for (int i = -32; i <= 32; i++) { if (i < -u_r || i > u_r) continue; h += coreAt(j + i) * u_k[u_r - i]; }
  vec3 c = lut(min(1.0, h * 1.8)) * 0.9;
  float core = coreAt(j);
  if (core > 0.0) { float a = min(1.0, u_s[j % u_K] * 1.4); c = c * (1.0 - a) + lut(core) * a; }
  o = vec4(floor(c + 0.5) / 255.0, 1.0);
}`;
const COMPOSITE_FS = HEAD + `
uniform sampler2D u_core; uniform sampler2D u_blur; uniform sampler2D u_lut; uniform sampler2D u_strength;
uniform int u_glow; uniform int u_hasBg; uniform float u_shift; uniform int u_canvasH;
uniform int u_band; uniform int u_bandStart; uniform int u_bandEnd; uniform sampler2D u_bandTex; uniform sampler2D u_bandCol;
uniform float u_bUpper; uniform float u_bLower; uniform float u_bGamma; uniform int u_bNan;
uniform int u_bRows; uniform float u_bYTop; uniform float u_bDestH;
vec3 lut(float p) { int i = int(floor(clamp(p, 0.0, 1.0) * 255.0 + 0.5)); return texelFetch(u_lut, ivec2(i, 0), 0).rgb * 255.0; }
vec3 background(int x, int y) {
  if (u_hasBg == 0 || x < 0 || x >= u_W || y >= u_H) return vec3(0.0);
  vec2 d = dataAt(x, y);
  float c = texelFetch(u_core, ivec2(x, y), 0).r;
  vec3 col;
  if (u_glow == 0) col = c > 0.0 ? lut(c) : vec3(0.0);
  else {
    float b0 = texelFetch(u_blur, ivec2(x, y), 0).r;
    float bl = x > 0 ? texelFetch(u_blur, ivec2(x - 1, y), 0).r : 0.0;
    float br = x < u_W - 1 ? texelFetch(u_blur, ivec2(x + 1, y), 0).r : 0.0;
    float h = (bl + 2.0 * b0 + br) / 4.0;
    float a = c > 0.0 ? min(1.0, texelFetch(u_strength, ivec2(y, 0), 0).r * 1.4) : 0.0;
    col = lut(min(1.0, h * 1.8)) * 0.9 * (1.0 - a) + lut(c) * a;
  }
  return d.g * col;
}
vec3 band(int y, float fy) {
  if (u_band == 1) {
    float n = texelFetch(u_bandTex, ivec2(0, y), 0).r;
    if (u_bNan == 1 || n < 1.0 || n <= u_bLower) return vec3(0.0);
    float t = min(1.0, max(0.0, (n - u_bLower) / max(1.0, u_bUpper - u_bLower)));
    return lut(u_bGamma == 1.0 ? t : (t <= 0.0 ? 0.0 : pow(t, u_bGamma)));
  }
  // drawImage(scratch 1 x rows -> dest rect) with bilinear smoothing; outside the dest rect stays black fill.
  if (fy < u_bYTop || fy >= u_bYTop + u_bDestH) return vec3(0.0);
  float sy = (fy - u_bYTop) * float(u_bRows) / u_bDestH - 0.5;
  float j0 = floor(sy), f = sy - j0;
  int a = clamp(int(j0), 0, u_bRows - 1), b = clamp(int(j0) + 1, 0, u_bRows - 1);
  vec3 ca = texelFetch(u_bandCol, ivec2(0, a), 0).rgb * 255.0, cb = texelFetch(u_bandCol, ivec2(0, b), 0).rgb * 255.0;
  return mix(ca, cb, f);
}
void main() {
  int X = int(gl_FragCoord.x);
  int y = u_canvasH - 1 - int(gl_FragCoord.y);
  vec3 rgb;
  if (u_band != 0 && X >= u_bandStart && X < u_bandEnd) rgb = band(y, float(y) + 0.5);
  else rgb = background(int(floor(gl_FragCoord.x - u_shift)), y);
  o = vec4(clamp(floor(rgb + 0.5), 0.0, 255.0) / 255.0, 1.0);
}`;

interface Program { program: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }
interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class GpuHeatmap {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private lost = false;
  private onChange: (state: "lost" | "restored") => void;
  private progs: Record<"core" | "blur" | "band" | "comp", Program> | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private tex: Record<string, WebGLTexture | null> = {};
  private fbCore: WebGLFramebuffer | null = null;
  private fbBlur: WebGLFramebuffer | null = null;
  private fbBand: WebGLFramebuffer | null = null;
  private W = 0; private H = 0;
  private slotIds = new Int32Array(0);
  private slotEaten: string[] = [];
  private eatenColumn = new Uint8Array(0);
  private kernelBuf = new Float32Array(65);
  private strengthBuf = new Float32Array(10);
  private strengthKey = "";
  private scratch = new Float32Array(0);
  private bg: { hasBg: boolean; glow: boolean; base: number; scale: GpuScale; shift: number } | null = null;
  private band: GpuBandRequest | null = null;
  private bandRows = 0;
  /** Per band texture: retained staging + last uploaded values (numeric compare; sources are reused/mutated). */
  private bandCache: Record<"bandRowsTex" | "bandSizesTex", { n: number; stage: Float32Array; last: Float32Array }> = {
    bandRowsTex: { n: 0, stage: new Float32Array(0), last: new Float32Array(0) },
    bandSizesTex: { n: 0, stage: new Float32Array(0), last: new Float32Array(0) },
  };
  private bandKernel = new Float32Array(0); private bandKernelK = 0;
  private timerExt: TimerExt | null = null;
  private pendingQuery: WebGLQuery | null = null;
  // getExtension() returns null while the context is lost. Keep this handle so
  // the explicit loss/restore check can actually request restoration.
  private lossExtension: WEBGL_lose_context | null = null;
  private dims: Record<string, [number, number, number]> = {};
  maxTexture = 0;
  failure = "";
  readonly info: GpuInfo = { gpuName: "", cpuMs: 0, gpuMs: null, timer: false, textures: [], estimatedBytes: 0,
    uploadedColumns: 0, uploadedColumnsTotal: 0, batchedUploads: 0, eatenColumns: 0, eatenColumnsTotal: 0, bandColumns: 0, bandColumnsTotal: 0, bandUpdates: 0, bandBytes: 0, bandBytesTotal: 0,
    bandRowsUploads: 0, bandSizesUploads: 0,
    contextLosses: 0, restores: 0 };
  private readonly lostHandler = (e: Event) => { e.preventDefault(); this.lost = true; this.info.contextLosses++;
    this.dropResources(); this.onChange("lost"); };
  private readonly restoredHandler = () => {
    this.lost = false; this.info.restores++;
    if (this.init()) this.onChange("restored");
  };

  constructor(canvas: HTMLCanvasElement, onChange: (state: "lost" | "restored") => void) {
    this.canvas = canvas; this.onChange = onChange;
    canvas.addEventListener("webglcontextlost", this.lostHandler);
    canvas.addEventListener("webglcontextrestored", this.restoredHandler);
    this.init();
  }

  get ready(): boolean { return !!this.gl && !!this.progs && !this.lost && !this.gl.isContextLost(); }

  private init(): boolean {
    try {
      const gl = this.gl ?? this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
      if (!gl) { this.failure = "WebGL2 unavailable"; return false; }
      this.lossExtension = gl.getExtension("WEBGL_lose_context");
      this.gl = gl;
      if (!gl.getExtension("EXT_color_buffer_float")) { this.failure = "EXT_color_buffer_float unavailable"; return false; }
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      this.info.gpuName = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      this.timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2") as unknown as TimerExt | null;
      this.info.timer = !!this.timerExt;
      this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const make = (fs: string): Program => {
        const p = gl.createProgram()!;
        for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
          const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
          gl.attachShader(p, s); gl.deleteShader(s);
        }
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
        return { program: p, u: new Map() };
      };
      this.progs = { core: make(CORE_FS), blur: make(BLUR_FS), band: make(BAND_FS), comp: make(COMPOSITE_FS) };
      this.vao = gl.createVertexArray();
      const lut = new Uint8Array(COLOR_LUT_STEPS * 4);
      for (let i = 0; i < COLOR_LUT_STEPS; i++) {
        lut[i * 4] = COLOR_LUT[i * 3]!; lut[i * 4 + 1] = COLOR_LUT[i * 3 + 1]!; lut[i * 4 + 2] = COLOR_LUT[i * 3 + 2]!; lut[i * 4 + 3] = 255;
      }
      this.alloc("lut", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, COLOR_LUT_STEPS, 1, lut, 4);
      this.W = this.H = 0; this.bandRows = 0; this.resetBandCache();
      this.failure = "";
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.progs = null;
      return false;
    }
  }

  /** GL objects die with the context; restored contexts re-upload everything (no stale cache reuse). */
  private dropResources(): void {
    this.progs = null; this.vao = null; this.tex = {}; this.fbCore = this.fbBlur = this.fbBand = null;
    this.W = this.H = 0; this.slotIds = new Int32Array(0); this.slotEaten = []; this.strengthKey = "";
    this.bandRows = 0; this.resetBandCache(); this.pendingQuery = null; this.dims = {}; this.bg = null;
  }

  private alloc(name: string, internal: number, format: number, type: number, w: number, h: number,
    data: ArrayBufferView | null, bpp: number): WebGLTexture {
    const gl = this.gl!;
    if (this.tex[name]) gl.deleteTexture(this.tex[name]!);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    this.tex[name] = t; this.dims[name] = [w, h, w * h * bpp];
    return t;
  }

  private target(name: string, w: number, h: number, internal: number, format: number, type: number, bpp: number) {
    const gl = this.gl!;
    const t = this.alloc(name, internal, format, type, w, h, null, bpp);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }

  private ensureSize(W: number, H: number): void {
    const gl = this.gl!;
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    if (W === this.W && H === this.H) return;
    for (const fb of [this.fbCore, this.fbBlur]) if (fb) gl.deleteFramebuffer(fb);
    this.alloc("data", gl.RG32F, gl.RG, gl.FLOAT, W, H, null, 8);
    this.alloc("eaten", gl.R8, gl.RED, gl.UNSIGNED_BYTE, W, H, new Uint8Array(W * H), 1);
    this.alloc("strength", gl.R32F, gl.RED, gl.FLOAT, H, 1, null, 4);
    this.fbCore = this.target("core", W, H, gl.R32F, gl.RED, gl.FLOAT, 4);
    this.fbBlur = this.target("blur", W, H, gl.R32F, gl.RED, gl.FLOAT, 4);
    this.W = W; this.H = H;
    this.slotIds = new Int32Array(W).fill(-1); this.slotEaten = new Array<string>(W).fill(""); this.strengthKey = "";
    this.scratch = new Float32Array(H * 2); this.eatenColumn = new Uint8Array(H);
  }

  private use(name: "core" | "blur" | "band" | "comp"): Program {
    const p = this.progs![name]; this.gl!.useProgram(p.program); return p;
  }
  private loc(p: Program, n: string) {
    if (!p.u.has(n)) p.u.set(n, this.gl!.getUniformLocation(p.program, n));
    return p.u.get(n)!;
  }
  private bindTex(p: Program, uniform: string, unit: number, name: string) {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, this.tex[name] ?? null);
    gl.uniform1i(this.loc(p, uniform), unit);
  }
  private common(p: Program, scale: GpuScale, base: number) {
    const gl = this.gl!;
    gl.uniform1i(this.loc(p, "u_W"), this.W); gl.uniform1i(this.loc(p, "u_H"), this.H); gl.uniform1i(this.loc(p, "u_base"), base);
    gl.uniform1f(this.loc(p, "u_upper"), scale.upper); gl.uniform1f(this.loc(p, "u_lower"), scale.lower);
    gl.uniform1f(this.loc(p, "u_gamma"), scale.gamma);
    this.bindTex(p, "u_data", 0, "data");
  }

  /** Upload changed profile columns and render core + blur, then composite. Returns false on failure. */
  render(frame: ProfileFrame, W: number, H: number, scale: GpuScale, style: "glow" | "block"): boolean {
    if (!this.ready) return false;
    const started = performance.now();
    const gl = this.gl!;
    this.pollTimer();
    this.ensureSize(W, H);
    const base = frame.aligned ? ((frame.firstPixel % W) + W) % W : 0;
    // 1. ring upload of changed columns only.
    const changed = planSlotUploads(W, base, x => frame.list[x]?.id ?? -1, this.slotIds);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.data!);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (changed.length > W / 4) {
      const all = new Float32Array(W * H * 2);
      for (let x = 0; x < W; x++) {
        const e = frame.list[x]!, slot = (x + base) % W;
        for (let y = 0; y < H; y++) { const i = (y * W + slot) * 2; all[i] = e.values[y]!; all[i + 1] = e.coverage[y]!; }
        this.slotIds[slot] = e.id;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RG, gl.FLOAT, all);
      this.info.batchedUploads++;
    } else for (const x of changed) {
      const e = frame.list[x]!, slot = (x + base) % W, s = this.scratch;
      for (let y = 0; y < H; y++) { s[y * 2] = e.values[y]!; s[y * 2 + 1] = e.coverage[y]!; }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, slot, 0, 1, H, gl.RG, gl.FLOAT, s);
      this.slotIds[slot] = e.id;
    }
    this.info.uploadedColumns = changed.length; this.info.uploadedColumnsTotal += changed.length;
    // 2. eaten mask (screen-indexed) and row strengths: only when their versions change.
    // Eaten mask ring: same slot as data; zeroed slots carry signature "" (allocated as zeros).
    const eatenChanged = planSlotUploads(W, base, x => frame.eaten.get(x)?.signature ?? "", this.slotEaten);
    if (eatenChanged.length) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex.eaten!);
      const column = this.eatenColumn;
      for (const x of eatenChanged) {
        const e = frame.eaten.get(x), slot = (x + base) % W;
        if (e) for (let y = 0; y < H; y++) column[y] = e.mask[y] ? 255 : 0; else column.fill(0);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, slot, 0, 1, H, gl.RED, gl.UNSIGNED_BYTE, column);
        this.slotEaten[slot] = e?.signature ?? "";
      }
    }
    this.info.eatenColumns = eatenChanged.length; this.info.eatenColumnsTotal += eatenChanged.length;
    if (frame.strengthKey !== this.strengthKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex.strength!);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, H, 1, gl.RED, gl.FLOAT, Float32Array.from(frame.strength));
      this.strengthKey = frame.strengthKey;
    }
    const timer = this.timerExt && !this.pendingQuery ? gl.createQuery() : null;
    if (timer) gl.beginQuery(this.timerExt!.TIME_ELAPSED_EXT, timer);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, W, H);
    // 3. core = position x fade x strength
    let p = this.use("core");
    this.common(p, scale, base);
    this.bindTex(p, "u_eaten", 1, "eaten"); this.bindTex(p, "u_strength", 2, "strength");
    gl.uniform1i(this.loc(p, "u_step"), frame.step); gl.uniform1i(this.loc(p, "u_glow"), style === "glow" ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbCore); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 4. vertical Gaussian
    if (style === "glow") {
      p = this.use("blur");
      this.bindTex(p, "u_core", 0, "core");
      gl.uniform1i(this.loc(p, "u_H"), H); gl.uniform1i(this.loc(p, "u_r"), (frame.kernel.length - 1) >> 1);
      gl.uniform1fv(this.loc(p, "u_k"), padded(frame.kernel, this.kernelBuf));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBlur); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bg = { hasBg: true, glow: style === "glow", base, scale: { ...scale }, shift: 0 };
    this.composite();
    if (timer) { gl.endQuery(this.timerExt!.TIME_ELAPSED_EXT); this.pendingQuery = timer; }
    this.info.cpuMs = performance.now() - started;
    return true;
  }

  /** No price data / no threshold: black background, band still drawn. */
  renderEmpty(W: number, H: number): boolean {
    if (!this.ready) return false;
    this.ensureSize(W, H);
    this.bg = { hasBg: false, glow: false, base: 0, scale: { upper: 1, lower: 0, gamma: 1 }, shift: 0 };
    this.composite();
    return true;
  }

  /** Mirrors the trade-follow bitmap shift (content moves right by dx); no data upload. */
  shift(dx: number): boolean {
    if (!this.ready || !this.bg) return false;
    this.bg.shift += dx; this.composite(); return true;
  }

  setBand(band: GpuBandRequest | null): boolean {
    if (!this.ready) return false;
    this.band = band;
    let bandColumns = 0, bandBytes = 0;
    if (band) {
      const gl = this.gl!;
      const rowsBytes = this.uploadBand("bandRowsTex", band.rows);
      const sizesBytes = this.uploadBand("bandSizesTex", band.sizes);
      if (rowsBytes) this.info.bandRowsUploads++;
      if (sizesBytes) this.info.bandSizesUploads++;
      bandColumns = (rowsBytes ? 1 : 0) + (sizesBytes ? 1 : 0);
      bandBytes = rowsBytes + sizesBytes;
      if (band.style === "glow") {
        const rows = this.bandCache.bandSizesTex.n * band.k;
        if (rows !== this.bandRows) {
          if (this.fbBand) gl.deleteFramebuffer(this.fbBand);
          this.fbBand = this.target("bandCol", 1, rows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4);
          this.bandRows = rows;
        }
        const p = this.use("band");
        if (this.bandKernelK !== band.k) { this.bandKernel = gaussianKernel(band.k) as Float32Array<ArrayBuffer>; this.bandKernelK = band.k; }
        const kernel = this.bandKernel, r = (kernel.length - 1) >> 1;
        this.bindTex(p, "u_band", 0, "bandSizesTex"); this.bindTex(p, "u_lut", 1, "lut");
        gl.uniform1i(this.loc(p, "u_K"), band.k); gl.uniform1i(this.loc(p, "u_rows"), rows); gl.uniform1i(this.loc(p, "u_r"), r);
        gl.uniform1fv(this.loc(p, "u_k"), padded(kernel, this.kernelBuf)); gl.uniform1fv(this.loc(p, "u_s"), padded(rowStrengths(band.k), this.strengthBuf));
        gl.uniform1f(this.loc(p, "u_upper"), Number.isNaN(band.scale.upper) ? 1 : band.scale.upper);
        gl.uniform1f(this.loc(p, "u_lower"), band.scale.lower); gl.uniform1f(this.loc(p, "u_gamma"), band.scale.gamma);
        gl.uniform1i(this.loc(p, "u_nan"), Number.isNaN(band.scale.upper) ? 1 : 0);
        gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBand); gl.viewport(0, 0, 1, rows);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }
    this.info.bandColumns = bandColumns; this.info.bandColumnsTotal += bandColumns;
    this.info.bandUpdates = bandColumns ? 1 : 0;
    this.info.bandBytes = bandBytes; this.info.bandBytesTotal += bandBytes;
    if (this.bg && (!band || (band.width === this.W && band.height === this.H))) this.composite();
    return true;
  }

  private resetBandCache(): void {
    for (const c of Object.values(this.bandCache)) c.n = 0;
  }

  /** Uploads one 1 x N band texture only if its length or any value changed. Returns uploaded bytes. */
  private uploadBand(name: "bandRowsTex" | "bandSizesTex", source: ArrayLike<number>): number {
    const gl = this.gl!, cache = this.bandCache[name], n = source.length;
    if (cache.stage.length !== n) cache.stage = new Float32Array(n);
    const stage = cache.stage;
    for (let i = 0; i < n; i++) stage[i] = source[i]!;
    if (cache.n !== n || !this.tex[name]) {
      this.alloc(name, gl.R32F, gl.RED, gl.FLOAT, 1, n, stage, 4);
      cache.n = n;
    } else {
      const last = cache.last;
      let same = true;
      for (let i = 0; i < n; i++) if (last[i] !== stage[i]) { same = false; break; }
      if (same) return 0;
      gl.bindTexture(gl.TEXTURE_2D, this.tex[name]!); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, n, gl.RED, gl.FLOAT, stage);
    }
    if (cache.last.length !== n) cache.last = new Float32Array(n);
    cache.last.set(stage);
    return n * 4;
  }

  private composite(): void {
    const gl = this.gl!, bg = this.bg;
    if (!bg) return;
    const band = this.band && this.band.width === this.W && this.band.height === this.H ? this.band : null;
    const p = this.use("comp");
    this.common(p, bg.scale, bg.base);
    this.bindTex(p, "u_core", 1, "core"); this.bindTex(p, "u_blur", 2, "blur"); this.bindTex(p, "u_lut", 3, "lut");
    this.bindTex(p, "u_strength", 4, "strength");
    this.bindTex(p, "u_bandTex", 5, band?.style === "block" ? "bandRowsTex" : "lut");
    this.bindTex(p, "u_bandCol", 6, band?.style === "glow" ? "bandCol" : "lut");
    gl.uniform1i(this.loc(p, "u_glow"), bg.glow ? 1 : 0); gl.uniform1i(this.loc(p, "u_hasBg"), bg.hasBg ? 1 : 0);
    gl.uniform1f(this.loc(p, "u_shift"), bg.shift); gl.uniform1i(this.loc(p, "u_canvasH"), this.canvas.height);
    gl.uniform1i(this.loc(p, "u_band"), band ? band.style === "block" ? 1 : 2 : 0);
    if (band) {
      gl.uniform1i(this.loc(p, "u_bandStart"), band.paintStart); gl.uniform1i(this.loc(p, "u_bandEnd"), band.paintEnd);
      gl.uniform1f(this.loc(p, "u_bUpper"), Number.isNaN(band.scale.upper) ? 1 : band.scale.upper);
      gl.uniform1f(this.loc(p, "u_bLower"), band.scale.lower); gl.uniform1f(this.loc(p, "u_bGamma"), band.scale.gamma);
      gl.uniform1i(this.loc(p, "u_bNan"), Number.isNaN(band.scale.upper) ? 1 : 0);
      if (band.style === "glow") {
        gl.uniform1i(this.loc(p, "u_bRows"), this.bandRows);
        gl.uniform1f(this.loc(p, "u_bYTop"), band.yTop); gl.uniform1f(this.loc(p, "u_bDestH"), band.destHeight);
      }
    }
    gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.updateInfo();
  }

  /** Synchronous readback of the composited drawing buffer, RGBA rows top-down (Y flipped from GL). */
  readPixels(): { width: number; height: number; rgba: Uint8Array } | null {
    if (!this.ready || !this.bg) return null;
    this.composite();
    const gl = this.gl!, w = this.canvas.width, h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4), out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { width: w, height: h, rgba: out };
  }

  private pollTimer(): void {
    const gl = this.gl!, q = this.pendingQuery, ext = this.timerExt;
    if (!q || !ext) return;
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) this.info.gpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
    gl.deleteQuery(q); this.pendingQuery = null;
  }

  private updateInfo(): void {
    this.info.textures = Object.entries(this.dims).map(([name, [width, height, bytes]]) => ({ name, width, height, bytes }));
    // Plus default framebuffer (RGBA8, double-buffered estimate).
    this.info.estimatedBytes = this.info.textures.reduce((n, t) => n + t.bytes, 0) + this.canvas.width * this.canvas.height * 8;
  }

  loseContext(): void { this.lossExtension?.loseContext(); }
  restoreContext(): void { this.lossExtension?.restoreContext(); }

  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.lostHandler);
    this.canvas.removeEventListener("webglcontextrestored", this.restoredHandler);
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      for (const t of Object.values(this.tex)) if (t) gl.deleteTexture(t);
      for (const fb of [this.fbCore, this.fbBlur, this.fbBand]) if (fb) gl.deleteFramebuffer(fb);
      if (this.progs) for (const p of Object.values(this.progs)) gl.deleteProgram(p.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.pendingQuery) gl.deleteQuery(this.pendingQuery);
    }
    this.dropResources(); this.gl = null;
  }
}

/** Copies values into a retained uniform buffer (zero tail), no per-frame allocation. */
function padded(values: ArrayLike<number>, out: Float32Array): Float32Array {
  out.fill(0);
  for (let i = 0; i < Math.min(out.length, values.length); i++) out[i] = values[i]!;
  return out;
}

/**
 * Ring upload planning: screen column x lives in slot (x + base) mod width. Returns the screen columns whose
 * key differs from the key retained for their slot. Retained keys are not modified (caller updates on upload).
 */
export function planSlotUploads<T>(width: number, base: number, keyAt: (x: number) => T, slots: ArrayLike<T>): number[] {
  const changed: number[] = [];
  for (let x = 0; x < width; x++) if (slots[(x + base) % width] !== keyAt(x)) changed.push(x);
  return changed;
}
