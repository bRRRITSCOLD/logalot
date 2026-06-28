import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { DefaultCatchBoundary, NotFound } from './components/states';
import { routeTree } from './routeTree.gen';

// Router entry consumed by the TanStack Start runtime (it calls getRouter()).
// Preload on intent (hover/focus) for snappy nav; a single app-wide error
// boundary + 404 keep every route's failure path consistent.
export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: NotFound,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
