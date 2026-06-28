import type { TenantResponse } from '@logalot/contracts';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '../../components/ui';

// Read-only view of the tenant's OWN settings. tenant_admin holds `tenant:read`
// but NOT `tenant:update` (that is platform_operator-only in the control-plane
// matrix), so there is intentionally no edit affordance here — offering one would
// be an action no role we serve can perform. Editable workspace config that a
// tenant_admin DOES own lives in the Retention card.
export interface TenantInfoCardProps {
  tenant: TenantResponse;
}

export function TenantInfoCard({ tenant }: TenantInfoCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Workspace</CardTitle>
        <Badge tone={tenant.status === 'active' ? 'success' : 'warning'}>{tenant.status}</Badge>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-fg-muted">Name</dt>
            <dd className="font-medium text-fg-default">{tenant.name}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-fg-muted">Slug</dt>
            <dd className="font-mono text-fg-default">{tenant.publicId}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
