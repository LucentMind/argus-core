import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node', // renderer tests opt into jsdom via // @vitest-environment jsdom
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'scripts/**/__tests__/**/*.test.{ts,mjs}'],
    setupFiles: ['./vitest.setup.ts'],
    globals: true, // lets @testing-library/react register its afterEach(cleanup) automatically
    // Headroom for I/O stalls on GitHub's Windows runners, not for slow tests.
    // Measured: the mkdtemp + openDb + createCase beforeEach shared by the tests
    // that failed costs 51ms locally (openDb 39ms of it), and CI runs ~9x slower
    // per test at matched parallelism — so ~0.5s expected. Two runs of the same
    // commit blew the 10s hook budget on five files and then the 5s test budget
    // on one, a different set each time: multi-second stalls, not slow code.
    //
    // Then a run on 2026-07-29 blew the raised 30s hook budget too, on hooks
    // measured at ~51ms: the whole suite ran 915s against a ~380s baseline on a
    // starved runner. No fixed budget tuned to "typical slow" survives that tail,
    // so the budgets are CI-conditional: tight locally, where they catch slow-code
    // regressions, and wide in CI, where their only job is to fail a true hang
    // faster than the workflow's job-level timeout would.
    testTimeout: process.env.CI ? 60_000 : 15_000,
    hookTimeout: process.env.CI ? 120_000 : 30_000
  }
})
