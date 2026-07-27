import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node', // renderer tests opt into jsdom via // @vitest-environment jsdom
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    globals: true, // lets @testing-library/react register its afterEach(cleanup) automatically
    // Headroom for I/O stalls on GitHub's Windows runners, not for slow tests.
    // Measured: the mkdtemp + openDb + createCase beforeEach shared by the tests
    // that failed costs 51ms locally (openDb 39ms of it), and CI runs ~9x slower
    // per test at matched parallelism — so ~0.5s expected. Two runs of the same
    // commit blew the 10s hook budget on five files and then the 5s test budget
    // on one, a different set each time: multi-second stalls, not slow code. The
    // defaults left no room for them. A real hang is still caught by the CI job's
    // 20-minute timeout.
    testTimeout: 15_000,
    hookTimeout: 30_000
  }
})
