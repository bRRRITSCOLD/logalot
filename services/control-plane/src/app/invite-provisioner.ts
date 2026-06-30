// InviteProvisioner is the driven port the authenticator calls to JIT-provision
// a user from a valid invite. The interface lives in ports.ts (alongside every
// other driven port); this module re-exports it as the canonical import path for
// callers that prefer the feature-file name over the monolithic ports barrel.
//
// The single concrete implementation (PgInviteProvisioner) lives in:
//   adapters/postgres/pg-invite-provisioner.ts
// and is wired in container.ts at startup.

export type { InviteProvisioner, InviteProvisionInput } from './ports';
