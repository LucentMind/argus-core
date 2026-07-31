import { useEffect, useRef, useState } from 'react'
import type { Theme } from '../lib/uiStore'
import type { BandConfig } from '../lib/ambientBands'
import { hexToRgb01 } from '../lib/hexColor'

/**
 * The ambient aurora behind the dashboard header — a raw-WebGL2 port of the
 * argus-ambient mock's hero panel (spec 2026-07-31-dynamic-theme-design.md §4).
 * Deliberately dropped from the mock: the discrete glow-source loop (never
 * bound to anything but the hero) and the uTop clip (this canvas starts below
 * the TopBar in normal flow, so its own top edge is the clip). The canvas
 * scrolls WITH the content it is anchored to, so scrolling needs no handling.
 */

const RES_SCALE = 0.55

/** Light-theme aurora pastels (spec §6 — starting values, tuned at CDP stage).
 *  The light `uBg` is NOT listed here: it is read from the resolved scoped
 *  `--void` at refresh time, because the two must be exactly equal or a seam
 *  appears where the canvas ends (spec invariant). */
const LIGHT_PAL_A: [number, number, number] = [0.3, 0.48, 0.82]
const LIGHT_PAL_B: [number, number, number] = [0.94, 0.66, 0.32]
const BLACK: [number, number, number] = [0, 0, 0]
const WHITE: [number, number, number] = [1, 1, 1]

const VERT = `#version 300 es
void main() {
  // fullscreen triangle from gl_VertexID — no vertex buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;    // CSS pixels — the space every rect below lives in
uniform vec2  uBuf;    // drawing-buffer pixels — where gl_FragCoord lives
uniform float uTime;
uniform vec4  uHero;   // wordmark rect, canvas-local CSS px (x, y, w, h)
uniform float uHeroOn;
uniform float uCutoff; // CSS px: light stops at the filter row
uniform float uFeather;
uniform float uFade;
uniform vec2  uPad;
uniform float uMode;
uniform float uLight;  // 0 = dark theme, 1 = light theme
uniform vec3  uBg;     // page colour (light theme) — MUST equal scoped --void
uniform vec3  uPalA;   // cool pastel, light theme
uniform vec3  uPalB;   // warm pastel, light theme

out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  // Normalise out of the drawing buffer FIRST, then scale into CSS pixels.
  // gl_FragCoord is in buffer space (CSS x dpr x RES_SCALE); the rects the JS
  // side uploads are in CSS space. Mixing the two silently offsets the light
  // by the render scale.
  vec2 px = vec2(gl_FragCoord.x / uBuf.x, 1.0 - gl_FragCoord.y / uBuf.y) * uRes;
  vec3 col = vec3(0.0);
  float sc = clamp(uRes.x / 1100.0, 1.0, 1.7);

  vec3 deep  = vec3(0.130, 0.200, 0.560);
  vec3 cyan  = vec3(0.220, 0.660, 0.950);
  vec3 ember = vec3(0.620, 0.360, 0.100);

  if (uHeroOn > 0.5 && uMode < 0.5) {
    /* ---- blob: the home geometry, driven by uPad ---- */
    vec2  c    = uHero.xy + uHero.zw * 0.5;
    vec2  hs   = uHero.zw * 0.5 + vec2(uPad.x * sc, uPad.y);
    float d    = sdRoundBox(px - c, hs, min(145.0, uPad.y));
    float fall = exp(-max(d, 0.0) / 205.0);
    fall *= mix(1.0, 0.06, smoothstep(0.0, 250.0, px.y - (c.y + hs.y * 0.7)));

    if (fall > 0.004) {
      vec2 n  = (px - c) / (620.0 * sc);
      vec2 q  = vec2(fbm(n * 1.4 + vec2(0.0, uTime * 0.130)),
                     fbm(n * 1.4 + vec2(5.2, 1.3) - vec2(uTime * 0.105, 0.0)));
      float a = fbm(n * 1.7 + 1.7 * q + vec2(uTime * 0.060, 0.0));

      vec3 tint = mix(deep, cyan, smoothstep(0.34, 0.78, a));
      tint      = mix(tint, ember, smoothstep(0.30, 0.02, a) * 0.45);

      float body  = fall * (0.56 + 1.18 * a);
      float rim   = exp(-abs(d + 28.0) / 40.0) * fall * 0.60;
      float sheen = exp(-pow((px.x - c.x - sin(uTime * 0.30) * 480.0 * sc) / (300.0 * sc), 2.0))
                    * fall * 0.42;

      col += tint * (body + rim) + cyan * sheen;
    }
  } else if (uMode > 0.5) {
    /* ---- ribbon: a wide, thin aurora that fits a header strip. The blob's
       radial falloff is tuned for a 145px-tall halo and mostly clips away in a
       44px band; this one is anisotropic by construction. ---- */
    float cy   = uCutoff * 0.42;
    float env  = exp(-pow((px.y - cy) / (uCutoff * 0.78), 2.0));
    vec2  n    = vec2(px.x / (700.0 * sc), (px.y - cy) / 150.0);
    vec2  q    = vec2(fbm(n * 1.1 + vec2(uTime * 0.055, 0.0)),
                      fbm(n * 1.1 + vec2(3.4, 1.7) - vec2(uTime * 0.041, 0.0)));
    float a    = fbm(n * 1.35 + 1.5 * q + vec2(uTime * 0.030, 0.0));
    /* brighter near the light anchor (the case id / the page title) */
    float lat  = mix(0.34, 1.0,
                 exp(-pow((px.x - (uHero.x + uHero.z * 0.5)) / (uRes.x * 0.42), 2.0)));
    lat = mix(1.0, lat, uHeroOn);
    vec3 tint = mix(deep, cyan, smoothstep(0.36, 0.80, a));
    tint      = mix(tint, ember, smoothstep(0.32, 0.04, a) * 0.42);
    float body  = env * lat * (0.30 + 1.35 * a);
    float sheen = exp(-pow((px.x - uRes.x * (0.5 + 0.42 * sin(uTime * 0.22))) / (330.0 * sc), 2.0))
                  * env * 0.45;
    col += tint * body + cyan * sheen;
  }

  /* ---- confine: below the cutoff nothing is lit ---- */
  col *= 1.0 - smoothstep(uCutoff - uFeather, uCutoff + uFade, px.y);

  /* ---- grade ---- */
  vec2  uv  = px / uRes;
  float vig = 1.0 - 0.34 * pow(length((uv - 0.5) * vec2(1.15, 1.0)), 2.1);
  col *= vig;
  col  = col / (1.0 + col * 0.55);
  col  = pow(max(col, vec3(0.0)), vec3(0.92));

  if (uLight > 0.5) {
    // Light theme: the panel is a tint, not a glow — adding brightness to a
    // near-white page just clips. Intensity drives how far the page colour is
    // pushed toward a pastel; the aurora's warm/cool balance picks which one.
    float I = clamp(length(col) * 1.30, 0.0, 1.0);
    // Polarised, not linear: a raw r/b ratio parks around 0.3 for most of the
    // panel, and mixing blue with amber at 0.3 averages into slate grey.
    // smoothstep pushes each fragment toward one pastel or the other — that is
    // what keeps any chroma at all.
    float warm = smoothstep(0.25, 0.75, clamp(col.r / max(col.b, 1e-4), 0.0, 1.0));
    outColor = vec4(mix(uBg, mix(uPalA, uPalB, warm), I), 1.0);
  } else {
    outColor = vec4(col, 1.0);
  }
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[ambient] shader compile failed:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

export function AmbientCanvas({
  light,
  cutoff,
  theme,
  band
}: {
  light: HTMLElement | null
  cutoff: HTMLElement | null
  theme: Theme
  band: BandConfig
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [fallback, setFallback] = useState(false)
  // Latest props, readable from inside the one-shot GL effect without rebuilding it.
  const latest = useRef({ light, cutoff, theme, band })
  useEffect(() => {
    latest.current = { light, cutoff, theme, band }
  }, [light, cutoff, theme, band])
  // measure+palette entry point the props effect below pokes after re-renders.
  const api = useRef<{ refresh: () => void } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A FRESH canvas per effect run — never reuse the JSX element. Under StrictMode's
    // dev double-mount, cleanup's loseContext() poisons the previous element:
    // getContext('webgl2') on it returns the same lost context forever, so a reused
    // canvas silently falls back on every dev boot.
    const canvas = host.ownerDocument.createElement('canvas')
    canvas.className = 'dyn-ambient'
    canvas.dataset.testid = 'ambient-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    let gl: WebGL2RenderingContext | null = null
    try {
      gl = canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance'
      })
    } catch {
      gl = null
    }
    if (!gl) {
      setFallback(true)
      return
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
      setFallback(true)
      return
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[ambient] link failed:', gl.getProgramInfoLog(prog))
      setFallback(true)
      return
    }
    gl.useProgram(prog)
    const u = {
      res: gl.getUniformLocation(prog, 'uRes'),
      buf: gl.getUniformLocation(prog, 'uBuf'),
      time: gl.getUniformLocation(prog, 'uTime'),
      hero: gl.getUniformLocation(prog, 'uHero'),
      heroOn: gl.getUniformLocation(prog, 'uHeroOn'),
      cutoff: gl.getUniformLocation(prog, 'uCutoff'),
      feather: gl.getUniformLocation(prog, 'uFeather'),
      fade: gl.getUniformLocation(prog, 'uFade'),
      pad: gl.getUniformLocation(prog, 'uPad'),
      mode: gl.getUniformLocation(prog, 'uMode'),
      light: gl.getUniformLocation(prog, 'uLight'),
      bg: gl.getUniformLocation(prog, 'uBg'),
      palA: gl.getUniformLocation(prog, 'uPalA'),
      palB: gl.getUniformLocation(prog, 'uPalB')
    }

    host.appendChild(canvas)

    let disposed = false
    let raf = 0

    /** Halts the rAF loop for good — used on context loss and on unmount, so
     *  no frame keeps calling GL ops after the context is gone. */
    const stop = (): void => {
      disposed = true
      cancelAnimationFrame(raf)
    }

    /** Re-measures anchors and re-applies the palette. Cheap enough to be one
     *  function — it runs on resize/props change, not per frame. */
    const refresh = (): void => {
      if (disposed || !gl) return
      const wrapper = host.parentElement
      if (!wrapper) return
      const { light: lightEl, cutoff: cutoffEl, theme: th, band } = latest.current
      const wr = wrapper.getBoundingClientRect()
      const cutoff = cutoffEl ? cutoffEl.getBoundingClientRect().bottom - wr.top : 460
      const w = Math.max(1, Math.round(wr.width))
      const h = Math.max(1, Math.round(cutoff + band.extra))
      canvas.style.height = `${h}px`
      const scale = Math.min(window.devicePixelRatio || 1, 2) * RES_SCALE
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(u.res, w, h)
      // read back off the canvas rather than recomputing — the rounding above
      // must match what gl_FragCoord sees, or every light drifts by the error
      gl.uniform2f(u.buf, canvas.width, canvas.height)
      gl.uniform1f(u.cutoff, cutoff)
      gl.uniform1f(u.feather, band.feather)
      gl.uniform1f(u.fade, band.fade)
      gl.uniform2f(u.pad, band.pad[0], band.pad[1])
      gl.uniform1f(u.mode, band.mode)
      if (lightEl) {
        const hr = lightEl.getBoundingClientRect()
        gl.uniform4f(u.hero, hr.x - wr.x, hr.y - wr.y, hr.width, hr.height)
        gl.uniform1f(u.heroOn, 1)
      } else {
        gl.uniform1f(u.heroOn, 0)
      }
      // SPEC INVARIANT: light uBg = the resolved scoped --void, read from CSS,
      // never a duplicated constant — the two must match exactly or a seam
      // appears where the canvas ends. WHITE, not black, is the safe fallback on
      // a light page: a black ground would be a full-page seam, not a subtle one.
      const light = th === 'light'
      const bg = light
        ? (hexToRgb01(getComputedStyle(wrapper).getPropertyValue('--void')) ?? WHITE)
        : BLACK
      gl.uniform1f(u.light, light ? 1 : 0)
      gl.uniform3f(u.bg, bg[0], bg[1], bg[2])
      const palA = light ? LIGHT_PAL_A : BLACK
      const palB = light ? LIGHT_PAL_B : BLACK
      gl.uniform3f(u.palA, palA[0], palA[1], palA[2])
      gl.uniform3f(u.palB, palB[0], palB[1], palB[2])
      gl.clearColor(bg[0], bg[1], bg[2], 1)
    }
    api.current = { refresh }

    const rate = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1
    const start = performance.now()
    const frame = (now: number): void => {
      if (disposed || !gl) return
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      gl.uniform1f(u.time, ((now - start) / 1000) * rate)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const onLost = (e: Event): void => {
      e.preventDefault()
      stop()
      setFallback(true)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    const onResize = (): void => refresh()
    window.addEventListener('resize', onResize)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => refresh()) : null
    if (ro && host.parentElement) ro.observe(host.parentElement)
    // Michroma loading late changes the wordmark rect
    void document.fonts?.ready.then(() => refresh())

    refresh()
    raf = requestAnimationFrame(frame)

    return () => {
      stop()
      api.current = null
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('webglcontextlost', onLost)
      ro?.disconnect()
      // release the context deterministically — navigating home->case->home
      // ten times must not accumulate ten live contexts
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }, [])

  // anchors/theme/band changed → re-measure and re-palette without rebuilding GL
  useEffect(() => {
    api.current?.refresh()
  }, [light, cutoff, theme, band])

  if (fallback) {
    return (
      <div className="dyn-ambient-fallback" data-testid="ambient-fallback" aria-hidden="true" />
    )
  }
  return <div ref={hostRef} data-testid="ambient-canvas-host" aria-hidden="true" />
}
