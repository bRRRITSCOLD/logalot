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
      {/* Placeholders for the feature pages built in #21-#23. */}
      <NavPlaceholder icon={<LogsIcon />} label="Log Explorer" />
      <NavPlaceholder icon={<SearchIcon />} label="Search" />
      <NavPlaceholder icon={<BellIcon />} label="Alerts" />
      <NavPlaceholder icon={<AdminIcon />} label="Admin" />
    </nav>
  );
}

function NavPlaceholder({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span
      className={cn(linkBase, 'cursor-not-allowed text-fg-subtle')}
      aria-disabled="true"
      title="Coming soon"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <Badge tone="neutral" className="text-2xs">
        soon
      </Badge>
    </span>
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
    <div className="flex min-h-svh flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col gap-4 border-border-default border-r bg-bg-surface p-3 lg:flex">
        <Brand />
        <NavLinks />
        <SessionFooter session={session} onLogout={onLogout} />
      </aside>

      {/* Mobile/tablet top bar */}
      <header className="flex items-center justify-between border-border-default border-b bg-bg-surface px-3 py-2 lg:hidden">
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

      {/* Content */}
      <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
    </div>
  );
}
