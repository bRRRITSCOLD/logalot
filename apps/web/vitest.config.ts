import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Component/unit tests run under jsdom with ONLY the React plugin — deliberately
// without the TanStack Start plugin, so tests exercise components in isolation
// without the SSR/router transform. Server functions are tested via their pure
// helpers (src/server/session.ts, control-plane client), not the runtime.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
