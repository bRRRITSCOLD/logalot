import { logLevelSchema } from '@logalot/contracts';
import { createFileRoute } from '@tanstack/react-router';
import { EmptyState } from '../../components/states';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { LogLevelBadge } from '../../components/ui/log-level-badge';
import { useSession } from '../../hooks/use-session';

// Authenticated landing / overview. This is shell chrome, not a feature page —
// the log explorer, search, and alerts pages arrive in #21-#23 as siblings under
// the same `_authed` guard. It demonstrates the session context + severity scale.
export const Route = createFileRoute('/_authed/app')({
  component: OverviewPage,
});

function OverviewPage() {
  const session = useSession();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-2xl text-fg-default">Overview</h1>
        <p className="text-fg-muted text-sm">
          Signed in as tenant <code className="font-mono text-fg-default">{session.tenantId}</code>
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Severity scale</CardTitle>
          <CardDescription>
            The shared log-level palette every feature page renders with.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {logLevelSchema.options.map((level) => (
            <LogLevelBadge key={level} level={level} />
          ))}
        </CardContent>
      </Card>

      <EmptyState
        title="No feature pages yet"
        description="Log Explorer, Search, and Alerts mount here once #21-#23 land."
      />
    </div>
  );
}
