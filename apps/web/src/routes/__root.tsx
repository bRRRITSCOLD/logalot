/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';
import { DefaultCatchBoundary, NotFound } from '../components/states';
import appCss from '../styles/app.css?url';

// Root route owns the HTML document. Dark theme is the default (data-theme set on
// <html>); the generated tokens.css drives every color via CSS variables.
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Logalot' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: NotFound,
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-bg-base text-fg-default antialiased">
        {/* nuqs URL-state adapter (the deferred-from-#20 dependency the Log Explorer
            page uses for shareable filter state); bound to the TanStack Router. */}
        <NuqsAdapter>
          <Outlet />
        </NuqsAdapter>
        <Scripts />
      </body>
    </html>
  );
}
