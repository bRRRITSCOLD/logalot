import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// TanStack Start app + BFF. The `tanstackStart` plugin owns file-based routing
// (src/routes -> src/routeTree.gen.ts) and the server runtime; `react` must come
// after it. Tailwind v4 reads its theme from the generated src/styles/tokens.css.
export default defineConfig({
  server: { port: 3000 },
  plugins: [tailwindcss(), tanstackStart(), react()],
});
