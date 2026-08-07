/**
 * The dynamic theme's context gauge — a wavy, self-lit fill edge for the session-status pill.
 *
 * This is a port of `AmbientCanvas.tsx`, not a lookalike: the same `hash` → `vnoise` → `fbm`
 * chain, the same domain-warp (two fbm samples drifting in opposite directions, fed back into a
 * third), the same `col/(1 + col*0.55)` tone-map and 0.92 grade, and the same premultiplied
 * output contract. What differs is the job — instead of lighting a header strip, the warped
 * field displaces a single ridge whose mean position IS the reading.
 *
 * ONE context for every pill on the page, blitted out per consumer. Chrome caps a document at
 * roughly sixteen live WebGL contexts and silently drops the oldest past that: a context per
 * pill would eventually evict the ambient canvas itself, which is a far more visible surface
 * than this one. Consumers therefore hand in a plain 2-D canvas and get a blit.
 *
 * Everything degrades to `null`/`false` rather than throwing. jsdom returns null from
 * `getContext('webgl2')` and so does a browser that has lost its GPU process, and in both cases
 * the pill must fall back to the flat CSS gradient rather than render nothing.
 */

/** Uniform set for one specimen. Lengths are CSS pixels; `fill` and `amp` are fractions of width. */
export interface GaugeFrame {
  /** CSS size of the destination, so the shader can scale its stroke weights. */
  w: number
  h: number
  /** Seconds. Held constant to freeze the ridge (reduced motion). */
  t: number
  /** 0..1 — the share of the context window in use. */
  fill: number
  /** Crest swing either side of `fill`, as a fraction of width. */
  amp: number
  /** Field frequency along the height. */
  scale: number
  warp: number
  glow: number
  /** How many trailing ridges to draw inside the fill (0-2). */
  ech: number
  /** Light theme tints rather than glows — adding brightness to a white ground only clips. */
  light: boolean
  /** Status tone, linear 0..1 RGB. Read off the pill's `currentColor` by the caller. */
  tone: readonly [number, number, number]
}

export interface GaugeRenderer {
  /** False when WebGL2 is unavailable (jsdom, lost context, blocklisted GPU). */
  available(): boolean
  /** Draw one frame into `dest`, sized in device pixels by the caller. No-op when unavailable. */
  render(dest: HTMLCanvasElement, frame: GaugeFrame): void
}

/** The tuning chosen from the edge study (the "Reference" set). */
export const GAUGE_TUNING = { amp: 0.06, scale: 1.1, warp: 1.2, glow: 1, ech: 2 } as const

/** Shared scratch buffer. Big enough for any pill at 2x DPR with room to spare. */
const BUF_W = 512
const BUF_H = 128

const VERT = `#version 300 es
void main() {
  // fullscreen triangle from gl_VertexID — no vertex buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;

uniform vec4  uVp;     // viewport in drawing-buffer px (x, y, w, h)
uniform vec2  uRes;    // this specimen in CSS px
uniform float uTime;
uniform float uFill;   // 0..1 — the reading
uniform float uAmp;    // crest swing, as a fraction of width
uniform float uScale;  // field frequency along the height
uniform float uWarp;
uniform float uGlow;
uniform float uEch;
uniform float uLight;  // 0 = dark theme, 1 = light
uniform vec3  uTone;

out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
/* AmbientCanvas's five octaves, kept for the along-crest brightness. */
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
/* TWO octaves, normalised, for the crest PATH. Five is right for a field read through a 200px
   blur; used as a centreline it puts detail at ~40 cycles over a 19px pill and the ridge turns
   to vibration. Two, at a low base frequency, is what buys the long lean. */
float fbmLow(vec2 p) {
  float a = 0.62, s = 0.0, n = 0.0;
  for (int i = 0; i < 2; i++) { s += a * vnoise(p); n += a; p *= 2.03; a *= 0.42; }
  return s / n;
}

/* Where the ridge sits on this row, as a signed fraction of the width. */
float crest(float yn, float t, float ph) {
  vec2 n = vec2(yn * uScale + ph, t * 0.16);
  vec2 q = vec2(fbmLow(n * 1.05 + vec2(t * 0.050, 0.0)),
                fbmLow(n * 1.05 + vec2(3.4, 1.7) - vec2(t * 0.040, 0.0)));
  return (fbmLow(n * 1.2 + uWarp * q) - 0.5) * 2.0;
}

void main() {
  vec2 f = vec2((gl_FragCoord.x - uVp.x) / uVp.z, 1.0 - (gl_FragCoord.y - uVp.y) / uVp.w);
  float W = max(uRes.x, 1.0);
  float yn = f.y;
  float t = uTime;

  /* One stroke unit, off the WIDTH. Height is wrong: the pill is 4.6:1, so a height-derived
     unit inflates every glow radius the moment the aspect changes and floods the element. */
  float u0 = max(W / 30.0, 0.4) * uGlow;
  float fillPx = uFill * W;

  /* Below roughly a tenth of the pill the glow is wider than the reading it describes: at 3% of
     a 96px pill the fill is under 3px, and a 4px halo on top of it triples the apparent level.
     Shrink the whole ridge toward the fill rather than let the gauge over-read. */
  float u = u0 * clamp(fillPx / (u0 * 3.0), 0.35, 1.0);

  /* Straighten the crest at both ends for the same reason. A wander of ±6% of the width is
     twice the whole reading at 3% — it would swing negative — and at 100% it swings off the
     pill and the edge disappears into the border. */
  float amp = uAmp * smoothstep(0.0, 0.16, uFill) * smoothstep(0.0, 0.10, 1.0 - uFill);

  float e0 = uFill + amp * crest(yn, t, 0.0);
  float d = (f.x - e0) * W;

  /* Energy field, colour-free: the two themes disagree about what to DO with light, not about
     where it is. */
  float e = 0.0;

  /* Body — a floor plus a falloff decaying LEFT from the crest, not a flat ramp. The colour
     pools just behind the ridge and the far side of the fill goes near-black, which is what
     lets the ridge read as floating over the fill rather than capping it. */
  float left = 1.0 - smoothstep(-1.0, 1.0, d);
  e += left * (0.075 + 0.34 * exp(min(d, 0.0) / (0.28 * W)));

  /* Echoes — the same field on its own phase, so they run parallel without ever locking up. */
  for (int i = 0; i < 2; i++) {
    if (float(i) >= uEch) break;
    float k = i == 0 ? 0.32 : 0.60;
    float ph = i == 0 ? 5.1 : 11.7;
    float ex = uFill * (1.0 - k) + amp * 0.85 * crest(yn, t * 0.82, ph);
    float dd = (f.x - ex) * W;
    float w = u * (i == 0 ? 0.85 : 1.15);
    e += exp(-dd * dd / (w * w)) * (i == 0 ? 0.30 : 0.17);
  }

  /* The filament. Brightness travels along the crest, driven by the same field, which is what
     stops it reading as a drawn line. The halo is wider on the fill side than the empty side —
     light spills into the body, not out of it. */
  float lum = 0.62 + 0.80 * fbm(vec2(yn * uScale * 1.7, t * 0.09));
  float hw = u * (d < 0.0 ? 1.9 : 1.25);
  float halo = exp(-d * d / (hw * hw));
  float core = exp(-d * d / (u * 0.42 * u * 0.42));
  e += halo * 0.55 * lum;

  vec3 col;
  if (uLight > 0.5) {
    /* Light theme is a tint, not a glow — AmbientCanvas reaches the same conclusion in its own
       light branch. The core reads as MORE saturated rather than whiter, because white on a
       white ground is nothing. */
    e += core * 1.15 * lum;
    col = mix(uTone, uTone * 0.62, clamp(core * lum, 0.0, 1.0));
  } else {
    /* The core keeps only a little white. It was 0.55 — a near-white filament — and the pill's
       label in dark is near-white too, so wherever the crest crossed the text it measured
       2.5:1. Holding the core near the tone drops its luminance and takes the same label back
       over 5:1, at the cost of the white-hot look the study had. */
    col = uTone * e + mix(uTone, vec3(1.0), 0.18) * core * 1.45 * lum;
    e = max(e, core * 1.45 * lum);
  }

  /* Grade — AmbientCanvas's, verbatim. */
  col = col / (1.0 + col * 0.55);
  col = pow(max(col, vec3(0.0)), vec3(0.92));

  /* Premultiplied, alpha tracking the energy field: the ridge sits OVER the pill's own tint
     rather than replacing it.

     Capped at 0.28, not 1.0, and the cap is measured rather than taste. The pill's label sits
     centred, directly in the crest's path. Worst-case contrast anywhere under the glyphs, swept
     against the real renderer (see the note on the ink label in SessionChips):

       cap    light   dark
       1.00    ~1.2    ~1.5     unreadable, and what shipped
       0.42    6.44    3.51     dark still under AA
       0.30    7.92    4.82     first cap that clears 4.5:1 in both
       0.28    ~8.2    ~5.1     chosen, with a little margin

     The ridge reads as a lit band rather than a white-hot filament. That is the honest price of
     putting a moving light source behind 10.5px type in a 96px pill. */
  float I = clamp(e * (uLight > 0.5 ? 1.45 : 1.25), 0.0, 0.28);
  outColor = vec4(col * I, I);
}`

const UNIFORMS = [
  'uVp',
  'uRes',
  'uTime',
  'uFill',
  'uAmp',
  'uScale',
  'uWarp',
  'uGlow',
  'uEch',
  'uLight',
  'uTone'
] as const

interface Ctx {
  gl: WebGL2RenderingContext
  src: HTMLCanvasElement
  loc: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[gauge] shader compile failed:', gl.getShaderInfoLog(sh))
    return null
  }
  return sh
}

function boot(): Ctx | null {
  if (typeof document === 'undefined') return null
  // Feature-detect BEFORE touching a canvas. jsdom does not define this constructor and answers
  // getContext('webgl2') by logging "Not implemented" to its virtual console — noise in every
  // renderer test run, from a call whose answer we already know.
  if (typeof WebGL2RenderingContext === 'undefined') return null
  const src = document.createElement('canvas')
  src.width = BUF_W
  src.height = BUF_H
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = src.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      // The blit reads the buffer inside the same frame as the draw, but a compositor that
      // recycles the buffer between the two would hand back a cleared one. Cheap insurance on a
      // 512x128 surface.
      preserveDrawingBuffer: true
    }) as WebGL2RenderingContext | null
  } catch {
    return null
  }
  if (!gl) return null

  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[gauge] link failed:', gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)
  const loc = {} as Ctx['loc']
  for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(prog, n)
  gl.clearColor(0, 0, 0, 0)
  gl.disable(gl.BLEND)
  return { gl, src, loc }
}

/** The process-wide renderer. Boots on first use and stays down for good if boot fails. */
export function createGaugeRenderer(): GaugeRenderer {
  let ctx: Ctx | null = null
  let tried = false

  const get = (): Ctx | null => {
    if (!tried) {
      tried = true
      ctx = boot()
      // A lost context can never be revived on the same canvas; drop to the CSS gradient for
      // the rest of the session rather than blitting a black rectangle every frame.
      ctx?.src.addEventListener('webglcontextlost', () => {
        ctx = null
      })
    }
    return ctx
  }

  return {
    available: () => get() !== null,
    render(dest, o) {
      const c = get()
      if (!c) return
      const { gl, loc } = c
      const bw = Math.min(BUF_W, Math.max(1, Math.round(dest.width)))
      const bh = Math.min(BUF_H, Math.max(1, Math.round(dest.height)))
      // Park the viewport at the buffer's TOP-left in image coordinates: GL's origin is bottom
      // -left, so the y offset is what makes the blit's source rect start at (0, 0).
      const vy = BUF_H - bh
      gl.viewport(0, vy, bw, bh)
      gl.scissor(0, vy, bw, bh)
      gl.enable(gl.SCISSOR_TEST)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform4f(loc.uVp, 0, vy, bw, bh)
      gl.uniform2f(loc.uRes, o.w, o.h)
      gl.uniform1f(loc.uTime, o.t)
      gl.uniform1f(loc.uFill, o.fill)
      gl.uniform1f(loc.uAmp, o.amp)
      gl.uniform1f(loc.uScale, o.scale)
      gl.uniform1f(loc.uWarp, o.warp)
      gl.uniform1f(loc.uGlow, o.glow)
      gl.uniform1f(loc.uEch, o.ech)
      gl.uniform1f(loc.uLight, o.light ? 1 : 0)
      gl.uniform3f(loc.uTone, o.tone[0], o.tone[1], o.tone[2])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.disable(gl.SCISSOR_TEST)

      const g2 = dest.getContext('2d')
      if (!g2) return
      g2.clearRect(0, 0, dest.width, dest.height)
      if (o.fill > 0.001) g2.drawImage(c.src, 0, 0, bw, bh, 0, 0, dest.width, dest.height)
    }
  }
}

export const gaugeRenderer: GaugeRenderer = createGaugeRenderer()

/**
 * `rgb(139 220 165)` / `rgb(139, 220, 165)` / `#8bdca5` → linear-ish 0..1 triple.
 *
 * The caller reads this off the pill's computed `color`, which is how the CSS gauge gets its
 * tone too — so the shader tracks the status tone AND the theme without a second palette to
 * keep in sync. Returns null on anything unparseable (`color-mix(...)`, `oklch(...)`, ''), and
 * the caller then skips the frame rather than drawing in a made-up colour.
 */
export function parseToneColor(css: string): [number, number, number] | null {
  const m = css.match(/-?[\d.]+/g)
  if (css.startsWith('rgb') && m && m.length >= 3) {
    const [r, g, b] = m
    return [Number(r) / 255, Number(g) / 255, Number(b) / 255]
  }
  const hex = css.trim().match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  return null
}
