import * as React from 'react';
import { cn } from '../../lib/cn';
import { MoonIcon, SunIcon } from './icons';

type Theme = 'dark' | 'light';
const STORAGE_KEY = 'lg-theme';

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// localStorage can be unavailable (privacy mode, sandboxed/SSR contexts). A theme
// preference is non-essential, so we degrade silently rather than crash the shell.
function readStoredTheme(): Theme | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore — the in-memory state + data-theme attribute still apply for this session.
  }
}

// Theme is a pure client-side preference (dark is the SSR default for a log
// viewer). We persist it in localStorage — it is a non-sensitive UI preference,
// unlike the session, which lives in httpOnly cookies.
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = React.useState<Theme>('dark');

  React.useEffect(() => {
    const stored = readStoredTheme();
    if (stored) {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    storeTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
        className,
      )}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
