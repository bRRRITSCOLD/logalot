// Package coldstore is the cold-tier adapter that implements the
// kernel.ColdArchive port (write) and the cold search path of kernel.LogStore
// (read). Cold tier = S3 Parquet + Glue + Athena (decision 016, ADR-0005).
//
// Architecture (hexagonal / ports-and-adapters):
//
//	kernel.ColdArchive  ←──── coldstore.Store (this package)
//	                              │
//	                ┌────────────┴────────────────────────────┐
//	                │                                         │
//	          Write path                              Read path
//	   (Archive — best-effort tee)          (Search — feature-flagged)
//	                │                                         │
//	  ┌─────────────┼──────────────┐           ┌─────────────┤
//	  │             │              │           │             │
//	  S3        Parquet         Glue       Fitness fn    Athena
//	PutObject   encoder      CreatePartition (NFR-6)  StartQueryExecution
//
// Key invariants (cold-tier.md, ADR-0005, decision 016):
//
//   - tenant_id is the LEADING S3 partition — structural isolation boundary.
//   - The cold write path is processor-batched direct S3 Parquet write (NOT
//     Firehose — see decision 016 §"Firehose REJECTED").
//   - After each flush, a Glue CreatePartition is registered for the
//     tenant_id/dt/hour triple so the partition is immediately queryable even
//     if Athena's partition projection bootstrap hasn't run.
//   - Every generated Athena SQL must pass the SQL fitness function
//     (CheckTenantPredicate) before StartQueryExecution is called. This is the
//     enforced local backstop (NFR-6); the AWS-proprietary injected projection
//     guard provides defense-in-depth on real AWS.
//   - Cold search stays feature-flagged until the real-AWS CI smoke test passes
//     (decision 016 §6, ErrColdSearchDisabled).
package coldstore
