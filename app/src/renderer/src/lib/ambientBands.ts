/** Owned here, not in DynamicScope.tsx, so `ambientBands` has no import back
 *  into the component tree — DynamicScope imports BANDS, and a type living on
 *  the component side would make that a cycle. */
export type DynamicVariant = 'home' | 'case' | 'settings'

export interface BandConfig {
  /** Halo padding around the light-source rect, CSS px. `x` is scaled by the
   *  shader's width factor; `y` is not. */
  pad: readonly [number, number]
  /** How far ABOVE the cutoff the light starts fading, CSS px. Home's 145px-tall
   *  halo wants 110; a 44px header band wants a fraction of that or the fade
   *  erases the whole band. */
  feather: number
  /** 0 = blob (home's sdRoundBox geometry), 1 = ribbon (anisotropic, for strips). */
  mode: 0 | 1
  /** How far the canvas extends past the cutoff, CSS px. */
  extra: number
}

/** Per-view band geometry. Values settled against the mock in
 *  `argus-docs/superpowers/assets/2026-07-31-dynamic-theme-case-settings.html`. */
export const BANDS: Record<DynamicVariant, BandConfig> = {
  home: { pad: [320, 145], feather: 110, mode: 0, extra: 50 },
  case: { pad: [240, 62], feather: 30, mode: 1, extra: 16 },
  settings: { pad: [300, 92], feather: 64, mode: 1, extra: 16 }
}
