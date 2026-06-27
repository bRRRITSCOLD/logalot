import { defineConfig } from 'vitest/config';

// Docker-backed integration suite (testcontainers Postgres). Kept out of the
// default `pnpm test` run so CI without a container runtime stays green. Run it
// explicitly with `pnpm test:integration` (requires Docker).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
