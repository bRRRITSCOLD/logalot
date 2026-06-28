import { createCsrfMiddleware, createStart } from '@tanstack/react-start';

// Explicit, pinned CSRF protection for server functions.
//
// TanStack Start engages its built-in `defaultCsrfMiddleware` ONLY while no
// `createStart` instance exists (see start-server-core `createStartHandler`:
// `requestMiddleware: hasStartInstance ? startOptions.requestMiddleware
//  : [defaultCsrfMiddleware]`). The moment a feature in #21-#23 adds its own start
// instance for unrelated request middleware, that implicit protection is silently
// dropped — server functions are same-origin RPC endpoints and would then accept
// cross-site requests. Declaring the CSRF middleware here makes the protection
// explicit and impossible to lose as this scaffold grows.
export const csrfMiddleware = createCsrfMiddleware({
  // Guard server-function RPC calls (the mutating BFF endpoints) only; plain
  // page/SSR GETs handled by the router are not the cross-site RPC surface.
  filter: (ctx) => ctx.handlerType === 'serverFn',
});

// Auto-discovered by the Start plugin as `src/start.ts` (the default start entry);
// the handler reads `startInstance.getOptions().requestMiddleware`.
export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
