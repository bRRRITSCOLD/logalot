import { Alert, Card, CardContent, CardHeader, CardTitle } from '../../components/ui';
import type { AdminData, AdminOutcome } from '../../server/admin';
import { ApiKeysSection, type ApiKeysSectionProps } from './api-keys-section';
import { RetentionCard, type RetentionCardProps } from './retention-card';
import { TenantInfoCard } from './tenant-info-card';
import { UsersSection, type UsersSectionProps } from './users-section';

// Mutation executors the route wires to its BFF server functions. Bundling them
// keeps the route thin and lets tests inject mocks without a Start runtime.
export interface AdminExecutors {
  issueApiKey: ApiKeysSectionProps['issue'];
  revokeApiKey: ApiKeysSectionProps['revoke'];
  createUser: UsersSectionProps['create'];
  updateUser: UsersSectionProps['update'];
  deleteUser: UsersSectionProps['remove'];
  updateRetention: RetentionCardProps['update'];
}

export interface AdminDashboardProps {
  data: AdminData;
  executors: AdminExecutors;
  onChanged: () => void | Promise<void>;
}

function SectionError({ title, outcome }: { title: string; outcome: AdminOutcome<unknown> }) {
  if (outcome.ok) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert tone={outcome.error.kind === 'forbidden' ? 'info' : 'danger'}>
          {outcome.error.message}
        </Alert>
      </CardContent>
    </Card>
  );
}

export function AdminDashboard({ data, executors, onChanged }: AdminDashboardProps) {
  return (
    <div className="flex flex-col gap-6">
      {data.tenant.ok ? (
        <TenantInfoCard tenant={data.tenant.data} />
      ) : (
        <SectionError title="Workspace" outcome={data.tenant} />
      )}

      {data.retention.ok ? (
        <RetentionCard
          retention={data.retention.data}
          update={executors.updateRetention}
          onChanged={onChanged}
        />
      ) : (
        <SectionError title="Retention" outcome={data.retention} />
      )}

      {/* Users + API keys are only present when the role was permitted to load
          them (server-gated in loadAdminData) — a member never receives them. */}
      {data.users ? (
        data.users.ok ? (
          <UsersSection
            users={data.users.data}
            create={executors.createUser}
            update={executors.updateUser}
            remove={executors.deleteUser}
            onChanged={onChanged}
          />
        ) : (
          <SectionError title="Users" outcome={data.users} />
        )
      ) : null}

      {data.apiKeys ? (
        data.apiKeys.ok ? (
          <ApiKeysSection
            apiKeys={data.apiKeys.data}
            issue={executors.issueApiKey}
            revoke={executors.revokeApiKey}
            onChanged={onChanged}
          />
        ) : (
          <SectionError title="API keys" outcome={data.apiKeys} />
        )
      ) : null}
    </div>
  );
}
