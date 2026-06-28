import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../hooks/use-session';
import type { ClientSession } from '../../server/session';

// Route-level smoke test locking the #21/#22 COEXISTENCE contract: the mode toggle,
// the mount auto-run gating, and the nuqs<->filters adapter wired in SearchMode.
// We mock the BFF server fns (no Start runtime in jsdom) and provide nuqs via its
// testing adapter so this exercises the real route wiring end to end.

const searchExecutor = vi.fn<(...args: unknown[]) => Promise<{ ok: true; events: unknown[] }>>();

vi.mock('../../server/search', () => ({
  defaultSearchExecutor: (...args: unknown[]) => searchExecutor(...args),
}));
vi.mock('../../server/auth', () => ({ getSession: vi.fn(async () => null) }));

// The tail's onReconnectExhausted needs a router; stub just useRouter, keep the rest
// of the router module real (Link, createFileRoute, …).
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useRouter: () => ({ navigate: vi.fn() }) };
});

// jsdom has no EventSource; the live tail constructs one. A no-op stub is enough —
// we only assert the tail surface renders, not that it streams.
class StubEventSource {
  addEventListener() {}
  close() {}
}

// Imported after the mocks are registered.
import { ExplorerPage } from './explorer';

const session: ClientSession = {
  userId: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  role: 'tenant_admin',
  expiresAt: 2_000_000_000,
};

function renderExplorer(searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <SessionProvider session={session}>
        <ExplorerPage />
      </SessionProvider>
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  searchExecutor.mockReset();
  searchExecutor.mockResolvedValue({ ok: true, events: [] });
  vi.stubGlobal('EventSource', StubEventSource as unknown as typeof EventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExplorerPage (route coexistence)', () => {
  it('defaults to the live-tail mode and never queries the search BFF', async () => {
    renderExplorer();
    // tail surface: the FilterBar message input
    expect(screen.getByLabelText('Search message text')).toBeInTheDocument();
    // both modes are reachable from the toggle
    expect(screen.getByRole('button', { name: 'Live tail' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('aria-pressed', 'false');
    expect(searchExecutor).not.toHaveBeenCalled();
  });

  it('toggles to search mode, showing the search bar and idle prompt (no query yet)', async () => {
    const u = userEvent.setup();
    renderExplorer();
    await u.click(screen.getByRole('button', { name: 'Search' }));

    // search surface: the full-text input + idle empty state, with no filters set
    expect(await screen.findByLabelText('Full-text search')).toBeInTheDocument();
    expect(screen.getByText(/search your logs/i)).toBeInTheDocument();
    expect(searchExecutor).not.toHaveBeenCalled();
  });

  it('lands in search mode from the URL and auto-runs the nuqs-mapped filters', async () => {
    renderExplorer('?mode=search&q=boot&level=error');

    expect(await screen.findByLabelText('Full-text search')).toHaveValue('boot');
    // the nuqs<->filters adapter mapped q→text and level→level, and the surface
    // auto-ran the shared link on mount via the BFF executor
    await waitFor(() => expect(searchExecutor).toHaveBeenCalledTimes(1));
    const filters = searchExecutor.mock.calls[0]?.[0] as { text: string; level: string };
    expect(filters.text).toBe('boot');
    expect(filters.level).toBe('error');
  });
});
