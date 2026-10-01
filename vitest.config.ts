import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { QUAYSIDE_QUIET: '1', QUAYSIDE_NOW: '2016-11-20T10:00:00Z' },
    testTimeout: 20_000,
    pool: 'forks',
  },
})
