import { Link } from '@tanstack/react-router';
import * as React from 'react';
import { cn } from '../../lib/cn';
import type { ClientSession } from '../../server/session';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  AdminIcon,
  BellIcon,
  CloseIcon,
  DashboardsIcon,
  LogOutIcon,
  LogsIcon,
  MenuIcon,
  OverviewIcon,
  SearchIcon,
} from './icons';
import { ThemeToggle } from './theme-toggle';

export interface AppShellProps {
  session: ClientSession;
  onLogout: () => void;
  children: React.ReactNode;
}

const linkBase =
  'flex items-center gap-2.5 rounded-control px-2.5 py-2 text-sm font-medium transition-colors';

// Active route gets the brand-muted treatment; the rest are quiet until hovered.
const activeLink = 'bg-bg-selected text-fg-default';
const idleLink = 'text-fg-muted hover:bg-bg-hover hover:text-fg-default';

// The navigation. Feature routes (#21-#23) replace their `disabled` placeholder
// with a real <Link to="…">: that is the single edit needed to surface a new page
// in the nav (see apps/web/README.md → "Adding a feature page").
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5">
      <Link
        to="/app"
        onClick={onNavigate}
        className={cn(linkBase, idleLink)}
        activeProps={{ className: cn(linkBase, activeLink) }}
        activeOptions={{ exact: true }}
      >
        <OverviewIcon />
        Overview
      </Link>
      <Link
        to="/explorer"
        onClick={onNavigate}
        className={cn(linkBase, idleLink)}
        activeProps={{ className: cn(linkBase, activeLink) }}
      >
        <LogsIcon />
        Log Explorer
      </Link>
      {/* Search is the second mode of the explorer surface (#22): same route, the
          `mode=search` query param selects the historical-search view. */}
      <Link
        to="/explorer"
        search={{ mode: 'search' }}
        onClick={onNavigate}
        className={cn(linkBase, idleLink)}
        activeProps={{ className: cn(linkBase, activeLink) }}
        activeOptions={{ includeSearch: true }}
      >
        <SearchIcon />
        Search
      </Link>
      {/* Dashboards (#193): saved visualizations. Visible to every role — a member
          sees a correctly reduced view (list/read only; create/delete are
          gated server-side and mirrored in the UI). */}
      <Link
        to="/dashboards"
        onClick={onNavigate}
        className={cn(linkBase, idleLink)}
        activeProps={{ className: cn(linkBase, activeLink) }}
      >
        <DashboardsIcon />
        Dashboards
      </Link>
      {/* Feature pages built in #23. Admin is visible to every role — a member sees
          a correctly reduced view (read-only workspace + retention; no user/key
          management); writes are gated server-side and mirrored in the UI. */}
      <Link
        to="/alerts"
        onClick={onNavigate}
        className={cn(linkBase, idleLink)}
        activeProps={{ className: cn(linkBase, activeLink) }}
      >
        <BellIcon />
        Alerts
      </Link>
      <Link
        to="/admin"
        onClick={onNavigate}
        className={cn(linkBase, idleLink)}
        activeProps={{ className: cn(linkBase, activeLink) }}
      >
        <AdminIcon />
        Admin
      </Link>
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="inline-flex size-7 items-center justify-center rounded-control bg-brand-solid font-bold text-fg-on-brand text-sm">
        L
      </span>
      <span className="font-semibold text-fg-default">Logalot</span>
    </div>
  );
}

function SessionFooter({ session, onLogout }: { session: ClientSession; onLogout: () => void }) {
  return (
    <div className="flex flex-col gap-2 border-border-subtle border-t pt-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <p className="truncate text-fg-muted text-xs" title={session.userId}>
            {session.userId.slice(0, 8)}…
          </p>
          <Badge tone="brand" className="mt-0.5">
            {session.role}
          </Badge>
        </div>
        <ThemeToggle />
      </div>
      <Button variant="ghost" size="sm" onClick={onLogout} className="justify-start">
        <LogOutIcon />
        Sign out
      </Button>
    </div>
  );
}

// Responsive application shell.
//   desktop (lg+): persistent left sidebar + content.
//   tablet/mobile (<lg): top bar with a menu button that opens an overlay drawer.
export function AppShell({ session, onLogout, children }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="flex h-svh flex-col overflow-hidden lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-border-default border-r bg-bg-surface p-3 lg:flex">
        <Brand />
        <NavLinks />
        <SessionFooter session={session} onLogout={onLogout} />
      </aside>

      {/* Mobile/tablet top bar */}
      <header className="flex shrink-0 items-center justify-between border-border-default border-b bg-bg-surface px-3 py-2 lg:hidden">
        <Brand />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            className="inline-flex size-8 items-center justify-center rounded-control text-fg-muted hover:bg-bg-hover hover:text-fg-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <MenuIcon />
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-modal lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-bg-overlay"
            onClick={() => setMobileOpen(false)}
          />
          <div
            id="mobile-nav"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col gap-4 border-border-default border-r bg-bg-surface p-3 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <Brand />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation menu"
                className="inline-flex size-8 items-center justify-center rounded-control text-fg-muted hover:bg-bg-hover hover:text-fg-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                <CloseIcon />
              </button>
            </div>
            <NavLinks onNavigate={() => setMobileOpen(false)} />
            <SessionFooter session={session} onLogout={onLogout} />
          </div>
        </div>
      ) : null}

      {/* Content — the scroll container. min-h-0 lets it shrink inside the
          viewport-locked shell so a fixed-height page (e.g. the live-tail explorer,
          which fills h-full and scrolls its own log list) stays bounded, while a
          tall normal page (Overview/Admin) scrolls here instead of growing the page. */}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
    </div>
  );
}
