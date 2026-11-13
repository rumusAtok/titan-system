import { defineConfig } from 'vitest/config';

// Unit tests: pure logic, no running infrastructure needed.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'services/*/src/**/*.test.ts', 'apps/gateway/src/**/*.test.ts'],
    environment: 'node',
  },
});
