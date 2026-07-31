import { z } from 'zod'

/**
 * The single zod entry point for modules that BOTH processes load.
 *
 * Zod v4 JIT-compiles object parsers, and decides whether it may by probing
 * `new Function("")`. Both renderer windows ship `script-src 'self'` with no
 * 'unsafe-eval', so that probe reports a `securitypolicyviolation` on every load.
 * Nothing breaks — zod catches the throw and uses its interpreted path — but it
 * puts permanent noise in the console of a packaged build, which is where a real
 * violation would otherwise stand out.
 *
 * The probe fires at schema CONSTRUCTION, not at parse: `$ZodObject` evaluates
 * `jit && allowsEval.value`, so merely importing a module with a module-scope
 * `z.looseObject({...})` trips it. `allowsEval` is memoised, so `jitless` has to be
 * set before the first schema is built. Being a DEPENDENCY of every schema module
 * rather than a sibling import is what makes that ordering airtight: ESM guarantees
 * a module's dependencies finish evaluating before its own body runs. A side-effect
 * import at the top of the renderer entry would not — both entries would pull it
 * into the same shared chunk as the schema modules, where the relative order is
 * Rollup's to choose.
 *
 * Renderer only. `jitless` disables the fastpath process-wide, and main genuinely
 * parses (settings, pack manifests, driver payloads) so it keeps the JIT. The
 * renderer never calls `.parse()` at all — it imports these modules for their
 * constants and types — so it gives up nothing.
 */
if (typeof window !== 'undefined') z.config({ jitless: true })

export { z }
