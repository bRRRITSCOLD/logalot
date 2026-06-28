import { describe, expect, it, vi } from 'vitest';
import { csrfMiddleware, startInstance } from './start';

// The CSRF middleware is a `createMiddleware().server(handler)` value: its server
// handler lives at `.options.server`. We invoke it directly with a minimal request
// context to assert the cross-site protection our `start.ts` pins is actually
// enforced (the framework otherwise only adds it when no start instance exists).
type CsrfCtx = {
  request: Request;
  handlerType: 'serverFn' | 'router';
  next: () => unknown;
};
const serverHandler = (
  csrfMiddleware as unknown as { options: { server: (ctx: CsrfCtx) => Promise<unknown> } }
).options.server;

const NEXT = Symbol('next');
function makeCtx(
  headers: Record<string, string>,
  handlerType: CsrfCtx['handlerType'] = 'serverFn',
) {
  return {
    request: new Request('http://localhost:3000/_serverFn/loginFn', { method: 'POST', headers }),
    handlerType,
    next: vi.fn(() => NEXT),
  } satisfies CsrfCtx;
}

describe('csrfMiddleware (pinned in start.ts)', () => {
  it('rejects a cross-site Sec-Fetch-Site request to a server function with 403', async () => {
    const ctx = makeCtx({ 'Sec-Fetch-Site': 'cross-site' });

    const result = await serverHandler(ctx);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(ctx.next).not.toHaveBeenCalled();
  });

  it('allows a same-origin server-function request to proceed', async () => {
    const ctx = makeCtx({ 'Sec-Fetch-Site': 'same-origin' });

    const result = await serverHandler(ctx);

    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(result).toBe(NEXT);
  });

  it('does not validate non-server-function (router/page) requests — the filter scopes it', async () => {
    // Even cross-site: the filter only guards server fns, so router GETs pass.
    const ctx = makeCtx({ 'Sec-Fetch-Site': 'cross-site' }, 'router');

    const result = await serverHandler(ctx);

    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(result).toBe(NEXT);
  });
});

describe('startInstance', () => {
  it('pins the CSRF middleware in requestMiddleware so a start instance never drops it', async () => {
    const options = await startInstance.getOptions();
    expect(options.requestMiddleware).toContain(csrfMiddleware);
  });
});
