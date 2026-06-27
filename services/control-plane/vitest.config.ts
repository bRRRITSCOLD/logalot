import { defineConfig } from 'vitest/config';

// Default test run = fast, Docker-free unit tests only. The Docker-backed
// integration suite lives under test/integration and runs via the separate
// `test:integration` script (vitest.integration.config.ts) so the default CI
// `pnpm test` stays green without a container runtime.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
