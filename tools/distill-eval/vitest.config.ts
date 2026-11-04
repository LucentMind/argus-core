import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['../test-temp-root.ts']
  }
})
