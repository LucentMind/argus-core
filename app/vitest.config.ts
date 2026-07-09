import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node', // renderer tests opt into jsdom via // @vitest-environment jsdom
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    globals: true // lets @testing-library/react register its afterEach(cleanup) automatically
  }
})
