// Package kernel is the shared Go kernel for Logalot services.
//
// It is the single source of truth (DRY) for the cross-service contracts that
// every Go service (ingest-service, processor, query-service, …) imports:
//
//   - TenantContext — the first-class multi-tenancy invariant. Tenant identity is
//     resolved from the credential at the edge (ADR-0007) and carried explicitly
//     down the stack (ADR-0002, overview.md §6). It is the MANDATORY first
//     parameter of every tenant-scoped port method; there is no un-scoped
//     overload, and a contract/fitness function (AssertTenantScoped) proves it.
//
//   - Ports (interfaces only, no infrastructure) — LogStore, Broker, TailBus,
//     ColdArchive, KeyStore, Authenticator, TenantStore. Concrete adapters
//     (Postgres, RabbitMQ, Redis, S3, …) live with the service that owns them,
//     behind these ports (hexagonal, overview.md §1).
//
//   - Published-language types — the ingest→processor pipeline Envelope and the
//     normalized LogEvent that mirrors the log_events columns (docs/data/model.md
//     §5). These (de)serialize stably so the wire contract is versionable.
//
//   - The Postgres tenant-context convention (ArmTenant / WithTenantScope) — the
//     ONE place the `SET LOCAL app.tenant_id` GUC convention lives, kept
//     driver-agnostic so the kernel takes no pgx/database/sql dependency.
//
// The kernel deliberately contains NO concrete adapters and NO service logic.
package kernel
